package controlpostgres

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"zapvm/internal/cloudplane"
)

const maximumComputerOperationBatch = 16

func computerStartOperationID(scope cloudplane.Scope, computerID string, epoch uint64) string {
	digest := sha256.Sum256([]byte(scope.TenantID + "\x00" + scope.ProjectID + "\x00" + computerID + "\x00" + strconv.FormatUint(epoch, 10)))
	return "start-" + hex.EncodeToString(digest[:16])
}

func (queue *Queue) ensureComputerStartOperation(ctx context.Context, transaction pgx.Tx, scope cloudplane.Scope, computerID string, placement computerPlacement, now time.Time) (bool, string, error) {
	if queue.placementMode != cloudplane.PlacementModeDynamic || placement.epoch == 0 {
		return true, "", nil
	}
	operation, err := scanComputerOperation(transaction.QueryRow(ctx, `
SELECT `+computerOperationColumns+` FROM zapvm.computer_operations
WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3 AND placement_epoch=$4 AND kind='start'
ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, scope.TenantID, scope.ProjectID, computerID, int64(placement.epoch)))
	if err == nil {
		switch operation.State {
		case cloudplane.ComputerOperationSucceeded:
			return true, "", nil
		case cloudplane.ComputerOperationFailed:
			return false, operation.FailureCode, nil
		default:
			return false, "", nil
		}
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, "", databaseFailure("inspect PostgreSQL Computer start operation", err)
	}
	operationID := computerStartOperationID(scope, computerID, placement.epoch)
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.computer_operations
    (id,tenant_id,project_id,computer_id,placement_epoch,kind,state,deadline_at,created_at,updated_at)
VALUES ($1,$2,$3,$4,$5,'start','pending',$6,$7,$7)`, operationID, scope.TenantID, scope.ProjectID, computerID, int64(placement.epoch), now.Add(queue.computerStartTimeout), now); err != nil {
		return false, "", databaseFailure("create PostgreSQL Computer start operation", err)
	}
	if _, err := transaction.Exec(ctx, `
UPDATE zapvm.computer_runtime SET observed_state='unavailable',failure_code=NULL,updated_at=$1
WHERE tenant_id=$2 AND project_id=$3 AND computer_id=$4 AND placement_epoch=$5`, now, scope.TenantID, scope.ProjectID, computerID, int64(placement.epoch)); err != nil {
		return false, "", databaseFailure("mark PostgreSQL Computer starting", err)
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: "computer_start_submit", scope: scope, nodeID: placement.nodeID, operationID: operationID, outcome: "pending"}); err != nil {
		return false, "", err
	}
	return false, "", nil
}

