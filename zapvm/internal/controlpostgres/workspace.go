package controlpostgres

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"time"

	"github.com/jackc/pgx/v5"

	"zapvm/internal/cloudplane"
)

const (
	postgresMaximumWorkspaceOperations         = 64
	postgresMaximumWorkspaceOperationsPerScope = 8
	postgresWorkspaceOperationTTL              = 15 * time.Minute
	postgresWorkspaceOperationRetention        = 10 * time.Minute
)

func (queue *Queue) SubmitWorkspaceOperation(ctx context.Context, principal string, request cloudplane.WorkspaceOperationRequest) (cloudplane.WorkspaceOperation, bool, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.WorkspaceOperation{}, false, err
	}
	if !cloudplane.ValidPrincipal(principal) {
		return cloudplane.WorkspaceOperation{}, false, cloudplane.ErrUnauthorized
	}
	if err := cloudplane.ValidateWorkspaceOperationRequest(request); err != nil {
		return cloudplane.WorkspaceOperation{}, false, err
	}
	if err := queue.sweepWorkspaceNow(ctx); err != nil {
		return cloudplane.WorkspaceOperation{}, false, err
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.WorkspaceOperation{}, false, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	if _, err := transaction.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "workspace|"+request.ID); err != nil {
		return cloudplane.WorkspaceOperation{}, false, databaseFailure("lock PostgreSQL workspace operation idempotency", err)
	}
	existing, err := scanQueueWorkspaceOperation(transaction.QueryRow(ctx, `SELECT `+queueWorkspaceOperationColumns+` FROM zapvm.workspace_operations WHERE id=$1 FOR UPDATE`, request.ID))
	if err == nil {
		if workspaceRequestMatches(existing, request) {
			if err := transaction.Commit(ctx); err != nil {
				return cloudplane.WorkspaceOperation{}, false, databaseFailure("commit PostgreSQL duplicate workspace operation", err)
			}
			return existing, false, nil
		}
		return cloudplane.WorkspaceOperation{}, false, cloudplane.ErrConflict
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.WorkspaceOperation{}, false, databaseFailure("inspect PostgreSQL duplicate workspace operation", err)
	}
	var provisioned bool
	if err := transaction.QueryRow(ctx, `SELECT EXISTS (
SELECT 1 FROM zapvm.computer_nodes WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3)`, request.Scope.TenantID, request.Scope.ProjectID, request.ComputerID).Scan(&provisioned); err != nil {
		return cloudplane.WorkspaceOperation{}, false, databaseFailure("inspect PostgreSQL workspace Computer", err)
	}
	if !provisioned {
		return cloudplane.WorkspaceOperation{}, false, cloudplane.ErrUnavailable
	}
	branch := ""
	if request.Kind == cloudplane.WorkspaceOperationGitPush {
		var taskComputer, taskState string
		err := transaction.QueryRow(ctx, `SELECT computer_id,state FROM zapvm.tasks WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE`, request.TaskID, request.Scope.TenantID, request.Scope.ProjectID).Scan(&taskComputer, &taskState)
		if errors.Is(err, pgx.ErrNoRows) {
			return cloudplane.WorkspaceOperation{}, false, cloudplane.ErrNotFound
		}
		if err != nil {
			return cloudplane.WorkspaceOperation{}, false, databaseFailure("inspect PostgreSQL Git operation Task", err)
		}
		if taskComputer != request.ComputerID || taskState != cloudplane.TaskSucceeded {
			return cloudplane.WorkspaceOperation{}, false, cloudplane.ErrConflict
		}
		branch = "zapvm/" + request.ID
	}
	if _, err := transaction.Exec(ctx, `SELECT audit_sequence FROM zapvm.control_state WHERE singleton FOR UPDATE`); err != nil {
		return cloudplane.WorkspaceOperation{}, false, databaseFailure("lock PostgreSQL workspace operation quota", err)
	}
	var total, scoped int
	if err := transaction.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE tenant_id=$1 AND project_id=$2) FROM zapvm.workspace_operations`, request.Scope.TenantID, request.Scope.ProjectID).Scan(&total, &scoped); err != nil {
		return cloudplane.WorkspaceOperation{}, false, databaseFailure("count PostgreSQL workspace operation quota", err)
	}
	if total >= postgresMaximumWorkspaceOperations || scoped >= postgresMaximumWorkspaceOperationsPerScope {
		return cloudplane.WorkspaceOperation{}, false, cloudplane.ErrQuotaReached
	}
	operation := cloudplane.WorkspaceOperation{
		ID: request.ID, TenantID: request.Scope.TenantID, ProjectID: request.Scope.ProjectID, ComputerID: request.ComputerID,
		Kind: request.Kind, Path: request.Path, TaskID: request.TaskID, ProviderID: request.ProviderID, Branch: branch,
		State: cloudplane.WorkspaceOperationPending,
	}
	audit, err := appendWorkspaceAudit(ctx, transaction, now, "submit", operation, "", "accepted", principal)
	if err != nil {
		return cloudplane.WorkspaceOperation{}, false, err
	}
	row := transaction.QueryRow(ctx, `
