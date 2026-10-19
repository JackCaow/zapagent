package controlpostgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"math"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"zapvm/internal/cloudplane"
)

func (queue *Queue) RegisterNodeWithReport(ctx context.Context, nodeID, generation string, report cloudplane.NodeReport) (cloudplane.Node, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.Node{}, err
	}
	if !queueIDPattern.MatchString(nodeID) || !validQueueGeneration(generation) {
		return cloudplane.Node{}, errors.New("PostgreSQL Node registration authority is invalid")
	}
	report, err := cloudplane.NormalizeNodeReport(report)
	if err != nil {
		return cloudplane.Node{}, err
	}
	if !queueNodeReportFitsPostgreSQL(report) {
		return cloudplane.Node{}, errors.New("PostgreSQL Node report counters exceed bigint")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.Node{}, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC()
	var currentGeneration string
	if err := transaction.QueryRow(ctx, `SELECT generation FROM zapvm.nodes WHERE id=$1 FOR UPDATE`, nodeID).Scan(&currentGeneration); errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.Node{}, cloudplane.ErrUnauthorized
	} else if err != nil {
		return cloudplane.Node{}, databaseFailure("lock PostgreSQL Node registration", err)
	}
	if currentGeneration != generation {
		if err := queue.fenceGeneration(ctx, transaction, nodeID, currentGeneration, now); err != nil {
			return cloudplane.Node{}, err
		}
	}
	node, err := updateQueueNode(ctx, transaction, nodeID, generation, cloudplane.NodeOnline, now, report)
	if err != nil {
		return cloudplane.Node{}, err
	}
	if err := queue.reconcileReportedComputerRuntimes(ctx, transaction, nodeID, generation, report, now); err != nil {
		return cloudplane.Node{}, err
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: "node_register", nodeID: nodeID, outcome: "success"}); err != nil {
		return cloudplane.Node{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.Node{}, databaseFailure("commit PostgreSQL Node registration", err)
	}
	return node, nil
}

func (queue *Queue) HeartbeatWithReport(ctx context.Context, nodeID, generation string, proofs []cloudplane.LeaseProof, report cloudplane.NodeReport) (cloudplane.Node, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.Node{}, err
	}
	if !queueIDPattern.MatchString(nodeID) || !validQueueGeneration(generation) || len(proofs) > queueMaximumBatch {
		return cloudplane.Node{}, errors.New("PostgreSQL Node heartbeat authority is invalid")
	}
	report, err := cloudplane.NormalizeNodeReport(report)
	if err != nil {
		return cloudplane.Node{}, err
	}
	if !queueNodeReportFitsPostgreSQL(report) {
		return cloudplane.Node{}, errors.New("PostgreSQL Node report counters exceed bigint")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.Node{}, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC()
	var state string
	if err := transaction.QueryRow(ctx, `SELECT state FROM zapvm.nodes WHERE id=$1 AND generation=$2 FOR UPDATE`, nodeID, generation).Scan(&state); errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.Node{}, cloudplane.ErrFenced
	} else if err != nil {
		return cloudplane.Node{}, databaseFailure("lock PostgreSQL Node heartbeat", err)
	}
	if err := renewQueueProofs(ctx, transaction, now, queue.leaseTTL, nodeID, generation, proofs); err != nil {
		return cloudplane.Node{}, err
	}
	if state == cloudplane.NodeOffline {
		state = cloudplane.NodeOnline
	}
	node, err := updateQueueNode(ctx, transaction, nodeID, generation, state, now, report)
	if err != nil {
		return cloudplane.Node{}, err
	}
	if err := queue.reconcileReportedComputerRuntimes(ctx, transaction, nodeID, generation, report, now); err != nil {
		return cloudplane.Node{}, err
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: "node_heartbeat", nodeID: nodeID, outcome: "success"}); err != nil {
		return cloudplane.Node{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.Node{}, databaseFailure("commit PostgreSQL Node heartbeat", err)
	}
	return node, nil
}

func (queue *Queue) SetNodeDraining(ctx context.Context, nodeID, generation string, draining bool) (cloudplane.Node, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.Node{}, err
	}
	if !queueIDPattern.MatchString(nodeID) || !validQueueGeneration(generation) {
		return cloudplane.Node{}, errors.New("PostgreSQL Node drain authority is invalid")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.Node{}, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC()
	state := cloudplane.NodeOnline
	if draining {
		state = cloudplane.NodeDraining
	}
	row := transaction.QueryRow(ctx, `
UPDATE zapvm.nodes SET state=$1,last_heartbeat=$2,updated_at=$2
WHERE id=$3 AND generation=$4 AND state<>'offline'
RETURNING `+queueNodeColumns, state, now, nodeID, generation)
	node, err := scanQueueNode(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.Node{}, cloudplane.ErrFenced
	}
	if err != nil {
		return cloudplane.Node{}, databaseFailure("update PostgreSQL Node drain state", err)
	}
	if err := loadQueueNodeScopes(ctx, transaction, &node); err != nil {
		return cloudplane.Node{}, err
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: "node_drain", nodeID: nodeID, outcome: state}); err != nil {
		return cloudplane.Node{}, err
	}
	if draining {
		if err := queue.releaseIdleDynamicPlacements(ctx, transaction, nodeID, generation, "node_draining", now); err != nil {
			return cloudplane.Node{}, err
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.Node{}, databaseFailure("commit PostgreSQL Node drain state", err)
	}
	return node, nil
}

