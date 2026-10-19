package controlpostgres

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"zapvm/internal/cloudplane"
	"zapvm/internal/credential"
	"zapvm/internal/nodeidentity"
)

type nodeIdentityAuditHash struct {
	SchemaVersion   int    `json:"schema_version"`
	Sequence        uint64 `json:"sequence"`
	OccurredAt      string `json:"occurred_at"`
	Action          string `json:"action"`
	NodeID          string `json:"node_id"`
	SerialHex       string `json:"serial_hex,omitempty"`
	PrincipalSHA256 string `json:"principal_sha256"`
	Outcome         string `json:"outcome"`
	PreviousSHA256  string `json:"previous_sha256,omitempty"`
}

func (queue *Queue) ProvisionNodeEnrollmentTokens(ctx context.Context, provisions []nodeidentity.EnrollmentProvision) error {
	if err := queue.validateCall(ctx); err != nil {
		return err
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	seen := make(map[string]struct{}, len(provisions))
	for _, provision := range provisions {
		if !queueIDPattern.MatchString(provision.NodeID) || len(provision.TokenSHA256) != sha256.Size ||
			!provision.ExpiresAt.After(now) || provision.ExpiresAt.After(now.Add(30*24*time.Hour)) {
			return errors.New("PostgreSQL Node enrollment provision is invalid")
		}
		if _, duplicate := seen[provision.NodeID]; duplicate {
			return errors.New("PostgreSQL Node enrollment provision is duplicated")
		}
		seen[provision.NodeID] = struct{}{}
		var existingDigest []byte
		var existingState string
		var existingExpiry time.Time
		err := transaction.QueryRow(ctx, `SELECT token_sha256,state,expires_at FROM zapvm.node_enrollment_tokens WHERE node_id=$1 FOR UPDATE`, provision.NodeID).Scan(&existingDigest, &existingState, &existingExpiry)
		if err == nil && subtle.ConstantTimeCompare(existingDigest, provision.TokenSHA256) == 1 {
			if existingState != "active" {
				// A consumed, revoked, or expired token is terminal. Keeping the
				// same hash in config across a restart must never reactivate it.
				continue
			}
			if existingExpiry.Equal(provision.ExpiresAt) {
				continue
			}
			return errors.New("PostgreSQL active Node enrollment provision changed expiry without rotating token")
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return databaseFailure("lock PostgreSQL Node enrollment provision", err)
		}
		if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.node_enrollment_tokens (node_id,token_sha256,state,issued_at,expires_at)
VALUES ($1,$2,'active',$3,$4)
ON CONFLICT (node_id) DO UPDATE SET token_sha256=EXCLUDED.token_sha256,state='active',issued_at=EXCLUDED.issued_at,
    expires_at=EXCLUDED.expires_at,consumed_at=NULL,revoked_at=NULL`, provision.NodeID, provision.TokenSHA256, now, provision.ExpiresAt); err != nil {
			return databaseFailure("upsert PostgreSQL Node enrollment provision", err)
		}
		if err := appendNodeIdentityAudit(ctx, transaction, now, "token_provision", provision.NodeID, "", "control-provision", "active"); err != nil {
			return err
		}
	}
	rows, err := transaction.Query(ctx, `SELECT node_id FROM zapvm.node_enrollment_tokens WHERE state='active' ORDER BY node_id FOR UPDATE`)
	if err != nil {
		return databaseFailure("lock removed PostgreSQL Node enrollment provisions", err)
	}
	removed := make([]string, 0)
	for rows.Next() {
		var nodeID string
		if err := rows.Scan(&nodeID); err != nil {
			rows.Close()
			return errors.New("decode removed PostgreSQL Node enrollment provision")
		}
		if _, retained := seen[nodeID]; !retained {
			removed = append(removed, nodeID)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read removed PostgreSQL Node enrollment provisions")
	}
	for _, nodeID := range removed {
		if _, err := transaction.Exec(ctx, `UPDATE zapvm.node_enrollment_tokens SET state='revoked',revoked_at=$1 WHERE node_id=$2 AND state='active'`, now, nodeID); err != nil {
			return databaseFailure("revoke removed PostgreSQL Node enrollment provision", err)
		}
		if err := appendNodeIdentityAudit(ctx, transaction, now, "token_revoke", nodeID, "", "control-provision", "revoked"); err != nil {
			return err
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return databaseFailure("commit PostgreSQL Node enrollment provisions", err)
	}
	return nil
}

func (queue *Queue) EnrollNodeCertificate(ctx context.Context, nodeID string, token []byte, record nodeidentity.CertificateRecord) error {
	if err := queue.validateCall(ctx); err != nil {
		return err
	}
	if record.NodeID != nodeID || record.RenewedFromSerialHex != "" || record.Validate() != nil || len(token) < 32 || len(token) > 4096 {
		return cloudplane.ErrUnauthorized
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	var digest []byte
	var state string
	var expiresAt time.Time
	if err := transaction.QueryRow(ctx, `SELECT token_sha256,state,expires_at FROM zapvm.node_enrollment_tokens WHERE node_id=$1 FOR UPDATE`, nodeID).Scan(&digest, &state, &expiresAt); errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.ErrUnauthorized
	} else if err != nil {
		return databaseFailure("lock PostgreSQL Node enrollment token", err)
	}
	candidate := sha256.Sum256(token)
	if state != "active" || !expiresAt.After(now) || subtle.ConstantTimeCompare(digest, candidate[:]) != 1 {
		return cloudplane.ErrUnauthorized
	}
	if err := insertNodeCertificate(ctx, transaction, record); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `UPDATE zapvm.node_enrollment_tokens SET state='consumed',consumed_at=$1 WHERE node_id=$2 AND state='active'`, now, nodeID); err != nil {
		return databaseFailure("consume PostgreSQL Node enrollment token", err)
	}
	if err := appendNodeIdentityAudit(ctx, transaction, now, "certificate_enroll", nodeID, record.SerialHex, "enrollment-token", "active"); err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return databaseFailure("commit PostgreSQL Node enrollment", err)
	}
	return nil
}

func (queue *Queue) RenewNodeCertificate(ctx context.Context, nodeID, currentSerial string, record nodeidentity.CertificateRecord) error {
	if err := queue.validateCall(ctx); err != nil {
		return err
	}
	if record.NodeID != nodeID || record.RenewedFromSerialHex != currentSerial || record.Validate() != nil {
		return cloudplane.ErrFenced
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	var state string
	var notBefore, notAfter time.Time
	if err := transaction.QueryRow(ctx, `SELECT state,not_before,not_after FROM zapvm.node_certificates WHERE serial_hex=$1 AND node_id=$2 FOR UPDATE`, currentSerial, nodeID).Scan(&state, &notBefore, &notAfter); errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.ErrFenced
	} else if err != nil {
		return databaseFailure("lock PostgreSQL renewing Node certificate", err)
	}
	if state != "active" || now.Before(notBefore) || !notAfter.After(now) {
		return cloudplane.ErrFenced
	}
	if err := insertNodeCertificate(ctx, transaction, record); err != nil {
		return err
	}
	if err := appendNodeIdentityAudit(ctx, transaction, now, "certificate_renew", nodeID, record.SerialHex, "node\x00"+nodeID+"\x00"+currentSerial, "active"); err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return databaseFailure("commit PostgreSQL Node certificate renewal", err)
	}
	return nil
}

func (queue *Queue) AuthorizeNodeCertificate(ctx context.Context, nodeID, serialHex string) error {
	if err := queue.validateCall(ctx); err != nil {
		return err
	}
	if !queueIDPattern.MatchString(nodeID) || len(serialHex) != 32 {
		return cloudplane.ErrUnauthorized
	}
	now := queue.now().UTC()
	var authorized bool
	if err := queue.migrator.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM zapvm.node_certificates WHERE node_id=$1 AND serial_hex=$2 AND state='active' AND not_before<=$3 AND not_after>$3)`, nodeID, serialHex, now).Scan(&authorized); err != nil {
		return databaseFailure("authorize PostgreSQL Node certificate", err)
	}
	if !authorized {
		return cloudplane.ErrUnauthorized
	}
	return nil
}

func (queue *Queue) RevokeNodeCertificate(ctx context.Context, principal, nodeID, serialHex string) error {
	if err := queue.validateCall(ctx); err != nil {
		return err
	}
	if !cloudplane.ValidPrincipal(principal) || !queueIDPattern.MatchString(nodeID) || len(serialHex) != 32 {
		return cloudplane.ErrUnauthorized
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	var state string
	if err := transaction.QueryRow(ctx, `SELECT state FROM zapvm.node_certificates WHERE serial_hex=$1 AND node_id=$2 FOR UPDATE`, serialHex, nodeID).Scan(&state); errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.ErrNotFound
	} else if err != nil {
		return databaseFailure("lock PostgreSQL Node certificate revocation", err)
	}
	if state == "revoked" {
		return nil
	}
	if _, err := transaction.Exec(ctx, `UPDATE zapvm.node_certificates SET state='revoked',revoked_at=$1 WHERE serial_hex=$2`, now, serialHex); err != nil {
		return databaseFailure("revoke PostgreSQL Node certificate", err)
	}
	var generation string
	if err := transaction.QueryRow(ctx, `SELECT generation FROM zapvm.nodes WHERE id=$1 FOR UPDATE`, nodeID).Scan(&generation); err != nil {
		return databaseFailure("lock revoked PostgreSQL Node", err)
	}
	if err := queue.fenceGeneration(ctx, transaction, nodeID, generation, now); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `UPDATE zapvm.nodes SET state='offline',in_flight=0,updated_at=$1 WHERE id=$2`, now, nodeID); err != nil {
		return databaseFailure("offline revoked PostgreSQL Node", err)
	}
	if err := appendNodeIdentityAudit(ctx, transaction, now, "certificate_revoke", nodeID, serialHex, principal, "revoked"); err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return databaseFailure("commit PostgreSQL Node certificate revocation", err)
	}
	return nil
}