INSERT INTO zapvm.workspace_operations
    (id,tenant_id,project_id,computer_id,kind,path,task_id,provider_id,branch,state,created_at,updated_at,expires_at,created_sequence)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$10,$11,$12)
RETURNING `+queueWorkspaceOperationColumns,
		request.ID, request.Scope.TenantID, request.Scope.ProjectID, request.ComputerID, request.Kind,
		optionalWorkspaceString(request.Kind != cloudplane.WorkspaceOperationGitPush, request.Path), optionalString(request.TaskID), optionalString(request.ProviderID), optionalString(branch),
		now, now.Add(postgresWorkspaceOperationTTL), int64(audit.Sequence))
	operation, err = scanQueueWorkspaceOperation(row)
	if err != nil {
		return cloudplane.WorkspaceOperation{}, false, databaseFailure("insert PostgreSQL workspace operation", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.WorkspaceOperation{}, false, databaseFailure("commit PostgreSQL workspace operation submit", err)
	}
	return operation, true, nil
}

func (queue *Queue) ClaimWorkspaceOperations(ctx context.Context, nodeID, generation string, maximum int) ([]cloudplane.WorkspaceOperationLease, error) {
	if err := queue.validateCall(ctx); err != nil {
		return nil, err
	}
	if !queueIDPattern.MatchString(nodeID) || !validQueueGeneration(generation) || maximum < 1 || maximum > 8 {
		return nil, errors.New("PostgreSQL workspace claim authority is invalid")
	}
	if err := queue.sweepWorkspaceNow(ctx); err != nil {
		return nil, err
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	var state string
	var capacity int32
	if err := transaction.QueryRow(ctx, `SELECT state,capacity FROM zapvm.nodes WHERE id=$1 AND generation=$2 FOR UPDATE`, nodeID, generation).Scan(&state, &capacity); errors.Is(err, pgx.ErrNoRows) {
		return nil, cloudplane.ErrFenced
	} else if err != nil {
		return nil, databaseFailure("lock PostgreSQL workspace Node", err)
	}
	if state != cloudplane.NodeOnline {
		return nil, cloudplane.ErrUnavailable
	}
	var inFlight int
	if err := transaction.QueryRow(ctx, `
SELECT (SELECT count(*) FROM zapvm.tasks WHERE node_id=$1 AND node_generation=$2 AND state IN ('leased','running','canceling'))+
       (SELECT count(*) FROM zapvm.workspace_operations WHERE node_id=$1 AND node_generation=$2 AND state='leased')`, nodeID, generation).Scan(&inFlight); err != nil {
		return nil, databaseFailure("count PostgreSQL workspace Node capacity", err)
	}
	available := int(capacity) - inFlight
	if available <= 0 {
		return nil, cloudplane.ErrCapacityReached
	}
	if maximum > available {
		maximum = available
	}
	rows, err := transaction.Query(ctx, `
SELECT `+prefixedWorkspaceOperationColumns("operation")+`
FROM zapvm.workspace_operations AS operation
JOIN zapvm.computer_nodes AS configured
  ON configured.node_id=$1 AND configured.tenant_id=operation.tenant_id AND configured.project_id=operation.project_id AND configured.computer_id=operation.computer_id
