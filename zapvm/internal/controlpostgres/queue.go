package controlpostgres

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"zapvm/internal/cloudplane"
	"zapvm/internal/credentialkms"
	"zapvm/internal/daemonrpc"
)

const (
	queueMaximumBatch                 = 64
	queueMaxEventSize                 = 1 << 20
	queueDefaultArtifactBytesPerTask  = uint64(20 << 30)
	queueDefaultArtifactBytesPerScope = uint64(100 << 30)
	queueMaximumArtifactSize          = uint64(5 << 30)
)

var (
	queueIDPattern      = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	queueNamePattern    = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)
	queueFailurePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
)

type queueTransition struct {
	state        string
	resultDigest string
	failureCode  string
	outboxKind   string
}

type QueueOptions struct {
	HeartbeatTTL            time.Duration
	LeaseTTL                time.Duration
	DispatchTimeout         time.Duration
	PlacementMode           string
	ComputerStartTimeout    time.Duration
	ArtifactBytesPerTask    uint64
	ArtifactBytesPerScope   uint64
	Now                     func() time.Time
	Random                  io.Reader
	CredentialBroker        *credentialkms.Broker
	CredentialCapabilityTTL time.Duration
}

type Queue struct {
	migrator                *Migrator
	heartbeatTTL            time.Duration
	leaseTTL                time.Duration
	dispatchTimeout         time.Duration
	placementMode           string
	computerStartTimeout    time.Duration
	artifactBytesPerTask    uint64
	artifactBytesPerScope   uint64
	now                     func() time.Time
	random                  io.Reader
	credentialBroker        *credentialkms.Broker
	credentialCapabilityTTL time.Duration
}

type OutboxRecord struct {
	ID          int64  `json:"id"`
	TenantID    string `json:"tenant_id"`
	ProjectID   string `json:"project_id"`
	TaskID      string `json:"task_id"`
	Attempt     uint8  `json:"attempt"`
	Kind        string `json:"kind"`
	EventCursor uint64 `json:"event_cursor,omitempty"`
	DedupeKey   string `json:"dedupe_key"`
	CreatedAt   string `json:"created_at"`
}

