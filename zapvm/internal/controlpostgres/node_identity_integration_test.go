package controlpostgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"zapvm/internal/cloudplane"
	"zapvm/internal/nodeidentity"
)

func TestPostgreSQLNodeIdentityEnrollmentRotationRevocationAndAudit(t *testing.T) {
	dsn := os.Getenv("ZAPVM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAPVM_TEST_POSTGRES_DSN is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	migrator, err := Open(ctx, dsn, OpenOptions{AllowInsecureLocalhost: true})
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	if _, err := migrator.Apply(ctx); err != nil {
		t.Fatal(err)
	}
	if err := resetQueueIntegrationState(ctx, migrator); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 8, 2, 0, 0, 0, time.UTC)
	currentTime := now
	queue, err := NewQueue(migrator, QueueOptions{HeartbeatTTL: 10 * time.Minute, LeaseTTL: 2 * time.Minute, Now: func() time.Time { return currentTime }})
	if err != nil {
		t.Fatal(err)
	}
	prepareNodeIdentityAuthority(t, ctx, migrator, queue, now)
	rawToken := []byte("single-use-enrollment-token-private-value")
	tokenDigest := sha256.Sum256(rawToken)
	if err := queue.ProvisionNodeEnrollmentTokens(ctx, []nodeidentity.EnrollmentProvision{{NodeID: "node-identity", TokenSHA256: tokenDigest[:], ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	first := identityCertificateRecord("node-identity", "11223344556677889900aabbccddeeff", 0x11, now, "")
	second := identityCertificateRecord("node-identity", "21223344556677889900aabbccddeeff", 0x22, now, "")
	records := []nodeidentity.CertificateRecord{first, second}
	errorsByIndex := make([]error, len(records))
	var wait sync.WaitGroup
	for index := range records {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			errorsByIndex[index] = queue.EnrollNodeCertificate(ctx, "node-identity", append([]byte(nil), rawToken...), records[index])
		}(index)
	}
	wait.Wait()
	winner := -1
	for index, enrollmentErr := range errorsByIndex {
		if enrollmentErr == nil {
			if winner != -1 {
				t.Fatalf("single-use token enrolled twice: %v", errorsByIndex)
			}
			winner = index
		} else if !errors.Is(enrollmentErr, cloudplane.ErrUnauthorized) {
			t.Fatalf("concurrent enrollment error=%v", enrollmentErr)
		}
	}
	if winner == -1 {
		t.Fatalf("single-use enrollment had no winner: %v", errorsByIndex)
	}
	active := records[winner]
	if err := queue.AuthorizeNodeCertificate(ctx, active.NodeID, active.SerialHex); err != nil {
		t.Fatal(err)
	}
	if err := queue.EnrollNodeCertificate(ctx, active.NodeID, rawToken, records[1-winner]); !errors.Is(err, cloudplane.ErrUnauthorized) {
		t.Fatalf("replayed enrollment token error=%v", err)
	}
	if err := queue.ProvisionNodeEnrollmentTokens(ctx, []nodeidentity.EnrollmentProvision{{NodeID: "node-identity", TokenSHA256: tokenDigest[:], ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	if err := queue.EnrollNodeCertificate(ctx, active.NodeID, rawToken, records[1-winner]); !errors.Is(err, cloudplane.ErrUnauthorized) {
		t.Fatalf("Control restart reactivated consumed enrollment token: %v", err)
	}
	renewed := identityCertificateRecord(active.NodeID, "31223344556677889900aabbccddeeff", 0x33, now.Add(time.Minute), active.SerialHex)
	if err := queue.RenewNodeCertificate(ctx, active.NodeID, active.SerialHex, renewed); err != nil {
		t.Fatal(err)
	}
	for _, serial := range []string{active.SerialHex, renewed.SerialHex} {
		if err := queue.AuthorizeNodeCertificate(ctx, active.NodeID, serial); err != nil {
			t.Fatalf("overlap certificate %s authorization=%v", serial, err)
		}
	}
	task := submitQueueTask(t, ctx, queue, "spiffe://example.test/tenant/acme/project/queue/client/identity", "identity-task", "identity-command", []string{"true"})
	leases, err := queue.Claim(ctx, active.NodeID, "generation-identity-0001", 1)
	if err != nil || len(leases) != 1 || leases[0].Task.ID != task.ID {
		t.Fatalf("identity Task lease=%#v err=%v", leases, err)
	}
	if _, err := queue.Acknowledge(ctx, active.NodeID, "generation-identity-0001", task.ID, leases[0].LeaseToken); err != nil {
		t.Fatal(err)
	}
	if err := queue.RevokeNodeCertificate(ctx, "spiffe://example.test/tenant/platform/project/operations/client/admin", active.NodeID, active.SerialHex); err != nil {
		t.Fatal(err)
	}
	if err := queue.AuthorizeNodeCertificate(ctx, active.NodeID, active.SerialHex); !errors.Is(err, cloudplane.ErrUnauthorized) {
		t.Fatalf("revoked certificate authorization=%v", err)
	}
	if err := queue.AuthorizeNodeCertificate(ctx, active.NodeID, renewed.SerialHex); err != nil {
		t.Fatalf("overlap replacement was incorrectly revoked: %v", err)
	}
	updated, err := queue.InspectTask(ctx, cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, task.ID)
	if err != nil || updated.State != cloudplane.TaskPending {
		t.Fatalf("revocation did not fence current generation Task=%#v err=%v", updated, err)
	}
	var persistedToken []byte
	var tokenState string
	if err := migrator.pool.QueryRow(ctx, `SELECT token_sha256,state FROM zapvm.node_enrollment_tokens WHERE node_id='node-identity'`).Scan(&persistedToken, &tokenState); err != nil || tokenState != "consumed" || !bytes.Equal(persistedToken, tokenDigest[:]) || bytes.Contains(persistedToken, rawToken) {
		t.Fatalf("persisted enrollment token state=%s digest=%x err=%v", tokenState, persistedToken, err)
	}
	replacementToken := sha256.Sum256([]byte("replacement-bootstrap-token-value"))
	if err := queue.ProvisionNodeEnrollmentTokens(ctx, []nodeidentity.EnrollmentProvision{{NodeID: active.NodeID, TokenSHA256: replacementToken[:], ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	if err := queue.ProvisionNodeEnrollmentTokens(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := migrator.pool.QueryRow(ctx, `SELECT state FROM zapvm.node_enrollment_tokens WHERE node_id=$1`, active.NodeID).Scan(&tokenState); err != nil || tokenState != "revoked" {
		t.Fatalf("removed enrollment token state=%s err=%v", tokenState, err)
	}
	expiringToken := sha256.Sum256([]byte("expiring-bootstrap-token-value"))
	if err := queue.ProvisionNodeEnrollmentTokens(ctx, []nodeidentity.EnrollmentProvision{{NodeID: active.NodeID, TokenSHA256: expiringToken[:], ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	currentTime = now.Add(7 * time.Hour)
	if err := queue.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if err := queue.AuthorizeNodeCertificate(ctx, active.NodeID, renewed.SerialHex); !errors.Is(err, cloudplane.ErrUnauthorized) {
		t.Fatalf("expired replacement certificate authorization=%v", err)
	}
	if err := migrator.pool.QueryRow(ctx, `SELECT state FROM zapvm.node_enrollment_tokens WHERE node_id=$1`, active.NodeID).Scan(&tokenState); err != nil || tokenState != "expired" {
		t.Fatalf("expired enrollment token state=%s err=%v", tokenState, err)
	}
	assertNodeIdentityAuditChain(t, ctx, migrator, 9)
}

func prepareNodeIdentityAuthority(t *testing.T, ctx context.Context, migrator *Migrator, queue *Queue, now time.Time) {
	t.Helper()
	transaction, err := migrator.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`SELECT set_config('zapvm.bypass_rls','on',true)`,
		`INSERT INTO zapvm.nodes (id,generation,state,capacity,last_heartbeat,daemon_state,updated_at) VALUES ('node-identity','provisioned-offline','offline',4,$1,'unknown',$1)`,
		`INSERT INTO zapvm.node_scopes (node_id,tenant_id,project_id) VALUES ('node-identity','acme','queue')`,
		`INSERT INTO zapvm.computers (tenant_id,project_id,computer_id,created_at) VALUES ('acme','queue','computer-queue',$1)`,
		`INSERT INTO zapvm.computer_nodes (tenant_id,project_id,computer_id,node_id) VALUES ('acme','queue','computer-queue','node-identity')`,
	} {
		arguments := []any(nil)
		if statement[len(statement)-2:] == "$1" || bytes.Contains([]byte(statement), []byte("$1")) {
			arguments = []any{now}
		}
		if _, err := transaction.Exec(ctx, statement, arguments...); err != nil {
			_ = transaction.Rollback(ctx)
			t.Fatal(err)
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.RegisterNodeWithReport(ctx, "node-identity", "generation-identity-0001", cloudplane.NodeReport{DaemonState: cloudplane.DaemonHealthy}); err != nil {
		t.Fatal(err)
	}
}

func identityCertificateRecord(nodeID, serial string, digestByte byte, issuedAt time.Time, renewedFrom string) nodeidentity.CertificateRecord {
	return nodeidentity.CertificateRecord{NodeID: nodeID, SerialHex: serial, PublicKeySHA256: bytes.Repeat([]byte{digestByte}, sha256.Size), IssuedAt: issuedAt, NotBefore: issuedAt.Add(-time.Minute), NotAfter: issuedAt.Add(6 * time.Hour), RenewedFromSerialHex: renewedFrom}
}

func assertNodeIdentityAuditChain(t *testing.T, ctx context.Context, migrator *Migrator, expected int) {
	t.Helper()
	rows, err := migrator.pool.Query(ctx, `SELECT COALESCE(encode(previous_sha256,'hex'),''),encode(sha256,'hex') FROM zapvm.node_identity_audit ORDER BY sequence`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	previous := ""
	count := 0
	for rows.Next() {
		var linked, digest string
		if err := rows.Scan(&linked, &digest); err != nil {
			t.Fatal(err)
		}
		if linked != previous {
			t.Fatalf("Node identity audit linked=%s expected=%s", linked, previous)
		}
		previous = digest
		count++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if count != expected {
		t.Fatalf("Node identity audit count=%d expected=%d", count, expected)
	}
}