func (queue *Queue) ClaimComputerOperations(ctx context.Context, nodeID, generation string, maximum int) ([]cloudplane.ComputerOperationLease, error) {
	if err := queue.validateCall(ctx); err != nil {
		return nil, err
	}
	if queue.placementMode != cloudplane.PlacementModeDynamic {
		return []cloudplane.ComputerOperationLease{}, nil
	}
	if !queueIDPattern.MatchString(nodeID) || !validQueueGeneration(generation) || maximum < 1 || maximum > maximumComputerOperationBatch {
		return nil, errors.New("PostgreSQL Computer operation claim authority is invalid")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	if err := queue.sweepComputerOperations(ctx, transaction, now); err != nil {
		return nil, err
	}
	var nodeState, daemonState string
	var lastHeartbeat time.Time
	if err := transaction.QueryRow(ctx, `SELECT state,daemon_state,last_heartbeat FROM zapvm.nodes WHERE id=$1 AND generation=$2 FOR UPDATE`, nodeID, generation).Scan(&nodeState, &daemonState, &lastHeartbeat); errors.Is(err, pgx.ErrNoRows) {
		return nil, cloudplane.ErrFenced
	} else if err != nil {
		return nil, databaseFailure("lock PostgreSQL Computer operation Node", err)
	}
	if nodeState != cloudplane.NodeOnline || now.Sub(lastHeartbeat) > queue.heartbeatTTL || (daemonState != cloudplane.DaemonUnknown && daemonState != cloudplane.DaemonHealthy) {
		return nil, cloudplane.ErrUnavailable
	}
	if err := queue.reconcileNodeResourceCounters(ctx, transaction, nodeID, now); err != nil {
		return nil, err
	}
	var slots, starting, running int
	if err := transaction.QueryRow(ctx, `SELECT vm_slots,starting_count,running_count FROM zapvm.node_resources WHERE node_id=$1 FOR UPDATE`, nodeID).Scan(&slots, &starting, &running); errors.Is(err, pgx.ErrNoRows) {
		return nil, cloudplane.ErrUnavailable
	} else if err != nil {
		return nil, databaseFailure("lock PostgreSQL Computer operation resources", err)
	}
	available := slots - starting - running
	if available < 0 {
		available = 0
	}
	operations := make([]cloudplane.ComputerOperation, 0, maximum)
	loadPending := func(kind string, limit int) error {
		if limit <= 0 {
			return nil
		}
		rows, err := transaction.Query(ctx, `
SELECT `+prefixedComputerOperationColumns("operation")+`
FROM zapvm.computer_operations AS operation
JOIN zapvm.computer_placements AS placement
  ON placement.tenant_id=operation.tenant_id AND placement.project_id=operation.project_id
  AND placement.computer_id=operation.computer_id AND placement.epoch=operation.placement_epoch
  AND placement.node_id=$1 AND placement.node_generation=$2 AND placement.state='ready'
WHERE operation.state='pending' AND operation.kind=$4 AND operation.attempt<10 AND operation.deadline_at>$3
ORDER BY operation.created_at,operation.id
FOR UPDATE OF operation,placement SKIP LOCKED LIMIT $5`, nodeID, generation, now, kind, limit)
		if err != nil {
			return databaseFailure("select PostgreSQL Computer operations", err)
		}
		defer rows.Close()
		for rows.Next() {
			operation, err := scanComputerOperation(rows)
			if err != nil {
				return errors.New("decode PostgreSQL Computer operation candidate")
			}
			operations = append(operations, operation)
		}
		if err := rows.Err(); err != nil {
			return errors.New("read PostgreSQL Computer operation candidates")
		}
		return nil
	}
	// Releases free capacity and therefore remain claimable even when every VM
	// slot is occupied. Starts are capped by the remaining slot count.
	if err := loadPending(cloudplane.ComputerOperationStop, maximum); err != nil {
		return nil, err
	}
	remaining := maximum - len(operations)
	if remaining > available {
		remaining = available
	}
	if err := loadPending(cloudplane.ComputerOperationStart, remaining); err != nil {
		return nil, err
	}
	leases := make([]cloudplane.ComputerOperationLease, 0, len(operations))
	for _, operation := range operations {
		tokenBytes := make([]byte, 32)
		if _, err := io.ReadFull(queue.random, tokenBytes); err != nil {
			return nil, errors.New("generate PostgreSQL Computer operation lease token")
		}
		token := base64.RawURLEncoding.EncodeToString(tokenBytes)
		digest := sha256.Sum256([]byte(token))
		deadline, err := time.Parse(time.RFC3339Nano, operation.DeadlineAt)
		if err != nil {
			return nil, errors.New("decode PostgreSQL Computer operation deadline")
		}
		leaseExpiry := now.Add(queue.computerStartTimeout)
		if deadline.Before(leaseExpiry) {
			leaseExpiry = deadline
		}
		updated, err := scanComputerOperation(transaction.QueryRow(ctx, `
UPDATE zapvm.computer_operations SET state='leased',node_id=$1,node_generation=$2,attempt=attempt+1,
    lease_token_hash=$3,lease_expires_at=$4,updated_at=$5
WHERE id=$6 AND state='pending' RETURNING `+computerOperationColumns,
			nodeID, generation, digest[:], leaseExpiry, now, operation.ID))
		if err != nil {
			return nil, databaseFailure("lease PostgreSQL Computer start operation", err)
		}
		if _, err := appendAudit(ctx, transaction, now, auditInput{action: "computer_start_claim", scope: updated.Scope(), nodeID: nodeID, operationID: updated.ID, outcome: "leased"}); err != nil {
			return nil, err
		}
		lease := cloudplane.ComputerOperationLease{Operation: updated, LeaseToken: token}
		if updated.Kind == cloudplane.ComputerOperationStart {
			var agent string
			var cpu uint
			var memoryBytes uint64
			err := transaction.QueryRow(ctx, `
SELECT agent,vcpu,memory_bytes FROM zapvm.computer_profiles
JOIN zapvm.computers USING (tenant_id,project_id,computer_id)
WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3`, updated.TenantID, updated.ProjectID, updated.ComputerID).Scan(&agent, &cpu, &memoryBytes)
			if err == nil {
				lease.Provision = &cloudplane.ComputerProvisionSpec{Agent: agent, CPUCount: cpu, MemoryMiB: memoryBytes / (1 << 20)}
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return nil, databaseFailure("resolve Computer provision", err)
			}
		}
		leases = append(leases, lease)
	}
	if err := queue.reconcileNodeResourceCounters(ctx, transaction, nodeID, now); err != nil {
		return nil, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return nil, databaseFailure("commit PostgreSQL Computer operation claim", err)
	}
	return leases, nil
}

func (queue *Queue) CompleteComputerOperation(ctx context.Context, nodeID, generation, operationID, leaseToken string, completion cloudplane.ComputerOperationCompletion) (cloudplane.ComputerOperation, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.ComputerOperation{}, err
	}
	if !queueIDPattern.MatchString(nodeID) || !validQueueGeneration(generation) || !queueIDPattern.MatchString(operationID) || validateQueueToken(leaseToken) != nil {
		return cloudplane.ComputerOperation{}, errors.New("PostgreSQL Computer operation completion authority is invalid")
	}
	if completion.Succeeded {
		if completion.FailureCode != "" {
			return cloudplane.ComputerOperation{}, errors.New("successful Computer operation cannot contain a failure code")
		}
	} else if !queueFailurePattern.MatchString(completion.FailureCode) {
		return cloudplane.ComputerOperation{}, errors.New("failed Computer operation requires a canonical failure code")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.ComputerOperation{}, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	operation, err := scanComputerOperation(transaction.QueryRow(ctx, `SELECT `+computerOperationColumns+` FROM zapvm.computer_operations WHERE id=$1 FOR UPDATE`, operationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.ComputerOperation{}, cloudplane.ErrFenced
	}
	if err != nil {
		return cloudplane.ComputerOperation{}, databaseFailure("lock PostgreSQL Computer operation completion", err)
	}
	// Completion is retry-safe when the Node lost the successful HTTP response.
	// Keep the lease-token digest on terminal operations so the same authenticated
	// Node generation can replay only the identical terminal transition.
	if operation.State == cloudplane.ComputerOperationSucceeded || operation.State == cloudplane.ComputerOperationFailed {
		replayedSuccess := operation.State == cloudplane.ComputerOperationSucceeded
		if operation.NodeID == nodeID && operation.NodeGeneration == generation && queueTokenMatches(operation.LeaseTokenHash, leaseToken) &&
			replayedSuccess == completion.Succeeded && operation.FailureCode == completion.FailureCode {
			return operation, nil
		}
		return cloudplane.ComputerOperation{}, cloudplane.ErrFenced
	}
	if operation.State != cloudplane.ComputerOperationLeased || operation.NodeID != nodeID || operation.NodeGeneration != generation || !queueTokenMatches(operation.LeaseTokenHash, leaseToken) {
		return cloudplane.ComputerOperation{}, cloudplane.ErrFenced
	}
	leaseExpiry, parseErr := time.Parse(time.RFC3339Nano, operation.LeaseExpiresAt)
	deadline, deadlineErr := time.Parse(time.RFC3339Nano, operation.DeadlineAt)
	if parseErr != nil || deadlineErr != nil || !leaseExpiry.After(now) || !deadline.After(now) {
		return cloudplane.ComputerOperation{}, cloudplane.ErrFenced
	}
	var placementReady bool
	if err := transaction.QueryRow(ctx, `SELECT EXISTS (
SELECT 1 FROM zapvm.computer_placements WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3
  AND epoch=$4 AND node_id=$5 AND node_generation=$6 AND state='ready')`, operation.TenantID, operation.ProjectID, operation.ComputerID, int64(operation.PlacementEpoch), nodeID, generation).Scan(&placementReady); err != nil {
		return cloudplane.ComputerOperation{}, databaseFailure("inspect PostgreSQL Computer operation placement", err)
	}
	if !placementReady {
		return cloudplane.ComputerOperation{}, cloudplane.ErrFenced
	}
	state, failureCode := cloudplane.ComputerOperationSucceeded, ""
	if !completion.Succeeded {
		state, failureCode = cloudplane.ComputerOperationFailed, completion.FailureCode
	}
	updated, err := scanComputerOperation(transaction.QueryRow(ctx, `
UPDATE zapvm.computer_operations SET state=$1,lease_expires_at=NULL,
    completed_at=$2,updated_at=$2,failure_code=NULLIF($3,'')
WHERE id=$4 RETURNING `+computerOperationColumns, state, now, failureCode, operation.ID))
	if err != nil {
		return cloudplane.ComputerOperation{}, databaseFailure("complete PostgreSQL Computer start operation", err)
	}
	observedState := cloudplane.ComputerObservedReady
	if operation.Kind == cloudplane.ComputerOperationStop || !completion.Succeeded {
		observedState = cloudplane.ComputerObservedDegraded
	}
	if operation.Kind == cloudplane.ComputerOperationStop && completion.Succeeded {
		observedState = cloudplane.ComputerObservedUnavailable
		failureCode = "computer_idle_stopped"
	}
	if _, err := transaction.Exec(ctx, `
UPDATE zapvm.computer_runtime SET observed_state=$1,failure_code=NULLIF($2,''),updated_at=$3
WHERE tenant_id=$4 AND project_id=$5 AND computer_id=$6 AND placement_epoch=$7`, observedState, failureCode, now,
		operation.TenantID, operation.ProjectID, operation.ComputerID, int64(operation.PlacementEpoch)); err != nil {
		return cloudplane.ComputerOperation{}, databaseFailure("complete PostgreSQL Computer runtime start", err)
	}
	if operation.Kind == cloudplane.ComputerOperationStart && !completion.Succeeded {
		if err := queue.releasePlacementAfterComputerOperationFailure(ctx, transaction, operation, failureCode, now); err != nil {
			return cloudplane.ComputerOperation{}, err
		}
	}
	if operation.Kind == cloudplane.ComputerOperationStop && completion.Succeeded {
		if _, err := transaction.Exec(ctx, `
UPDATE zapvm.computer_placements SET state='released',reason='admin_release',released_at=$1
WHERE tenant_id=$2 AND project_id=$3 AND computer_id=$4 AND epoch=$5 AND state='ready'`, now,
			operation.TenantID, operation.ProjectID, operation.ComputerID, int64(operation.PlacementEpoch)); err != nil {
			return cloudplane.ComputerOperation{}, databaseFailure("release PostgreSQL Computer placement after stop", err)
		}
		if _, err := transaction.Exec(ctx, `
UPDATE zapvm.computer_runtime SET assigned_node_id=NULL,updated_at=$1
WHERE tenant_id=$2 AND project_id=$3 AND computer_id=$4 AND placement_epoch=$5`, now,
			operation.TenantID, operation.ProjectID, operation.ComputerID, int64(operation.PlacementEpoch)); err != nil {
			return cloudplane.ComputerOperation{}, databaseFailure("clear PostgreSQL Computer placement after stop", err)
		}
	}
	if operation.Kind == cloudplane.ComputerOperationStart && completion.Succeeded {
		if _, err := transaction.Exec(ctx, `
UPDATE zapvm.tasks SET queue_reason='dispatch_wait',updated_at=$1
WHERE tenant_id=$2 AND project_id=$3 AND computer_id=$4 AND placement_epoch=$5 AND state='pending'`, now,
			operation.TenantID, operation.ProjectID, operation.ComputerID, int64(operation.PlacementEpoch)); err != nil {
			return cloudplane.ComputerOperation{}, databaseFailure("release PostgreSQL Tasks after Computer start", err)
		}
	}
	if err := queue.reconcileNodeResourceCounters(ctx, transaction, nodeID, now); err != nil {
		return cloudplane.ComputerOperation{}, err
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: "computer_" + operation.Kind + "_complete", scope: updated.Scope(), nodeID: nodeID, operationID: updated.ID, outcome: updated.State}); err != nil {
		return cloudplane.ComputerOperation{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.ComputerOperation{}, databaseFailure("commit PostgreSQL Computer operation completion", err)
	}
	return updated, nil
}

func (queue *Queue) sweepComputerOperations(ctx context.Context, transaction pgx.Tx, now time.Time) error {
	rows, err := transaction.Query(ctx, `SELECT `+computerOperationColumns+` FROM zapvm.computer_operations
WHERE state IN ('pending','leased') AND (deadline_at<=$1 OR lease_expires_at<=$1) ORDER BY created_at,id FOR UPDATE SKIP LOCKED`, now)
	if err != nil {
		return databaseFailure("lock PostgreSQL expired Computer operations", err)
	}
	operations := make([]cloudplane.ComputerOperation, 0)
	for rows.Next() {
		operation, err := scanComputerOperation(rows)
		if err != nil {
			rows.Close()
			return errors.New("decode expired PostgreSQL Computer operation")
		}
		operations = append(operations, operation)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read expired PostgreSQL Computer operations")
	}
	touchedNodes := make(map[string]struct{})
	for _, operation := range operations {
		deadline, _ := time.Parse(time.RFC3339Nano, operation.DeadlineAt)
		state, failure := cloudplane.ComputerOperationPending, ""
		if !deadline.After(now) {
			state, failure = cloudplane.ComputerOperationFailed, "computer_"+operation.Kind+"_timeout"
		} else if operation.Attempt >= cloudplane.MaxAttempts {
			state, failure = cloudplane.ComputerOperationFailed, "lease_exhausted"
		}
		completedAt := any(nil)
		if state == cloudplane.ComputerOperationFailed {
			completedAt = now
		}
		updated, err := scanComputerOperation(transaction.QueryRow(ctx, `
UPDATE zapvm.computer_operations SET state=$1,node_id=NULL,node_generation=NULL,lease_token_hash=NULL,lease_expires_at=NULL,
    completed_at=$2,failure_code=NULLIF($3,''),updated_at=$4 WHERE id=$5 RETURNING `+computerOperationColumns,
			state, completedAt, failure, now, operation.ID))
		if err != nil {
			return databaseFailure("sweep PostgreSQL Computer operation", err)
		}
		if operation.NodeID != "" {
			touchedNodes[operation.NodeID] = struct{}{}
		}
		if state == cloudplane.ComputerOperationFailed {
			if _, err := transaction.Exec(ctx, `
UPDATE zapvm.computer_runtime SET observed_state='degraded',failure_code=$1,updated_at=$2
WHERE tenant_id=$3 AND project_id=$4 AND computer_id=$5 AND placement_epoch=$6`, failure, now,
				operation.TenantID, operation.ProjectID, operation.ComputerID, int64(operation.PlacementEpoch)); err != nil {
				return databaseFailure("fail timed out PostgreSQL Computer runtime", err)
			}
			if operation.Kind == cloudplane.ComputerOperationStart {
				if err := queue.releasePlacementAfterComputerOperationFailure(ctx, transaction, updated, failure, now); err != nil {
					return err
				}
			}
		}
		if _, err := appendAudit(ctx, transaction, now, auditInput{action: "computer_" + operation.Kind + "_sweep", scope: updated.Scope(), nodeID: operation.NodeID, operationID: updated.ID, outcome: updated.State}); err != nil {
			return err
		}
	}
	for nodeID := range touchedNodes {
		if err := queue.reconcileNodeResourceCounters(ctx, transaction, nodeID, now); err != nil {
			return err
		}
	}
	return nil
}

func (queue *Queue) reconcileNodeResourceCounters(ctx context.Context, transaction pgx.Tx, nodeID string, now time.Time) error {
	if _, err := transaction.Exec(ctx, `
UPDATE zapvm.node_resources AS resources SET
    starting_count=(SELECT count(*) FROM zapvm.computer_operations WHERE node_id=$1 AND kind='start' AND state='leased'),
    running_count=(
      SELECT count(*) FROM zapvm.computer_placements AS placement
      WHERE placement.node_id=$1 AND placement.state='ready' AND EXISTS (
        SELECT 1 FROM zapvm.computer_operations AS operation
        WHERE operation.tenant_id=placement.tenant_id AND operation.project_id=placement.project_id
          AND operation.computer_id=placement.computer_id AND operation.placement_epoch=placement.epoch
          AND operation.kind='start' AND operation.state='succeeded'
      )
    ),updated_at=$2
WHERE node_id=$1`, nodeID, now); err != nil {
		return databaseFailure("reconcile PostgreSQL Node Computer resources", err)
	}
	return nil
}

func (queue *Queue) failComputerOperationsForPlacement(ctx context.Context, transaction pgx.Tx, scope cloudplane.Scope, computerID string, epoch int64, now time.Time) error {
	if _, err := transaction.Exec(ctx, `
UPDATE zapvm.computer_operations SET state='failed',node_id=NULL,node_generation=NULL,
    lease_token_hash=NULL,lease_expires_at=NULL,completed_at=$1,failure_code='placement_released',updated_at=$1
WHERE tenant_id=$2 AND project_id=$3 AND computer_id=$4 AND placement_epoch=$5
  AND state IN ('pending','leased')`, now, scope.TenantID, scope.ProjectID, computerID, epoch); err != nil {
		return databaseFailure("fence PostgreSQL Computer operations for released placement", err)
	}
	return nil
}

func (queue *Queue) releasePlacementAfterComputerOperationFailure(ctx context.Context, transaction pgx.Tx, operation cloudplane.ComputerOperation, failureCode string, now time.Time) error {
	command, err := transaction.Exec(ctx, `
UPDATE zapvm.computer_placements SET state='released',reason='start_failed',released_at=$1
WHERE tenant_id=$2 AND project_id=$3 AND computer_id=$4 AND epoch=$5 AND state='ready'`, now,
		operation.TenantID, operation.ProjectID, operation.ComputerID, int64(operation.PlacementEpoch))
	if err != nil {
		return databaseFailure("release PostgreSQL Computer placement after start failure", err)
	}
	if command.RowsAffected() == 0 {
		return nil
	}
	if _, err := transaction.Exec(ctx, `
UPDATE zapvm.computer_runtime SET observed_state='degraded',assigned_node_id=NULL,failure_code=$1,updated_at=$2
WHERE tenant_id=$3 AND project_id=$4 AND computer_id=$5 AND placement_epoch=$6`, failureCode, now,
		operation.TenantID, operation.ProjectID, operation.ComputerID, int64(operation.PlacementEpoch)); err != nil {
		return databaseFailure("clear PostgreSQL Computer placement after start failure", err)
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: "computer_placement_release", scope: operation.Scope(), nodeID: operation.NodeID, operationID: operation.ID, outcome: "start_failed"}); err != nil {
		return err
	}
	return nil
}

const computerOperationColumns = `
id,tenant_id,project_id,computer_id,placement_epoch,kind,state,COALESCE(node_id,''),COALESCE(node_generation,''),attempt,
COALESCE(encode(lease_token_hash,'hex'),''),lease_expires_at,deadline_at,created_at,updated_at,completed_at,COALESCE(failure_code,'')`

func prefixedComputerOperationColumns(prefix string) string {
	return prefix + `.id,` + prefix + `.tenant_id,` + prefix + `.project_id,` + prefix + `.computer_id,` + prefix + `.placement_epoch,` + prefix + `.kind,` + prefix + `.state,` +
		`COALESCE(` + prefix + `.node_id,''),COALESCE(` + prefix + `.node_generation,''),` + prefix + `.attempt,COALESCE(encode(` + prefix + `.lease_token_hash,'hex'),''),` +
		prefix + `.lease_expires_at,` + prefix + `.deadline_at,` + prefix + `.created_at,` + prefix + `.updated_at,` + prefix + `.completed_at,COALESCE(` + prefix + `.failure_code,'')`
}

func scanComputerOperation(row pgx.Row) (cloudplane.ComputerOperation, error) {
	var operation cloudplane.ComputerOperation
	var epoch int64
	var attempt int16
	var leaseExpiry, completedAt *time.Time
	var deadline, createdAt, updatedAt time.Time
	if err := row.Scan(&operation.ID, &operation.TenantID, &operation.ProjectID, &operation.ComputerID, &epoch, &operation.Kind, &operation.State,
		&operation.NodeID, &operation.NodeGeneration, &attempt, &operation.LeaseTokenHash, &leaseExpiry, &deadline, &createdAt, &updatedAt, &completedAt, &operation.FailureCode); err != nil {
		return cloudplane.ComputerOperation{}, err
	}
	if epoch < 1 || attempt < 0 || attempt > int16(cloudplane.MaxAttempts) {
		return cloudplane.ComputerOperation{}, errors.New("PostgreSQL Computer operation row is invalid")
	}
	operation.PlacementEpoch = uint64(epoch)
	operation.Attempt = uint8(attempt)
	operation.DeadlineAt = deadline.UTC().Format(time.RFC3339Nano)
	operation.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	operation.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	if leaseExpiry != nil {
		operation.LeaseExpiresAt = leaseExpiry.UTC().Format(time.RFC3339Nano)
	}
	if completedAt != nil {
		operation.CompletedAt = completedAt.UTC().Format(time.RFC3339Nano)
	}
	return operation, nil
}
