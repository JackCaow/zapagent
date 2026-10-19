package controlpostgres

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"zapvm/internal/cloudplane"
	"zapvm/internal/daemonrpc"
)

const (
	postgresMaximumTasks         = 10000
	postgresMaximumTasksPerScope = 1000
	postgresMaximumPage          = 1000
	residentAgentCommand         = "/usr/local/sbin/zapvm-resident-agent"
)

func (queue *Queue) Submit(ctx context.Context, principal string, request cloudplane.SubmitRequest) (cloudplane.Task, bool, error) {
	return queue.submit(ctx, principal, request, nil)
}

func (queue *Queue) SubmitAgentSession(ctx context.Context, principal string, request cloudplane.SubmitRequest, sessionID string, continuation bool) (cloudplane.Task, bool, error) {
	if !queueIDPattern.MatchString(sessionID) {
		return cloudplane.Task{}, false, errors.New("PostgreSQL Agent Session ID is invalid")
	}
	return queue.submit(ctx, principal, request, func(ctx context.Context, transaction pgx.Tx, command daemonrpc.ComputerTaskSubmitRequest) error {
		if err := queue.requireComputerSchedulable(ctx, transaction, request.Scope, request.ComputerID); err != nil {
			return err
		}
		if command.Command.SessionID != sessionID || len(command.Command.Argv) == 0 || command.Command.Argv[0] != residentAgentCommand {
			return cloudplane.ErrConflict
		}
		var computerID string
		err := transaction.QueryRow(ctx, `SELECT computer_id FROM zapvm.agent_sessions WHERE tenant_id=$1 AND project_id=$2 AND session_id=$3 FOR SHARE`, request.Scope.TenantID, request.Scope.ProjectID, sessionID).Scan(&computerID)
		found := err == nil
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return databaseFailure("inspect PostgreSQL Agent Session", err)
		}
		if found && computerID != request.ComputerID {
			return cloudplane.ErrConflict
		}
		if continuation != found {
			return cloudplane.ErrConflict
		}
		if found {
			var active int
			if err := transaction.QueryRow(ctx, `SELECT count(*) FROM zapvm.tasks WHERE tenant_id=$1 AND project_id=$2 AND session_id=$3 AND state NOT IN ('succeeded','failed','canceled')`, request.Scope.TenantID, request.Scope.ProjectID, sessionID).Scan(&active); err != nil {
				return databaseFailure("inspect PostgreSQL Agent Session activity", err)
			}
			if active != 0 {
				return cloudplane.ErrConflict
			}
		}
		return nil
	})
}

func (queue *Queue) RetryAgentSession(ctx context.Context, principal string, scope cloudplane.Scope, sourceID, newID string) (cloudplane.Task, bool, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.Task{}, false, err
	}
	if !cloudplane.ValidPrincipal(principal) || scope.Validate() != nil {
		return cloudplane.Task{}, false, cloudplane.ErrUnauthorized
	}
	if !queueIDPattern.MatchString(sourceID) || !queueIDPattern.MatchString(newID) || sourceID == newID {
		return cloudplane.Task{}, false, errors.New("PostgreSQL Agent retry IDs are invalid")
	}
	source, err := queue.InspectTask(ctx, scope, sourceID)
	if err != nil {
		return cloudplane.Task{}, false, err
	}
	if source.State != cloudplane.TaskFailed && source.State != cloudplane.TaskCanceled {
		return cloudplane.Task{}, false, cloudplane.ErrConflict
	}
	command, err := daemonrpc.DecodeComputerTaskSubmit(source.Payload)
	if err != nil || len(command.Command.Argv) == 0 || command.Command.Argv[0] != residentAgentCommand || command.Command.SessionID == "" {
		return cloudplane.Task{}, false, cloudplane.ErrNotFound
	}
	command.ID = newID
	payload, err := json.Marshal(command)
	if err != nil {
		return cloudplane.Task{}, false, errors.New("encode PostgreSQL Agent retry")
	}
	return queue.submit(ctx, principal, cloudplane.SubmitRequest{
		ID: newID, Scope: scope, ComputerID: source.ComputerID, Payload: payload,
		CredentialIDs: append([]string(nil), source.CredentialIDs...), RetryOf: sourceID,
	}, func(ctx context.Context, transaction pgx.Tx, candidate daemonrpc.ComputerTaskSubmitRequest) error {
		if err := queue.requireComputerSchedulable(ctx, transaction, scope, source.ComputerID); err != nil {
			return err
		}
		if candidate.Command.SessionID != command.Command.SessionID {
			return cloudplane.ErrConflict
		}
		var active int
		if err := transaction.QueryRow(ctx, `SELECT count(*) FROM zapvm.tasks WHERE tenant_id=$1 AND project_id=$2 AND session_id=$3 AND state NOT IN ('succeeded','failed','canceled')`, scope.TenantID, scope.ProjectID, command.Command.SessionID).Scan(&active); err != nil {
			return databaseFailure("inspect PostgreSQL retry Session activity", err)
		}
		if active != 0 {
			return cloudplane.ErrConflict
		}
		return nil
	})
}

