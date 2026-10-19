package controlpostgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"

	"zapvm/internal/cloudplane"
)

var auditOutcomePattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,127}$`)

type auditInput struct {
	action, nodeID, taskID, operationID, artifactID, outcome, principal string
	scope                                                               cloudplane.Scope
}

func appendAudit(ctx context.Context, transaction pgx.Tx, now time.Time, input auditInput) (cloudplane.AuditRecord, error) {
	now = now.UTC().Truncate(time.Microsecond)
	if !queueNamePattern.MatchString(input.action) || !auditOutcomePattern.MatchString(input.outcome) ||
		(input.scope != (cloudplane.Scope{}) && input.scope.Validate() != nil) ||
		(input.nodeID != "" && !queueIDPattern.MatchString(input.nodeID)) ||
		(input.taskID != "" && !queueIDPattern.MatchString(input.taskID)) ||
		(input.operationID != "" && !queueIDPattern.MatchString(input.operationID)) ||
		(input.artifactID != "" && !queueIDPattern.MatchString(input.artifactID)) ||
		(input.principal != "" && !cloudplane.ValidPrincipal(input.principal)) {
		return cloudplane.AuditRecord{}, errors.New("PostgreSQL audit input is invalid")
	}
	var sequence int64
	if err := transaction.QueryRow(ctx, `SELECT audit_sequence FROM zapvm.control_state WHERE singleton FOR UPDATE`).Scan(&sequence); err != nil {
		return cloudplane.AuditRecord{}, databaseFailure("lock PostgreSQL audit sequence", err)
	}
	var previous []byte
	err := transaction.QueryRow(ctx, `SELECT sha256 FROM zapvm.audit_records WHERE sequence=$1`, sequence).Scan(&previous)
	if sequence == 0 && errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	if err != nil {
		return cloudplane.AuditRecord{}, databaseFailure("read PostgreSQL audit chain", err)
	}
	if sequence != 0 && len(previous) != sha256.Size {
		return cloudplane.AuditRecord{}, errors.New("PostgreSQL audit chain is incomplete")
	}
	record := cloudplane.AuditRecord{
		SchemaVersion: cloudplane.SchemaVersion, Sequence: uint64(sequence + 1), Timestamp: now.UTC().Format(time.RFC3339Nano),
		Action: input.action, TenantID: input.scope.TenantID, ProjectID: input.scope.ProjectID, NodeID: input.nodeID,
		TaskID: input.taskID, OperationID: input.operationID, ArtifactID: input.artifactID, Outcome: input.outcome,
	}
	if len(previous) != 0 {
		record.PreviousSHA256 = hex.EncodeToString(previous)
	}
	if input.principal != "" {
		digest := sha256.Sum256([]byte(input.principal))
		record.PrincipalSHA256 = hex.EncodeToString(digest[:])
	}
	digestHex, err := cloudplane.HashAuditRecord(record)
	if err != nil {
		return cloudplane.AuditRecord{}, errors.New("hash PostgreSQL audit record")
	}
	digest, _ := hex.DecodeString(digestHex)
	if _, err := transaction.Exec(ctx, `UPDATE zapvm.control_state SET audit_sequence=$1,updated_at=$2 WHERE singleton`, sequence+1, now); err != nil {
		return cloudplane.AuditRecord{}, databaseFailure("advance PostgreSQL audit sequence", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.audit_records
    (sequence,schema_version,occurred_at,action,tenant_id,project_id,node_id,task_id,operation_id,artifact_id,principal_sha256,outcome,previous_sha256,sha256)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
		sequence+1, record.SchemaVersion, now, record.Action, optionalString(record.TenantID), optionalString(record.ProjectID),
		optionalString(record.NodeID), optionalString(record.TaskID), optionalString(record.OperationID), optionalString(record.ArtifactID),
		optionalDigest(record.PrincipalSHA256), record.Outcome, previous, digest); err != nil {
		return cloudplane.AuditRecord{}, databaseFailure("insert PostgreSQL audit record", err)
	}
	record.SHA256 = digestHex
	return record, nil
}

func optionalDigest(value string) any {
	if value == "" {
		return nil
	}
	decoded, _ := hex.DecodeString(value)
	return decoded
}