WHERE operation.state='pending' AND operation.attempt<10 AND operation.expires_at>$2
ORDER BY operation.created_sequence,operation.id
FOR UPDATE OF operation SKIP LOCKED LIMIT $3`, nodeID, now, maximum)
	if err != nil {
		return nil, databaseFailure("select PostgreSQL workspace operations", err)
	}
	candidates := make([]cloudplane.WorkspaceOperation, 0, maximum)
	for rows.Next() {
		operation, err := scanQueueWorkspaceOperation(rows)
		if err != nil {
			rows.Close()
			return nil, errors.New("decode PostgreSQL workspace operation candidate")
		}
		candidates = append(candidates, operation)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, errors.New("read PostgreSQL workspace operation candidates")
	}
	leases := make([]cloudplane.WorkspaceOperationLease, 0, len(candidates))
	for _, operation := range candidates {
		tokenBytes := make([]byte, 32)
		if _, err := io.ReadFull(queue.random, tokenBytes); err != nil {
			return nil, errors.New("generate PostgreSQL workspace lease token")
		}
		token := base64.RawURLEncoding.EncodeToString(tokenBytes)
		digest := sha256.Sum256([]byte(token))
		updated, err := scanQueueWorkspaceOperation(transaction.QueryRow(ctx, `
UPDATE zapvm.workspace_operations SET state='leased',node_id=$1,node_generation=$2,attempt=attempt+1,
    lease_token_hash=$3,lease_expires_at=$4,updated_at=$5
WHERE id=$6 AND state='pending' RETURNING `+queueWorkspaceOperationColumns,
			nodeID, generation, digest[:], now.Add(queue.leaseTTL), now, operation.ID))
		if err != nil {
			return nil, databaseFailure("lease PostgreSQL workspace operation", err)
		}
		if _, err := appendWorkspaceAudit(ctx, transaction, now, "lease", updated, nodeID, "success", ""); err != nil {
			return nil, err
		}
		leases = append(leases, cloudplane.WorkspaceOperationLease{Operation: updated, LeaseToken: token})
	}
	if _, err := transaction.Exec(ctx, `UPDATE zapvm.nodes SET in_flight=$1,updated_at=$2 WHERE id=$3 AND generation=$4`, inFlight+len(leases), now, nodeID, generation); err != nil {
		return nil, databaseFailure("update PostgreSQL workspace Node capacity", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return nil, databaseFailure("commit PostgreSQL workspace claim", err)
	}
	return leases, nil
}

func (queue *Queue) InspectWorkspaceOperation(ctx context.Context, scope cloudplane.Scope, operationID string) (cloudplane.WorkspaceOperation, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	if scope.Validate() != nil || !queueIDPattern.MatchString(operationID) {
		return cloudplane.WorkspaceOperation{}, cloudplane.ErrNotFound
	}
	if err := queue.sweepWorkspaceNow(ctx); err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	defer rollbackBounded(transaction)
	operation, err := scanQueueWorkspaceOperation(transaction.QueryRow(ctx, `SELECT `+queueWorkspaceOperationColumns+` FROM zapvm.workspace_operations WHERE id=$1 AND tenant_id=$2 AND project_id=$3`, operationID, scope.TenantID, scope.ProjectID))
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.WorkspaceOperation{}, cloudplane.ErrNotFound
	}
	if err != nil {
		return cloudplane.WorkspaceOperation{}, databaseFailure("inspect PostgreSQL workspace operation", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.WorkspaceOperation{}, databaseFailure("commit PostgreSQL workspace operation inspection", err)
	}
	return operation, nil
}

func (queue *Queue) InspectWorkspaceOperationLease(ctx context.Context, nodeID, generation, operationID, leaseToken string) (cloudplane.WorkspaceOperation, error) {
	if err := queue.validateWorkspaceAuthority(ctx, nodeID, generation, operationID, leaseToken); err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	if err := queue.sweepWorkspaceNow(ctx); err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	operation, err := queue.requireWorkspaceLease(ctx, transaction, now, nodeID, generation, operationID, leaseToken)
	if err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.WorkspaceOperation{}, databaseFailure("commit PostgreSQL workspace lease inspection", err)
	}
	return operation, nil
}

func (queue *Queue) CompleteWorkspaceOperation(ctx context.Context, nodeID, generation, operationID, leaseToken string, completion cloudplane.WorkspaceOperationCompletion) (cloudplane.WorkspaceOperation, error) {
	if err := queue.validateWorkspaceAuthority(ctx, nodeID, generation, operationID, leaseToken); err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	if err := queue.sweepWorkspaceNow(ctx); err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	operation, err := queue.requireWorkspaceLease(ctx, transaction, now, nodeID, generation, operationID, leaseToken)
	if err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	state, failure := cloudplane.WorkspaceOperationFailed, completion.FailureCode
	var result any
	var resultDigest any
	if completion.Succeeded {
		if completion.FailureCode != "" {
			return cloudplane.WorkspaceOperation{}, errors.New("PostgreSQL workspace completion is invalid")
		}
		normalized, digestHex, validateErr := cloudplane.ValidateWorkspaceOperationResult(operation, completion.Result)
		if validateErr != nil {
			failure = "invalid_result"
		} else {
			state, failure, result = cloudplane.WorkspaceOperationSucceeded, "", string(normalized)
			digest, _ := hex.DecodeString(digestHex)
			resultDigest = digest
		}
	} else if !queueFailurePattern.MatchString(completion.FailureCode) || len(completion.Result) != 0 {
		return cloudplane.WorkspaceOperation{}, errors.New("PostgreSQL workspace failure is invalid")
	}
	updated, err := scanQueueWorkspaceOperation(transaction.QueryRow(ctx, `