func NewQueue(migrator *Migrator, options QueueOptions) (*Queue, error) {
	if migrator == nil || migrator.pool == nil {
		return nil, errors.New("PostgreSQL migrator is not open")
	}
	if options.LeaseTTL == 0 {
		options.LeaseTTL = 2 * time.Minute
	}
	if options.HeartbeatTTL == 0 {
		options.HeartbeatTTL = 45 * time.Second
	}
	if options.DispatchTimeout == 0 {
		options.DispatchTimeout = 2 * time.Minute
	}
	if options.PlacementMode == "" {
		options.PlacementMode = cloudplane.PlacementModeStatic
	}
	if options.PlacementMode != cloudplane.PlacementModeStatic && options.PlacementMode != cloudplane.PlacementModeDynamic {
		return nil, errors.New("PostgreSQL queue placement mode must be static or dynamic")
	}
	if options.ComputerStartTimeout == 0 {
		options.ComputerStartTimeout = 5 * time.Minute
		if options.PlacementMode == cloudplane.PlacementModeDynamic && options.DispatchTimeout < options.ComputerStartTimeout {
			options.ComputerStartTimeout = options.DispatchTimeout
		}
	}
	if options.ComputerStartTimeout < 30*time.Second || options.ComputerStartTimeout > 30*time.Minute {
		return nil, errors.New("PostgreSQL Computer start timeout must be between 30 seconds and 30 minutes")
	}
	if options.PlacementMode == cloudplane.PlacementModeDynamic && options.ComputerStartTimeout > options.DispatchTimeout {
		return nil, errors.New("PostgreSQL Computer start timeout cannot exceed Task dispatch timeout")
	}
	if options.HeartbeatTTL < 5*time.Second || options.HeartbeatTTL > 10*time.Minute {
		return nil, errors.New("PostgreSQL queue heartbeat TTL must be between 5 seconds and 10 minutes")
	}
	if options.LeaseTTL < 10*time.Second || options.LeaseTTL > time.Hour {
		return nil, errors.New("PostgreSQL queue lease TTL must be between 10 seconds and 1 hour")
	}
	if options.DispatchTimeout < time.Second || options.DispatchTimeout > time.Hour {
		return nil, errors.New("PostgreSQL queue dispatch timeout must be between 1 second and 1 hour")
	}
	if options.ArtifactBytesPerTask == 0 {
		options.ArtifactBytesPerTask = queueDefaultArtifactBytesPerTask
	}
	if options.ArtifactBytesPerScope == 0 {
		options.ArtifactBytesPerScope = queueDefaultArtifactBytesPerScope
	}
	if options.ArtifactBytesPerTask < queueMaximumArtifactSize || options.ArtifactBytesPerTask > uint64(100<<30) ||
		options.ArtifactBytesPerScope < options.ArtifactBytesPerTask || options.ArtifactBytesPerScope > uint64(10<<40) {
		return nil, errors.New("PostgreSQL queue Artifact byte quotas are invalid")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Random == nil {
		options.Random = rand.Reader
	}
	if options.CredentialBroker == nil && options.CredentialCapabilityTTL != 0 {
		return nil, errors.New("Credential capability TTL requires an envelope broker")
	}
	if options.CredentialBroker != nil {
		if options.CredentialCapabilityTTL == 0 {
			options.CredentialCapabilityTTL = 5 * time.Minute
		}
		if options.CredentialCapabilityTTL < 10*time.Second || options.CredentialCapabilityTTL > 15*time.Minute {
			return nil, errors.New("Credential capability TTL must be between 10 seconds and 15 minutes")
		}
	}
	return &Queue{
		migrator: migrator, heartbeatTTL: options.HeartbeatTTL, leaseTTL: options.LeaseTTL, dispatchTimeout: options.DispatchTimeout,
		placementMode:        options.PlacementMode,
		computerStartTimeout: options.ComputerStartTimeout,
		artifactBytesPerTask: options.ArtifactBytesPerTask, artifactBytesPerScope: options.ArtifactBytesPerScope,
		now: options.Now, random: options.Random,
		credentialBroker: options.CredentialBroker, credentialCapabilityTTL: options.CredentialCapabilityTTL,
	}, nil
}

func (queue *Queue) Claim(ctx context.Context, nodeID, generation string, maximum int) ([]cloudplane.Lease, error) {
	if err := queue.validateCall(ctx); err != nil {
		return nil, err
	}
	if !queueIDPattern.MatchString(nodeID) || !validQueueGeneration(generation) || maximum < 1 || maximum > queueMaximumBatch {
		return nil, errors.New("PostgreSQL queue claim authority is invalid")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC()
	var missingRawPayload bool
	if err := transaction.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM zapvm.tasks WHERE state IN ('pending','leased','running','canceling') AND payload_raw IS NULL)`).Scan(&missingRawPayload); err != nil {
		return nil, databaseFailure("inspect PostgreSQL queue raw payloads", err)
	}
	if missingRawPayload {
		return nil, cloudplane.ErrUnavailable
	}
	if err := queue.expirePending(ctx, transaction, now); err != nil {
		return nil, err
	}
	if err := queue.reapExpired(ctx, transaction, now, nodeID, generation); err != nil {
		return nil, err
	}
	var state, daemonState string
	var capacity int32
	var lastHeartbeat time.Time
	err = transaction.QueryRow(ctx, `SELECT state, daemon_state, capacity, last_heartbeat FROM zapvm.nodes WHERE id = $1 AND generation = $2 FOR UPDATE`, nodeID, generation).Scan(&state, &daemonState, &capacity, &lastHeartbeat)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, cloudplane.ErrFenced
	}
	if err != nil {
		return nil, databaseFailure("lock PostgreSQL queue Node", err)
	}
	if state != cloudplane.NodeOnline || now.Sub(lastHeartbeat) > queue.heartbeatTTL || (daemonState != cloudplane.DaemonUnknown && daemonState != cloudplane.DaemonHealthy) {
		return nil, cloudplane.ErrUnavailable
	}
	var inFlight int
	if err := transaction.QueryRow(ctx, `
SELECT
    (SELECT count(*) FROM zapvm.tasks WHERE node_id = $1 AND node_generation = $2 AND state IN ('leased','running','canceling')) +
    (SELECT count(*) FROM zapvm.workspace_operations WHERE node_id = $1 AND node_generation = $2 AND state = 'leased')`, nodeID, generation).Scan(&inFlight); err != nil {
		return nil, databaseFailure("count PostgreSQL queue Node capacity", err)
	}
	available := int(capacity) - inFlight
	if available <= 0 {
		return nil, cloudplane.ErrCapacityReached
	}
	if maximum > available {
		maximum = available
	}
	candidateQuery := `
SELECT t.id, t.tenant_id, t.project_id, c.agent
FROM zapvm.tasks AS t
JOIN zapvm.node_scopes AS ns
  ON ns.node_id = $1 AND ns.tenant_id = t.tenant_id AND ns.project_id = t.project_id
JOIN zapvm.computers AS c
  ON c.tenant_id = t.tenant_id AND c.project_id = t.project_id AND c.computer_id = t.computer_id
LEFT JOIN zapvm.scope_dispatch AS sd
  ON sd.tenant_id = t.tenant_id AND sd.project_id = t.project_id
WHERE t.state = 'pending' AND t.attempt < 10
	AND t.payload_raw IS NOT NULL
  AND (
      EXISTS (
          SELECT 1 FROM zapvm.computer_nodes AS cn
          WHERE cn.node_id = $1 AND cn.tenant_id = t.tenant_id AND cn.project_id = t.project_id AND cn.computer_id = t.computer_id
      )
      OR NOT EXISTS (
          SELECT 1 FROM zapvm.computer_nodes AS configured
          WHERE configured.tenant_id = t.tenant_id AND configured.project_id = t.project_id
      )
  )
  AND (
      cardinality(t.credential_ids) = 0
      OR $3
      OR (SELECT count(DISTINCT tenant_id) FROM zapvm.node_scopes WHERE node_id = $1) = 1
  )
  AND (
      NOT $3 OR cardinality(t.credential_ids) = 0 OR NOT EXISTS (
          SELECT 1 FROM unnest(t.credential_ids) AS requested(credential_id)
          WHERE NOT EXISTS (
              SELECT 1 FROM zapvm.credential_envelopes AS envelope
              WHERE envelope.tenant_id=t.tenant_id AND envelope.project_id=t.project_id
                AND envelope.credential_id=requested.credential_id AND envelope.state='active'
          )
      )
  )
ORDER BY COALESCE(sd.dispatch_cursor, 0), t.created_sequence, t.id
FOR UPDATE OF t SKIP LOCKED
LIMIT $2`
	candidateArgs := []any{nodeID, maximum, queue.credentialBroker != nil}
	if queue.placementMode == cloudplane.PlacementModeDynamic {
		candidateQuery = `
SELECT t.id, t.tenant_id, t.project_id, c.agent
FROM zapvm.tasks AS t
JOIN zapvm.node_scopes AS ns
  ON ns.node_id = $1 AND ns.tenant_id = t.tenant_id AND ns.project_id = t.project_id
JOIN zapvm.computers AS c
  ON c.tenant_id = t.tenant_id AND c.project_id = t.project_id AND c.computer_id = t.computer_id
JOIN zapvm.computer_placements AS placement
  ON placement.tenant_id=t.tenant_id AND placement.project_id=t.project_id
  AND placement.computer_id=t.computer_id AND placement.epoch=t.placement_epoch
  AND placement.node_id=$1 AND placement.node_generation=$4 AND placement.state='ready'
JOIN zapvm.computer_runtime AS runtime
  ON runtime.tenant_id=t.tenant_id AND runtime.project_id=t.project_id AND runtime.computer_id=t.computer_id
  AND runtime.placement_epoch=t.placement_epoch AND runtime.observed_state IN ('ready','busy')
LEFT JOIN zapvm.scope_dispatch AS sd
  ON sd.tenant_id = t.tenant_id AND sd.project_id = t.project_id
WHERE t.state = 'pending' AND t.attempt < 10 AND t.payload_raw IS NOT NULL
  AND (
      cardinality(t.credential_ids) = 0
      OR $3
      OR (SELECT count(DISTINCT tenant_id) FROM zapvm.node_scopes WHERE node_id = $1) = 1
  )
  AND (
      NOT $3 OR cardinality(t.credential_ids) = 0 OR NOT EXISTS (
          SELECT 1 FROM unnest(t.credential_ids) AS requested(credential_id)
          WHERE NOT EXISTS (
              SELECT 1 FROM zapvm.credential_envelopes AS envelope
              WHERE envelope.tenant_id=t.tenant_id AND envelope.project_id=t.project_id
                AND envelope.credential_id=requested.credential_id AND envelope.state='active'
          )
      )
  )
ORDER BY COALESCE(sd.dispatch_cursor, 0), t.created_sequence, t.id
FOR UPDATE OF t, placement SKIP LOCKED
LIMIT $2`
		candidateArgs = append(candidateArgs, generation)
	}
	rows, err := transaction.Query(ctx, candidateQuery, candidateArgs...)
	if err != nil {
		return nil, databaseFailure("select PostgreSQL queue Tasks", err)
	}
	type candidate struct{ id, tenantID, projectID, agent string }
	candidates := make([]candidate, 0, maximum)
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.id, &item.tenantID, &item.projectID, &item.agent); err != nil {
			rows.Close()
			return nil, errors.New("decode PostgreSQL queue Task candidate")
		}
		candidates = append(candidates, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, errors.New("read PostgreSQL queue Task candidates")
	}
	leases := make([]cloudplane.Lease, 0, len(candidates))
	committed := false
	defer func() {
		if committed {
			return
		}
		for index := range leases {
			leases[index].CredentialCapability.Destroy()
		}
	}()
	for _, item := range candidates {
		tokenBytes := make([]byte, 32)
		if _, err := io.ReadFull(queue.random, tokenBytes); err != nil {
			return nil, errors.New("generate PostgreSQL queue lease token")
		}
		token := base64.RawURLEncoding.EncodeToString(tokenBytes)
		tokenDigest := sha256.Sum256([]byte(token))
		var dispatch int64
		if err := transaction.QueryRow(ctx, `UPDATE zapvm.control_state SET dispatch_sequence = dispatch_sequence + 1, updated_at = $1 WHERE singleton RETURNING dispatch_sequence`, now).Scan(&dispatch); err != nil {
			return nil, databaseFailure("advance PostgreSQL queue dispatch", err)
		}
		row := transaction.QueryRow(ctx, `
UPDATE zapvm.tasks SET
    state = 'leased', node_id = $2, node_generation = $3, attempt = attempt + 1,
    lease_token_hash = $4, lease_expires_at = $5, updated_at = $1, dispatch_sequence = $6
WHERE id = $7 AND state = 'pending'
RETURNING `+queueTaskColumns, now, nodeID, generation, tokenDigest[:], now.Add(queue.leaseTTL), dispatch, item.id)
		task, err := scanQueueTask(row)
		if err != nil {
			return nil, databaseFailure("lease PostgreSQL queue Task", err)
		}
		if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.scope_dispatch (tenant_id, project_id, dispatch_cursor, updated_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (tenant_id, project_id) DO UPDATE SET dispatch_cursor = EXCLUDED.dispatch_cursor, updated_at = EXCLUDED.updated_at`, item.tenantID, item.projectID, dispatch, now); err != nil {
			return nil, databaseFailure("update PostgreSQL queue scope dispatch", err)
		}
		if err := insertQueueOutbox(ctx, transaction, task, "leased", 0, now); err != nil {
			return nil, err
		}
		if _, err := appendAudit(ctx, transaction, now, auditInput{action: "task_claim", scope: task.Scope(), nodeID: nodeID, taskID: task.ID, outcome: "leased"}); err != nil {
			return nil, err
		}
		capability, err := queue.issueCredentialCapability(ctx, transaction, task, nodeID, generation, now)
		if err != nil {
			return nil, err
		}
		leases = append(leases, cloudplane.Lease{Task: task, Agent: item.agent, LeaseToken: token, CredentialCapability: capability})
	}
	if _, err := transaction.Exec(ctx, `UPDATE zapvm.nodes SET in_flight = $1, updated_at = $2 WHERE id = $3 AND generation = $4`, inFlight+len(leases), now, nodeID, generation); err != nil {
		return nil, databaseFailure("update PostgreSQL queue Node capacity", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return nil, databaseFailure("commit PostgreSQL queue claim", err)
	}
	committed = true
	return leases, nil
}

