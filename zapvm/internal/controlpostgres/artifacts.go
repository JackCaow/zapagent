package controlpostgres

import (
	"context"
	"encoding/hex"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"

	"zapvm/internal/cloudplane"
	"zapvm/internal/daemonrpc"
)

const (
	postgresMaximumArtifacts          = 10000
	postgresMaximumArtifactsPerTask   = 100
	postgresMaximumArtifactsPerScope  = 1000
	postgresArtifactMetadataRetention = 7 * 24 * time.Hour
)

func (queue *Queue) RegisterArtifact(ctx context.Context, nodeID, generation, taskID, leaseToken string, request cloudplane.ArtifactRegistrationRequest) (cloudplane.Artifact, bool, error) {
	if err := queue.validateAuthority(ctx, nodeID, generation, taskID, leaseToken); err != nil {
		return cloudplane.Artifact{}, false, err
	}
	normalized, name, err := cloudplane.NormalizeArtifactRegistrationRequest(request)
	if err != nil {
		return cloudplane.Artifact{}, false, err
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.Artifact{}, false, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	if err := queue.expireArtifacts(ctx, transaction, now); err != nil {
		return cloudplane.Artifact{}, false, err
	}
	task, sessionID, err := queue.requireArtifactLease(ctx, transaction, now, nodeID, generation, taskID, leaseToken)
	if err != nil {
		return cloudplane.Artifact{}, false, err
	}
	if task.State != cloudplane.TaskRunning && task.State != cloudplane.TaskCanceling {
		return cloudplane.Artifact{}, false, cloudplane.ErrConflict
	}
	if _, err := transaction.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "artifact|"+normalized.ID); err != nil {
		return cloudplane.Artifact{}, false, databaseFailure("lock PostgreSQL Artifact idempotency", err)
	}
	existing, err := scanQueueArtifact(transaction.QueryRow(ctx, `SELECT `+queueArtifactColumns+` FROM zapvm.artifacts WHERE id=$1 FOR UPDATE`, normalized.ID))
	if err == nil {
		if artifactRegistrationMatches(existing, task, sessionID, normalized, name) {
			if err := transaction.Commit(ctx); err != nil {
				return cloudplane.Artifact{}, false, databaseFailure("commit PostgreSQL duplicate Artifact registration", err)
			}
			return existing, false, nil
		}
		return cloudplane.Artifact{}, false, cloudplane.ErrConflict
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.Artifact{}, false, databaseFailure("inspect PostgreSQL duplicate Artifact", err)
	}
	if _, err := transaction.Exec(ctx, `SELECT audit_sequence FROM zapvm.control_state WHERE singleton FOR UPDATE`); err != nil {
		return cloudplane.Artifact{}, false, databaseFailure("lock PostgreSQL Artifact quota", err)
	}
	var total, perTask, perScope int
	var taskBytes, scopeBytes int64
	if err := transaction.QueryRow(ctx, `
SELECT count(*),
       count(*) FILTER (WHERE task_id=$1 AND state<>'expired'),
       count(*) FILTER (WHERE tenant_id=$2 AND project_id=$3 AND state<>'expired'),
       COALESCE(sum(size_bytes) FILTER (WHERE task_id=$1 AND state<>'expired'),0),
       COALESCE(sum(size_bytes) FILTER (WHERE tenant_id=$2 AND project_id=$3 AND state<>'expired'),0)
FROM zapvm.artifacts`, task.ID, task.TenantID, task.ProjectID).Scan(&total, &perTask, &perScope, &taskBytes, &scopeBytes); err != nil {
		return cloudplane.Artifact{}, false, databaseFailure("count PostgreSQL Artifact quota", err)
	}
	var workspaceBytes uint64
	if err := transaction.QueryRow(ctx, `SELECT COALESCE((SELECT artifact_bytes FROM zapvm.workspace_quotas WHERE tenant_id=$1 AND project_id=$2),$3)`, task.TenantID, task.ProjectID, queue.artifactBytesPerScope).Scan(&workspaceBytes); err != nil {
		return cloudplane.Artifact{}, false, databaseFailure("read PostgreSQL Workspace Artifact quota", err)
	}
	if workspaceBytes < queue.artifactBytesPerScope {
		// A Workspace may choose a stricter product quota than the global
		// storage guard. The global limit remains the absolute upper bound.
		queueScopeLimit := workspaceBytes
		if uint64(scopeBytes) > queueScopeLimit || normalized.Size > queueScopeLimit-uint64(scopeBytes) {
			return cloudplane.Artifact{}, false, cloudplane.ErrQuotaReached
		}
	}
	if total >= postgresMaximumArtifacts || perTask >= postgresMaximumArtifactsPerTask || perScope >= postgresMaximumArtifactsPerScope ||
		taskBytes < 0 || scopeBytes < 0 || uint64(taskBytes) > queue.artifactBytesPerTask || uint64(scopeBytes) > queue.artifactBytesPerScope ||
		normalized.Size > queue.artifactBytesPerTask-uint64(taskBytes) || normalized.Size > queue.artifactBytesPerScope-uint64(scopeBytes) {
		return cloudplane.Artifact{}, false, cloudplane.ErrQuotaReached
	}
	audit, err := appendAudit(ctx, transaction, now, auditInput{
		action: "artifact_register", scope: task.Scope(), nodeID: nodeID, taskID: task.ID, artifactID: normalized.ID, outcome: cloudplane.ArtifactPending,
	})
	if err != nil {
		return cloudplane.Artifact{}, false, err
	}
	digest, _ := hex.DecodeString(normalized.SHA256)
	row := transaction.QueryRow(ctx, `
INSERT INTO zapvm.artifacts
    (id,tenant_id,project_id,computer_id,session_id,task_id,path,name,content_type,size_bytes,sha256,state,
     retention_seconds,created_at,updated_at,expires_at,created_sequence,registered_node_id,registered_node_generation)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13,$13,$14,$15,$16,$17)
RETURNING `+queueArtifactColumns,
		normalized.ID, task.TenantID, task.ProjectID, task.ComputerID, sessionID, task.ID, normalized.Path, name,
		normalized.ContentType, int64(normalized.Size), digest, int64(normalized.RetentionSeconds), now,
		now.Add(time.Duration(normalized.RetentionSeconds)*time.Second), int64(audit.Sequence), nodeID, generation)
	artifact, err := scanQueueArtifact(row)
	if err != nil {
		return cloudplane.Artifact{}, false, databaseFailure("insert PostgreSQL Artifact", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.Artifact{}, false, databaseFailure("commit PostgreSQL Artifact registration", err)
	}
	return artifact, true, nil
}

func (queue *Queue) InspectAgentArtifact(ctx context.Context, scope cloudplane.Scope, artifactID string) (cloudplane.Artifact, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.Artifact{}, err
	}
	if scope.Validate() != nil || !queueIDPattern.MatchString(artifactID) {
		return cloudplane.Artifact{}, cloudplane.ErrNotFound
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.Artifact{}, err
	}
	defer rollbackBounded(transaction)
	if err := queue.expireArtifacts(ctx, transaction, queue.now().UTC().Truncate(time.Microsecond)); err != nil {
		return cloudplane.Artifact{}, err
	}
	artifact, err := scanQueueArtifact(transaction.QueryRow(ctx, `SELECT `+queueArtifactColumns+` FROM zapvm.artifacts WHERE id=$1 AND tenant_id=$2 AND project_id=$3`, artifactID, scope.TenantID, scope.ProjectID))
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.Artifact{}, cloudplane.ErrNotFound
	}
	if err != nil {
		return cloudplane.Artifact{}, databaseFailure("inspect PostgreSQL Artifact", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.Artifact{}, databaseFailure("commit PostgreSQL Artifact inspection", err)
	}
	return artifact, nil
}