UPDATE zapvm.workspace_operations SET state=$1,node_id=NULL,node_generation=NULL,lease_token_hash=NULL,lease_expires_at=NULL,
    result=$2::jsonb,result_raw=$3,result_sha256=$4,failure_code=NULLIF($5,''),updated_at=$6
WHERE id=$7 RETURNING `+queueWorkspaceOperationColumns, state, result, optionalWorkspaceResultBytes(result), resultDigest, failure, now, operation.ID))
	if err != nil {
		return cloudplane.WorkspaceOperation{}, databaseFailure("complete PostgreSQL workspace operation", err)
	}
	if _, err := appendWorkspaceAudit(ctx, transaction, now, "complete", updated, nodeID, updated.State, ""); err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	if err := refreshQueueNodeInFlight(ctx, transaction, nodeID, generation, now); err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.WorkspaceOperation{}, databaseFailure("commit PostgreSQL workspace completion", err)
	}
	return updated, nil
}

func (queue *Queue) DeleteWorkspaceOperation(ctx context.Context, principal string, scope cloudplane.Scope, operationID string) (cloudplane.WorkspaceOperation, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	if !cloudplane.ValidPrincipal(principal) {
		return cloudplane.WorkspaceOperation{}, cloudplane.ErrUnauthorized
	}
	if scope.Validate() != nil || !queueIDPattern.MatchString(operationID) {
		return cloudplane.WorkspaceOperation{}, cloudplane.ErrNotFound
	}
	if err := queue.sweepWorkspaceNow(ctx); err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	operation, err := scanQueueWorkspaceOperation(transaction.QueryRow(ctx, `SELECT `+queueWorkspaceOperationColumns+` FROM zapvm.workspace_operations WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE`, operationID, scope.TenantID, scope.ProjectID))
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.WorkspaceOperation{}, cloudplane.ErrNotFound
	}
	if err != nil {
		return cloudplane.WorkspaceOperation{}, databaseFailure("lock PostgreSQL workspace deletion", err)
	}
	if operation.State != cloudplane.WorkspaceOperationSucceeded && operation.State != cloudplane.WorkspaceOperationFailed {
		return cloudplane.WorkspaceOperation{}, cloudplane.ErrConflict
	}
	if _, err := appendWorkspaceAudit(ctx, transaction, now, "delete", operation, "", "success", principal); err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	if _, err := transaction.Exec(ctx, `DELETE FROM zapvm.workspace_operations WHERE id=$1`, operation.ID); err != nil {
		return cloudplane.WorkspaceOperation{}, databaseFailure("delete PostgreSQL workspace operation", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.WorkspaceOperation{}, databaseFailure("commit PostgreSQL workspace deletion", err)
	}
	return operation, nil
}

func (queue *Queue) validateWorkspaceAuthority(ctx context.Context, nodeID, generation, operationID, leaseToken string) error {
	if err := queue.validateCall(ctx); err != nil {
		return err
	}
	if !queueIDPattern.MatchString(nodeID) || !validQueueGeneration(generation) || !queueIDPattern.MatchString(operationID) || validateQueueToken(leaseToken) != nil {
		return errors.New("PostgreSQL workspace lease authority is invalid")
	}
	return nil
}

func (queue *Queue) requireWorkspaceLease(ctx context.Context, transaction pgx.Tx, now time.Time, nodeID, generation, operationID, leaseToken string) (cloudplane.WorkspaceOperation, error) {
	var nodeState string
	if err := transaction.QueryRow(ctx, `SELECT state FROM zapvm.nodes WHERE id=$1 AND generation=$2 FOR SHARE`, nodeID, generation).Scan(&nodeState); errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.WorkspaceOperation{}, cloudplane.ErrFenced
	} else if err != nil {
		return cloudplane.WorkspaceOperation{}, databaseFailure("inspect PostgreSQL workspace Node", err)
	}
	if nodeState == cloudplane.NodeOffline {
		return cloudplane.WorkspaceOperation{}, cloudplane.ErrUnavailable
	}
	operation, err := scanQueueWorkspaceOperation(transaction.QueryRow(ctx, `SELECT `+queueWorkspaceOperationColumns+` FROM zapvm.workspace_operations WHERE id=$1 FOR UPDATE`, operationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.WorkspaceOperation{}, cloudplane.ErrNotFound
	}
	if err != nil {
		return cloudplane.WorkspaceOperation{}, databaseFailure("lock PostgreSQL workspace lease", err)
	}
	if operation.State != cloudplane.WorkspaceOperationLeased || operation.NodeID != nodeID || operation.NodeGeneration != generation || !queueTokenMatches(operation.LeaseTokenHash, leaseToken) {
		return cloudplane.WorkspaceOperation{}, cloudplane.ErrFenced
	}
	leaseExpires, err := time.Parse(time.RFC3339Nano, operation.LeaseExpiresAt)
	if err != nil || !leaseExpires.After(now) {
		return cloudplane.WorkspaceOperation{}, cloudplane.ErrFenced
	}
	return operation, nil
}

func (queue *Queue) sweepWorkspaceOperations(ctx context.Context, transaction pgx.Tx, now time.Time) error {
	// Workspace operations are deliberately bounded to 64 records. Serializing
	// their sweep gives every replica the same lock order before it takes a
	// per-operation idempotency or row lock, preventing cross-replica deadlocks.
	if _, err := transaction.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "workspace|sweep"); err != nil {
		return databaseFailure("lock PostgreSQL workspace sweep", err)
	}
	rows, err := transaction.Query(ctx, `SELECT `+queueWorkspaceOperationColumns+` FROM zapvm.workspace_operations ORDER BY created_sequence,id FOR UPDATE`)
	if err != nil {
		return databaseFailure("lock PostgreSQL workspace sweep", err)
	}
	operations := make([]cloudplane.WorkspaceOperation, 0)
	for rows.Next() {
		operation, err := scanQueueWorkspaceOperation(rows)
		if err != nil {
			rows.Close()
			return errors.New("decode PostgreSQL workspace sweep")
		}
		operations = append(operations, operation)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read PostgreSQL workspace sweep")
	}
	touchedNodes := make(map[string]string)
	for _, operation := range operations {
		updated, err := time.Parse(time.RFC3339Nano, operation.UpdatedAt)
		if err != nil {
			return err
		}
		if (operation.State == cloudplane.WorkspaceOperationSucceeded || operation.State == cloudplane.WorkspaceOperationFailed) && now.Sub(updated) >= postgresWorkspaceOperationRetention {
			if _, err := appendWorkspaceAudit(ctx, transaction, now, "prune", operation, "", "retention", ""); err != nil {
				return err
			}
			if _, err := transaction.Exec(ctx, `DELETE FROM zapvm.workspace_operations WHERE id=$1`, operation.ID); err != nil {
				return databaseFailure("prune PostgreSQL workspace operation", err)
			}
			continue
		}
		expires, err := time.Parse(time.RFC3339Nano, operation.ExpiresAt)
		if err != nil {
			return err
		}
		state, failure, action := "", "", ""
		if operation.State == cloudplane.WorkspaceOperationPending && !expires.After(now) {
			state, failure, action = cloudplane.WorkspaceOperationFailed, "operation_timeout", "expire"
		} else if operation.State == cloudplane.WorkspaceOperationLeased {
			leaseExpires, err := time.Parse(time.RFC3339Nano, operation.LeaseExpiresAt)
			if err != nil {
				return err
			}
			if leaseExpires.After(now) {
				continue
			}
			action = "lease_expire"
			if !expires.After(now) {
				state, failure = cloudplane.WorkspaceOperationFailed, "operation_timeout"
			} else if operation.Attempt >= cloudplane.MaxAttempts {
				state, failure = cloudplane.WorkspaceOperationFailed, "lease_exhausted"
			} else {
				state = cloudplane.WorkspaceOperationPending
			}
			touchedNodes[operation.NodeID] = operation.NodeGeneration
		}
		if state == "" {
			continue
		}
		updatedOperation, err := scanQueueWorkspaceOperation(transaction.QueryRow(ctx, `