func (queue *Queue) Acknowledge(ctx context.Context, nodeID, generation, taskID, leaseToken string) (cloudplane.Task, error) {
	requestDigest := sha256.Sum256([]byte("ack"))
	return queue.transition(ctx, nodeID, generation, taskID, leaseToken, "ack", requestDigest[:], func(task cloudplane.Task) (queueTransition, error) {
		if task.State == cloudplane.TaskCanceling {
			return queueTransition{state: cloudplane.TaskCanceling, outboxKind: "canceling"}, nil
		}
		if task.State != cloudplane.TaskLeased {
			return queueTransition{}, cloudplane.ErrConflict
		}
		return queueTransition{state: cloudplane.TaskRunning, outboxKind: "running"}, nil
	})
}

func (queue *Queue) Complete(ctx context.Context, nodeID, generation, taskID, leaseToken string, completion cloudplane.Completion) (cloudplane.Task, error) {
	if err := validateQueueCompletion(completion); err != nil {
		return cloudplane.Task{}, err
	}
	request, _ := json.Marshal(struct {
		Succeeded bool   `json:"succeeded"`
		Result    string `json:"result_sha256"`
		Failure   string `json:"failure_code"`
	}{completion.Succeeded, completion.ResultSHA256, completion.FailureCode})
	requestDigest := sha256.Sum256(request)
	return queue.transition(ctx, nodeID, generation, taskID, leaseToken, "complete", requestDigest[:], func(task cloudplane.Task) (queueTransition, error) {
		if task.State != cloudplane.TaskRunning && task.State != cloudplane.TaskCanceling {
			return queueTransition{}, cloudplane.ErrConflict
		}
		if completion.Succeeded {
			return queueTransition{state: cloudplane.TaskSucceeded, resultDigest: completion.ResultSHA256, outboxKind: "terminal"}, nil
		}
		return queueTransition{state: cloudplane.TaskFailed, resultDigest: completion.ResultSHA256, failureCode: completion.FailureCode, outboxKind: "terminal"}, nil
	})
}

func (queue *Queue) ConfirmCanceled(ctx context.Context, nodeID, generation, taskID, leaseToken string) (cloudplane.Task, error) {
	requestDigest := sha256.Sum256([]byte("canceled"))
	return queue.transition(ctx, nodeID, generation, taskID, leaseToken, "canceled", requestDigest[:], func(task cloudplane.Task) (queueTransition, error) {
		if task.State != cloudplane.TaskCanceling {
			return queueTransition{}, cloudplane.ErrConflict
		}
		return queueTransition{state: cloudplane.TaskCanceled, outboxKind: "terminal"}, nil
	})
}

func (queue *Queue) Cancel(ctx context.Context, principal string, scope cloudplane.Scope, taskID string) (cloudplane.Task, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.Task{}, err
	}
	if err := scope.Validate(); err != nil || !queueIDPattern.MatchString(taskID) || !cloudplane.ValidPrincipal(principal) {
		return cloudplane.Task{}, cloudplane.ErrUnauthorized
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.Task{}, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC()
	if err := queue.reapExpired(ctx, transaction, now, "", ""); err != nil {
		return cloudplane.Task{}, err
	}
	task, err := scanQueueTask(transaction.QueryRow(ctx, `SELECT `+queueTaskColumns+` FROM zapvm.tasks WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE`, taskID, scope.TenantID, scope.ProjectID))
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.Task{}, cloudplane.ErrNotFound
	}
	if err != nil {
		return cloudplane.Task{}, databaseFailure("lock PostgreSQL queue Task cancellation", err)
	}
	if task.State == cloudplane.TaskCanceled || task.State == cloudplane.TaskCanceling {
		if err := transaction.Commit(ctx); err != nil {
			return cloudplane.Task{}, databaseFailure("commit PostgreSQL duplicate Task cancellation", err)
		}
		return task, nil
	}
	if terminalQueueTask(task.State) {
		return cloudplane.Task{}, cloudplane.ErrTerminal
	}
	nextState, outboxKind := cloudplane.TaskCanceling, "canceling"
	if task.State == cloudplane.TaskPending {
		nextState, outboxKind = cloudplane.TaskCanceled, "terminal"
	}
	updated, err := scanQueueTask(transaction.QueryRow(ctx, `
UPDATE zapvm.tasks SET state=$1,updated_at=$2,
    node_id=CASE WHEN $1='canceled' THEN NULL ELSE node_id END,
    node_generation=CASE WHEN $1='canceled' THEN NULL ELSE node_generation END,
    lease_token_hash=CASE WHEN $1='canceled' THEN NULL ELSE lease_token_hash END,
    lease_expires_at=CASE WHEN $1='canceled' THEN NULL ELSE lease_expires_at END
WHERE id=$3 RETURNING `+queueTaskColumns, nextState, now, task.ID))
	if err != nil {
		return cloudplane.Task{}, databaseFailure("cancel PostgreSQL queue Task", err)
	}
	if err := insertQueueOutbox(ctx, transaction, updated, outboxKind, 0, now); err != nil {
		return cloudplane.Task{}, err
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: "task_cancel", scope: updated.Scope(), nodeID: updated.NodeID, taskID: updated.ID, outcome: updated.State, principal: principal}); err != nil {
		return cloudplane.Task{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.Task{}, databaseFailure("commit PostgreSQL queue Task cancellation", err)
	}
	return updated, nil
}

func (queue *Queue) Cancellations(ctx context.Context, nodeID, generation string, proofs []cloudplane.LeaseProof) ([]string, error) {
	if err := queue.validateCall(ctx); err != nil {
		return nil, err
	}
	if !queueIDPattern.MatchString(nodeID) || !validQueueGeneration(generation) || len(proofs) > queueMaximumBatch {
		return nil, errors.New("PostgreSQL queue cancellation proofs are invalid")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollbackBounded(transaction)
	var nodeState string
	if err := transaction.QueryRow(ctx, `SELECT state FROM zapvm.nodes WHERE id=$1 AND generation=$2`, nodeID, generation).Scan(&nodeState); errors.Is(err, pgx.ErrNoRows) {
		return nil, cloudplane.ErrFenced
	} else if err != nil {
		return nil, databaseFailure("read PostgreSQL queue cancellation Node", err)
	}
	if nodeState == cloudplane.NodeOffline {
		return nil, cloudplane.ErrUnavailable
	}
	now := queue.now().UTC()
	seen := make(map[string]struct{}, len(proofs))
	cancellations := make([]string, 0)
	for _, proof := range proofs {
		if _, exists := seen[proof.TaskID]; exists {
			return nil, errors.New("PostgreSQL queue cancellation proofs contain duplicate Tasks")
		}
		seen[proof.TaskID] = struct{}{}
		if !queueIDPattern.MatchString(proof.TaskID) || validateQueueToken(proof.LeaseToken) != nil {
			return nil, errors.New("PostgreSQL queue cancellation proof is invalid")
		}
		task, err := scanQueueTask(transaction.QueryRow(ctx, `SELECT `+queueTaskColumns+` FROM zapvm.tasks WHERE id=$1`, proof.TaskID))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, cloudplane.ErrFenced
		}
		if err != nil {
			return nil, databaseFailure("read PostgreSQL queue cancellation Task", err)
		}
		expiresAt, expiryError := time.Parse(time.RFC3339Nano, task.LeaseExpiresAt)
		if task.NodeID != nodeID || task.NodeGeneration != generation || !activeQueueTask(task.State) || !queueTokenMatches(task.LeaseTokenHash, proof.LeaseToken) || expiryError != nil || !expiresAt.After(now) {
			return nil, cloudplane.ErrFenced
		}
		if task.State == cloudplane.TaskCanceling {
			cancellations = append(cancellations, task.ID)
		}
	}
	sort.Strings(cancellations)
	if err := transaction.Commit(ctx); err != nil {
		return nil, databaseFailure("commit PostgreSQL queue cancellation query", err)
	}
	return cancellations, nil
}