type submitAdmission func(context.Context, pgx.Tx, daemonrpc.ComputerTaskSubmitRequest) error

func optionalUint64(value uint64) any {
	if value == 0 {
		return nil
	}
	return int64(value)
}

func (queue *Queue) requireComputerSchedulable(ctx context.Context, transaction pgx.Tx, scope cloudplane.Scope, computerID string) error {
	if queue.placementMode == cloudplane.PlacementModeDynamic {
		_, available, err := queue.ensureDynamicPlacement(ctx, transaction, scope, computerID, queue.now().UTC())
		if err != nil {
			return err
		}
		if !available {
			return cloudplane.ErrComputerOffline
		}
		return nil
	}
	var available bool
	err := transaction.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
    FROM zapvm.computer_nodes AS placement
    JOIN zapvm.nodes AS node ON node.id=placement.node_id
    WHERE placement.tenant_id=$1 AND placement.project_id=$2 AND placement.computer_id=$3
      AND node.state='online' AND node.last_heartbeat>$4
      AND node.daemon_state IN ('unknown','healthy')
)`, scope.TenantID, scope.ProjectID, computerID, queue.now().UTC().Add(-queue.heartbeatTTL)).Scan(&available)
	if err != nil {
		return databaseFailure("inspect PostgreSQL Agent Computer availability", err)
	}
	if !available {
		return cloudplane.ErrComputerOffline
	}
	return nil
}

func (queue *Queue) taskQueueReason(ctx context.Context, transaction pgx.Tx, scope cloudplane.Scope, computerID string, now time.Time) (string, uint64, error) {
	if queue.placementMode == cloudplane.PlacementModeDynamic {
		placement, placed, err := queue.ensureDynamicPlacement(ctx, transaction, scope, computerID, now)
		if err != nil {
			return "", 0, err
		}
		if !placed {
			return cloudplane.QueueReasonNodeOffline, 0, nil
		}
		ready, _, err := queue.ensureComputerStartOperation(ctx, transaction, scope, computerID, placement, now)
		if err != nil {
			return "", 0, err
		}
		if !ready {
			return cloudplane.QueueReasonComputerStarting, placement.epoch, nil
		}
		var schedulable, available bool
		if err := transaction.QueryRow(ctx, `
SELECT node.state='online' AND node.generation=$2 AND node.last_heartbeat>$3
         AND node.daemon_state IN ('unknown','healthy'),
       node.state='online' AND node.generation=$2 AND node.last_heartbeat>$3
         AND node.daemon_state IN ('unknown','healthy') AND node.in_flight<node.capacity