UPDATE zapvm.workspace_operations SET state=$1,node_id=NULL,node_generation=NULL,lease_token_hash=NULL,lease_expires_at=NULL,
    failure_code=NULLIF($2,''),result=NULL,result_raw=NULL,result_sha256=NULL,updated_at=$3 WHERE id=$4 RETURNING `+queueWorkspaceOperationColumns,
			state, failure, now, operation.ID))
		if err != nil {
			return databaseFailure("sweep PostgreSQL workspace operation", err)
		}
		if _, err := appendWorkspaceAudit(ctx, transaction, now, action, updatedOperation, operation.NodeID, updatedOperation.State, ""); err != nil {
			return err
		}
	}
	for nodeID, generation := range touchedNodes {
		if err := refreshQueueNodeInFlight(ctx, transaction, nodeID, generation, now); err != nil {
			return err
		}
	}
	return nil
}

func (queue *Queue) sweepWorkspaceNow(ctx context.Context) error {
	transaction, err := queue.begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackBounded(transaction)
	if err := queue.sweepWorkspaceOperations(ctx, transaction, queue.now().UTC().Truncate(time.Microsecond)); err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return databaseFailure("commit PostgreSQL workspace sweep", err)
	}
	return nil
}

func (queue *Queue) fenceWorkspaceGeneration(ctx context.Context, transaction pgx.Tx, nodeID, generation string, now time.Time) error {
	rows, err := transaction.Query(ctx, `SELECT `+queueWorkspaceOperationColumns+` FROM zapvm.workspace_operations WHERE node_id=$1 AND node_generation=$2 AND state='leased' ORDER BY id FOR UPDATE`, nodeID, generation)
	if err != nil {
		return databaseFailure("lock PostgreSQL generation workspace operations", err)
	}
	operations := make([]cloudplane.WorkspaceOperation, 0)
	for rows.Next() {
		operation, err := scanQueueWorkspaceOperation(rows)
		if err != nil {
			rows.Close()
			return errors.New("decode PostgreSQL generation workspace operation")
		}
		operations = append(operations, operation)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read PostgreSQL generation workspace operations")
	}
	for _, operation := range operations {
		expires, _ := time.Parse(time.RFC3339Nano, operation.ExpiresAt)
		state, failure := cloudplane.WorkspaceOperationPending, ""
		if !expires.After(now) {
			state, failure = cloudplane.WorkspaceOperationFailed, "operation_timeout"
		} else if operation.Attempt >= cloudplane.MaxAttempts {
			state, failure = cloudplane.WorkspaceOperationFailed, "generation_exhausted"
		}
		updated, err := scanQueueWorkspaceOperation(transaction.QueryRow(ctx, `