func (queue *Queue) PrepareArtifactUpload(ctx context.Context, nodeID, generation, taskID, leaseToken, artifactID string) (cloudplane.Artifact, bool, error) {
	if err := queue.validateAuthority(ctx, nodeID, generation, taskID, leaseToken); err != nil || !queueIDPattern.MatchString(artifactID) {
		if err != nil {
			return cloudplane.Artifact{}, false, err
		}
		return cloudplane.Artifact{}, false, cloudplane.ErrNotFound
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.Artifact{}, false, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	if err := queue.expireArtifacts(ctx, transaction, now); err != nil {
		return cloudplane.Artifact{}, false, err
	}
	task, _, err := queue.requireArtifactLease(ctx, transaction, now, nodeID, generation, taskID, leaseToken)
	if err != nil {
		return cloudplane.Artifact{}, false, err
	}
	artifact, err := queue.lockTaskArtifact(ctx, transaction, task, artifactID)
	if err != nil {
		return cloudplane.Artifact{}, false, err
	}
	if artifact.ObjectKey == "" && (artifact.State == cloudplane.ArtifactPending || artifact.State == cloudplane.ArtifactFailed) {
		artifact.ObjectKey = cloudplane.ArtifactObjectKeyFor(artifact)
		artifact, err = scanQueueArtifact(transaction.QueryRow(ctx, `UPDATE zapvm.artifacts SET object_key=$1,updated_at=$2 WHERE id=$3 RETURNING `+queueArtifactColumns, artifact.ObjectKey, now, artifact.ID))
		if err != nil {
			return cloudplane.Artifact{}, false, databaseFailure("prepare PostgreSQL Artifact upload", err)
		}
	}
	upload := artifact.State == cloudplane.ArtifactPending || artifact.State == cloudplane.ArtifactFailed
	if !upload && artifact.State != cloudplane.ArtifactAvailable {
		return cloudplane.Artifact{}, false, cloudplane.ErrConflict
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.Artifact{}, false, databaseFailure("commit PostgreSQL Artifact upload preparation", err)
	}
	return artifact, upload, nil
}

func (queue *Queue) CompleteArtifactUpload(ctx context.Context, nodeID, generation, taskID, leaseToken, artifactID, objectKey string) (cloudplane.Artifact, error) {
	if err := queue.validateAuthority(ctx, nodeID, generation, taskID, leaseToken); err != nil {
		return cloudplane.Artifact{}, err
	}
	if !queueIDPattern.MatchString(artifactID) || !cloudplane.ValidArtifactObjectKey(objectKey) {
		return cloudplane.Artifact{}, errors.New("PostgreSQL Artifact object key is invalid")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.Artifact{}, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	if err := queue.expireArtifacts(ctx, transaction, now); err != nil {
		return cloudplane.Artifact{}, err
	}
	task, _, err := queue.requireArtifactLease(ctx, transaction, now, nodeID, generation, taskID, leaseToken)
	if err != nil {
		return cloudplane.Artifact{}, err
	}
	artifact, err := queue.lockTaskArtifact(ctx, transaction, task, artifactID)
	if err != nil {
		return cloudplane.Artifact{}, err
	}
	if artifact.State == cloudplane.ArtifactAvailable {
		if artifact.ObjectKey != objectKey {
			return cloudplane.Artifact{}, cloudplane.ErrConflict
		}
		if err := transaction.Commit(ctx); err != nil {
			return cloudplane.Artifact{}, databaseFailure("commit PostgreSQL duplicate Artifact upload", err)
		}
		return artifact, nil
	}
	if (artifact.State != cloudplane.ArtifactPending && artifact.State != cloudplane.ArtifactFailed) || (artifact.ObjectKey != "" && artifact.ObjectKey != objectKey) {
		return cloudplane.Artifact{}, cloudplane.ErrConflict
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: "artifact_upload", scope: artifact.Scope(), nodeID: nodeID, taskID: task.ID, artifactID: artifact.ID, outcome: cloudplane.ArtifactAvailable}); err != nil {
		return cloudplane.Artifact{}, err
	}
	artifact, err = scanQueueArtifact(transaction.QueryRow(ctx, `
UPDATE zapvm.artifacts SET state='available',object_key=$1,available_at=$2,updated_at=$2,failure_code=NULL
WHERE id=$3 RETURNING `+queueArtifactColumns, objectKey, now, artifact.ID))
	if err != nil {
		return cloudplane.Artifact{}, databaseFailure("complete PostgreSQL Artifact upload", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.Artifact{}, databaseFailure("commit PostgreSQL Artifact upload", err)
	}
	return artifact, nil
}

func (queue *Queue) FailArtifactUpload(ctx context.Context, nodeID, generation, taskID, leaseToken, artifactID, failureCode string) (cloudplane.Artifact, error) {
	if err := queue.validateAuthority(ctx, nodeID, generation, taskID, leaseToken); err != nil {
		return cloudplane.Artifact{}, err
	}
	if !queueIDPattern.MatchString(artifactID) || !queueFailurePattern.MatchString(failureCode) {
		return cloudplane.Artifact{}, errors.New("PostgreSQL Artifact upload failure is invalid")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.Artifact{}, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	if err := queue.expireArtifacts(ctx, transaction, now); err != nil {
		return cloudplane.Artifact{}, err
	}
	task, _, err := queue.requireArtifactLease(ctx, transaction, now, nodeID, generation, taskID, leaseToken)
	if err != nil {
		return cloudplane.Artifact{}, err
	}
	artifact, err := queue.lockTaskArtifact(ctx, transaction, task, artifactID)
	if err != nil {
		return cloudplane.Artifact{}, err
	}
	if artifact.State == cloudplane.ArtifactAvailable {
		if err := transaction.Commit(ctx); err != nil {
			return cloudplane.Artifact{}, databaseFailure("commit PostgreSQL available Artifact failure report", err)
		}
		return artifact, nil
	}
	if artifact.State != cloudplane.ArtifactPending && artifact.State != cloudplane.ArtifactFailed {
		return cloudplane.Artifact{}, cloudplane.ErrConflict
	}
	if artifact.State == cloudplane.ArtifactFailed && artifact.FailureCode == failureCode {
		if err := transaction.Commit(ctx); err != nil {
			return cloudplane.Artifact{}, databaseFailure("commit PostgreSQL duplicate Artifact failure", err)
		}
		return artifact, nil
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: "artifact_upload_failed", scope: artifact.Scope(), nodeID: nodeID, taskID: task.ID, artifactID: artifact.ID, outcome: failureCode}); err != nil {
		return cloudplane.Artifact{}, err
	}
	artifact, err = scanQueueArtifact(transaction.QueryRow(ctx, `
UPDATE zapvm.artifacts SET state='failed',failure_code=$1,available_at=NULL,updated_at=$2
WHERE id=$3 RETURNING `+queueArtifactColumns, failureCode, now, artifact.ID))
	if err != nil {
		return cloudplane.Artifact{}, databaseFailure("fail PostgreSQL Artifact upload", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.Artifact{}, databaseFailure("commit PostgreSQL Artifact upload failure", err)
	}
	return artifact, nil
}

func (queue *Queue) ExpiredArtifactObjects(ctx context.Context, limit int) ([]cloudplane.Artifact, error) {
	if err := queue.validateCall(ctx); err != nil {
		return nil, err
	}
	if limit < 1 || limit > postgresMaximumPage {
		return nil, errors.New("PostgreSQL Artifact GC limit must be between 1 and 1000")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollbackBounded(transaction)
	if err := queue.expireArtifacts(ctx, transaction, queue.now().UTC().Truncate(time.Microsecond)); err != nil {
		return nil, err
	}
	rows, err := transaction.Query(ctx, `SELECT `+queueArtifactColumns+` FROM zapvm.artifacts WHERE state='expired' AND object_key IS NOT NULL ORDER BY updated_at,id LIMIT $1`, limit)
	if err != nil {
		return nil, databaseFailure("list PostgreSQL expired Artifact objects", err)
	}
	result := make([]cloudplane.Artifact, 0, limit)
	for rows.Next() {
		artifact, err := scanQueueArtifact(rows)
		if err != nil {
			rows.Close()
			return nil, errors.New("decode PostgreSQL expired Artifact")
		}
		result = append(result, artifact)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, errors.New("read PostgreSQL expired Artifacts")
	}
	if err := transaction.Commit(ctx); err != nil {
		return nil, databaseFailure("commit PostgreSQL expired Artifact list", err)
	}
	return result, nil
}

func (queue *Queue) ConfirmArtifactObjectDeleted(ctx context.Context, artifactID, objectKey string) error {
	if err := queue.validateCall(ctx); err != nil {
		return err
	}
	if !queueIDPattern.MatchString(artifactID) || !cloudplane.ValidArtifactObjectKey(objectKey) {
		return cloudplane.ErrConflict
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	artifact, err := scanQueueArtifact(transaction.QueryRow(ctx, `SELECT `+queueArtifactColumns+` FROM zapvm.artifacts WHERE id=$1 FOR UPDATE`, artifactID))
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (artifact.State != cloudplane.ArtifactExpired || artifact.ObjectKey != objectKey)) {
		return cloudplane.ErrConflict
	}
	if err != nil {
		return databaseFailure("lock PostgreSQL deleted Artifact object", err)
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: "artifact_delete", scope: artifact.Scope(), taskID: artifact.TaskID, artifactID: artifact.ID, outcome: "deleted"}); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `UPDATE zapvm.artifacts SET object_key=NULL,available_at=NULL,updated_at=$1 WHERE id=$2`, now, artifact.ID); err != nil {
		return databaseFailure("confirm PostgreSQL Artifact object deletion", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return databaseFailure("commit PostgreSQL Artifact object deletion", err)
	}
	return nil
}

func (queue *Queue) ListAgentSessionArtifacts(ctx context.Context, scope cloudplane.Scope, taskID string, after uint64, limit int) ([]cloudplane.Artifact, uint64, error) {
	if err := queue.validateCall(ctx); err != nil {
		return nil, 0, err
	}
	if scope.Validate() != nil || !queueIDPattern.MatchString(taskID) || after > math.MaxInt64 || limit < 1 || limit > postgresMaximumPage {
		return nil, 0, cloudplane.ErrNotFound
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return nil, 0, err
	}
	defer rollbackBounded(transaction)
	if err := queue.expireArtifacts(ctx, transaction, queue.now().UTC().Truncate(time.Microsecond)); err != nil {
		return nil, 0, err
	}
	task, err := scanQueueTask(transaction.QueryRow(ctx, `SELECT `+queueTaskColumns+` FROM zapvm.tasks WHERE id=$1 AND tenant_id=$2 AND project_id=$3`, taskID, scope.TenantID, scope.ProjectID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, cloudplane.ErrNotFound
	}
	if err != nil {
		return nil, 0, databaseFailure("inspect PostgreSQL Artifact Session Task", err)
	}
	command, err := daemonrpc.DecodeComputerTaskSubmit(task.Payload)
	if err != nil || command.Command.SessionID == "" || len(command.Command.Argv) == 0 || command.Command.Argv[0] != residentAgentCommand {
		return nil, 0, cloudplane.ErrNotFound
	}
	rows, err := transaction.Query(ctx, `SELECT `+queueArtifactColumns+` FROM zapvm.artifacts WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND created_sequence>$4 ORDER BY created_sequence,id LIMIT $5`, scope.TenantID, scope.ProjectID, taskID, int64(after), limit)
	if err != nil {
		return nil, 0, databaseFailure("list PostgreSQL Agent Session Artifacts", err)
	}
	result := make([]cloudplane.Artifact, 0, limit)
	for rows.Next() {
		artifact, err := scanQueueArtifact(rows)
		if err != nil {
			rows.Close()
			return nil, 0, errors.New("decode PostgreSQL Agent Session Artifact")
		}
		result = append(result, artifact)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, 0, errors.New("read PostgreSQL Agent Session Artifacts")
	}
	next := after
	if len(result) != 0 {
		next = result[len(result)-1].CreatedSequence
	}
	if err := transaction.Commit(ctx); err != nil {
		return nil, 0, databaseFailure("commit PostgreSQL Agent Session Artifact list", err)
	}
	return result, next, nil
}

func (queue *Queue) requireArtifactLease(ctx context.Context, transaction pgx.Tx, now time.Time, nodeID, generation, taskID, leaseToken string) (cloudplane.Task, string, error) {
	var nodeState string
	if err := transaction.QueryRow(ctx, `SELECT state FROM zapvm.nodes WHERE id=$1 AND generation=$2 FOR SHARE`, nodeID, generation).Scan(&nodeState); errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.Task{}, "", cloudplane.ErrFenced
	} else if err != nil {
		return cloudplane.Task{}, "", databaseFailure("inspect PostgreSQL Artifact Node", err)
	}
	if nodeState == cloudplane.NodeOffline {
		return cloudplane.Task{}, "", cloudplane.ErrUnavailable
	}
	task, err := scanQueueTask(transaction.QueryRow(ctx, `SELECT `+queueTaskColumns+` FROM zapvm.tasks WHERE id=$1 FOR UPDATE`, taskID))
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.Task{}, "", cloudplane.ErrNotFound
	}
	if err != nil {
		return cloudplane.Task{}, "", databaseFailure("lock PostgreSQL Artifact Task", err)
	}
	if task.NodeID != nodeID || task.NodeGeneration != generation || !activeQueueTask(task.State) || !queueTokenMatches(task.LeaseTokenHash, leaseToken) {
		return cloudplane.Task{}, "", cloudplane.ErrFenced
	}
	leaseExpires, err := time.Parse(time.RFC3339Nano, task.LeaseExpiresAt)
	if err != nil || !leaseExpires.After(now) {
		return cloudplane.Task{}, "", cloudplane.ErrFenced
	}
	command, err := daemonrpc.DecodeComputerTaskSubmit(task.Payload)
	if err != nil || command.ComputerID != task.ComputerID || command.Command.SessionID == "" || len(command.Command.Argv) == 0 || command.Command.Argv[0] != residentAgentCommand {
		return cloudplane.Task{}, "", cloudplane.ErrConflict
	}
	return task, command.Command.SessionID, nil
}

func (queue *Queue) lockTaskArtifact(ctx context.Context, transaction pgx.Tx, task cloudplane.Task, artifactID string) (cloudplane.Artifact, error) {
	artifact, err := scanQueueArtifact(transaction.QueryRow(ctx, `SELECT `+queueArtifactColumns+` FROM zapvm.artifacts WHERE id=$1 FOR UPDATE`, artifactID))
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (artifact.TaskID != task.ID || artifact.Scope() != task.Scope())) {
		return cloudplane.Artifact{}, cloudplane.ErrNotFound
	}
	if err != nil {
		return cloudplane.Artifact{}, databaseFailure("lock PostgreSQL Artifact", err)
	}
	return artifact, nil
}

func (queue *Queue) expireArtifacts(ctx context.Context, transaction pgx.Tx, now time.Time) error {
	rows, err := transaction.Query(ctx, `SELECT `+queueArtifactColumns+` FROM zapvm.artifacts WHERE state<>'expired' AND expires_at<=$1 ORDER BY expires_at,id FOR UPDATE`, now)
	if err != nil {
		return databaseFailure("lock expired PostgreSQL Artifacts", err)
	}
	expired := make([]cloudplane.Artifact, 0)
	for rows.Next() {
		artifact, err := scanQueueArtifact(rows)
		if err != nil {
			rows.Close()
			return errors.New("decode expiring PostgreSQL Artifact")
		}
		expired = append(expired, artifact)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read expiring PostgreSQL Artifacts")
	}
	for _, artifact := range expired {
		if _, err := appendAudit(ctx, transaction, now, auditInput{action: "artifact_expire", scope: artifact.Scope(), taskID: artifact.TaskID, artifactID: artifact.ID, outcome: cloudplane.ArtifactExpired}); err != nil {
			return err
		}
		if _, err := transaction.Exec(ctx, `UPDATE zapvm.artifacts SET state='expired',failure_code=NULL,updated_at=$1 WHERE id=$2`, now, artifact.ID); err != nil {
			return databaseFailure("expire PostgreSQL Artifact", err)
		}
	}
	pruneRows, err := transaction.Query(ctx, `SELECT `+queueArtifactColumns+` FROM zapvm.artifacts WHERE state='expired' AND object_key IS NULL AND updated_at<=$1 ORDER BY updated_at,id FOR UPDATE`, now.Add(-postgresArtifactMetadataRetention))
	if err != nil {
		return databaseFailure("lock prunable PostgreSQL Artifacts", err)
	}
	prunable := make([]cloudplane.Artifact, 0)
	for pruneRows.Next() {
		artifact, err := scanQueueArtifact(pruneRows)
		if err != nil {
			pruneRows.Close()
			return errors.New("decode prunable PostgreSQL Artifact")
		}
		prunable = append(prunable, artifact)
	}
	pruneRows.Close()
	if err := pruneRows.Err(); err != nil {
		return errors.New("read prunable PostgreSQL Artifacts")
	}
	for _, artifact := range prunable {
		if _, err := appendAudit(ctx, transaction, now, auditInput{action: "artifact_prune", scope: artifact.Scope(), taskID: artifact.TaskID, artifactID: artifact.ID, outcome: "retention"}); err != nil {
			return err
		}
		if _, err := transaction.Exec(ctx, `DELETE FROM zapvm.artifacts WHERE id=$1`, artifact.ID); err != nil {
			return databaseFailure("prune PostgreSQL Artifact", err)
		}
	}
	return nil
}

func artifactRegistrationMatches(artifact cloudplane.Artifact, task cloudplane.Task, sessionID string, request cloudplane.ArtifactRegistrationRequest, name string) bool {
	return artifact.Scope() == task.Scope() && artifact.ComputerID == task.ComputerID && artifact.SessionID == sessionID && artifact.TaskID == task.ID &&
		artifact.Path == request.Path && artifact.Name == name && artifact.ContentType == request.ContentType && artifact.Size == request.Size &&
		artifact.SHA256 == request.SHA256 && artifact.RetentionSeconds == request.RetentionSeconds
}

const queueArtifactColumns = `
id,tenant_id,project_id,computer_id,session_id,task_id,path,name,content_type,size_bytes,encode(sha256,'hex'),state,
retention_seconds,created_at,updated_at,expires_at,COALESCE(failure_code,''),COALESCE(object_key,''),available_at,
created_sequence,registered_node_id,registered_node_generation`

func scanQueueArtifact(row pgx.Row) (cloudplane.Artifact, error) {
	var artifact cloudplane.Artifact
	var size, retention, sequence int64
	var created, updated, expires time.Time
	var available *time.Time
	if err := row.Scan(&artifact.ID, &artifact.TenantID, &artifact.ProjectID, &artifact.ComputerID, &artifact.SessionID, &artifact.TaskID,
		&artifact.Path, &artifact.Name, &artifact.ContentType, &size, &artifact.SHA256, &artifact.State, &retention,
		&created, &updated, &expires, &artifact.FailureCode, &artifact.ObjectKey, &available, &sequence,
		&artifact.RegisteredNodeID, &artifact.RegisteredNodeGeneration); err != nil {
		return cloudplane.Artifact{}, err
	}
	if size < 1 || retention < 1 || sequence < 1 || uint64(size) > queueMaximumArtifactSize ||
		!queueIDPattern.MatchString(artifact.ID) || !queueIDPattern.MatchString(artifact.RegisteredNodeID) || !validQueueGeneration(artifact.RegisteredNodeGeneration) ||
		updated.Before(created) || !expires.Equal(created.Add(time.Duration(retention)*time.Second)) {
		return cloudplane.Artifact{}, errors.New("PostgreSQL Artifact row is invalid")
	}
	request, name, err := cloudplane.NormalizeArtifactRegistrationRequest(cloudplane.ArtifactRegistrationRequest{
		ID: artifact.ID, Path: artifact.Path, ContentType: artifact.ContentType, Size: uint64(size), SHA256: artifact.SHA256, RetentionSeconds: uint64(retention),
	})
	if err != nil || artifact.Name != name || request.ContentType != artifact.ContentType || request.SHA256 != artifact.SHA256 || artifact.Scope().Validate() != nil {
		return cloudplane.Artifact{}, errors.New("PostgreSQL Artifact metadata is invalid")
	}
	if artifact.State == cloudplane.ArtifactFailed {
		if !queueFailurePattern.MatchString(artifact.FailureCode) {
			return cloudplane.Artifact{}, errors.New("PostgreSQL failed Artifact row is invalid")
		}
	} else if artifact.FailureCode != "" {
		return cloudplane.Artifact{}, errors.New("PostgreSQL Artifact failure state is invalid")
	}
	if artifact.ObjectKey != "" && !cloudplane.ValidArtifactObjectKey(artifact.ObjectKey) {
		return cloudplane.Artifact{}, errors.New("PostgreSQL Artifact object key is invalid")
	}
	if available != nil {
		if available.Before(created) || available.After(updated) || artifact.ObjectKey == "" {
			return cloudplane.Artifact{}, errors.New("PostgreSQL Artifact availability is invalid")
		}
		artifact.AvailableAt = available.UTC().Format(time.RFC3339Nano)
	}
	switch artifact.State {
	case cloudplane.ArtifactAvailable:
		if artifact.ObjectKey == "" || available == nil {
			return cloudplane.Artifact{}, errors.New("PostgreSQL available Artifact row is invalid")
		}
	case cloudplane.ArtifactPending, cloudplane.ArtifactFailed:
		if available != nil {
			return cloudplane.Artifact{}, errors.New("PostgreSQL unavailable Artifact row is invalid")
		}
	case cloudplane.ArtifactExpired:
	default:
		return cloudplane.Artifact{}, errors.New("PostgreSQL Artifact state is invalid")
	}
	artifact.Size, artifact.RetentionSeconds, artifact.CreatedSequence = uint64(size), uint64(retention), uint64(sequence)
	artifact.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	artifact.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	artifact.ExpiresAt = expires.UTC().Format(time.RFC3339Nano)
	return artifact, nil
}