func (queue *Queue) transition(ctx context.Context, nodeID, generation, taskID, leaseToken, action string, requestDigest []byte, decide func(cloudplane.Task) (queueTransition, error)) (cloudplane.Task, error) {
	if err := queue.validateAuthority(ctx, nodeID, generation, taskID, leaseToken); err != nil {
		return cloudplane.Task{}, err
	}
	tokenDigest := sha256.Sum256([]byte(leaseToken))
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.Task{}, err
	}
	defer rollbackBounded(transaction)
	if task, found, err := receiptTask(ctx, transaction, taskID, action, tokenDigest[:], requestDigest); err != nil {
		return cloudplane.Task{}, err
	} else if found {
		if err := transaction.Commit(ctx); err != nil {
			return cloudplane.Task{}, databaseFailure("commit PostgreSQL queue receipt read", err)
		}
		return task, nil
	}
	task, err := scanQueueTask(transaction.QueryRow(ctx, `SELECT `+queueTaskColumns+` FROM zapvm.tasks WHERE id = $1 FOR UPDATE`, taskID))
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.Task{}, cloudplane.ErrFenced
	}
	if err != nil {
		return cloudplane.Task{}, databaseFailure("lock PostgreSQL queue Task transition", err)
	}
	if task.NodeID != nodeID || task.NodeGeneration != generation || !activeQueueTask(task.State) || task.LeaseExpiresAt == "" || !queueTokenMatches(task.LeaseTokenHash, leaseToken) {
		return cloudplane.Task{}, cloudplane.ErrFenced
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, task.LeaseExpiresAt)
	if err != nil || !expiresAt.After(queue.now().UTC()) {
		return cloudplane.Task{}, cloudplane.ErrFenced
	}
	now := queue.now().UTC()
	decision, err := decide(task)
	if err != nil {
		return cloudplane.Task{}, err
	}
	leaseExpires := any(now.Add(queue.leaseTTL))
	nodeValue, generationValue, leaseHash := any(nodeID), any(generation), any(tokenDigest[:])
	if terminalQueueTask(decision.state) {
		leaseExpires, nodeValue, generationValue, leaseHash = nil, nil, nil, nil
	}
	row := transaction.QueryRow(ctx, `
UPDATE zapvm.tasks SET state = $1, node_id = $2, node_generation = $3, lease_token_hash = $4,
    lease_expires_at = $5, updated_at = $6,
    result_sha256 = CASE WHEN $7 = '' THEN NULL ELSE decode($7, 'hex') END,
    failure_code = CASE WHEN $8 = '' THEN NULL ELSE $8 END
WHERE id = $9
RETURNING `+queueTaskColumns, decision.state, nodeValue, generationValue, leaseHash, leaseExpires, now, decision.resultDigest, decision.failureCode, taskID)
	updated, err := scanQueueTask(row)
	if err != nil {
		return cloudplane.Task{}, databaseFailure("update PostgreSQL queue Task transition", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.task_transition_receipts
    (tenant_id, project_id, task_id, attempt, action, lease_token_hash, request_sha256, response_state, created_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, updated.TenantID, updated.ProjectID, updated.ID, updated.Attempt, action, tokenDigest[:], requestDigest, updated.State, now); err != nil {
		return cloudplane.Task{}, databaseFailure("record PostgreSQL queue Task receipt", err)
	}
	if err := insertQueueOutbox(ctx, transaction, updated, decision.outboxKind, 0, now); err != nil {
		return cloudplane.Task{}, err
	}
	auditAction := "task_" + action
	if action == "canceled" {
		auditAction = "task_canceled"
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: auditAction, scope: updated.Scope(), nodeID: nodeID, taskID: updated.ID, outcome: updated.State}); err != nil {
		return cloudplane.Task{}, err
	}
	if terminalQueueTask(updated.State) {
		if err := queue.revokeTaskCredentialCapabilities(ctx, transaction, updated, now); err != nil {
			return cloudplane.Task{}, err
		}
		if _, err := transaction.Exec(ctx, `UPDATE zapvm.nodes SET in_flight = GREATEST(in_flight - 1, 0), updated_at = $1 WHERE id = $2 AND generation = $3`, now, nodeID, generation); err != nil {
			return cloudplane.Task{}, databaseFailure("release PostgreSQL queue Node capacity", err)
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.Task{}, databaseFailure("commit PostgreSQL queue Task transition", err)
	}
	return updated, nil
}

func (queue *Queue) Renew(ctx context.Context, nodeID, generation string, proofs []cloudplane.LeaseProof) error {
	if err := queue.validateCall(ctx); err != nil {
		return err
	}
	if !queueIDPattern.MatchString(nodeID) || !validQueueGeneration(generation) || len(proofs) > queueMaximumBatch {
		return errors.New("PostgreSQL queue renewal authority is invalid")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC()
	var nodeState string
	if err := transaction.QueryRow(ctx, `SELECT state FROM zapvm.nodes WHERE id = $1 AND generation = $2 FOR UPDATE`, nodeID, generation).Scan(&nodeState); errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.ErrFenced
	} else if err != nil {
		return databaseFailure("lock PostgreSQL queue Node renewal", err)
	}
	if nodeState == cloudplane.NodeOffline {
		return cloudplane.ErrUnavailable
	}
	seen := make(map[string]struct{}, len(proofs))
	for _, proof := range proofs {
		if _, duplicate := seen[proof.TaskID]; duplicate {
			return errors.New("PostgreSQL queue renewal contains duplicate Tasks")
		}
		seen[proof.TaskID] = struct{}{}
		if err := validateQueueToken(proof.LeaseToken); err != nil || !queueIDPattern.MatchString(proof.TaskID) {
			return errors.New("PostgreSQL queue renewal proof is invalid")
		}
		digest := sha256.Sum256([]byte(proof.LeaseToken))
		command, err := transaction.Exec(ctx, `
UPDATE zapvm.tasks SET lease_expires_at = $1, updated_at = $2
WHERE id = $3 AND node_id = $4 AND node_generation = $5
  AND state IN ('leased','running','canceling') AND lease_token_hash = $6 AND lease_expires_at > $2`, now.Add(queue.leaseTTL), now, proof.TaskID, nodeID, generation, digest[:])
		if err != nil {
			return databaseFailure("renew PostgreSQL queue Task lease", err)
		}
		if command.RowsAffected() != 1 {
			return cloudplane.ErrFenced
		}
	}
	if _, err := transaction.Exec(ctx, `UPDATE zapvm.nodes SET last_heartbeat = $1, updated_at = $1 WHERE id = $2 AND generation = $3`, now, nodeID, generation); err != nil {
		return databaseFailure("update PostgreSQL queue Node heartbeat", err)
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: "node_heartbeat", nodeID: nodeID, outcome: "success"}); err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return databaseFailure("commit PostgreSQL queue renewal", err)
	}
	return nil
}