func (queue *Queue) ListNodes(ctx context.Context) ([]cloudplane.Node, error) {
	if err := queue.validateCall(ctx); err != nil {
		return nil, err
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollbackBounded(transaction)
	rows, err := transaction.Query(ctx, `SELECT `+queueNodeColumns+` FROM zapvm.nodes ORDER BY id`)
	if err != nil {
		return nil, databaseFailure("list PostgreSQL Nodes", err)
	}
	nodes := make([]cloudplane.Node, 0)
	for rows.Next() {
		node, err := scanQueueNode(rows)
		if err != nil {
			rows.Close()
			return nil, errors.New("decode PostgreSQL Node")
		}
		nodes = append(nodes, node)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, errors.New("read PostgreSQL Nodes")
	}
	for index := range nodes {
		if err := loadQueueNodeScopes(ctx, transaction, &nodes[index]); err != nil {
			return nil, err
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return nil, databaseFailure("commit PostgreSQL Node list", err)
	}
	return nodes, nil
}

func renewQueueProofs(ctx context.Context, transaction pgx.Tx, now time.Time, leaseTTL time.Duration, nodeID, generation string, proofs []cloudplane.LeaseProof) error {
	seen := make(map[string]struct{}, len(proofs))
	for _, proof := range proofs {
		if _, duplicate := seen[proof.TaskID]; duplicate {
			return errors.New("PostgreSQL heartbeat contains duplicate Tasks")
		}
		seen[proof.TaskID] = struct{}{}
		if !queueIDPattern.MatchString(proof.TaskID) || validateQueueToken(proof.LeaseToken) != nil {
			return errors.New("PostgreSQL heartbeat proof is invalid")
		}
		digest := sha256Bytes(proof.LeaseToken)
		command, err := transaction.Exec(ctx, `
UPDATE zapvm.tasks SET lease_expires_at=$1,updated_at=$2
WHERE id=$3 AND node_id=$4 AND node_generation=$5 AND state IN ('leased','running','canceling')
  AND lease_token_hash=$6 AND lease_expires_at>$2`, now.Add(leaseTTL), now, proof.TaskID, nodeID, generation, digest)
		if err != nil {
			return databaseFailure("renew PostgreSQL heartbeat Task lease", err)
		}
		if command.RowsAffected() != 1 {
			return cloudplane.ErrFenced
		}
	}
	return nil
}

func updateQueueNode(ctx context.Context, transaction pgx.Tx, nodeID, generation, state string, now time.Time, report cloudplane.NodeReport) (cloudplane.Node, error) {
	row := transaction.QueryRow(ctx, `
UPDATE zapvm.nodes SET generation=$1,state=$2,last_heartbeat=$3,node_version=NULLIF($4,''),daemon_version=NULLIF($5,''),
    image_digest=CASE WHEN $6='' THEN NULL ELSE decode($6,'hex') END,daemon_state=$7,failure_code=NULLIF($8,''),
    start_attempts=$9,start_failures=$10,start_duration_ms_total=$11,start_duration_ms_max=$12,updated_at=$3,
    in_flight=(SELECT count(*) FROM zapvm.tasks WHERE node_id=$13 AND node_generation=$1 AND state IN ('leased','running','canceling'))
        +(SELECT count(*) FROM zapvm.workspace_operations WHERE node_id=$13 AND node_generation=$1 AND state='leased')
WHERE id=$13 RETURNING `+queueNodeColumns,
		generation, state, now, report.NodeVersion, report.DaemonVersion, report.ImageDigest, report.DaemonState, report.FailureCode,
		int64(report.StartAttempts), int64(report.StartFailures), int64(report.StartDurationMillisTotal), int64(report.StartDurationMillisMax), nodeID)
	node, err := scanQueueNode(row)
	if err != nil {
		return cloudplane.Node{}, databaseFailure("update PostgreSQL Node report", err)
	}
	if err := loadQueueNodeScopes(ctx, transaction, &node); err != nil {
		return cloudplane.Node{}, err
	}
	return node, nil
}

func (queue *Queue) fenceGeneration(ctx context.Context, transaction pgx.Tx, nodeID, generation string, now time.Time) error {
	rows, err := transaction.Query(ctx, `SELECT `+queueTaskColumns+` FROM zapvm.tasks WHERE node_id=$1 AND node_generation=$2 AND state IN ('leased','running','canceling') ORDER BY id FOR UPDATE`, nodeID, generation)
	if err != nil {
		return databaseFailure("lock PostgreSQL generation Tasks", err)
	}
	tasks := make([]cloudplane.Task, 0)
	for rows.Next() {
		task, err := scanQueueTask(rows)
		if err != nil {
			rows.Close()
			return errors.New("decode PostgreSQL generation Task")
		}
		tasks = append(tasks, task)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read PostgreSQL generation Tasks")
	}
	for _, task := range tasks {
		state, failure, kind := cloudplane.TaskPending, "", "requeued"
		if task.State == cloudplane.TaskCanceling {
			state, failure, kind = cloudplane.TaskFailed, "cancel_unconfirmed", "terminal"
		} else if task.Attempt >= cloudplane.MaxAttempts {
			state, failure, kind = cloudplane.TaskFailed, "generation_exhausted", "terminal"
		}
		updated, err := scanQueueTask(transaction.QueryRow(ctx, `
UPDATE zapvm.tasks SET state=$1,failure_code=NULLIF($2,''),node_id=NULL,node_generation=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=$3,
    queue_reason=CASE WHEN $1='pending' THEN 'dispatch_wait' ELSE queue_reason END,
    queue_deadline=CASE WHEN $1='pending' THEN $5 ELSE queue_deadline END
WHERE id=$4 RETURNING `+queueTaskColumns, state, failure, now, task.ID, now.Add(queue.dispatchTimeout)))
		if err != nil {
			return databaseFailure("fence PostgreSQL generation Task", err)
		}
		if err := queue.revokeTaskCredentialCapabilities(ctx, transaction, updated, now); err != nil {
			return err
		}
		if err := insertQueueOutbox(ctx, transaction, updated, kind, 0, now); err != nil {
			return err
		}
		if _, err := appendAudit(ctx, transaction, now, auditInput{action: "task_generation_fence", scope: updated.Scope(), nodeID: nodeID, taskID: updated.ID, outcome: updated.State}); err != nil {
			return err
		}
	}
	if err := queue.fenceWorkspaceGeneration(ctx, transaction, nodeID, generation, now); err != nil {
		return err
	}
	return queue.releaseDynamicPlacementsForNodeGeneration(ctx, transaction, nodeID, generation, now)
}

const queueNodeColumns = `
id,generation,state,capacity,in_flight,last_heartbeat,COALESCE(node_version,''),COALESCE(daemon_version,''),
COALESCE(encode(image_digest,'hex'),''),daemon_state,COALESCE(failure_code,''),start_attempts,start_failures,
start_duration_ms_total,start_duration_ms_max`

func scanQueueNode(row pgx.Row) (cloudplane.Node, error) {
	var node cloudplane.Node
	var capacity, inFlight int32
	var lastHeartbeat time.Time
	var attempts, failures, total, maximum int64
	if err := row.Scan(&node.ID, &node.Generation, &node.State, &capacity, &inFlight, &lastHeartbeat, &node.NodeVersion, &node.DaemonVersion,
		&node.ImageDigest, &node.DaemonState, &node.FailureCode, &attempts, &failures, &total, &maximum); err != nil {
		return cloudplane.Node{}, err
	}
	if capacity < 1 || capacity > 1024 || inFlight < 0 || inFlight > capacity || attempts < 0 || failures < 0 || total < 0 || maximum < 0 {
		return cloudplane.Node{}, errors.New("PostgreSQL Node row is invalid")
	}
	node.Capacity, node.InFlight = uint16(capacity), uint16(inFlight)
	node.LastHeartbeat = lastHeartbeat.UTC().Format(time.RFC3339Nano)
	node.StartAttempts, node.StartFailures = uint64(attempts), uint64(failures)
	node.StartDurationMillisTotal, node.StartDurationMillisMax = uint64(total), uint64(maximum)
	return node, nil
}

func loadQueueNodeScopes(ctx context.Context, transaction pgx.Tx, node *cloudplane.Node) error {
	rows, err := transaction.Query(ctx, `SELECT tenant_id,project_id FROM zapvm.node_scopes WHERE node_id=$1 ORDER BY tenant_id,project_id`, node.ID)
	if err != nil {
		return databaseFailure("list PostgreSQL Node scopes", err)
	}
	node.Scopes = make([]cloudplane.Scope, 0)
	for rows.Next() {
		var scope cloudplane.Scope
		if err := rows.Scan(&scope.TenantID, &scope.ProjectID); err != nil {
			rows.Close()
			return errors.New("decode PostgreSQL Node scope")
		}
		node.Scopes = append(node.Scopes, scope)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read PostgreSQL Node scopes")
	}
	sort.Slice(node.Scopes, func(left, right int) bool {
		if node.Scopes[left].TenantID == node.Scopes[right].TenantID {
			return node.Scopes[left].ProjectID < node.Scopes[right].ProjectID
		}
		return node.Scopes[left].TenantID < node.Scopes[right].TenantID
	})
	return nil
}

func sha256Bytes(value string) []byte {
	digest := sha256.Sum256([]byte(value))
	return digest[:]
}

func queueNodeReportFitsPostgreSQL(report cloudplane.NodeReport) bool {
	return report.StartAttempts <= math.MaxInt64 && report.StartFailures <= math.MaxInt64 &&
		report.StartDurationMillisTotal <= math.MaxInt64 && report.StartDurationMillisMax <= math.MaxInt64
}
