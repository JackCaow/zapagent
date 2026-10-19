package controlpostgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"zapvm/internal/cloudplane"
)

func computerStopOperationID(scope cloudplane.Scope, computerID string, epoch, generation uint64) string {
	digest := sha256.Sum256([]byte(scope.TenantID + "\x00" + scope.ProjectID + "\x00" + computerID + "\x00" + strconv.FormatUint(epoch, 10) + "\x00" + strconv.FormatUint(generation, 10)))
	return "stop-" + hex.EncodeToString(digest[:16])
}

// RequestAgentComputerLifecycle exposes only runtime lifecycle controls. The
// provision ledger remains configuration-owned, so an administrator cannot
// create or delete a Computer behind the declarative Control configuration.
func (queue *Queue) RequestAgentComputerLifecycle(ctx context.Context, principal string, scope cloudplane.Scope, computerID, action string) (cloudplane.AgentComputerLifecycle, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.AgentComputerLifecycle{}, err
	}
	if queue.placementMode != cloudplane.PlacementModeDynamic || scope.Validate() != nil || !queueIDPattern.MatchString(computerID) || !cloudplane.ValidPrincipal(principal) {
		return cloudplane.AgentComputerLifecycle{}, cloudplane.ErrUnauthorized
	}
	if action != cloudplane.ComputerLifecycleWake && action != cloudplane.ComputerLifecycleRelease {
		return cloudplane.AgentComputerLifecycle{}, errors.New("invalid Computer lifecycle action")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.AgentComputerLifecycle{}, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	if err := queue.reconcileComputerRuntimes(ctx, transaction, now); err != nil {
		return cloudplane.AgentComputerLifecycle{}, err
	}
	var exists bool
	if err := transaction.QueryRow(ctx, `SELECT EXISTS (
SELECT 1 FROM zapvm.computers WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3)`, scope.TenantID, scope.ProjectID, computerID).Scan(&exists); err != nil {
		return cloudplane.AgentComputerLifecycle{}, databaseFailure("inspect PostgreSQL Computer lifecycle authority", err)
	}
	if !exists {
		return cloudplane.AgentComputerLifecycle{}, cloudplane.ErrNotFound
	}

	result := cloudplane.AgentComputerLifecycle{Action: action}
	if action == cloudplane.ComputerLifecycleWake {
		placement, ready, err := queue.ensureDynamicPlacement(ctx, transaction, scope, computerID, now)
		if err != nil {
			return cloudplane.AgentComputerLifecycle{}, err
		}
		if !ready {
			return cloudplane.AgentComputerLifecycle{}, cloudplane.ErrUnavailable
		}
		started, failure, err := queue.ensureComputerStartOperation(ctx, transaction, scope, computerID, placement, now)
		if err != nil {
			return cloudplane.AgentComputerLifecycle{}, err
		}
		if failure != "" {
			return cloudplane.AgentComputerLifecycle{}, cloudplane.ErrUnavailable
		}
		result.OperationID = computerStartOperationID(scope, computerID, placement.epoch)
		result.Accepted = !started
		outcome := "pending"
		if started {
			outcome = "ready"
		}
		if _, err := appendAudit(ctx, transaction, now, auditInput{action: "computer_wake", scope: scope, nodeID: placement.nodeID, operationID: result.OperationID, principal: principal, outcome: outcome}); err != nil {
			return cloudplane.AgentComputerLifecycle{}, err
		}
	} else {
		result, err = queue.requestComputerRelease(ctx, transaction, principal, scope, computerID, now)
		if err != nil {
			return cloudplane.AgentComputerLifecycle{}, err
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.AgentComputerLifecycle{}, databaseFailure("commit PostgreSQL Computer lifecycle request", err)
	}
	return result, nil
}

func (queue *Queue) requestComputerRelease(ctx context.Context, transaction pgx.Tx, principal string, scope cloudplane.Scope, computerID string, now time.Time) (cloudplane.AgentComputerLifecycle, error) {
	result := cloudplane.AgentComputerLifecycle{Action: cloudplane.ComputerLifecycleRelease}
	var nodeID, nodeGeneration, startState string
	var epoch int64
	var hasActiveTasks bool
	err := transaction.QueryRow(ctx, `
SELECT placement.node_id,placement.node_generation,placement.epoch,
       COALESCE((SELECT operation.state FROM zapvm.computer_operations AS operation
                 WHERE operation.tenant_id=placement.tenant_id AND operation.project_id=placement.project_id
                   AND operation.computer_id=placement.computer_id AND operation.placement_epoch=placement.epoch
                   AND operation.kind='start' ORDER BY operation.created_at DESC LIMIT 1),''),
       EXISTS (SELECT 1 FROM zapvm.tasks AS task
               WHERE task.tenant_id=placement.tenant_id AND task.project_id=placement.project_id
                 AND task.computer_id=placement.computer_id AND task.placement_epoch=placement.epoch
                 AND task.state IN ('leased','running','canceling'))
FROM zapvm.computer_placements AS placement
WHERE placement.tenant_id=$1 AND placement.project_id=$2 AND placement.computer_id=$3 AND placement.state='ready'
FOR UPDATE OF placement`, scope.TenantID, scope.ProjectID, computerID).Scan(&nodeID, &nodeGeneration, &epoch, &startState, &hasActiveTasks)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err := appendAudit(ctx, transaction, now, auditInput{action: "computer_release", scope: scope, principal: principal, outcome: "already_released"}); err != nil {
			return cloudplane.AgentComputerLifecycle{}, err
		}
		return result, nil
	}
	if err != nil {
		return cloudplane.AgentComputerLifecycle{}, databaseFailure("lock PostgreSQL Computer release placement", err)
	}
	if epoch < 1 || hasActiveTasks || startState != cloudplane.ComputerOperationSucceeded {
		return cloudplane.AgentComputerLifecycle{}, cloudplane.ErrConflict
	}
	var existingID string
	err = transaction.QueryRow(ctx, `SELECT id FROM zapvm.computer_operations
WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3 AND placement_epoch=$4 AND kind='stop'
  AND state IN ('pending','leased') ORDER BY created_at DESC LIMIT 1`, scope.TenantID, scope.ProjectID, computerID, epoch).Scan(&existingID)
	if err == nil {
		result.Accepted = true
		result.OperationID = existingID
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.AgentComputerLifecycle{}, databaseFailure("inspect PostgreSQL Computer release operation", err)
	}
	var stateGeneration int64
	if err := transaction.QueryRow(ctx, `
UPDATE zapvm.computer_runtime SET state_generation=state_generation+1,observed_state='unavailable',
    failure_code='computer_stopping',updated_at=$1
WHERE tenant_id=$2 AND project_id=$3 AND computer_id=$4 AND placement_epoch=$5
RETURNING state_generation`, now, scope.TenantID, scope.ProjectID, computerID, epoch).Scan(&stateGeneration); err != nil || stateGeneration < 1 {
		return cloudplane.AgentComputerLifecycle{}, databaseFailure("advance PostgreSQL Computer release generation", err)
	}
	operationID := computerStopOperationID(scope, computerID, uint64(epoch), uint64(stateGeneration))
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.computer_operations
    (id,tenant_id,project_id,computer_id,placement_epoch,kind,state,deadline_at,created_at,updated_at)
VALUES ($1,$2,$3,$4,$5,'stop','pending',$6,$7,$7)`, operationID, scope.TenantID, scope.ProjectID, computerID, epoch, now.Add(queue.computerStartTimeout), now); err != nil {
		return cloudplane.AgentComputerLifecycle{}, databaseFailure("create PostgreSQL Computer release operation", err)
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: "computer_release", scope: scope, nodeID: nodeID, operationID: operationID, principal: principal, outcome: "pending"}); err != nil {
		return cloudplane.AgentComputerLifecycle{}, err
	}
	result.Accepted = true
	result.OperationID = operationID
	_ = nodeGeneration // placement fencing is enforced when the Node claims.
	return result, nil
}
