package controlpostgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"zapvm/internal/cloudplane"
	"zapvm/internal/credentialkms"
	"zapvm/internal/daemonrpc"
)

func TestPostgreSQLCredentialBrokerOneTimeBindingRotationAndNoPlaintext(t *testing.T) {
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
	defer func() {
		if err := resetQueueIntegrationState(context.Background(), migrator); err != nil {
			t.Errorf("reset PostgreSQL Credential integration state: %v", err)
		}
	}()

	wrapper, err := credentialkms.NewStaticKeyWrapper(bytes.Repeat([]byte{0x91}, 32), "integration/credential-kek", "v1")
	if err != nil {
		t.Fatal(err)
	}
	defer wrapper.Close()
	envelopes, err := credentialkms.New(wrapper)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	queue, err := NewQueue(migrator, QueueOptions{
		HeartbeatTTL: 10 * time.Minute, LeaseTTL: 2 * time.Minute, CredentialCapabilityTTL: 30 * time.Second,
		CredentialBroker: envelopes, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	const nodeID = "node-credential"
	const generation = "generation-credential-0001"
	const principal = "spiffe://example.test/tenant/acme/project/credential/client/integration"
	scope := cloudplane.Scope{TenantID: "acme", ProjectID: "credential"}
	prepareCredentialIntegrationAuthority(t, ctx, migrator, now, nodeID, generation, scope)
	firstSecret := []byte("credential-version-one-private-value")
	secondSecret := []byte("credential-version-two-private-value")
	descriptor, err := queue.PutCredential(ctx, principal, scope, "model-key", firstSecret)
	if err != nil || descriptor.Version != 1 || descriptor.State != "active" {
		t.Fatalf("first Credential descriptor=%#v err=%v", descriptor, err)
	}

	first := submitCredentialIntegrationTask(t, ctx, queue, principal, scope, "credential-task-one")
	firstLease := claimCredentialIntegrationTask(t, ctx, queue, nodeID, generation, first.ID)
	assertCapabilityNotPersistedInPlaintext(t, ctx, migrator, firstSecret, firstLease)
	if _, err := queue.Acknowledge(ctx, nodeID, generation, first.ID, firstLease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	rotated, err := queue.PutCredential(ctx, principal, scope, "model-key", secondSecret)
	if err != nil || rotated.Version != 2 {
		t.Fatalf("rotated Credential=%#v err=%v", rotated, err)
	}
	firstBundle, err := queue.RedeemCredentialCapability(ctx, nodeID, generation, first.ID, firstLease.LeaseToken, *firstLease.CredentialCapability)
	if err != nil || !bytes.Equal(firstBundle.Values["model-key"], firstSecret) {
		t.Fatalf("pinned first Credential bundle=%q err=%v", firstBundle.Values["model-key"], err)
	}
	firstBundle.Destroy()
	if _, err := queue.RedeemCredentialCapability(ctx, nodeID, generation, first.ID, firstLease.LeaseToken, *firstLease.CredentialCapability); !errors.Is(err, cloudplane.ErrFenced) {
		t.Fatalf("replayed Credential capability error=%v", err)
	}
	if _, err := queue.Complete(ctx, nodeID, generation, first.ID, firstLease.LeaseToken, cloudplane.Completion{Succeeded: true}); err != nil {
		t.Fatal(err)
	}

	second := submitCredentialIntegrationTask(t, ctx, queue, principal, scope, "credential-task-two")
	secondLease := claimCredentialIntegrationTask(t, ctx, queue, nodeID, generation, second.ID)
	if _, err := queue.Acknowledge(ctx, nodeID, generation, second.ID, secondLease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	for name, attempt := range map[string]func() error{
		"wrong generation": func() error {
			_, err := queue.RedeemCredentialCapability(ctx, nodeID, "generation-credential-wrong", second.ID, secondLease.LeaseToken, *secondLease.CredentialCapability)
			return err
		},
		"wrong Task": func() error {
			_, err := queue.RedeemCredentialCapability(ctx, nodeID, generation, first.ID, secondLease.LeaseToken, *secondLease.CredentialCapability)
			return err
		},
		"wrong lease": func() error {
			_, err := queue.RedeemCredentialCapability(ctx, nodeID, generation, second.ID, firstLease.LeaseToken, *secondLease.CredentialCapability)
			return err
		},
	} {
		if err := attempt(); !errors.Is(err, cloudplane.ErrFenced) {
			t.Fatalf("%s Credential binding error=%v", name, err)
		}
	}
	secondBundle, err := queue.RedeemCredentialCapability(ctx, nodeID, generation, second.ID, secondLease.LeaseToken, *secondLease.CredentialCapability)
	if err != nil || !bytes.Equal(secondBundle.Values["model-key"], secondSecret) {
		t.Fatalf("second Credential bundle=%q err=%v", secondBundle.Values["model-key"], err)
	}
	secondBundle.Destroy()
	if _, err := queue.Complete(ctx, nodeID, generation, second.ID, secondLease.LeaseToken, cloudplane.Completion{Succeeded: true}); err != nil {
		t.Fatal(err)
	}

	concurrent := submitCredentialIntegrationTask(t, ctx, queue, principal, scope, "credential-task-concurrent")
	concurrentLease := claimCredentialIntegrationTask(t, ctx, queue, nodeID, generation, concurrent.ID)
	if _, err := queue.Acknowledge(ctx, nodeID, generation, concurrent.ID, concurrentLease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	var wait sync.WaitGroup
	for index := 0; index < 2; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			bundle, err := queue.RedeemCredentialCapability(ctx, nodeID, generation, concurrent.ID, concurrentLease.LeaseToken, *concurrentLease.CredentialCapability)
			bundle.Destroy()
			results <- err
		}()
	}
	wait.Wait()
	close(results)
	succeeded, fenced := 0, 0
	for err := range results {
		if err == nil {
			succeeded++
		} else if errors.Is(err, cloudplane.ErrFenced) {
			fenced++
		} else {
			t.Fatalf("concurrent Credential redemption error=%v", err)
		}
	}
	if succeeded != 1 || fenced != 1 {
		t.Fatalf("concurrent Credential redemptions succeeded=%d fenced=%d", succeeded, fenced)
	}
	if _, err := queue.Complete(ctx, nodeID, generation, concurrent.ID, concurrentLease.LeaseToken, cloudplane.Completion{Succeeded: true}); err != nil {
		t.Fatal(err)
	}
	unredeemed := submitCredentialIntegrationTask(t, ctx, queue, principal, scope, "credential-task-terminal")
	unredeemedLease := claimCredentialIntegrationTask(t, ctx, queue, nodeID, generation, unredeemed.ID)
	if _, err := queue.Acknowledge(ctx, nodeID, generation, unredeemed.ID, unredeemedLease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Complete(ctx, nodeID, generation, unredeemed.ID, unredeemedLease.LeaseToken, cloudplane.Completion{Succeeded: false, FailureCode: "execution_failed"}); err != nil {
		t.Fatal(err)
	}
	var revokedState string
	if err := migrator.pool.QueryRow(ctx, `SELECT state FROM zapvm.credential_capabilities WHERE capability_id=$1`, unredeemedLease.CredentialCapability.ID).Scan(&revokedState); err != nil || revokedState != "revoked" {
		t.Fatalf("terminal Credential capability state=%q err=%v", revokedState, err)
	}

	expiring := submitCredentialIntegrationTask(t, ctx, queue, principal, scope, "credential-task-expiring")
	expiringLease := claimCredentialIntegrationTask(t, ctx, queue, nodeID, generation, expiring.ID)
	if _, err := queue.Acknowledge(ctx, nodeID, generation, expiring.ID, expiringLease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	expiredQueue, err := NewQueue(migrator, QueueOptions{
		HeartbeatTTL: 10 * time.Minute, LeaseTTL: 2 * time.Minute, CredentialCapabilityTTL: 30 * time.Second,
		CredentialBroker: envelopes, Now: func() time.Time { return now.Add(31 * time.Second) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := expiredQueue.RedeemCredentialCapability(ctx, nodeID, generation, expiring.ID, expiringLease.LeaseToken, *expiringLease.CredentialCapability); !errors.Is(err, cloudplane.ErrFenced) {
		t.Fatalf("expired Credential capability error=%v", err)
	}
	var expiredState string
	if err := migrator.pool.QueryRow(ctx, `SELECT state FROM zapvm.credential_capabilities WHERE capability_id=$1`, expiringLease.CredentialCapability.ID).Scan(&expiredState); err != nil || expiredState != "expired" {
		t.Fatalf("expired Credential state=%q err=%v", expiredState, err)
	}
	if _, err := queue.Complete(ctx, nodeID, generation, expiring.ID, expiringLease.LeaseToken, cloudplane.Completion{Succeeded: false, FailureCode: "credential_expired"}); err != nil {
		t.Fatal(err)
	}

	fencedTask := submitCredentialIntegrationTask(t, ctx, queue, principal, scope, "credential-task-generation")
	fencedLease := claimCredentialIntegrationTask(t, ctx, queue, nodeID, generation, fencedTask.ID)
	if _, err := queue.Acknowledge(ctx, nodeID, generation, fencedTask.ID, fencedLease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	const nextGeneration = "generation-credential-0002"
	if _, err := queue.RegisterNodeWithReport(ctx, nodeID, nextGeneration, cloudplane.NodeReport{DaemonState: cloudplane.DaemonHealthy}); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.RedeemCredentialCapability(ctx, nodeID, generation, fencedTask.ID, fencedLease.LeaseToken, *fencedLease.CredentialCapability); !errors.Is(err, cloudplane.ErrFenced) {
		t.Fatalf("old-generation Credential capability error=%v", err)
	}
	newGenerationLease := claimCredentialIntegrationTask(t, ctx, queue, nodeID, nextGeneration, fencedTask.ID)
	if _, err := queue.Acknowledge(ctx, nodeID, nextGeneration, fencedTask.ID, newGenerationLease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	newGenerationBundle, err := queue.RedeemCredentialCapability(ctx, nodeID, nextGeneration, fencedTask.ID, newGenerationLease.LeaseToken, *newGenerationLease.CredentialCapability)
	if err != nil || !bytes.Equal(newGenerationBundle.Values["model-key"], secondSecret) {
		t.Fatalf("new-generation Credential bundle=%q err=%v", newGenerationBundle.Values["model-key"], err)
	}
	newGenerationBundle.Destroy()

	assertCredentialAuditChain(t, ctx, migrator)
}

func prepareCredentialIntegrationAuthority(t *testing.T, ctx context.Context, migrator *Migrator, now time.Time, nodeID, generation string, scope cloudplane.Scope) {
	t.Helper()
	transaction, err := migrator.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO zapvm.nodes (id,generation,state,capacity,last_heartbeat,daemon_state,updated_at) VALUES ($1,$2,'online',8,$3,'healthy',$3)`, []any{nodeID, generation, now}},
		{`INSERT INTO zapvm.node_scopes (node_id,tenant_id,project_id) VALUES ($1,$2,$3)`, []any{nodeID, scope.TenantID, scope.ProjectID}},
		{`INSERT INTO zapvm.computers (tenant_id,project_id,computer_id,created_at) VALUES ($1,$2,'computer-credential',$3)`, []any{scope.TenantID, scope.ProjectID, now}},
		{`INSERT INTO zapvm.computer_nodes (tenant_id,project_id,computer_id,node_id) VALUES ($1,$2,'computer-credential',$3)`, []any{scope.TenantID, scope.ProjectID, nodeID}},
	}
	for _, statement := range statements {
		if _, err := transaction.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func submitCredentialIntegrationTask(t *testing.T, ctx context.Context, queue *Queue, principal string, scope cloudplane.Scope, id string) cloudplane.Task {
	t.Helper()
	payload, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
		ID: id, ComputerID: "computer-credential",
		Command: daemonrpc.Command{ID: "command-" + id, SessionID: "session-" + id, Argv: []string{"/bin/true"}, CredentialIDs: []string{"model-key"}, TimeoutMillis: 60000},
	})
	if err != nil {
		t.Fatal(err)
	}
	task, created, err := queue.Submit(ctx, principal, cloudplane.SubmitRequest{
		ID: id, Scope: scope, ComputerID: "computer-credential", Payload: payload, CredentialIDs: []string{"model-key"},
	})
	if err != nil || !created {
		t.Fatalf("submit Credential Task=%#v created=%t err=%v", task, created, err)
	}
	return task
}

func claimCredentialIntegrationTask(t *testing.T, ctx context.Context, queue *Queue, nodeID, generation, taskID string) cloudplane.Lease {
	t.Helper()
	leases, err := queue.Claim(ctx, nodeID, generation, 1)
	if err != nil || len(leases) != 1 || leases[0].Task.ID != taskID || leases[0].CredentialCapability == nil || len(leases[0].CredentialCapability.Secret) != 32 {
		t.Fatalf("claim Credential Task %q leases=%#v err=%v", taskID, leases, err)
	}
	return leases[0]
}

func assertCapabilityNotPersistedInPlaintext(t *testing.T, ctx context.Context, migrator *Migrator, plaintext []byte, lease cloudplane.Lease) {
	t.Helper()
	var wrapped, nonce, ciphertext, aad, secretDigest []byte
	if err := migrator.pool.QueryRow(ctx, `SELECT wrapped_data_key,nonce,ciphertext,aad_sha256 FROM zapvm.credential_envelopes WHERE tenant_id='acme' AND project_id='credential' AND credential_id='model-key' AND version=1`).Scan(&wrapped, &nonce, &ciphertext, &aad); err != nil {
		t.Fatal(err)
	}
	if err := migrator.pool.QueryRow(ctx, `SELECT secret_sha256 FROM zapvm.credential_capabilities WHERE capability_id=$1`, lease.CredentialCapability.ID).Scan(&secretDigest); err != nil {
		t.Fatal(err)
	}
	for label, persisted := range map[string][]byte{"wrapped": wrapped, "nonce": nonce, "ciphertext": ciphertext, "aad": aad, "capability digest": secretDigest} {
		if bytes.Contains(persisted, plaintext) || bytes.Contains(persisted, lease.CredentialCapability.Secret) {
			t.Fatalf("%s persisted Credential or capability plaintext", label)
		}
	}
	secretHash := sha256RawBytes(lease.CredentialCapability.Secret)
	if hex.EncodeToString(secretDigest) != hex.EncodeToString(secretHash) {
		t.Fatal("persisted Credential capability digest differs")
	}
}

func sha256RawBytes(value []byte) []byte {
	digest := sha256.Sum256(value)
	return digest[:]
}

func assertCredentialAuditChain(t *testing.T, ctx context.Context, migrator *Migrator) {
	t.Helper()
	rows, err := migrator.pool.Query(ctx, `SELECT COALESCE(encode(previous_sha256,'hex'),''),encode(sha256,'hex'),action FROM zapvm.credential_access_audit ORDER BY sequence`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	previous := ""
	actions := make(map[string]int)
	for rows.Next() {
		var linked, digest, action string
		if err := rows.Scan(&linked, &digest, &action); err != nil {
			t.Fatal(err)
		}
		if linked != previous {
			t.Fatalf("Credential audit chain linked=%s expected=%s", linked, previous)
		}
		previous = digest
		actions[action]++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"credential_create", "credential_rotate", "capability_issue", "capability_redeem", "capability_expire", "capability_revoke"} {
		if actions[action] == 0 {
			t.Fatalf("Credential audit action %q is missing: %#v", action, actions)
		}
	}
}