func (queue *Queue) AppendEvent(ctx context.Context, nodeID, generation, taskID, leaseToken string, source daemonrpc.ComputerTaskEvent) (cloudplane.TaskEvent, bool, error) {
	if err := queue.validateAuthority(ctx, nodeID, generation, taskID, leaseToken); err != nil {
		return cloudplane.TaskEvent{}, false, err
	}
	if source.TaskID != taskID || source.Cursor == 0 || !queueNamePattern.MatchString(source.Type) || len(source.Data) > queueMaxEventSize || len(source.Error) > queueMaxEventSize || len(source.CommandID) > 128 || len(source.Stream) > 32 {
		return cloudplane.TaskEvent{}, false, errors.New("PostgreSQL queue Event is invalid")
	}
	occurredAt, err := time.Parse(time.RFC3339Nano, source.Timestamp)
	if err != nil {
		return cloudplane.TaskEvent{}, false, errors.New("PostgreSQL queue Event timestamp is invalid")
	}
	occurredAt = occurredAt.UTC().Truncate(time.Microsecond)
	source.Timestamp = occurredAt.Format(time.RFC3339Nano)
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.TaskEvent{}, false, err
	}
	defer rollbackBounded(transaction)
	task, err := scanQueueTask(transaction.QueryRow(ctx, `SELECT `+queueTaskColumns+` FROM zapvm.tasks WHERE id = $1 FOR UPDATE`, taskID))
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.TaskEvent{}, false, cloudplane.ErrFenced
	}
	if err != nil {
		return cloudplane.TaskEvent{}, false, databaseFailure("lock PostgreSQL queue Event Task", err)
	}
	if task.NodeID != nodeID || task.NodeGeneration != generation || (task.State != cloudplane.TaskRunning && task.State != cloudplane.TaskCanceling) || !queueTokenMatches(task.LeaseTokenHash, leaseToken) {
		return cloudplane.TaskEvent{}, false, cloudplane.ErrFenced
	}
	leaseExpiresAt, err := time.Parse(time.RFC3339Nano, task.LeaseExpiresAt)
	if err != nil || !leaseExpiresAt.After(queue.now().UTC()) {
		return cloudplane.TaskEvent{}, false, cloudplane.ErrFenced
	}
	var existing cloudplane.TaskEvent
	var existingOccurred time.Time
	err = transaction.QueryRow(ctx, `
SELECT cursor, attempt, source_cursor, occurred_at, type, COALESCE(command_id,''), COALESCE(stream,''), data, COALESCE(pid,0), ok, COALESCE(error,'')
FROM zapvm.task_events
WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND attempt=$4 AND source_cursor=$5`, task.TenantID, task.ProjectID, task.ID, task.Attempt, source.Cursor).Scan(
		&existing.Cursor, &existing.Attempt, &existing.SourceCursor, &existingOccurred, &existing.Type, &existing.CommandID, &existing.Stream, &existing.Data, &existing.PID, &existing.OK, &existing.Error,
	)
	if err == nil {
		existing.Timestamp = existingOccurred.UTC().Format(time.RFC3339Nano)
		existing.TaskID = task.ID
		candidate := eventFromQueueSource(task, source, existing.Cursor)
		if !equalQueueEvent(existing, candidate) {
			return cloudplane.TaskEvent{}, false, cloudplane.ErrConflict
		}
		if err := transaction.Commit(ctx); err != nil {
			return cloudplane.TaskEvent{}, false, databaseFailure("commit PostgreSQL duplicate Event", err)
		}
		return existing, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.TaskEvent{}, false, databaseFailure("inspect PostgreSQL duplicate Event", err)
	}
	var lastSource, cursor int64
	if err := transaction.QueryRow(ctx, `SELECT COALESCE(max(source_cursor) FILTER (WHERE attempt=$2),0), COALESCE(max(cursor),0) FROM zapvm.task_events WHERE task_id=$1`, task.ID, task.Attempt).Scan(&lastSource, &cursor); err != nil {
		return cloudplane.TaskEvent{}, false, databaseFailure("inspect PostgreSQL Event cursor", err)
	}
	if source.Cursor != uint64(lastSource+1) {
		return cloudplane.TaskEvent{}, false, cloudplane.ErrConflict
	}
	event := eventFromQueueSource(task, source, uint64(cursor+1))
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.task_events
    (tenant_id,project_id,task_id,cursor,attempt,source_cursor,occurred_at,type,command_id,stream,data,pid,ok,error)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''),NULLIF($10,''),$11,NULLIF($12,0),$13,NULLIF($14,''))`, task.TenantID, task.ProjectID, task.ID, event.Cursor, event.Attempt, event.SourceCursor, occurredAt.UTC(), event.Type, event.CommandID, event.Stream, event.Data, event.PID, event.OK, event.Error); err != nil {
		return cloudplane.TaskEvent{}, false, databaseFailure("insert PostgreSQL queue Event", err)
	}
	now := queue.now().UTC()
	if _, err := transaction.Exec(ctx, `UPDATE zapvm.tasks SET updated_at=$1, lease_expires_at=$2 WHERE id=$3`, now, now.Add(queue.leaseTTL), task.ID); err != nil {
		return cloudplane.TaskEvent{}, false, databaseFailure("renew PostgreSQL queue Event lease", err)
	}
	if err := insertQueueOutbox(ctx, transaction, task, "event", event.Cursor, now); err != nil {
		return cloudplane.TaskEvent{}, false, err
	}
	if _, err := appendAudit(ctx, transaction, now, auditInput{action: "task_event", scope: task.Scope(), nodeID: nodeID, taskID: task.ID, outcome: event.Type}); err != nil {
		return cloudplane.TaskEvent{}, false, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.TaskEvent{}, false, databaseFailure("commit PostgreSQL queue Event", err)
	}
	return event, true, nil
}

// AppendEvents persists one Relay batch in a single transaction. A replayed
// batch returns the existing records after byte-for-byte semantic validation;
// a mixed duplicate/new tail is also safe after an acknowledgement loss.
func (queue *Queue) AppendEvents(ctx context.Context, nodeID, generation, taskID, leaseToken string, sources []daemonrpc.ComputerTaskEvent) ([]cloudplane.TaskEvent, error) {
	if err := queue.validateAuthority(ctx, nodeID, generation, taskID, leaseToken); err != nil {
		return nil, err
	}
	if len(sources) == 0 || len(sources) > queueMaximumBatch {
		return nil, errors.New("PostgreSQL queue Event batch is invalid")
	}
	normalized := append([]daemonrpc.ComputerTaskEvent(nil), sources...)
	occurred := make([]time.Time, len(normalized))
	sourceCursors := make([]int64, len(normalized))
	for index := range normalized {
		source := &normalized[index]
		if source.TaskID != taskID || source.Cursor == 0 || source.Cursor > uint64(1<<63-1) || !queueNamePattern.MatchString(source.Type) || len(source.Data) > queueMaxEventSize || len(source.Error) > queueMaxEventSize || len(source.CommandID) > 128 || len(source.Stream) > 32 {
			return nil, errors.New("PostgreSQL queue Event is invalid")
		}
		sourceCursors[index] = int64(source.Cursor)
		parsed, err := time.Parse(time.RFC3339Nano, source.Timestamp)
		if err != nil {
			return nil, errors.New("PostgreSQL queue Event timestamp is invalid")
		}
		occurred[index] = parsed.UTC().Truncate(time.Microsecond)
		source.Timestamp = occurred[index].Format(time.RFC3339Nano)
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollbackBounded(transaction)
	task, err := scanQueueTask(transaction.QueryRow(ctx, `SELECT `+queueTaskColumns+` FROM zapvm.tasks WHERE id = $1 FOR UPDATE`, taskID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, cloudplane.ErrFenced
	}
	if err != nil {
		return nil, databaseFailure("lock PostgreSQL queue Event batch Task", err)
	}
	if task.NodeID != nodeID || task.NodeGeneration != generation || (task.State != cloudplane.TaskRunning && task.State != cloudplane.TaskCanceling) || !queueTokenMatches(task.LeaseTokenHash, leaseToken) {
		return nil, cloudplane.ErrFenced
	}
	leaseExpiresAt, err := time.Parse(time.RFC3339Nano, task.LeaseExpiresAt)
	if err != nil || !leaseExpiresAt.After(queue.now().UTC()) {
		return nil, cloudplane.ErrFenced
	}
	existing := make(map[uint64]cloudplane.TaskEvent)
	rows, err := transaction.Query(ctx, `