UPDATE zapvm.workspace_operations SET state=$1,node_id=NULL,node_generation=NULL,lease_token_hash=NULL,lease_expires_at=NULL,
    failure_code=NULLIF($2,''),updated_at=$3 WHERE id=$4 RETURNING `+queueWorkspaceOperationColumns,
			state, failure, now, operation.ID))
		if err != nil {
			return databaseFailure("fence PostgreSQL generation workspace operation", err)
		}
		if _, err := appendWorkspaceAudit(ctx, transaction, now, "generation_fence", updated, nodeID, updated.State, ""); err != nil {
			return err
		}
	}
	return nil
}

func refreshQueueNodeInFlight(ctx context.Context, transaction pgx.Tx, nodeID, generation string, now time.Time) error {
	if _, err := transaction.Exec(ctx, `
UPDATE zapvm.nodes SET in_flight=
    (SELECT count(*) FROM zapvm.tasks WHERE node_id=$1 AND node_generation=$2 AND state IN ('leased','running','canceling'))+
    (SELECT count(*) FROM zapvm.workspace_operations WHERE node_id=$1 AND node_generation=$2 AND state='leased'),updated_at=$3
WHERE id=$1 AND generation=$2`, nodeID, generation, now); err != nil {
		return databaseFailure("refresh PostgreSQL Node in-flight count", err)
	}
	return nil
}

func appendWorkspaceAudit(ctx context.Context, transaction pgx.Tx, now time.Time, suffix string, operation cloudplane.WorkspaceOperation, nodeID, outcome, principal string) (cloudplane.AuditRecord, error) {
	action := "workspace_operation_" + suffix
	taskID := ""
	if operation.Kind == cloudplane.WorkspaceOperationGitPush {
		action = "git_operation_" + suffix
		taskID = operation.TaskID
	}
	return appendAudit(ctx, transaction, now, auditInput{
		action: action, scope: operation.Scope(), nodeID: nodeID, taskID: taskID, operationID: operation.ID, outcome: outcome, principal: principal,
	})
}

func workspaceRequestMatches(operation cloudplane.WorkspaceOperation, request cloudplane.WorkspaceOperationRequest) bool {
	return operation.Scope() == request.Scope && operation.ComputerID == request.ComputerID && operation.Kind == request.Kind && operation.Path == request.Path &&
		operation.TaskID == request.TaskID && operation.ProviderID == request.ProviderID
}

func optionalWorkspaceString(include bool, value string) any {
	if !include {
		return nil
	}
	return value
}

func optionalWorkspaceResultBytes(result any) any {
	if result == nil {
		return nil
	}
	return []byte(result.(string))
}

const queueWorkspaceOperationColumns = `
id,tenant_id,project_id,computer_id,kind,COALESCE(path,''),COALESCE(task_id,''),COALESCE(provider_id,''),COALESCE(branch,''),
state,COALESCE(node_id,''),COALESCE(node_generation,''),attempt,COALESCE(encode(lease_token_hash,'hex'),''),lease_expires_at,
created_at,updated_at,expires_at,COALESCE(convert_from(result_raw,'UTF8'),''),COALESCE(encode(result_sha256,'hex'),''),COALESCE(failure_code,''),created_sequence`

func prefixedWorkspaceOperationColumns(prefix string) string {
	return prefix + `.id,` + prefix + `.tenant_id,` + prefix + `.project_id,` + prefix + `.computer_id,` + prefix + `.kind,` +
		`COALESCE(` + prefix + `.path,''),COALESCE(` + prefix + `.task_id,''),COALESCE(` + prefix + `.provider_id,''),COALESCE(` + prefix + `.branch,''),` +
		prefix + `.state,COALESCE(` + prefix + `.node_id,''),COALESCE(` + prefix + `.node_generation,''),` + prefix + `.attempt,` +
		`COALESCE(encode(` + prefix + `.lease_token_hash,'hex'),''),` + prefix + `.lease_expires_at,` + prefix + `.created_at,` + prefix + `.updated_at,` + prefix + `.expires_at,` +
		`COALESCE(convert_from(` + prefix + `.result_raw,'UTF8'),''),COALESCE(encode(` + prefix + `.result_sha256,'hex'),''),COALESCE(` + prefix + `.failure_code,''),` + prefix + `.created_sequence`
}

func scanQueueWorkspaceOperation(row pgx.Row) (cloudplane.WorkspaceOperation, error) {
	var operation cloudplane.WorkspaceOperation
	var attempt int16
	var leaseExpires *time.Time
	var created, updated, expires time.Time
	var result string
	var sequence int64
	if err := row.Scan(&operation.ID, &operation.TenantID, &operation.ProjectID, &operation.ComputerID, &operation.Kind, &operation.Path,
		&operation.TaskID, &operation.ProviderID, &operation.Branch, &operation.State, &operation.NodeID, &operation.NodeGeneration,
		&attempt, &operation.LeaseTokenHash, &leaseExpires, &created, &updated, &expires, &result, &operation.ResultSHA256,
		&operation.FailureCode, &sequence); err != nil {
		return cloudplane.WorkspaceOperation{}, err
	}
	if attempt < 0 || attempt > cloudplane.MaxAttempts || sequence < 1 || updated.Before(created) || !expires.Equal(created.Add(postgresWorkspaceOperationTTL)) {
		return cloudplane.WorkspaceOperation{}, errors.New("PostgreSQL workspace operation row is invalid")
	}
	operation.Attempt, operation.CreatedSequence = uint8(attempt), uint64(sequence)
	operation.CreatedAt, operation.UpdatedAt, operation.ExpiresAt = created.UTC().Format(time.RFC3339Nano), updated.UTC().Format(time.RFC3339Nano), expires.UTC().Format(time.RFC3339Nano)
	if leaseExpires != nil {
		operation.LeaseExpiresAt = leaseExpires.UTC().Format(time.RFC3339Nano)
	}
	if result != "" {
		if !json.Valid([]byte(result)) {
			return cloudplane.WorkspaceOperation{}, errors.New("PostgreSQL workspace result is invalid")
		}
		operation.Result = json.RawMessage(result)
	}
	if cloudplane.ValidateWorkspaceOperationRequest(cloudplane.WorkspaceOperationRequest{
		ID: operation.ID, Scope: operation.Scope(), ComputerID: operation.ComputerID, Kind: operation.Kind, Path: operation.Path,
		TaskID: operation.TaskID, ProviderID: operation.ProviderID,
	}) != nil || (operation.Kind == cloudplane.WorkspaceOperationGitPush && operation.Branch != "zapvm/"+operation.ID) ||
		(operation.Kind != cloudplane.WorkspaceOperationGitPush && operation.Branch != "") {
		return cloudplane.WorkspaceOperation{}, errors.New("PostgreSQL workspace operation metadata is invalid")
	}
	switch operation.State {
	case cloudplane.WorkspaceOperationPending:
		if operation.NodeID != "" || operation.NodeGeneration != "" || operation.LeaseTokenHash != "" || leaseExpires != nil || operation.Result != nil || operation.ResultSHA256 != "" || operation.FailureCode != "" {
			return cloudplane.WorkspaceOperation{}, errors.New("PostgreSQL pending workspace operation is invalid")
		}
	case cloudplane.WorkspaceOperationLeased:
		if !queueIDPattern.MatchString(operation.NodeID) || !validQueueGeneration(operation.NodeGeneration) || len(operation.LeaseTokenHash) != 64 || leaseExpires == nil || operation.Result != nil || operation.ResultSHA256 != "" || operation.FailureCode != "" {
			return cloudplane.WorkspaceOperation{}, errors.New("PostgreSQL leased workspace operation is invalid")
		}
	case cloudplane.WorkspaceOperationSucceeded:
		_, digest, err := cloudplane.ValidateWorkspaceOperationResult(operation, operation.Result)
		if err != nil {
			return cloudplane.WorkspaceOperation{}, errors.New("PostgreSQL successful workspace result is invalid")
		}
		if digest != operation.ResultSHA256 {
			return cloudplane.WorkspaceOperation{}, errors.New("PostgreSQL successful workspace result digest differs")
		}
		if operation.NodeID != "" || operation.NodeGeneration != "" || operation.LeaseTokenHash != "" || leaseExpires != nil || operation.FailureCode != "" {
			return cloudplane.WorkspaceOperation{}, errors.New("PostgreSQL successful workspace authority is invalid")
		}
	case cloudplane.WorkspaceOperationFailed:
		if !queueFailurePattern.MatchString(operation.FailureCode) || operation.NodeID != "" || operation.NodeGeneration != "" || operation.LeaseTokenHash != "" || leaseExpires != nil || operation.Result != nil || operation.ResultSHA256 != "" {
			return cloudplane.WorkspaceOperation{}, errors.New("PostgreSQL failed workspace operation is invalid")
		}
	default:
		return cloudplane.WorkspaceOperation{}, errors.New("PostgreSQL workspace operation state is invalid")
	}
	if operation.CreatedSequence > math.MaxInt64 {
		return cloudplane.WorkspaceOperation{}, errors.New("PostgreSQL workspace sequence is invalid")
	}
	return operation, nil
}