FROM zapvm.nodes AS node WHERE node.id=$1`, placement.nodeID, placement.nodeGeneration, now.Add(-queue.heartbeatTTL)).Scan(&schedulable, &available); err != nil {
			return "", 0, databaseFailure("inspect dynamic PostgreSQL Task queue reason", err)
		}
		if available {
			return cloudplane.QueueReasonDispatchWait, placement.epoch, nil
		}
		if schedulable {
			return cloudplane.QueueReasonCapacityWait, placement.epoch, nil
		}
		return cloudplane.QueueReasonNodeOffline, placement.epoch, nil
	}
	var schedulable, available bool
	err := transaction.QueryRow(ctx, `
SELECT
    COALESCE(bool_or(node.state='online' AND node.last_heartbeat>$4 AND node.daemon_state IN ('unknown','healthy')),false),
    COALESCE(bool_or(node.state='online' AND node.last_heartbeat>$4 AND node.daemon_state IN ('unknown','healthy') AND node.in_flight<node.capacity),false)
FROM zapvm.nodes AS node
JOIN zapvm.node_scopes AS scope
  ON scope.node_id=node.id AND scope.tenant_id=$1 AND scope.project_id=$2
WHERE EXISTS (
        SELECT 1 FROM zapvm.computer_nodes AS placement
        WHERE placement.node_id=node.id AND placement.tenant_id=$1 AND placement.project_id=$2 AND placement.computer_id=$3
      )
   OR NOT EXISTS (
        SELECT 1 FROM zapvm.computer_nodes AS configured
        WHERE configured.tenant_id=$1 AND configured.project_id=$2
      )`, scope.TenantID, scope.ProjectID, computerID, now.Add(-queue.heartbeatTTL)).Scan(&schedulable, &available)
	if err != nil {
		return "", 0, databaseFailure("inspect PostgreSQL Task queue reason", err)
	}
	if available {
		return cloudplane.QueueReasonDispatchWait, 0, nil
	}
	if schedulable {
		return cloudplane.QueueReasonCapacityWait, 0, nil
	}
	return cloudplane.QueueReasonNodeOffline, 0, nil
}

func (queue *Queue) submit(ctx context.Context, principal string, request cloudplane.SubmitRequest, admission submitAdmission) (cloudplane.Task, bool, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.Task{}, false, err
	}
	if !cloudplane.ValidPrincipal(principal) {
		return cloudplane.Task{}, false, errors.New("PostgreSQL Task submit principal is invalid")
	}
	request, digestHex, err := cloudplane.PrepareSubmitRequest(request)
	if err != nil {
		return cloudplane.Task{}, false, err
	}
	command, err := daemonrpc.DecodeComputerTaskSubmit(request.Payload)
	if err != nil {
		return cloudplane.Task{}, false, err
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.Task{}, false, err
	}
	defer rollbackBounded(transaction)
	if _, err := transaction.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "task|"+request.ID); err != nil {
		return cloudplane.Task{}, false, databaseFailure("lock PostgreSQL Task idempotency", err)
	}
	existing, err := scanQueueTask(transaction.QueryRow(ctx, `SELECT `+queueTaskColumns+` FROM zapvm.tasks WHERE id=$1 FOR UPDATE`, request.ID))
	if err == nil {
		if existing.Scope() != request.Scope || existing.ComputerID != request.ComputerID || existing.PayloadSHA256 != digestHex || existing.RetryOf != request.RetryOf || !sameQueueStrings(existing.CredentialIDs, request.CredentialIDs) {
			return cloudplane.Task{}, false, cloudplane.ErrConflict
		}
		if err := transaction.Commit(ctx); err != nil {
			return cloudplane.Task{}, false, databaseFailure("commit PostgreSQL duplicate Task submit", err)
		}
		return existing, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.Task{}, false, databaseFailure("inspect PostgreSQL duplicate Task", err)
	}
	var computerExists bool
	if err := transaction.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM zapvm.computers WHERE tenant_id=$1 AND project_id=$2 AND computer_id=$3)`, request.Scope.TenantID, request.Scope.ProjectID, request.ComputerID).Scan(&computerExists); err != nil {
		return cloudplane.Task{}, false, databaseFailure("inspect PostgreSQL Task Computer", err)
	}
	if !computerExists {
		return cloudplane.Task{}, false, cloudplane.ErrUnavailable
	}
	if queue.credentialBroker != nil && len(request.CredentialIDs) != 0 {
		var activeCredentials int
		if err := transaction.QueryRow(ctx, `
SELECT count(*) FROM zapvm.credential_envelopes
WHERE tenant_id=$1 AND project_id=$2 AND state='active' AND credential_id=ANY($3)`,
			request.Scope.TenantID, request.Scope.ProjectID, request.CredentialIDs).Scan(&activeCredentials); err != nil {
			return cloudplane.Task{}, false, databaseFailure("inspect PostgreSQL Task Credentials", err)
		}
		if activeCredentials != len(request.CredentialIDs) {
			return cloudplane.Task{}, false, cloudplane.ErrUnavailable
		}
	}
	if request.RetryOf != "" {
		var retryTenant, retryProject, retryComputer, retryState string
		if err := transaction.QueryRow(ctx, `SELECT tenant_id,project_id,computer_id,state FROM zapvm.tasks WHERE id=$1 FOR SHARE`, request.RetryOf).Scan(&retryTenant, &retryProject, &retryComputer, &retryState); errors.Is(err, pgx.ErrNoRows) {
			return cloudplane.Task{}, false, cloudplane.ErrNotFound
		} else if err != nil {
			return cloudplane.Task{}, false, databaseFailure("inspect PostgreSQL Task retry source", err)
		}
		if retryTenant != request.Scope.TenantID || retryProject != request.Scope.ProjectID || retryComputer != request.ComputerID || !cloudplane.IsTerminalTaskState(retryState) {
			return cloudplane.Task{}, false, cloudplane.ErrConflict
		}
	}
	sessionID := residentAgentSessionID(command)
	if sessionID != "" {
		lockKey := request.Scope.TenantID + "|" + request.Scope.ProjectID + "|" + sessionID
		if _, err := transaction.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, lockKey); err != nil {
			return cloudplane.Task{}, false, databaseFailure("lock PostgreSQL Agent Session admission", err)
		}
	}
	if admission != nil {
		if err := admission(ctx, transaction, command); err != nil {
			return cloudplane.Task{}, false, err
		}
	}
	var auditSequence int64
	if err := transaction.QueryRow(ctx, `SELECT audit_sequence FROM zapvm.control_state WHERE singleton FOR UPDATE`).Scan(&auditSequence); err != nil {
		return cloudplane.Task{}, false, databaseFailure("lock PostgreSQL Task quota", err)
	}
	var total, scoped int
	if err := transaction.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE tenant_id=$1 AND project_id=$2) FROM zapvm.tasks`, request.Scope.TenantID, request.Scope.ProjectID).Scan(&total, &scoped); err != nil {
		return cloudplane.Task{}, false, databaseFailure("count PostgreSQL Task quota", err)
	}
	if total >= postgresMaximumTasks || scoped >= postgresMaximumTasksPerScope {
		return cloudplane.Task{}, false, cloudplane.ErrQuotaReached
	}
	now := queue.now().UTC()
	periodStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	var active, maxConcurrent int
	var maxTaskSeconds, usedTaskSeconds int64
	if err := transaction.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE state IN ('pending','leased','running','canceling')),
	   COALESCE((SELECT max_concurrent_tasks FROM zapvm.workspace_quotas WHERE tenant_id=$1 AND project_id=$2),5),
	   COALESCE((SELECT monthly_task_seconds FROM zapvm.workspace_quotas WHERE tenant_id=$1 AND project_id=$2),360000),
	   COALESCE(sum(EXTRACT(EPOCH FROM (updated_at-created_at))) FILTER (WHERE created_at >= $3 AND state IN ('succeeded','failed','canceled'))::bigint,0)
FROM zapvm.tasks WHERE tenant_id=$1 AND project_id=$2`, request.Scope.TenantID, request.Scope.ProjectID, periodStart).Scan(&active, &maxConcurrent, &maxTaskSeconds, &usedTaskSeconds); err != nil {
		return cloudplane.Task{}, false, databaseFailure("count PostgreSQL Workspace Task quota", err)
	}
	if active >= maxConcurrent || usedTaskSeconds >= maxTaskSeconds {
		return cloudplane.Task{}, false, cloudplane.ErrQuotaReached
	}
	queueReason, placementEpoch, err := queue.taskQueueReason(ctx, transaction, request.Scope, request.ComputerID, now)
	if err != nil {
		return cloudplane.Task{}, false, err
	}
	action := "task_submit"
	if request.RetryOf != "" {
		action = "task_retry"
	}
	audit, err := appendAudit(ctx, transaction, now, auditInput{action: action, scope: request.Scope, taskID: request.ID, outcome: "accepted", principal: principal})
	if err != nil {
		return cloudplane.Task{}, false, err
	}
	if sessionID != "" {
		var sessionComputer string
		if err := transaction.QueryRow(ctx, `
INSERT INTO zapvm.agent_sessions (tenant_id,project_id,session_id,computer_id,created_at,updated_at)
VALUES ($1,$2,$3,$4,$5,$5)
ON CONFLICT (tenant_id,project_id,session_id) DO UPDATE SET updated_at=EXCLUDED.updated_at
WHERE zapvm.agent_sessions.computer_id=EXCLUDED.computer_id
RETURNING computer_id`, request.Scope.TenantID, request.Scope.ProjectID, sessionID, request.ComputerID, now).Scan(&sessionComputer); errors.Is(err, pgx.ErrNoRows) {
			return cloudplane.Task{}, false, cloudplane.ErrConflict
		} else if err != nil {
			return cloudplane.Task{}, false, databaseFailure("upsert PostgreSQL Agent Session", err)
		}
	}
	digest, _ := hex.DecodeString(digestHex)
	credentialIDs := append([]string{}, request.CredentialIDs...)
	row := transaction.QueryRow(ctx, `
INSERT INTO zapvm.tasks
    (id,tenant_id,project_id,computer_id,session_id,payload,payload_raw,payload_sha256,credential_ids,retry_of,state,created_at,created_sequence,updated_at,queue_reason,queue_deadline,placement_epoch)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$11,$13,$14,$15)
RETURNING `+queueTaskColumns, request.ID, request.Scope.TenantID, request.Scope.ProjectID, request.ComputerID, optionalString(sessionID), request.Payload,
		[]byte(request.Payload), digest, credentialIDs, optionalString(request.RetryOf), now, int64(audit.Sequence), queueReason, now.Add(queue.dispatchTimeout), optionalUint64(placementEpoch))
	task, err := scanQueueTask(row)
	if err != nil {
		return cloudplane.Task{}, false, databaseFailure("insert PostgreSQL Task", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.Task{}, false, databaseFailure("commit PostgreSQL Task submit", err)
	}
	return task, true, nil
}