SELECT cursor, attempt, source_cursor, occurred_at, type, COALESCE(command_id,''), COALESCE(stream,''), data, COALESCE(pid,0), ok, COALESCE(error,'')
FROM zapvm.task_events
WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND attempt=$4 AND source_cursor=ANY($5)
ORDER BY source_cursor`, task.TenantID, task.ProjectID, task.ID, task.Attempt, sourceCursors)
	if err != nil {
		return nil, databaseFailure("inspect PostgreSQL duplicate Event batch", err)
	}
	for rows.Next() {
		var event cloudplane.TaskEvent
		var eventOccurred time.Time
		if err := rows.Scan(&event.Cursor, &event.Attempt, &event.SourceCursor, &eventOccurred, &event.Type, &event.CommandID, &event.Stream, &event.Data, &event.PID, &event.OK, &event.Error); err != nil {
			rows.Close()
			return nil, databaseFailure("decode PostgreSQL Event batch", err)
		}
		event.TaskID = task.ID
		event.Timestamp = eventOccurred.UTC().Format(time.RFC3339Nano)
		existing[event.SourceCursor] = event
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, databaseFailure("read PostgreSQL Event batch", err)
	}
	var lastSource, cursor int64
	if err := transaction.QueryRow(ctx, `SELECT COALESCE(max(source_cursor) FILTER (WHERE attempt=$2),0), COALESCE(max(cursor),0) FROM zapvm.task_events WHERE task_id=$1`, task.ID, task.Attempt).Scan(&lastSource, &cursor); err != nil {
		return nil, databaseFailure("inspect PostgreSQL Event batch cursor", err)
	}
	result := make([]cloudplane.TaskEvent, 0, len(normalized))
	createdAny := false
	now := queue.now().UTC()
	for index, source := range normalized {
		if prior, ok := existing[source.Cursor]; ok {
			candidate := eventFromQueueSource(task, source, prior.Cursor)
			if !equalQueueEvent(prior, candidate) {
				return nil, cloudplane.ErrConflict
			}
			result = append(result, prior)
			continue
		}
		if source.Cursor != uint64(lastSource+1) {
			return nil, cloudplane.ErrConflict
		}
		cursor++
		event := eventFromQueueSource(task, source, uint64(cursor))
		if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.task_events
    (tenant_id,project_id,task_id,cursor,attempt,source_cursor,occurred_at,type,command_id,stream,data,pid,ok,error)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''),NULLIF($10,''),$11,NULLIF($12,0),$13,NULLIF($14,''))`, task.TenantID, task.ProjectID, task.ID, event.Cursor, event.Attempt, event.SourceCursor, occurred[index], event.Type, event.CommandID, event.Stream, event.Data, event.PID, event.OK, event.Error); err != nil {
			return nil, databaseFailure("insert PostgreSQL queue Event batch", err)
		}
		if err := insertQueueOutbox(ctx, transaction, task, "event", event.Cursor, now); err != nil {
			return nil, err
		}
		if _, err := appendAudit(ctx, transaction, now, auditInput{action: "task_event", scope: task.Scope(), nodeID: nodeID, taskID: task.ID, outcome: event.Type}); err != nil {
			return nil, err
		}
		existing[source.Cursor] = event
		lastSource = int64(source.Cursor)
		createdAny = true
		result = append(result, event)
	}
	if createdAny {
		if _, err := transaction.Exec(ctx, `UPDATE zapvm.tasks SET updated_at=$1, lease_expires_at=$2 WHERE id=$3`, now, now.Add(queue.leaseTTL), task.ID); err != nil {
			return nil, databaseFailure("renew PostgreSQL queue Event batch lease", err)
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return nil, databaseFailure("commit PostgreSQL queue Event batch", err)
	}
	return result, nil
}