func (queue *Queue) expireNodeIdentity(ctx context.Context, transaction pgx.Tx, now time.Time) error {
	rows, err := transaction.Query(ctx, `SELECT node_id FROM zapvm.node_enrollment_tokens WHERE state='active' AND expires_at<=$1 ORDER BY node_id FOR UPDATE`, now)
	if err != nil {
		return databaseFailure("lock expired PostgreSQL Node enrollment tokens", err)
	}
	expiredTokens := make([]string, 0)
	for rows.Next() {
		var nodeID string
		if err := rows.Scan(&nodeID); err != nil {
			rows.Close()
			return errors.New("decode expired PostgreSQL Node enrollment token")
		}
		expiredTokens = append(expiredTokens, nodeID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read expired PostgreSQL Node enrollment tokens")
	}
	for _, nodeID := range expiredTokens {
		if _, err := transaction.Exec(ctx, `UPDATE zapvm.node_enrollment_tokens SET state='expired' WHERE node_id=$1 AND state='active'`, nodeID); err != nil {
			return databaseFailure("expire PostgreSQL Node enrollment token", err)
		}
		if err := appendNodeIdentityAudit(ctx, transaction, now, "token_expire", nodeID, "", "control-sweep", "expired"); err != nil {
			return err
		}
	}

	rows, err = transaction.Query(ctx, `SELECT node_id,serial_hex FROM zapvm.node_certificates WHERE state='active' AND not_after<=$1 ORDER BY node_id,serial_hex FOR UPDATE`, now)
	if err != nil {
		return databaseFailure("lock expired PostgreSQL Node certificates", err)
	}
	type expiredCertificate struct{ nodeID, serialHex string }
	expiredCertificates := make([]expiredCertificate, 0)
	for rows.Next() {
		var certificate expiredCertificate
		if err := rows.Scan(&certificate.nodeID, &certificate.serialHex); err != nil {
			rows.Close()
			return errors.New("decode expired PostgreSQL Node certificate")
		}
		expiredCertificates = append(expiredCertificates, certificate)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read expired PostgreSQL Node certificates")
	}
	for _, certificate := range expiredCertificates {
		if _, err := transaction.Exec(ctx, `UPDATE zapvm.node_certificates SET state='expired' WHERE serial_hex=$1 AND state='active'`, certificate.serialHex); err != nil {
			return databaseFailure("expire PostgreSQL Node certificate", err)
		}
		if err := appendNodeIdentityAudit(ctx, transaction, now, "certificate_expire", certificate.nodeID, certificate.serialHex, "control-sweep", "expired"); err != nil {
			return err
		}
	}
	return nil
}

func insertNodeCertificate(ctx context.Context, transaction pgx.Tx, record nodeidentity.CertificateRecord) error {
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.node_certificates
    (serial_hex,node_id,public_key_sha256,state,issued_at,not_before,not_after,renewed_from_serial_hex)
VALUES ($1,$2,$3,'active',$4,$5,$6,$7)`, record.SerialHex, record.NodeID, record.PublicKeySHA256,
		record.IssuedAt, record.NotBefore, record.NotAfter, optionalString(record.RenewedFromSerialHex)); err != nil {
		return databaseFailure("insert PostgreSQL Node certificate", err)
	}
	return nil
}

func appendNodeIdentityAudit(ctx context.Context, transaction pgx.Tx, now time.Time, action, nodeID, serialHex, principal, outcome string) error {
	principalDigest := sha256.Sum256([]byte(principal))
	var sequence int64
	if err := transaction.QueryRow(ctx, `SELECT node_identity_audit_sequence FROM zapvm.control_state WHERE singleton FOR UPDATE`).Scan(&sequence); err != nil {
		return databaseFailure("lock PostgreSQL Node identity audit sequence", err)
	}
	var previous []byte
	err := transaction.QueryRow(ctx, `SELECT sha256 FROM zapvm.node_identity_audit WHERE sequence=$1`, sequence).Scan(&previous)
	if sequence == 0 && errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	if err != nil || (sequence != 0 && len(previous) != sha256.Size) {
		return errors.New("PostgreSQL Node identity audit chain is incomplete")
	}
	record := nodeIdentityAuditHash{SchemaVersion: 1, Sequence: uint64(sequence + 1), OccurredAt: now.UTC().Format(time.RFC3339Nano), Action: action, NodeID: nodeID, SerialHex: serialHex, PrincipalSHA256: hex.EncodeToString(principalDigest[:]), Outcome: outcome}
	if len(previous) != 0 {
		record.PreviousSHA256 = hex.EncodeToString(previous)
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return errors.New("encode PostgreSQL Node identity audit record")
	}
	digest := sha256.Sum256(encoded)
	credential.ZeroBytes(encoded)
	if _, err := transaction.Exec(ctx, `UPDATE zapvm.control_state SET node_identity_audit_sequence=$1,updated_at=$2 WHERE singleton`, sequence+1, now); err != nil {
		return databaseFailure("advance PostgreSQL Node identity audit sequence", err)
	}
	if _, err := transaction.Exec(ctx, `INSERT INTO zapvm.node_identity_audit (sequence,schema_version,occurred_at,action,node_id,serial_hex,principal_sha256,outcome,previous_sha256,sha256) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9)`, sequence+1, now, action, nodeID, optionalString(serialHex), principalDigest[:], outcome, previous, digest[:]); err != nil {
		return databaseFailure("insert PostgreSQL Node identity audit record", err)
	}
	return nil
}