func residentAgentSessionID(command daemonrpc.ComputerTaskSubmitRequest) string {
	if len(command.Command.Argv) == 0 || command.Command.Argv[0] != residentAgentCommand {
		return ""
	}
	return command.Command.SessionID
}

func (queue *Queue) InspectTask(ctx context.Context, scope cloudplane.Scope, taskID string) (cloudplane.Task, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.Task{}, err
	}
	if scope.Validate() != nil {
		return cloudplane.Task{}, cloudplane.ErrUnauthorized
	}
	if !queueIDPattern.MatchString(taskID) {
		return cloudplane.Task{}, cloudplane.ErrNotFound
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.Task{}, err
	}
	defer rollbackBounded(transaction)
	task, err := scanQueueTask(transaction.QueryRow(ctx, `SELECT `+queueTaskColumns+` FROM zapvm.tasks WHERE id=$1 AND tenant_id=$2 AND project_id=$3`, taskID, scope.TenantID, scope.ProjectID))
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.Task{}, cloudplane.ErrNotFound
	}
	if err != nil {
		return cloudplane.Task{}, databaseFailure("inspect PostgreSQL Task", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.Task{}, databaseFailure("commit PostgreSQL Task inspection", err)
	}
	return task, nil
}

func (queue *Queue) TaskEvents(ctx context.Context, scope cloudplane.Scope, taskID string, after uint64, limit int) ([]cloudplane.TaskEvent, error) {
	if err := queue.validateCall(ctx); err != nil {
		return nil, err
	}
	if scope.Validate() != nil {
		return nil, cloudplane.ErrUnauthorized
	}
	if !queueIDPattern.MatchString(taskID) || limit < 1 || limit > postgresMaximumPage {
		return nil, errors.New("PostgreSQL Task Event page is invalid")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollbackBounded(transaction)
	var exists bool
	if err := transaction.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM zapvm.tasks WHERE id=$1 AND tenant_id=$2 AND project_id=$3)`, taskID, scope.TenantID, scope.ProjectID).Scan(&exists); err != nil {
		return nil, databaseFailure("inspect PostgreSQL Event Task", err)
	}
	if !exists {
		return nil, cloudplane.ErrNotFound
	}
	rows, err := transaction.Query(ctx, `
SELECT cursor,attempt,source_cursor,occurred_at,type,COALESCE(command_id,''),COALESCE(stream,''),data,COALESCE(pid,0),ok,COALESCE(error,'')
FROM zapvm.task_events WHERE task_id=$1 AND cursor>$2 ORDER BY cursor LIMIT $3`, taskID, int64(after), limit)
	if err != nil {
		return nil, databaseFailure("list PostgreSQL Task Events", err)
	}
	events := make([]cloudplane.TaskEvent, 0)
	for rows.Next() {
		event, err := scanPostgreSQLEvent(rows, taskID)
		if err != nil {
			rows.Close()
			return nil, errors.New("decode PostgreSQL Task Event")
		}
		events = append(events, event)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, errors.New("read PostgreSQL Task Events")
	}
	if err := transaction.Commit(ctx); err != nil {
		return nil, databaseFailure("commit PostgreSQL Task Event list", err)
	}
	return events, nil
}

func (queue *Queue) WaitTaskEvents(ctx context.Context, scope cloudplane.Scope, taskID string, after uint64, limit int) (cloudplane.Task, []cloudplane.TaskEvent, error) {
	if ctx == nil {
		return cloudplane.Task{}, nil, errors.New("PostgreSQL Task Event wait context is required")
	}
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		task, err := queue.InspectTask(ctx, scope, taskID)
		if err != nil {
			return cloudplane.Task{}, nil, err
		}
		events, err := queue.TaskEvents(ctx, scope, taskID, after, limit)
		if err != nil {
			return cloudplane.Task{}, nil, err
		}
		if len(events) != 0 || cloudplane.IsTerminalTaskState(task.State) {
			return task, events, nil
		}
		select {
		case <-ctx.Done():
			return cloudplane.Task{}, nil, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (queue *Queue) ListAgentSessions(ctx context.Context, scope cloudplane.Scope, after uint64, limit int) ([]cloudplane.Task, uint64, error) {
	if err := queue.validateCall(ctx); err != nil {
		return nil, after, err
	}
	if scope.Validate() != nil {
		return nil, after, cloudplane.ErrUnauthorized
	}
	if limit < 1 || limit > postgresMaximumPage {
		return nil, after, errors.New("PostgreSQL Agent Session page is invalid")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return nil, after, err
	}
	defer rollbackBounded(transaction)
	rows, err := transaction.Query(ctx, `SELECT `+queueTaskColumns+` FROM zapvm.tasks WHERE tenant_id=$1 AND project_id=$2 AND session_id IS NOT NULL AND created_sequence>$3 ORDER BY created_sequence,id`, scope.TenantID, scope.ProjectID, int64(after))
	if err != nil {
		return nil, after, databaseFailure("list PostgreSQL Agent Sessions", err)
	}
	tasks := make([]cloudplane.Task, 0, limit)
	for rows.Next() {
		task, err := scanQueueTask(rows)
		if err != nil {
			rows.Close()
			return nil, after, errors.New("decode PostgreSQL Agent Session")
		}
		command, decodeErr := daemonrpc.DecodeComputerTaskSubmit(task.Payload)
		if decodeErr == nil && len(command.Command.Argv) != 0 && command.Command.Argv[0] == residentAgentCommand {
			tasks = append(tasks, task)
			if len(tasks) == limit {
				break
			}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, after, errors.New("read PostgreSQL Agent Sessions")
	}
	if err := transaction.Commit(ctx); err != nil {
		return nil, after, databaseFailure("commit PostgreSQL Agent Session list", err)
	}
	next := after
	if len(tasks) != 0 {
		next = tasks[len(tasks)-1].CreatedSequence
	}
	return tasks, next, nil
}

func (queue *Queue) Audit(ctx context.Context, scope cloudplane.Scope, after uint64, limit int) ([]cloudplane.AuditRecord, error) {
	if err := queue.validateCall(ctx); err != nil {
		return nil, err
	}
	if scope.Validate() != nil {
		return nil, cloudplane.ErrUnauthorized
	}
	if limit < 1 || limit > postgresMaximumPage {
		return nil, errors.New("PostgreSQL audit page is invalid")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollbackBounded(transaction)
	rows, err := transaction.Query(ctx, `
SELECT sequence,schema_version,occurred_at,action,COALESCE(node_id,''),COALESCE(task_id,''),COALESCE(operation_id,''),COALESCE(artifact_id,''),
       COALESCE(encode(principal_sha256,'hex'),''),outcome,COALESCE(encode(previous_sha256,'hex'),''),encode(sha256,'hex')
FROM zapvm.audit_records WHERE tenant_id=$1 AND project_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4`, scope.TenantID, scope.ProjectID, int64(after), limit)
	if err != nil {
		return nil, databaseFailure("list PostgreSQL audit records", err)
	}
	records := make([]cloudplane.AuditRecord, 0)
	for rows.Next() {
		var record cloudplane.AuditRecord
		var sequence int64
		var occurred time.Time
		if err := rows.Scan(&sequence, &record.SchemaVersion, &occurred, &record.Action, &record.NodeID, &record.TaskID, &record.OperationID, &record.ArtifactID,
			&record.PrincipalSHA256, &record.Outcome, &record.PreviousSHA256, &record.SHA256); err != nil || sequence < 1 {
			rows.Close()
			return nil, errors.New("decode PostgreSQL audit record")
		}
		record.Sequence, record.Timestamp, record.TenantID, record.ProjectID = uint64(sequence), occurred.UTC().Format(time.RFC3339Nano), scope.TenantID, scope.ProjectID
		records = append(records, record)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, errors.New("read PostgreSQL audit records")
	}
	if err := transaction.Commit(ctx); err != nil {
		return nil, databaseFailure("commit PostgreSQL audit list", err)
	}
	return records, nil
}

func scanPostgreSQLEvent(row pgx.Row, taskID string) (cloudplane.TaskEvent, error) {
	var event cloudplane.TaskEvent
	var cursor, sourceCursor int64
	var attempt int16
	var occurred time.Time
	if err := row.Scan(&cursor, &attempt, &sourceCursor, &occurred, &event.Type, &event.CommandID, &event.Stream, &event.Data, &event.PID, &event.OK, &event.Error); err != nil {
		return cloudplane.TaskEvent{}, err
	}
	if cursor < 1 || sourceCursor < 1 || attempt < 1 || attempt > cloudplane.MaxAttempts {
		return cloudplane.TaskEvent{}, errors.New("PostgreSQL Event row is invalid")
	}
	event.Cursor, event.SourceCursor, event.Attempt = uint64(cursor), uint64(sourceCursor), uint8(attempt)
	event.Timestamp, event.TaskID = occurred.UTC().Format(time.RFC3339Nano), taskID
	return event, nil
}

func sameQueueStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