func (queue *Queue) ClaimOutbox(ctx context.Context, replicaID string, maximum int, ttl time.Duration) ([]OutboxRecord, error) {
	if err := queue.validateCall(ctx); err != nil {
		return nil, err
	}
	if !queueIDPattern.MatchString(replicaID) || maximum < 1 || maximum > 1000 || ttl < 5*time.Second || ttl > 5*time.Minute {
		return nil, errors.New("PostgreSQL outbox claim is invalid")
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC()
	rows, err := transaction.Query(ctx, `
WITH candidates AS (
    SELECT id FROM zapvm.task_outbox
    WHERE delivered_at IS NULL AND (claimed_by IS NULL OR claim_expires_at <= $1)
    ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2
)
UPDATE zapvm.task_outbox AS o SET claimed_by=$3, claim_expires_at=$4
FROM candidates WHERE o.id=candidates.id
RETURNING o.id,o.tenant_id,o.project_id,o.task_id,o.attempt,o.kind,COALESCE(o.event_cursor,0),o.dedupe_key,o.created_at`, now, maximum, replicaID, now.Add(ttl))
	if err != nil {
		return nil, databaseFailure("claim PostgreSQL Task outbox", err)
	}
	records := make([]OutboxRecord, 0, maximum)
	for rows.Next() {
		var record OutboxRecord
		var attempt int16
		var cursor int64
		var created time.Time
		if err := rows.Scan(&record.ID, &record.TenantID, &record.ProjectID, &record.TaskID, &attempt, &record.Kind, &cursor, &record.DedupeKey, &created); err != nil {
			rows.Close()
			return nil, errors.New("decode PostgreSQL Task outbox")
		}
		record.Attempt = uint8(attempt)
		record.EventCursor = uint64(cursor)
		record.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		records = append(records, record)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, errors.New("read PostgreSQL Task outbox")
	}
	if err := transaction.Commit(ctx); err != nil {
		return nil, databaseFailure("commit PostgreSQL Task outbox claim", err)
	}
	sort.Slice(records, func(left, right int) bool { return records[left].ID < records[right].ID })
	return records, nil
}

func (queue *Queue) AckOutbox(ctx context.Context, replicaID string, ids []int64) error {
	if err := queue.validateCall(ctx); err != nil {
		return err
	}
	if !queueIDPattern.MatchString(replicaID) || len(ids) < 1 || len(ids) > 1000 {
		return errors.New("PostgreSQL outbox acknowledgment is invalid")
	}
	sorted := append([]int64(nil), ids...)
	sort.Slice(sorted, func(left, right int) bool { return sorted[left] < sorted[right] })
	for index, id := range sorted {
		if id < 1 || (index > 0 && id == sorted[index-1]) {
			return errors.New("PostgreSQL outbox acknowledgment IDs are invalid")
		}
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC()
	command, err := transaction.Exec(ctx, `
UPDATE zapvm.task_outbox SET delivered_at=$1, claimed_by=NULL, claim_expires_at=NULL
WHERE id = ANY($2) AND claimed_by=$3 AND claim_expires_at>$1 AND delivered_at IS NULL`, now, sorted, replicaID)
	if err != nil {
		return databaseFailure("acknowledge PostgreSQL Task outbox", err)
	}
	if command.RowsAffected() != int64(len(sorted)) {
		return cloudplane.ErrFenced
	}
	if err := transaction.Commit(ctx); err != nil {
		return databaseFailure("commit PostgreSQL Task outbox acknowledgment", err)
	}
	return nil
}

const queueTaskColumns = `
id,tenant_id,project_id,computer_id,convert_from(payload_raw,'UTF8'),encode(payload_sha256,'hex'),credential_ids,
COALESCE(retry_of,''),state,COALESCE(node_id,''),COALESCE(node_generation,''),attempt,
COALESCE(encode(lease_token_hash,'hex'),''),lease_expires_at,created_at,created_sequence,updated_at,
COALESCE(encode(result_sha256,'hex'),''),COALESCE(failure_code,''),COALESCE(dispatch_sequence,0),
COALESCE(queue_reason,''),queue_deadline,COALESCE(placement_epoch,0)`

func scanQueueTask(row pgx.Row) (cloudplane.Task, error) {
	var task cloudplane.Task
	var payload string
	var attempt int16
	var leaseExpires *time.Time
	var created, updated time.Time
	var queueDeadline *time.Time
	var createdSequence, dispatch, placementEpoch int64
	err := row.Scan(&task.ID, &task.TenantID, &task.ProjectID, &task.ComputerID, &payload, &task.PayloadSHA256, &task.CredentialIDs,
		&task.RetryOf, &task.State, &task.NodeID, &task.NodeGeneration, &attempt, &task.LeaseTokenHash, &leaseExpires,
		&created, &createdSequence, &updated, &task.ResultSHA256, &task.FailureCode, &dispatch, &task.QueueReason, &queueDeadline, &placementEpoch)
	if err != nil {
		return cloudplane.Task{}, err
	}
	if attempt < 0 || attempt > 255 || createdSequence < 0 || dispatch < 0 || placementEpoch < 0 || !json.Valid([]byte(payload)) {
		return cloudplane.Task{}, errors.New("PostgreSQL queue Task row is invalid")
	}
	payloadDigest := sha256.Sum256([]byte(payload))
	if hex.EncodeToString(payloadDigest[:]) != task.PayloadSHA256 {
		return cloudplane.Task{}, errors.New("PostgreSQL queue Task payload digest differs")
	}
	task.Payload = json.RawMessage(payload)
	task.Attempt = uint8(attempt)
	task.CreatedSequence = uint64(createdSequence)
	task.DispatchSequence = uint64(dispatch)
	task.PlacementEpoch = uint64(placementEpoch)
	task.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	task.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	if leaseExpires != nil {
		task.LeaseExpiresAt = leaseExpires.UTC().Format(time.RFC3339Nano)
	}
	if queueDeadline != nil {
		task.QueueDeadline = queueDeadline.UTC().Format(time.RFC3339Nano)
	}
	return task, nil
}

func (queue *Queue) begin(ctx context.Context) (pgx.Tx, error) {
	transaction, err := queue.migrator.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, errors.New("begin PostgreSQL queue transaction")
	}
	if err := enableOwnerBypass(ctx, transaction); err != nil {
		rollbackBounded(transaction)
		return nil, err
	}
	return transaction, nil
}

func (queue *Queue) validateCall(ctx context.Context) error {
	if queue == nil || queue.migrator == nil || queue.migrator.pool == nil || ctx == nil {
		return errors.New("PostgreSQL queue is not open")
	}
	return nil
}

func (queue *Queue) validateAuthority(ctx context.Context, nodeID, generation, taskID, leaseToken string) error {
	if err := queue.validateCall(ctx); err != nil {
		return err
	}
	if !queueIDPattern.MatchString(nodeID) || !validQueueGeneration(generation) || !queueIDPattern.MatchString(taskID) || validateQueueToken(leaseToken) != nil {
		return errors.New("PostgreSQL queue lease authority is invalid")
	}
	return nil
}

func validQueueGeneration(value string) bool {
	return len(value) >= 16 && queueIDPattern.MatchString(value)
}

func validateQueueToken(value string) error {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return errors.New("PostgreSQL queue lease token is invalid")
	}
	return nil
}

func queueTokenMatches(expectedHex, token string) bool {
	expected, err := hex.DecodeString(expectedHex)
	if err != nil || len(expected) != sha256.Size {
		return false
	}
	digest := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(expected, digest[:]) == 1
}

func activeQueueTask(state string) bool {
	return state == cloudplane.TaskLeased || state == cloudplane.TaskRunning || state == cloudplane.TaskCanceling
}

func terminalQueueTask(state string) bool {
	return state == cloudplane.TaskSucceeded || state == cloudplane.TaskFailed || state == cloudplane.TaskCanceled
}

func validateQueueCompletion(completion cloudplane.Completion) error {
	if completion.ResultSHA256 != "" {
		decoded, err := hex.DecodeString(completion.ResultSHA256)
		if err != nil || len(decoded) != sha256.Size || strings.ToLower(completion.ResultSHA256) != completion.ResultSHA256 {
			return errors.New("PostgreSQL queue completion digest is invalid")
		}
	}
	if completion.Succeeded {
		if completion.FailureCode != "" {
			return errors.New("PostgreSQL queue successful completion has a failure code")
		}
		return nil
	}
	if !queueFailurePattern.MatchString(completion.FailureCode) {
		return errors.New("PostgreSQL queue failed completion requires a failure code")
	}
	return nil
}

func receiptTask(ctx context.Context, transaction pgx.Tx, taskID, action string, tokenDigest, requestDigest []byte) (cloudplane.Task, bool, error) {
	var storedToken, storedRequest []byte
	err := transaction.QueryRow(ctx, `SELECT lease_token_hash,request_sha256 FROM zapvm.task_transition_receipts WHERE task_id=$1 AND action=$2 AND lease_token_hash=$3`, taskID, action, tokenDigest).Scan(&storedToken, &storedRequest)
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudplane.Task{}, false, nil
	}
	if err != nil {
		return cloudplane.Task{}, false, databaseFailure("read PostgreSQL queue Task receipt", err)
	}
	if subtle.ConstantTimeCompare(storedToken, tokenDigest) != 1 || subtle.ConstantTimeCompare(storedRequest, requestDigest) != 1 {
		return cloudplane.Task{}, false, cloudplane.ErrConflict
	}
	task, err := scanQueueTask(transaction.QueryRow(ctx, `SELECT `+queueTaskColumns+` FROM zapvm.tasks WHERE id=$1`, taskID))
	if err != nil {
		return cloudplane.Task{}, false, databaseFailure("read PostgreSQL receipt Task", err)
	}
	return task, true, nil
}

func insertQueueOutbox(ctx context.Context, transaction pgx.Tx, task cloudplane.Task, kind string, eventCursor uint64, now time.Time) error {
	dedupeMaterial := fmt.Sprintf("%s\x00%d\x00%s\x00%d", task.ID, task.Attempt, kind, eventCursor)
	dedupeDigest := sha256.Sum256([]byte(dedupeMaterial))
	dedupe := hex.EncodeToString(dedupeDigest[:])
	var cursor any
	if kind == "event" {
		cursor = int64(eventCursor)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.task_outbox (tenant_id,project_id,task_id,attempt,kind,event_cursor,dedupe_key,created_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dedupe_key) DO NOTHING`, task.TenantID, task.ProjectID, task.ID, task.Attempt, kind, cursor, dedupe, now); err != nil {
		return databaseFailure("insert PostgreSQL Task outbox", err)
	}
	return nil
}

func (queue *Queue) expirePending(ctx context.Context, transaction pgx.Tx, now time.Time) error {
	rows, err := transaction.Query(ctx, `SELECT `+queueTaskColumns+` FROM zapvm.tasks WHERE state='pending' ORDER BY queue_deadline NULLS FIRST,created_sequence FOR UPDATE SKIP LOCKED LIMIT 1024`)
	if err != nil {
		return databaseFailure("lock PostgreSQL pending Tasks", err)
	}
	pending := make([]cloudplane.Task, 0)
	for rows.Next() {
		task, scanErr := scanQueueTask(rows)
		if scanErr != nil {
			rows.Close()
			return errors.New("decode PostgreSQL pending Task")
		}
		pending = append(pending, task)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read PostgreSQL pending Tasks")
	}
	for _, task := range pending {
		deadline := now.Add(queue.dispatchTimeout)
		if task.QueueDeadline != "" {
			if parsed, parseErr := time.Parse(time.RFC3339Nano, task.QueueDeadline); parseErr == nil {
				deadline = parsed
			}
		}
		if !deadline.After(now) {
			failureCode := "dispatch_timeout"
			switch task.QueueReason {
			case cloudplane.QueueReasonNodeOffline:
				failureCode = "computer_offline"
			case cloudplane.QueueReasonCapacityWait:
				failureCode = "capacity_timeout"
			case cloudplane.QueueReasonComputerStarting:
				failureCode = "computer_unavailable"
			}
			updated, err := scanQueueTask(transaction.QueryRow(ctx, `
UPDATE zapvm.tasks SET state='failed',failure_code=$1,updated_at=$2
WHERE id=$3 AND state='pending'
RETURNING `+queueTaskColumns, failureCode, now, task.ID))
			if err != nil {
				return databaseFailure("expire PostgreSQL pending Task", err)
			}
			if err := insertQueueOutbox(ctx, transaction, updated, "terminal", 0, now); err != nil {
				return err
			}
			if _, err := appendAudit(ctx, transaction, now, auditInput{action: "task_dispatch_timeout", scope: updated.Scope(), taskID: updated.ID, outcome: updated.State}); err != nil {
				return err
			}
			continue
		}
		reason, placementEpoch, err := queue.taskQueueReason(ctx, transaction, task.Scope(), task.ComputerID, now)
		if err != nil {
			return err
		}
		if task.QueueReason != reason || task.QueueDeadline == "" || task.PlacementEpoch != placementEpoch {
			if _, err := transaction.Exec(ctx, `UPDATE zapvm.tasks SET queue_reason=$1,queue_deadline=$2,placement_epoch=$3 WHERE id=$4 AND state='pending'`, reason, deadline, optionalUint64(placementEpoch), task.ID); err != nil {
				return databaseFailure("refresh PostgreSQL Task queue status", err)
			}
			if task.QueueReason != "" && task.QueueReason != reason {
				if _, err := appendAudit(ctx, transaction, now, auditInput{action: "task_queue_reason", scope: task.Scope(), taskID: task.ID, outcome: reason}); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (queue *Queue) reapExpired(ctx context.Context, transaction pgx.Tx, now time.Time, claimingNodeID, claimingGeneration string) error {
	type nodeAuthority struct{ id, generation string }
	expiredNodes := make(map[nodeAuthority]int)
	expiredTaskNodes := make(map[string]string)
	expiredTaskIDs := make([]string, 0, 1024)
	lockedRows, err := transaction.Query(ctx, `
SELECT id,node_id,node_generation FROM zapvm.tasks
WHERE state IN ('leased','running','canceling') AND lease_expires_at <= $1
ORDER BY (node_id=$2 AND node_generation=$3) DESC,lease_expires_at,id
FOR UPDATE SKIP LOCKED
LIMIT 1024`, now, claimingNodeID, claimingGeneration)
	if err != nil {
		return databaseFailure("lock expired PostgreSQL queue leases", err)
	}
	for lockedRows.Next() {
		var taskID string
		var authority nodeAuthority
		if err := lockedRows.Scan(&taskID, &authority.id, &authority.generation); err != nil {
			lockedRows.Close()
			return errors.New("decode expired PostgreSQL queue authority")
		}
		expiredTaskIDs = append(expiredTaskIDs, taskID)
		expiredTaskNodes[taskID] = authority.id
		expiredNodes[authority]++
	}
	lockedRows.Close()
	if err := lockedRows.Err(); err != nil {
		return errors.New("read expired PostgreSQL queue authorities")
	}
	if len(expiredTaskIDs) == 0 {
		return nil
	}
	rows, err := transaction.Query(ctx, `
UPDATE zapvm.tasks SET
    state = CASE WHEN state='canceling' OR attempt>=10 THEN 'failed' ELSE 'pending' END,
    failure_code = CASE WHEN state='canceling' THEN 'cancel_unconfirmed' WHEN attempt>=10 THEN 'lease_exhausted' ELSE NULL END,
	    node_id=NULL,node_generation=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=$1,
	    queue_reason=CASE WHEN state='canceling' OR attempt>=10 THEN queue_reason ELSE 'dispatch_wait' END,
	    queue_deadline=CASE WHEN state='canceling' OR attempt>=10 THEN queue_deadline ELSE $3 END
WHERE id=ANY($2) AND state IN ('leased','running','canceling') AND lease_expires_at <= $1
RETURNING `+queueTaskColumns, now, expiredTaskIDs, now.Add(queue.dispatchTimeout))
	if err != nil {
		return databaseFailure("reap PostgreSQL queue leases", err)
	}
	reaped := make([]cloudplane.Task, 0)
	for rows.Next() {
		task, err := scanQueueTask(rows)
		if err != nil {
			rows.Close()
			return errors.New("decode reaped PostgreSQL queue Task")
		}
		reaped = append(reaped, task)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read reaped PostgreSQL queue Tasks")
	}
	for _, task := range reaped {
		if err := queue.revokeTaskCredentialCapabilities(ctx, transaction, task, now); err != nil {
			return err
		}
		kind := "requeued"
		if terminalQueueTask(task.State) {
			kind = "terminal"
		}
		if err := insertQueueOutbox(ctx, transaction, task, kind, 0, now); err != nil {
			return err
		}
		if _, err := appendAudit(ctx, transaction, now, auditInput{action: "task_lease_expire", scope: task.Scope(), nodeID: expiredTaskNodes[task.ID], taskID: task.ID, outcome: task.State}); err != nil {
			return err
		}
	}
	authorities := make([]nodeAuthority, 0, len(expiredNodes))
	for authority := range expiredNodes {
		authorities = append(authorities, authority)
	}
	sort.Slice(authorities, func(left, right int) bool {
		if authorities[left].id == authorities[right].id {
			return authorities[left].generation < authorities[right].generation
		}
		return authorities[left].id < authorities[right].id
	})
	for _, authority := range authorities {
		count := expiredNodes[authority]
		if _, err := transaction.Exec(ctx, `UPDATE zapvm.nodes SET in_flight=GREATEST(in_flight-$1,0),updated_at=$2 WHERE id=$3 AND generation=$4`, count, now, authority.id, authority.generation); err != nil {
			return databaseFailure("release expired PostgreSQL queue Node capacity", err)
		}
	}
	return nil
}

func eventFromQueueSource(task cloudplane.Task, source daemonrpc.ComputerTaskEvent, cursor uint64) cloudplane.TaskEvent {
	return cloudplane.TaskEvent{
		Cursor: cursor, Attempt: task.Attempt, SourceCursor: source.Cursor, Timestamp: source.Timestamp,
		TaskID: task.ID, Type: source.Type, CommandID: source.CommandID, Stream: source.Stream,
		Data: append([]byte(nil), source.Data...), PID: source.PID, OK: source.OK, Error: source.Error,
	}
}

func equalQueueEvent(left, right cloudplane.TaskEvent) bool {
	if left.Cursor != right.Cursor || left.Attempt != right.Attempt || left.SourceCursor != right.SourceCursor || left.Timestamp != right.Timestamp || left.TaskID != right.TaskID || left.Type != right.Type || left.CommandID != right.CommandID || left.Stream != right.Stream || left.PID != right.PID || left.Error != right.Error || string(left.Data) != string(right.Data) {
		return false
	}
	if left.OK == nil || right.OK == nil {
		return left.OK == nil && right.OK == nil
	}
	return *left.OK == *right.OK
}
