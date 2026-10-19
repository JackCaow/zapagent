package cloudplane

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"zapvm/internal/daemonrpc"
)

const (
	defaultHeartbeatTTL          = 45 * time.Second
	defaultLeaseTTL              = 2 * time.Minute
	defaultDispatchTimeout       = 2 * time.Minute
	defaultArtifactBytesPerTask  = uint64(20 << 30)
	defaultArtifactBytesPerScope = uint64(100 << 30)
	artifactMetadataRetention    = 7 * 24 * time.Hour
	maxTaskPrunePerSweep         = 1000
	maxEventBytesPerTask         = uint64(8 << 20)
	maxEventBytesTotal           = uint64(24 << 20)
	maxClaimBatch                = 64
	maxTasks                     = 10000
	maxTasksPerScope             = 1000
	maxAuditRecords              = 100000
	MaxEventsPerTask             = 100000
)

type Options struct {
	HeartbeatTTL          time.Duration
	LeaseTTL              time.Duration
	DispatchTimeout       time.Duration
	ArtifactBytesPerTask  uint64
	ArtifactBytesPerScope uint64
	TaskRetention         time.Duration
	Now                   func() time.Time
	Random                io.Reader
	StateMirror           StateMirror
	StateMirrorTimeout    time.Duration
	StatePrimary          StatePrimary
	StatePrimaryTimeout   time.Duration
}

type Store struct {
	mu                    sync.Mutex
	root                  string
	provisions            map[string]NodeProvision
	heartbeatTTL          time.Duration
	leaseTTL              time.Duration
	dispatchTimeout       time.Duration
	artifactBytesPerTask  uint64
	artifactBytesPerScope uint64
	taskRetention         time.Duration
	now                   func() time.Time
	random                io.Reader
	state                 diskState
	degraded              error
	lock                  *os.File
	updates               chan struct{}
	eventBytes            map[string]uint64
	totalEventBytes       uint64
	stateMirror           StateMirror
	stateMirrorTimeout    time.Duration
	statePrimary          StatePrimary
	statePrimaryTimeout   time.Duration
}

func Open(root string, provisions []NodeProvision, options Options) (*Store, error) {
	if err := ValidateComputerAgentPlacements(provisions); err != nil {
		return nil, err
	}
	provisionMap := make(map[string]NodeProvision, len(provisions))
	for _, provision := range provisions {
		if err := provision.Validate(); err != nil {
			return nil, fmt.Errorf("node provision %q: %w", provision.ID, err)
		}
		if _, exists := provisionMap[provision.ID]; exists {
			return nil, errors.New("duplicate node provision")
		}
		provision.Scopes = append([]Scope(nil), provision.Scopes...)
		provision.Computers = append([]ComputerProvision(nil), provision.Computers...)
		provisionMap[provision.ID] = provision
	}
	if len(provisionMap) == 0 {
		return nil, errors.New("at least one node provision is required")
	}
	if options.HeartbeatTTL == 0 {
		options.HeartbeatTTL = defaultHeartbeatTTL
	}
	if options.LeaseTTL == 0 {
		options.LeaseTTL = defaultLeaseTTL
	}
	if options.DispatchTimeout == 0 {
		options.DispatchTimeout = defaultDispatchTimeout
	}
	if options.ArtifactBytesPerTask == 0 {
		options.ArtifactBytesPerTask = defaultArtifactBytesPerTask
	}
	if options.ArtifactBytesPerScope == 0 {
		options.ArtifactBytesPerScope = defaultArtifactBytesPerScope
	}
	if options.HeartbeatTTL < 5*time.Second || options.HeartbeatTTL > 10*time.Minute {
		return nil, errors.New("heartbeat TTL must be between 5 seconds and 10 minutes")
	}
	if options.LeaseTTL < 10*time.Second || options.LeaseTTL > time.Hour {
		return nil, errors.New("lease TTL must be between 10 seconds and 1 hour")
	}
	if options.DispatchTimeout < time.Second || options.DispatchTimeout > time.Hour {
		return nil, errors.New("dispatch timeout must be between 1 second and 1 hour")
	}
	if options.ArtifactBytesPerTask < maxArtifactSize || options.ArtifactBytesPerTask > uint64(100<<30) ||
		options.ArtifactBytesPerScope < options.ArtifactBytesPerTask || options.ArtifactBytesPerScope > uint64(10<<40) {
		return nil, errors.New("cloud control-plane Artifact byte quotas are invalid")
	}
	if options.TaskRetention != 0 && (options.TaskRetention < time.Hour || options.TaskRetention > 365*24*time.Hour) {
		return nil, errors.New("cloud control-plane Task retention must be zero or between 1 hour and 365 days")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Random == nil {
		options.Random = rand.Reader
	}
	if options.StateMirrorTimeout == 0 {
		options.StateMirrorTimeout = 2 * time.Minute
	}
	if options.StateMirrorTimeout < 5*time.Second || options.StateMirrorTimeout > 10*time.Minute {
		return nil, errors.New("cloud control-plane State mirror timeout must be between 5 seconds and 10 minutes")
	}
	if options.StatePrimary != nil && options.StateMirror != nil {
		return nil, errors.New("cloud control-plane State primary and mirror are mutually exclusive")
	}
	if options.StatePrimaryTimeout == 0 {
		options.StatePrimaryTimeout = 2 * time.Minute
	}
	if options.StatePrimaryTimeout < 5*time.Second || options.StatePrimaryTimeout > 10*time.Minute {
		return nil, errors.New("cloud control-plane State primary timeout must be between 5 seconds and 10 minutes")
	}
	if root == "" || !filepath.IsAbs(root) {
		return nil, errors.New("cloud control-plane root must be absolute")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("cloud control-plane root must be a real directory")
	}
	if err := protectRoot(root); err != nil {
		return nil, err
	}
	lock, err := openStoreLock(root)
	if err != nil {
		return nil, err
	}
	var state diskState
	var migrated bool
	primaryLoaded := false
	primaryProvisionsChanged := false
	if options.StatePrimary != nil {
		primaryContext, cancel := context.WithTimeout(context.Background(), options.StatePrimaryTimeout)
		primarySnapshot, exists, loadErr := options.StatePrimary.Load(primaryContext)
		cancel()
		if loadErr != nil {
			_ = closeStoreLock(lock)
			return nil, fmt.Errorf("load cloud control-plane State primary: %w", loadErr)
		}
		if exists {
			state, primaryProvisionsChanged, err = stateFromOfflineSnapshot(primarySnapshot, provisionMap)
			if err != nil {
				_ = closeStoreLock(lock)
				return nil, fmt.Errorf("restore cloud control-plane State primary: %w", err)
			}
			primaryLoaded = true
		}
	}
	if !primaryLoaded {
		state, err = openState(root)
		if err != nil {
			_ = closeStoreLock(lock)
			return nil, err
		}
		migrated, err = migrateState(&state)
		if err != nil {
			_ = closeStoreLock(lock)
			return nil, err
		}
	}
	store := &Store{
		root: root, provisions: provisionMap, heartbeatTTL: options.HeartbeatTTL,
		leaseTTL: options.LeaseTTL, dispatchTimeout: options.DispatchTimeout, artifactBytesPerTask: options.ArtifactBytesPerTask,
		artifactBytesPerScope: options.ArtifactBytesPerScope, taskRetention: options.TaskRetention,
		now: options.Now, random: options.Random, state: state, lock: lock,
		updates: make(chan struct{}), eventBytes: make(map[string]uint64, len(state.Events)),
		stateMirror: options.StateMirror, stateMirrorTimeout: options.StateMirrorTimeout,
		statePrimary: options.StatePrimary, statePrimaryTimeout: options.StatePrimaryTimeout,
	}
	if err := store.validateLoadedState(); err != nil {
		_ = closeStoreLock(lock)
		return nil, err
	}
	for taskID, events := range store.state.Events {
		for _, event := range events {
			weight := eventStorageBytes(event)
			store.eventBytes[taskID] += weight
			store.totalEventBytes += weight
		}
	}
	if store.statePrimary != nil && primaryLoaded && primaryProvisionsChanged {
		snapshot, err := store.offlineSnapshotLocked()
		if err == nil {
			primaryContext, cancel := context.WithTimeout(context.Background(), store.statePrimaryTimeout)
			err = store.statePrimary.Commit(primaryContext, snapshot)
			cancel()
		}
		if err != nil {
			_ = closeStoreLock(lock)
			return nil, fmt.Errorf("reconcile cloud control-plane State primary provisions: %w", err)
		}
	}
	if primaryLoaded || migrated {
		if err := writeState(root, store.state); err != nil {
			_ = closeStoreLock(lock)
			return nil, fmt.Errorf("persist cloud control-plane state cache: %w", err)
		}
	}
	if store.statePrimary != nil && !primaryLoaded {
		snapshot, err := store.offlineSnapshotLocked()
		if err == nil {
			primaryContext, cancel := context.WithTimeout(context.Background(), store.statePrimaryTimeout)
			err = store.statePrimary.Commit(primaryContext, snapshot)
			cancel()
		}
		if err != nil {
			_ = closeStoreLock(lock)
			return nil, fmt.Errorf("initialize cloud control-plane State primary: %w", err)
		}
	}
	if store.stateMirror != nil {
		snapshot, err := store.offlineSnapshotLocked()
		if err == nil {
			mirrorContext, cancel := context.WithTimeout(context.Background(), store.stateMirrorTimeout)
			err = store.stateMirror.Reconcile(mirrorContext, snapshot)
			cancel()
		}
		if err != nil {
			mirrorContext, cancel := context.WithTimeout(context.Background(), store.stateMirrorTimeout)
			_ = store.stateMirror.Close(mirrorContext)
			cancel()
			_ = closeStoreLock(lock)
			return nil, fmt.Errorf("reconcile cloud control-plane State mirror: %w", err)
		}
	}
	return store, nil
}

func (store *Store) Close() error {
	store.mu.Lock()
	if store.lock == nil {
		store.mu.Unlock()
		return nil
	}
	lock := store.lock
	store.lock = nil
	mirror := store.stateMirror
	store.stateMirror = nil
	timeout := store.stateMirrorTimeout
	store.degraded = errors.New("cloud control-plane store is closed")
	store.mu.Unlock()
	var mirrorErr error
	if mirror != nil {
		mirrorContext, cancel := context.WithTimeout(context.Background(), timeout)
		mirrorErr = mirror.Close(mirrorContext)
		cancel()
	}
	return errors.Join(mirrorErr, closeStoreLock(lock))
}

func (store *Store) RegisterNode(nodeID, generation string) (Node, error) {
	return store.RegisterNodeWithReport(nodeID, generation, NodeReport{})
}

func (store *Store) RegisterNodeWithReport(nodeID, generation string, report NodeReport) (Node, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return Node{}, err
	}
	provision, exists := store.provisions[nodeID]
	if !exists {
		return Node{}, ErrUnauthorized
	}
	if !validGeneration(generation) {
		return Node{}, errors.New("node generation is invalid")
	}
	report, err := report.normalized()
	if err != nil {
		return Node{}, err
	}
	now := store.now().UTC()
	if err := store.sweepPersistLocked(now); err != nil {
		return Node{}, err
	}
	current, exists := store.state.Nodes[nodeID]
	if exists && current.Generation != generation {
		if err := store.requeueNodeLocked(nodeID, current.Generation, now); err != nil {
			store.degraded = err
			return Node{}, err
		}
	}
	node := Node{
		ID: nodeID, Generation: generation, State: NodeOnline, Capacity: provision.Capacity,
		Scopes: append([]Scope(nil), provision.Scopes...), LastHeartbeat: timestamp(now),
	}
	applyNodeReport(&node, report)
	node.InFlight = store.inFlightLocked(nodeID, generation)
	store.state.Nodes[nodeID] = node
	if err := store.commitLocked("node_register", Scope{}, nodeID, "", "success"); err != nil {
		return Node{}, err
	}
	return cloneNode(node), nil
}

func (store *Store) Heartbeat(nodeID, generation string, proofs []LeaseProof) (Node, error) {
	return store.HeartbeatWithReport(nodeID, generation, proofs, NodeReport{})
}

func (store *Store) HeartbeatWithReport(nodeID, generation string, proofs []LeaseProof, report NodeReport) (Node, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return Node{}, err
	}
	if len(proofs) > maxClaimBatch {
		return Node{}, errors.New("heartbeat contains too many lease proofs")
	}
	report, err := report.normalized()
	if err != nil {
		return Node{}, err
	}
	now := store.now().UTC()
	if err := store.sweepPersistLocked(now); err != nil {
		return Node{}, err
	}
	node, err := store.requireNodeLocked(nodeID, generation)
	if err != nil {
		return Node{}, err
	}
	seen := make(map[string]struct{}, len(proofs))
	validated := make([]Task, 0, len(proofs))
	for _, proof := range proofs {
		if _, duplicate := seen[proof.TaskID]; duplicate {
			return Node{}, errors.New("heartbeat contains duplicate Task proofs")
		}
		seen[proof.TaskID] = struct{}{}
		task, exists := store.state.Tasks[proof.TaskID]
		if !exists || task.NodeID != nodeID || task.NodeGeneration != generation || !activeTask(task.State) || !tokenMatches(task.LeaseTokenHash, proof.LeaseToken) {
			return Node{}, ErrFenced
		}
		validated = append(validated, task)
	}
	for _, task := range validated {
		task.LeaseExpiresAt = timestamp(now.Add(store.leaseTTL))
		task.UpdatedAt = timestamp(now)
		store.state.Tasks[task.ID] = task
	}
	node.LastHeartbeat = timestamp(now)
	if node.State == NodeOffline {
		node.State = NodeOnline
	}
	node.InFlight = store.inFlightLocked(nodeID, generation)
	applyNodeReport(&node, report)
	store.state.Nodes[nodeID] = node
	if err := store.commitLocked("node_heartbeat", Scope{}, nodeID, "", "success"); err != nil {
		return Node{}, err
	}
	return cloneNode(node), nil
}

// Cancellations returns only cancellation intents for leases proven by the
// current Node generation. A Node cannot enumerate cancellation requests for
// another generation, Node, tenant, or Task whose lease token it does not hold.
func (store *Store) Cancellations(nodeID, generation string, proofs []LeaseProof) ([]string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return nil, err
	}
	if len(proofs) > maxClaimBatch {
		return nil, errors.New("cancellation query contains too many lease proofs")
	}
	if err := store.sweepPersistLocked(store.now().UTC()); err != nil {
		return nil, err
	}
	if _, err := store.requireNodeLocked(nodeID, generation); err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(proofs))
	cancellations := make([]string, 0)
	for _, proof := range proofs {
		if _, duplicate := seen[proof.TaskID]; duplicate {
			return nil, errors.New("cancellation query contains duplicate Task proofs")
		}
		seen[proof.TaskID] = struct{}{}
		task, exists := store.state.Tasks[proof.TaskID]
		if !exists || task.NodeID != nodeID || task.NodeGeneration != generation ||
			!activeTask(task.State) || !tokenMatches(task.LeaseTokenHash, proof.LeaseToken) {
			return nil, ErrFenced
		}
		if task.State == TaskCanceling {
			cancellations = append(cancellations, task.ID)
		}
	}
	sort.Strings(cancellations)
	return cancellations, nil
}

func (store *Store) SetNodeDraining(nodeID, generation string, draining bool) (Node, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return Node{}, err
	}
	now := store.now().UTC()
	if err := store.sweepPersistLocked(now); err != nil {
		return Node{}, err
	}
	node, err := store.requireNodeLocked(nodeID, generation)
	if err != nil {
		return Node{}, err
	}
	if draining {
		node.State = NodeDraining
	} else {
		node.State = NodeOnline
	}
	node.LastHeartbeat = timestamp(now)
	store.state.Nodes[nodeID] = node
	if err := store.commitLocked("node_drain", Scope{}, nodeID, "", node.State); err != nil {
		return Node{}, err
	}
	return cloneNode(node), nil
}

func (store *Store) Submit(principal string, request SubmitRequest) (Task, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.submitLocked(principal, request, nil)
}

func (store *Store) SubmitAgentSession(principal string, request SubmitRequest, sessionID string, continuation bool) (Task, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if !computerID(sessionID) {
		return Task{}, false, errors.New("Agent Session ID is invalid")
	}
	return store.submitLocked(principal, request, func() error {
		if !store.computerSchedulableLocked(request.Scope, request.ComputerID) {
			return ErrComputerOffline
		}
		found := false
		for _, task := range store.state.Tasks {
			if task.Scope() != request.Scope {
				continue
			}
			view, err := publicAgentSession(task)
			if err != nil || view.SessionID != sessionID {
				continue
			}
			found = true
			if view.ComputerID != request.ComputerID || !terminalTask(view.State) {
				return ErrConflict
			}
		}
		if continuation != found {
			return ErrConflict
		}
		return nil
	})
}

func (store *Store) RetryAgentSession(principal string, scope Scope, sourceID, newID string) (Task, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if !validPrincipal(principal) || scope.Validate() != nil {
		return Task{}, false, ErrUnauthorized
	}
	if !computerID(sourceID) || !computerID(newID) || sourceID == newID {
		return Task{}, false, errors.New("Agent retry IDs are invalid")
	}
	if err := store.sweepPersistLocked(store.now().UTC()); err != nil {
		return Task{}, false, err
	}
	source, exists := store.state.Tasks[sourceID]
	if !exists || source.Scope() != scope {
		return Task{}, false, ErrNotFound
	}
	sourceView, err := publicAgentSession(source)
	if err != nil {
		return Task{}, false, ErrNotFound
	}
	if source.State != TaskFailed && source.State != TaskCanceled {
		return Task{}, false, ErrConflict
	}
	command, err := daemonrpc.DecodeComputerTaskSubmit(source.Payload)
	if err != nil {
		return Task{}, false, ErrConflict
	}
	command.ID = newID
	payload, err := json.Marshal(command)
	if err != nil {
		return Task{}, false, err
	}
	request := SubmitRequest{
		ID: newID, Scope: scope, ComputerID: source.ComputerID, Payload: payload,
		CredentialIDs: append([]string(nil), source.CredentialIDs...), RetryOf: sourceID,
	}
	return store.submitLocked(principal, request, func() error {
		if !store.computerSchedulableLocked(scope, source.ComputerID) {
			return ErrComputerOffline
		}
		for _, task := range store.state.Tasks {
			if task.Scope() != scope {
				continue
			}
			view, viewErr := publicAgentSession(task)
			if viewErr != nil || view.SessionID != sourceView.SessionID {
				continue
			}
			if view.ComputerID != source.ComputerID || !terminalTask(view.State) {
				return ErrConflict
			}
		}
		return nil
	})
}

func (store *Store) submitLocked(principal string, request SubmitRequest, admission func() error) (Task, bool, error) {
	if err := store.readyLocked(); err != nil {
		return Task{}, false, err
	}
	if !validPrincipal(principal) {
		return Task{}, false, errors.New("task submit principal is invalid")
	}
	normalizedPayload, err := normalizeTaskPayload(request.Payload)
	if err != nil {
		return Task{}, false, err
	}
	request.Payload = normalizedPayload
	digest, err := request.validate()
	if err != nil {
		return Task{}, false, err
	}
	if !store.computerProvisionedLocked(request.Scope, request.ComputerID) {
		return Task{}, false, ErrUnavailable
	}
	if existing, exists := store.state.Tasks[request.ID]; exists {
		if existing.TenantID != request.Scope.TenantID || existing.ProjectID != request.Scope.ProjectID ||
			existing.ComputerID != request.ComputerID || existing.PayloadSHA256 != digest || existing.RetryOf != request.RetryOf || !equalStrings(existing.CredentialIDs, request.CredentialIDs) {
			return Task{}, false, ErrConflict
		}
		return cloneTask(existing), false, nil
	}
	now := store.now().UTC()
	if err := store.sweepPersistLocked(now); err != nil {
		return Task{}, false, err
	}
	if admission != nil {
		if err := admission(); err != nil {
			return Task{}, false, err
		}
	}
	if len(store.state.Tasks) >= maxTasks {
		return Task{}, false, ErrQuotaReached
	}
	scopeTasks := 0
	for _, task := range store.state.Tasks {
		if task.Scope() == request.Scope {
			scopeTasks++
		}
	}
	if scopeTasks >= maxTasksPerScope {
		return Task{}, false, ErrQuotaReached
	}
	task := Task{
		ID: request.ID, TenantID: request.Scope.TenantID, ProjectID: request.Scope.ProjectID,
		ComputerID: request.ComputerID, Payload: append([]byte(nil), request.Payload...), PayloadSHA256: digest,
		CredentialIDs: append([]string(nil), request.CredentialIDs...), RetryOf: request.RetryOf, State: TaskPending,
		CreatedAt: timestamp(now), CreatedSequence: store.state.Sequence + 1, UpdatedAt: timestamp(now),
		QueueReason: store.queueReasonLocked(request.Scope, request.ComputerID), QueueDeadline: timestamp(now.Add(store.dispatchTimeout)),
	}
	store.state.Tasks[task.ID] = task
	store.state.Events[task.ID] = make([]TaskEvent, 0)
	store.eventBytes[task.ID] = 0
	action := "task_submit"
	if task.RetryOf != "" {
		action = "task_retry"
	}
	if err := store.commitPrincipalLocked(action, task.Scope(), "", task.ID, "accepted", principal); err != nil {
		return Task{}, false, err
	}
	return cloneTask(task), true, nil
}

func (store *Store) Claim(nodeID, generation string, maximum int) ([]Lease, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return nil, err
	}
	if maximum < 1 || maximum > maxClaimBatch {
		return nil, fmt.Errorf("claim maximum must be between 1 and %d", maxClaimBatch)
	}
	now := store.now().UTC()
	if err := store.sweepPersistLocked(now); err != nil {
		return nil, err
	}
	node, err := store.requireNodeLocked(nodeID, generation)
	if err != nil {
		return nil, err
	}
	if node.State != NodeOnline {
		return nil, ErrUnavailable
	}
	if !reportFromNode(node).schedulable() {
		return nil, ErrUnavailable
	}
	available := int(node.Capacity) - int(store.inFlightLocked(nodeID, generation))
	if available <= 0 {
		return nil, ErrCapacityReached
	}
	if maximum > available {
		maximum = available
	}
	leases := make([]Lease, 0, maximum)
	for len(leases) < maximum {
		taskID := store.nextPendingLocked(store.provisions[nodeID])
		if taskID == "" {
			break
		}
		task := store.state.Tasks[taskID]
		tokenBytes := make([]byte, 32)
		if _, err := io.ReadFull(store.random, tokenBytes); err != nil {
			store.degraded = fmt.Errorf("generate lease token: %w", err)
			return nil, store.degraded
		}
		token := base64.RawURLEncoding.EncodeToString(tokenBytes)
		tokenDigest := sha256.Sum256([]byte(token))
		store.state.DispatchSequence++
		task.State = TaskLeased
		task.NodeID = nodeID
		task.NodeGeneration = generation
		task.Attempt++
		task.LeaseTokenHash = hex.EncodeToString(tokenDigest[:])
		task.LeaseExpiresAt = timestamp(now.Add(store.leaseTTL))
		task.UpdatedAt = timestamp(now)
		task.DispatchSequence = store.state.DispatchSequence
		store.state.Tasks[task.ID] = task
		store.state.ScopeDispatch[task.Scope().key()] = store.state.DispatchSequence
		agent := ""
		for _, candidate := range store.provisions[nodeID].Computers {
			if candidate.ID == task.ComputerID && candidate.TenantID == task.TenantID && candidate.ProjectID == task.ProjectID {
				agent = candidate.Agent
				break
			}
		}
		leases = append(leases, Lease{Task: cloneTask(task), Agent: agent, LeaseToken: token})
	}
	if len(leases) == 0 {
		return leases, nil
	}
	store.state.Nodes[nodeID] = node
	for _, lease := range leases {
		if err := store.appendAuditLocked("task_lease", lease.Task.Scope(), nodeID, lease.Task.ID, "success"); err != nil {
			store.degraded = err
			return nil, err
		}
	}
	if err := store.persistLocked(); err != nil {
		return nil, err
	}
	return leases, nil
}

func (store *Store) Acknowledge(nodeID, generation, taskID, leaseToken string) (Task, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return Task{}, err
	}
	now := store.now().UTC()
	if err := store.sweepPersistLocked(now); err != nil {
		return Task{}, err
	}
	if _, err := store.requireNodeLocked(nodeID, generation); err != nil {
		return Task{}, err
	}
	task, err := store.requireLeaseLocked(nodeID, generation, taskID, leaseToken)
	if err != nil {
		return Task{}, err
	}
	if task.State == TaskCanceling {
		return cloneTask(task), nil
	}
	if task.State != TaskLeased {
		return Task{}, ErrConflict
	}
	task.State = TaskRunning
	task.UpdatedAt = timestamp(now)
	task.LeaseExpiresAt = timestamp(now.Add(store.leaseTTL))
	store.state.Tasks[task.ID] = task
	if err := store.commitLocked("task_ack", task.Scope(), nodeID, task.ID, "success"); err != nil {
		return Task{}, err
	}
	return cloneTask(task), nil
}

func (store *Store) Complete(nodeID, generation, taskID, leaseToken string, completion Completion) (Task, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return Task{}, err
	}
	if err := completion.validate(); err != nil {
		return Task{}, err
	}
	now := store.now().UTC()
	if err := store.sweepPersistLocked(now); err != nil {
		return Task{}, err
	}
	if _, err := store.requireNodeLocked(nodeID, generation); err != nil {
		return Task{}, err
	}
	task, err := store.requireLeaseLocked(nodeID, generation, taskID, leaseToken)
	if err != nil {
		return Task{}, err
	}
	if task.State != TaskRunning && task.State != TaskCanceling {
		return Task{}, ErrConflict
	}
	if completion.Succeeded {
		task.State = TaskSucceeded
	} else {
		task.State = TaskFailed
	}
	task.ResultSHA256 = completion.ResultSHA256
	task.FailureCode = completion.FailureCode
	task.UpdatedAt = timestamp(now)
	clearLease(&task)
	store.state.Tasks[task.ID] = task
	if err := store.commitLocked("task_complete", task.Scope(), nodeID, task.ID, task.State); err != nil {
		return Task{}, err
	}
	return cloneTask(task), nil
}

func (store *Store) ConfirmCanceled(nodeID, generation, taskID, leaseToken string) (Task, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return Task{}, err
	}
	now := store.now().UTC()
	if err := store.sweepPersistLocked(now); err != nil {
		return Task{}, err
	}
	if _, err := store.requireNodeLocked(nodeID, generation); err != nil {
		return Task{}, err
	}
	task, err := store.requireLeaseLocked(nodeID, generation, taskID, leaseToken)
	if err != nil {
		return Task{}, err
	}
	if task.State != TaskCanceling {
		return Task{}, ErrConflict
	}
	task.State = TaskCanceled
	task.UpdatedAt = timestamp(now)
	clearLease(&task)
	store.state.Tasks[task.ID] = task
	if err := store.commitLocked("task_canceled", task.Scope(), nodeID, task.ID, "confirmed"); err != nil {
		return Task{}, err
	}
	return cloneTask(task), nil
}

func (store *Store) AppendTaskEvent(nodeID, generation, taskID, leaseToken string, source daemonrpc.ComputerTaskEvent) (TaskEvent, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return TaskEvent{}, false, err
	}
	now := store.now().UTC()
	if err := store.sweepPersistLocked(now); err != nil {
		return TaskEvent{}, false, err
	}
	if _, err := store.requireNodeLocked(nodeID, generation); err != nil {
		return TaskEvent{}, false, err
	}
	task, err := store.requireLeaseLocked(nodeID, generation, taskID, leaseToken)
	if err != nil {
		return TaskEvent{}, false, err
	}
	if (task.State != TaskRunning && task.State != TaskCanceling) || source.TaskID != taskID || source.Cursor == 0 {
		return TaskEvent{}, false, ErrConflict
	}
	events := store.state.Events[taskID]
	var lastSource uint64
	for _, existing := range events {
		if existing.Attempt != task.Attempt {
			continue
		}
		lastSource = existing.SourceCursor
		if existing.SourceCursor == source.Cursor {
			candidate := taskEventFromSource(task, source, existing.Cursor)
			if equalTaskEvent(existing, candidate) {
				return cloneTaskEvent(existing), false, nil
			}
			return TaskEvent{}, false, ErrConflict
		}
	}
	if len(events) >= MaxEventsPerTask || source.Cursor != lastSource+1 {
		return TaskEvent{}, false, ErrConflict
	}
	event := taskEventFromSource(task, source, uint64(len(events)+1))
	if err := validateTaskEvent(event); err != nil {
		return TaskEvent{}, false, err
	}
	weight := eventStorageBytes(event)
	if weight > maxEventBytesPerTask || store.eventBytes[taskID] > maxEventBytesPerTask-weight ||
		weight > maxEventBytesTotal || store.totalEventBytes > maxEventBytesTotal-weight {
		return TaskEvent{}, false, ErrQuotaReached
	}
	store.state.Events[taskID] = append(events, event)
	store.eventBytes[taskID] += weight
	store.totalEventBytes += weight
	task.UpdatedAt = timestamp(now)
	task.LeaseExpiresAt = timestamp(now.Add(store.leaseTTL))
	store.state.Tasks[taskID] = task
	if err := store.commitLocked("task_event", task.Scope(), nodeID, taskID, "accepted"); err != nil {
		return TaskEvent{}, false, err
	}
	return cloneTaskEvent(event), true, nil
}

func (store *Store) TaskEvents(scope Scope, taskID string, after uint64, limit int) ([]TaskEvent, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := scope.Validate(); err != nil {
		return nil, ErrUnauthorized
	}
	task, exists := store.state.Tasks[taskID]
	if !exists || task.Scope() != scope {
		return nil, ErrNotFound
	}
	if limit < 1 || limit > 1000 {
		return nil, errors.New("Task event limit must be between 1 and 1000")
	}
	events := store.state.Events[taskID]
	if after > uint64(len(events)) {
		return nil, errors.New("Task event cursor is ahead of the journal")
	}
	end := after + uint64(limit)
	if end > uint64(len(events)) {
		end = uint64(len(events))
	}
	result := make([]TaskEvent, 0, end-after)
	for _, event := range events[after:end] {
		result = append(result, cloneTaskEvent(event))
	}
	return result, nil
}

func (store *Store) WaitTaskEvents(ctx context.Context, scope Scope, taskID string, after uint64, limit int) (Task, []TaskEvent, error) {
	if ctx == nil {
		return Task{}, nil, errors.New("Task event wait context is required")
	}
	for {
		store.mu.Lock()
		if err := scope.Validate(); err != nil {
			store.mu.Unlock()
			return Task{}, nil, ErrUnauthorized
		}
		task, exists := store.state.Tasks[taskID]
		if !exists || task.Scope() != scope {
			store.mu.Unlock()
			return Task{}, nil, ErrNotFound
		}
		if limit < 1 || limit > 1000 {
			store.mu.Unlock()
			return Task{}, nil, errors.New("Task event limit must be between 1 and 1000")
		}
		events := store.state.Events[taskID]
		if after > uint64(len(events)) {
			store.mu.Unlock()
			return Task{}, nil, errors.New("Task event cursor is ahead of the journal")
		}
		end := after + uint64(limit)
		if end > uint64(len(events)) {
			end = uint64(len(events))
		}
		result := make([]TaskEvent, 0, end-after)
		for _, event := range events[after:end] {
			result = append(result, cloneTaskEvent(event))
		}
		if len(result) != 0 || terminalTask(task.State) {
			store.mu.Unlock()
			return cloneTask(task), result, nil
		}
		updates := store.updates
		store.mu.Unlock()
		select {
		case <-ctx.Done():
			return Task{}, nil, ctx.Err()
		case <-updates:
		}
	}
}

func (store *Store) Cancel(principal string, scope Scope, taskID string) (Task, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return Task{}, err
	}
	if !validPrincipal(principal) || scope.Validate() != nil {
		return Task{}, ErrUnauthorized
	}
	if err := store.sweepPersistLocked(store.now().UTC()); err != nil {
		return Task{}, err
	}
	task, exists := store.state.Tasks[taskID]
	if !exists || task.Scope() != scope {
		return Task{}, ErrNotFound
	}
	if task.State == TaskCanceled || task.State == TaskCanceling {
		return cloneTask(task), nil
	}
	if terminalTask(task.State) {
		return Task{}, ErrTerminal
	}
	nodeID := task.NodeID
	if task.State == TaskPending {
		task.State = TaskCanceled
		clearLease(&task)
	} else {
		task.State = TaskCanceling
	}
	task.UpdatedAt = timestamp(store.now().UTC())
	store.state.Tasks[task.ID] = task
	if err := store.commitPrincipalLocked("task_cancel", scope, nodeID, task.ID, task.State, principal); err != nil {
		return Task{}, err
	}
	return cloneTask(task), nil
}

func (store *Store) InspectTask(scope Scope, taskID string) (Task, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := scope.Validate(); err != nil {
		return Task{}, ErrUnauthorized
	}
	task, exists := store.state.Tasks[taskID]
	if !exists || task.Scope() != scope {
		return Task{}, ErrNotFound
	}
	return cloneTask(task), nil
}

func (store *Store) ListAgentSessions(scope Scope, after uint64, limit int) ([]Task, uint64, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := scope.Validate(); err != nil {
		return nil, after, ErrUnauthorized
	}
	if limit < 1 || limit > 1000 {
		return nil, after, errors.New("Agent Session limit must be between 1 and 1000")
	}
	candidates := make([]Task, 0)
	for _, task := range store.state.Tasks {
		if task.Scope() != scope || task.CreatedSequence <= after {
			continue
		}
		if _, err := publicAgentSession(task); err != nil {
			continue
		}
		candidates = append(candidates, task)
	}
	sort.Slice(candidates, func(left, right int) bool {
		if candidates[left].CreatedSequence != candidates[right].CreatedSequence {
			return candidates[left].CreatedSequence < candidates[right].CreatedSequence
		}
		return candidates[left].ID < candidates[right].ID
	})
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	next := after
	result := make([]Task, 0, len(candidates))
	for _, task := range candidates {
		result = append(result, cloneTask(task))
		next = task.CreatedSequence
	}
	return result, next, nil
}

func (store *Store) ListAgentComputers(scope Scope) ([]AgentComputer, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := scope.Validate(); err != nil {
		return nil, ErrUnauthorized
	}
	if err := store.sweepPersistLocked(store.now().UTC()); err != nil {
		return nil, err
	}
	ids := make(map[string]struct{})
	for _, provision := range store.provisions {
		for _, computerProvision := range provision.Computers {
			if computerProvision.Scope() == scope {
				ids[computerProvision.ID] = struct{}{}
			}
		}
	}
	computers := make([]AgentComputer, 0, len(ids))
	for id := range ids {
		computers = append(computers, store.computerRuntimeLocked(scope, id))
	}
	sort.Slice(computers, func(left, right int) bool { return computers[left].ID < computers[right].ID })
	return computers, nil
}

func (store *Store) ListNodes() []Node {
	store.mu.Lock()
	defer store.mu.Unlock()
	nodes := make([]Node, 0, len(store.state.Nodes))
	for _, node := range store.state.Nodes {
		node.InFlight = store.inFlightLocked(node.ID, node.Generation)
		nodes = append(nodes, cloneNode(node))
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })
	return nodes
}

func (store *Store) Sweep() error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return err
	}
	return store.sweepPersistLocked(store.now().UTC())
}

func (store *Store) requireNodeLocked(nodeID, generation string) (Node, error) {
	node, exists := store.state.Nodes[nodeID]
	if !exists || node.Generation != generation {
		return Node{}, ErrFenced
	}
	last, err := parseTimestamp(node.LastHeartbeat)
	if err != nil || store.now().UTC().Sub(last) > store.heartbeatTTL || node.State == NodeOffline {
		return Node{}, ErrUnavailable
	}
	return node, nil
}

func (store *Store) requireLeaseLocked(nodeID, generation, taskID, token string) (Task, error) {
	task, exists := store.state.Tasks[taskID]
	if !exists {
		return Task{}, ErrNotFound
	}
	if task.NodeID != nodeID || task.NodeGeneration != generation || !activeTask(task.State) || !tokenMatches(task.LeaseTokenHash, token) {
		return Task{}, ErrFenced
	}
	expires, err := parseTimestamp(task.LeaseExpiresAt)
	if err != nil || !expires.After(store.now().UTC()) {
		return Task{}, ErrFenced
	}
	return task, nil
}

func (store *Store) nextPendingLocked(provision NodeProvision) string {
	allowed := make(map[string]struct{}, len(provision.Scopes))
	tenants := make(map[string]struct{}, len(provision.Scopes))
	for _, scope := range provision.Scopes {
		allowed[scope.key()] = struct{}{}
		tenants[scope.TenantID] = struct{}{}
	}
	type candidate struct {
		id            string
		scopeDispatch uint64
		created       uint64
	}
	var candidates []candidate
	for _, task := range store.state.Tasks {
		if task.State != TaskPending || task.Attempt >= MaxAttempts {
			continue
		}
		if _, ok := allowed[task.Scope().key()]; !ok {
			continue
		}
		if !store.computerAllowedOnProvisionLocked(provision, task.Scope(), task.ComputerID) {
			continue
		}
		// Credential values remain in the Host-local broker. A node serving more
		// than one tenant must never receive a credential-bearing Task because
		// the local daemon credential namespace is not tenant-qualified.
		if len(task.CredentialIDs) != 0 && len(tenants) != 1 {
			continue
		}
		candidates = append(candidates, candidate{id: task.ID, scopeDispatch: store.state.ScopeDispatch[task.Scope().key()], created: task.CreatedSequence})
	}
	if len(candidates) == 0 {
		return ""
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].scopeDispatch != candidates[j].scopeDispatch {
			return candidates[i].scopeDispatch < candidates[j].scopeDispatch
		}
		if candidates[i].created != candidates[j].created {
			return candidates[i].created < candidates[j].created
		}
		return candidates[i].id < candidates[j].id
	})
	return candidates[0].id
}

func (store *Store) computerProvisionedLocked(scope Scope, computerID string) bool {
	hasExplicitCatalog := store.scopeHasExplicitComputersLocked(scope)
	for _, provision := range store.provisions {
		for _, authorized := range provision.Scopes {
			if authorized != scope {
				continue
			}
			if !hasExplicitCatalog && len(provision.Computers) == 0 {
				return true
			}
			for _, computerProvision := range provision.Computers {
				if computerProvision.ID == computerID && computerProvision.Scope() == scope {
					return true
				}
			}
		}
	}
	return false
}

func (store *Store) computerSchedulableLocked(scope Scope, computerID string) bool {
	for nodeID, provision := range store.provisions {
		if !store.computerAllowedOnProvisionLocked(provision, scope, computerID) {
			continue
		}
		node, exists := store.state.Nodes[nodeID]
		if exists && node.State == NodeOnline && reportFromNode(node).schedulable() {
			return true
		}
	}
	return false
}

func (store *Store) queueReasonLocked(scope Scope, computerID string) string {
	hasSchedulable := false
	for nodeID, provision := range store.provisions {
		if !store.computerAllowedOnProvisionLocked(provision, scope, computerID) {
			continue
		}
		node, exists := store.state.Nodes[nodeID]
		if !exists || node.State != NodeOnline || !reportFromNode(node).schedulable() {
			continue
		}
		hasSchedulable = true
		if store.inFlightLocked(nodeID, node.Generation) < node.Capacity {
			return QueueReasonDispatchWait
		}
	}
	if hasSchedulable {
		return QueueReasonCapacityWait
	}
	return QueueReasonNodeOffline
}

func (store *Store) computerRuntimeLocked(scope Scope, computerID string) AgentComputer {
	computer := AgentComputer{
		ID: computerID, State: NodeOffline, DesiredState: ComputerDesiredRunning,
		ObservedState: ComputerObservedUnavailable, FailureCode: QueueReasonNodeOffline,
	}
	var lastActivity time.Time
	nodeIDs := make([]string, 0, len(store.provisions))
	for nodeID := range store.provisions {
		nodeIDs = append(nodeIDs, nodeID)
	}
	sort.Strings(nodeIDs)
	for _, nodeID := range nodeIDs {
		provision := store.provisions[nodeID]
		if !store.computerAllowedOnProvisionLocked(provision, scope, computerID) {
			continue
		}
		node, exists := store.state.Nodes[nodeID]
		if !exists {
			continue
		}
		if node.State == NodeOnline && reportFromNode(node).schedulable() {
			computer.State = NodeOnline
			computer.ObservedState = ComputerObservedReady
			computer.AssignedNodeID = nodeID
			computer.FailureCode = ""
			break
		}
		if computer.ObservedState == ComputerObservedUnavailable && (node.State == NodeDraining || node.DaemonState == DaemonDegraded) {
			computer.State = NodeDraining
			computer.ObservedState = ComputerObservedDegraded
			computer.AssignedNodeID = nodeID
			computer.FailureCode = "node_degraded"
		}
	}
	for _, task := range store.state.Tasks {
		if task.Scope() != scope || task.ComputerID != computerID {
			continue
		}
		updated, err := parseTimestamp(task.UpdatedAt)
		if err == nil && updated.After(lastActivity) {
			lastActivity = updated
			computer.LastActivityAt = task.UpdatedAt
		}
		node, nodeAvailable := store.state.Nodes[task.NodeID]
		if activeTask(task.State) && nodeAvailable && node.State == NodeOnline && reportFromNode(node).schedulable() {
			computer.State = NodeOnline
			computer.ObservedState = ComputerObservedBusy
			computer.AssignedNodeID = task.NodeID
			computer.FailureCode = ""
		}
	}
	return computer
}

func (store *Store) computerAllowedOnProvisionLocked(provision NodeProvision, scope Scope, computerID string) bool {
	if len(provision.Computers) == 0 {
		// Schema-1 configurations without an explicit catalog retain their
		// original scope-wide behavior only until that scope has any explicit
		// Computer catalog. Mixed rollout cannot create a wildcard bypass.
		return !store.scopeHasExplicitComputersLocked(scope)
	}
	for _, computerProvision := range provision.Computers {
		if computerProvision.ID == computerID && computerProvision.Scope() == scope {
			return true
		}
	}
	return false
}

func (store *Store) scopeHasExplicitComputersLocked(scope Scope) bool {
	for _, provision := range store.provisions {
		for _, computerProvision := range provision.Computers {
			if computerProvision.Scope() == scope {
				return true
			}
		}
	}
	return false
}

func (store *Store) sweepPersistLocked(now time.Time) error {
	before := store.state.Sequence
	if err := store.sweepLocked(now); err != nil {
		store.degraded = err
		return err
	}
	if store.state.Sequence != before {
		return store.persistLocked()
	}
	return nil
}

func (store *Store) sweepLocked(now time.Time) error {
	for id, node := range store.state.Nodes {
		last, err := parseTimestamp(node.LastHeartbeat)
		if err != nil || now.Sub(last) > store.heartbeatTTL {
			if node.State != NodeOffline {
				node.State = NodeOffline
				store.state.Nodes[id] = node
				if err := store.appendAuditLocked("node_offline", Scope{}, id, "", "timeout"); err != nil {
					return err
				}
			}
		}
	}
	for id, task := range store.state.Tasks {
		if task.State == TaskPending {
			previousReason := task.QueueReason
			task.QueueReason = store.queueReasonLocked(task.Scope(), task.ComputerID)
			if previousReason != "" && previousReason != task.QueueReason {
				if err := store.appendAuditLocked("task_queue_reason", task.Scope(), "", task.ID, task.QueueReason); err != nil {
					return err
				}
			}
			deadline, err := parseTimestamp(task.QueueDeadline)
			if err != nil {
				task.QueueDeadline = timestamp(now.Add(store.dispatchTimeout))
				deadline, _ = parseTimestamp(task.QueueDeadline)
			}
			if !deadline.After(now) {
				task.State = TaskFailed
				switch task.QueueReason {
				case QueueReasonNodeOffline:
					task.FailureCode = "computer_offline"
				case QueueReasonCapacityWait:
					task.FailureCode = "capacity_timeout"
				default:
					task.FailureCode = "dispatch_timeout"
				}
				task.UpdatedAt = timestamp(now)
				if err := store.appendAuditLocked("task_dispatch_timeout", task.Scope(), "", task.ID, task.State); err != nil {
					return err
				}
			}
			store.state.Tasks[id] = task
			continue
		}
		if !activeTask(task.State) {
			continue
		}
		expires, err := parseTimestamp(task.LeaseExpiresAt)
		if err == nil && expires.After(now) {
			continue
		}
		if task.State == TaskCanceling {
			task.State = TaskFailed
			task.FailureCode = "cancel_unconfirmed"
		} else if task.Attempt >= MaxAttempts {
			task.State = TaskFailed
			task.FailureCode = "lease_exhausted"
		} else {
			task.State = TaskPending
			task.QueueReason = store.queueReasonLocked(task.Scope(), task.ComputerID)
			task.QueueDeadline = timestamp(now.Add(store.dispatchTimeout))
		}
		nodeID := task.NodeID
		task.UpdatedAt = timestamp(now)
		clearLease(&task)
		store.state.Tasks[id] = task
		if err := store.appendAuditLocked("task_lease_expire", task.Scope(), nodeID, task.ID, task.State); err != nil {
			return err
		}
	}
	for id, operation := range store.state.WorkspaceOperations {
		updated, _ := parseTimestamp(operation.UpdatedAt)
		if (operation.State == WorkspaceOperationSucceeded || operation.State == WorkspaceOperationFailed) && now.Sub(updated) >= workspaceOperationRetention {
			delete(store.state.WorkspaceOperations, id)
			if err := store.appendOperationAuditLocked("prune", operation, "", "retention"); err != nil {
				return err
			}
			continue
		}
		expires, _ := parseTimestamp(operation.ExpiresAt)
		if operation.State == WorkspaceOperationPending && !expires.After(now) {
			operation.State = WorkspaceOperationFailed
			operation.FailureCode = "operation_timeout"
			operation.UpdatedAt = timestamp(now)
			store.state.WorkspaceOperations[id] = operation
			if err := store.appendOperationAuditLocked("expire", operation, "", operation.State); err != nil {
				return err
			}
			continue
		}
		if operation.State != WorkspaceOperationLeased {
			continue
		}
		leaseExpires, _ := parseTimestamp(operation.LeaseExpiresAt)
		if leaseExpires.After(now) {
			continue
		}
		nodeID := operation.NodeID
		if !expires.After(now) {
			operation.State = WorkspaceOperationFailed
			operation.FailureCode = "operation_timeout"
		} else if operation.Attempt >= MaxAttempts {
			operation.State = WorkspaceOperationFailed
			operation.FailureCode = "lease_exhausted"
		} else {
			operation.State = WorkspaceOperationPending
		}
		operation.UpdatedAt = timestamp(now)
		clearWorkspaceOperationLease(&operation)
		store.state.WorkspaceOperations[id] = operation
		if err := store.appendOperationAuditLocked("lease_expire", operation, nodeID, operation.State); err != nil {
			return err
		}
	}
	for id, artifact := range store.state.Artifacts {
		if artifact.State == ArtifactExpired {
			updated, _ := parseTimestamp(artifact.UpdatedAt)
			if artifact.ObjectKey == "" && now.Sub(updated) >= artifactMetadataRetention {
				if err := store.appendArtifactAuditLocked("artifact_prune", artifact.Scope(), "", artifact.TaskID, artifact.ID, "retention"); err != nil {
					return err
				}
				delete(store.state.Artifacts, id)
			}
			continue
		}
		expires, _ := parseTimestamp(artifact.ExpiresAt)
		if expires.After(now) {
			continue
		}
		artifact.State = ArtifactExpired
		artifact.FailureCode = ""
		artifact.UpdatedAt = timestamp(now)
		store.state.Artifacts[id] = artifact
		if err := store.appendArtifactAuditLocked("artifact_expire", artifact.Scope(), "", artifact.TaskID, artifact.ID, ArtifactExpired); err != nil {
			return err
		}
	}
	return store.pruneTasksLocked(now)
}

func (store *Store) pruneTasksLocked(now time.Time) error {
	if store.taskRetention == 0 || len(store.state.Tasks) == 0 {
		return nil
	}
	adjacent := make(map[string][]string, len(store.state.Tasks))
	sessionFirst := make(map[string]string)
	for id, task := range store.state.Tasks {
		if _, exists := adjacent[id]; !exists {
			adjacent[id] = nil
		}
		if task.RetryOf != "" {
			if _, exists := store.state.Tasks[task.RetryOf]; exists {
				adjacent[id] = append(adjacent[id], task.RetryOf)
				adjacent[task.RetryOf] = append(adjacent[task.RetryOf], id)
			}
		}
		view, err := publicAgentSession(task)
		if err != nil {
			continue
		}
		key := task.Scope().key() + "\x00" + view.SessionID
		if first, exists := sessionFirst[key]; exists {
			adjacent[id] = append(adjacent[id], first)
			adjacent[first] = append(adjacent[first], id)
		} else {
			sessionFirst[key] = id
		}
	}
	type taskGroup struct {
		ids       []string
		updatedAt time.Time
		eligible  bool
	}
	visited := make(map[string]struct{}, len(store.state.Tasks))
	groups := make([]taskGroup, 0)
	artifactTasks := make(map[string]struct{}, len(store.state.Artifacts))
	for _, artifact := range store.state.Artifacts {
		artifactTasks[artifact.TaskID] = struct{}{}
	}
	for _, operation := range store.state.WorkspaceOperations {
		if operation.Kind == WorkspaceOperationGitPush {
			artifactTasks[operation.TaskID] = struct{}{}
		}
	}
	for id := range store.state.Tasks {
		if _, seen := visited[id]; seen {
			continue
		}
		group := taskGroup{eligible: true}
		pending := []string{id}
		for len(pending) > 0 {
			last := len(pending) - 1
			current := pending[last]
			pending = pending[:last]
			if _, seen := visited[current]; seen {
				continue
			}
			visited[current] = struct{}{}
			group.ids = append(group.ids, current)
			pending = append(pending, adjacent[current]...)
		}
		for _, taskID := range group.ids {
			task := store.state.Tasks[taskID]
			updated, err := parseTimestamp(task.UpdatedAt)
			if err != nil || !terminalTask(task.State) || now.Sub(updated) < store.taskRetention {
				group.eligible = false
			}
			if updated.After(group.updatedAt) {
				group.updatedAt = updated
			}
		}
		if group.eligible {
			for _, taskID := range group.ids {
				if _, exists := artifactTasks[taskID]; exists {
					group.eligible = false
					break
				}
			}
		}
		sort.Strings(group.ids)
		groups = append(groups, group)
	}
	sort.Slice(groups, func(left, right int) bool {
		if !groups[left].updatedAt.Equal(groups[right].updatedAt) {
			return groups[left].updatedAt.Before(groups[right].updatedAt)
		}
		return groups[left].ids[0] < groups[right].ids[0]
	})
	pruned := 0
	for _, group := range groups {
		if !group.eligible || pruned+len(group.ids) > maxTaskPrunePerSweep {
			continue
		}
		for _, taskID := range group.ids {
			task := store.state.Tasks[taskID]
			if err := store.appendAuditLocked("task_prune", task.Scope(), "", task.ID, "retention"); err != nil {
				return err
			}
			delete(store.state.Tasks, taskID)
			delete(store.state.Events, taskID)
			weight := store.eventBytes[taskID]
			if store.totalEventBytes >= weight {
				store.totalEventBytes -= weight
			} else {
				store.totalEventBytes = 0
			}
			delete(store.eventBytes, taskID)
			pruned++
		}
	}
	return nil
}

func (store *Store) requeueNodeLocked(nodeID, generation string, now time.Time) error {
	for id, task := range store.state.Tasks {
		if task.NodeID != nodeID || task.NodeGeneration != generation || !activeTask(task.State) {
			continue
		}
		if task.State == TaskCanceling {
			task.State = TaskFailed
			task.FailureCode = "cancel_unconfirmed"
		} else if task.Attempt >= MaxAttempts {
			task.State = TaskFailed
			task.FailureCode = "generation_exhausted"
		} else {
			task.State = TaskPending
			task.QueueReason = store.queueReasonLocked(task.Scope(), task.ComputerID)
			task.QueueDeadline = timestamp(now.Add(store.dispatchTimeout))
		}
		task.UpdatedAt = timestamp(now)
		clearLease(&task)
		store.state.Tasks[id] = task
		if err := store.appendAuditLocked("task_generation_fence", task.Scope(), nodeID, task.ID, task.State); err != nil {
			return err
		}
	}
	for id, operation := range store.state.WorkspaceOperations {
		if operation.NodeID != nodeID || operation.NodeGeneration != generation || operation.State != WorkspaceOperationLeased {
			continue
		}
		expires, _ := parseTimestamp(operation.ExpiresAt)
		if !expires.After(now) {
			operation.State = WorkspaceOperationFailed
			operation.FailureCode = "operation_timeout"
		} else if operation.Attempt >= MaxAttempts {
			operation.State = WorkspaceOperationFailed
			operation.FailureCode = "generation_exhausted"
		} else {
			operation.State = WorkspaceOperationPending
		}
		operation.UpdatedAt = timestamp(now)
		clearWorkspaceOperationLease(&operation)
		store.state.WorkspaceOperations[id] = operation
		if err := store.appendOperationAuditLocked("generation_fence", operation, nodeID, operation.State); err != nil {
			return err
		}
	}
	return nil
}

func (store *Store) inFlightLocked(nodeID, generation string) uint16 {
	var count uint16
	for _, task := range store.state.Tasks {
		if task.NodeID == nodeID && task.NodeGeneration == generation && activeTask(task.State) {
			count++
		}
	}
	for _, operation := range store.state.WorkspaceOperations {
		if operation.NodeID == nodeID && operation.NodeGeneration == generation && operation.State == WorkspaceOperationLeased {
			count++
		}
	}
	return count
}

func (store *Store) readyLocked() error {
	if store.degraded != nil {
		return errors.Join(ErrStoreDegraded, store.degraded)
	}
	if store.stateMirror != nil && store.stateMirror.Health().Failed {
		return errors.Join(ErrStoreDegraded, errors.New("cloud control-plane State mirror is unavailable"))
	}
	return nil
}

func (store *Store) commitLocked(action string, scope Scope, nodeID, taskID, outcome string) error {
	if err := store.appendAuditLocked(action, scope, nodeID, taskID, outcome); err != nil {
		store.degraded = err
		return err
	}
	return store.persistLocked()
}

func (store *Store) commitPrincipalLocked(action string, scope Scope, nodeID, taskID, outcome, principal string) error {
	if err := store.appendAuditLocked(action, scope, nodeID, taskID, outcome, principal); err != nil {
		store.degraded = err
		return err
	}
	return store.persistLocked()
}

func (store *Store) commitOperationLocked(suffix string, operation WorkspaceOperation, nodeID, outcome string) error {
	if err := store.appendOperationAuditLocked(suffix, operation, nodeID, outcome); err != nil {
		store.degraded = err
		return err
	}
	return store.persistLocked()
}

func (store *Store) commitOperationPrincipalLocked(suffix string, operation WorkspaceOperation, nodeID, outcome, principal string) error {
	if err := store.appendOperationAuditLocked(suffix, operation, nodeID, outcome, principal); err != nil {
		store.degraded = err
		return err
	}
	return store.persistLocked()
}

func (store *Store) persistLocked() error {
	if store.statePrimary != nil {
		snapshot, err := store.offlineSnapshotLocked()
		if err != nil {
			store.degraded = err
			return err
		}
		primaryContext, cancel := context.WithTimeout(context.Background(), store.statePrimaryTimeout)
		err = store.statePrimary.Commit(primaryContext, snapshot)
		cancel()
		if err != nil {
			store.degraded = err
			return err
		}
		if err := writeState(store.root, store.state); err != nil {
			store.degraded = err
			return err
		}
	} else {
		if err := writeState(store.root, store.state); err != nil {
			store.degraded = err
			return err
		}
		if store.stateMirror != nil {
			snapshot, err := store.offlineSnapshotLocked()
			if err != nil {
				store.degraded = err
				return err
			}
			if err := store.stateMirror.Enqueue(snapshot); err != nil {
				store.degraded = err
				return err
			}
		}
	}
	if store.updates != nil {
		close(store.updates)
	}
	store.updates = make(chan struct{})
	return nil
}

func tokenMatches(expectedHash, token string) bool {
	if expectedHash == "" || len(token) != 43 {
		return false
	}
	digest := sha256.Sum256([]byte(token))
	actual := hex.EncodeToString(digest[:])
	return subtleStringEqual(expectedHash, actual)
}

func subtleStringEqual(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	var difference byte
	for index := range left {
		difference |= left[index] ^ right[index]
	}
	return difference == 0
}

func clearLease(task *Task) {
	task.NodeID = ""
	task.NodeGeneration = ""
	task.LeaseTokenHash = ""
	task.LeaseExpiresAt = ""
}

func activeTask(state string) bool {
	return state == TaskLeased || state == TaskRunning || state == TaskCanceling
}

func terminalTask(state string) bool {
	return state == TaskSucceeded || state == TaskFailed || state == TaskCanceled
}

// IsTerminalTaskState reports whether no further execution transition is valid.
func IsTerminalTaskState(state string) bool { return terminalTask(state) }

func timestamp(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func equalStrings(left, right []string) bool {
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

func taskEventFromSource(task Task, source daemonrpc.ComputerTaskEvent, cursor uint64) TaskEvent {
	return TaskEvent{
		Cursor: cursor, Attempt: task.Attempt, SourceCursor: source.Cursor, Timestamp: source.Timestamp,
		TaskID: task.ID, Type: source.Type, CommandID: source.CommandID, Stream: source.Stream,
		Data: append([]byte(nil), source.Data...), PID: source.PID, OK: source.OK, Error: source.Error,
	}
}

func eventStorageBytes(event TaskEvent) uint64 {
	// Data is base64-encoded in state.json. A 2x accounting factor plus fixed
	// envelope overhead deliberately leaves headroom under maxStateSize.
	return uint64(len(event.Data))*2 + uint64(len(event.Error)+len(event.Type)+len(event.CommandID)+len(event.Stream)+len(event.Timestamp)+len(event.TaskID)) + 256
}

func validateTaskEvent(event TaskEvent) error {
	if event.Cursor == 0 || event.Attempt == 0 || event.SourceCursor == 0 || !computerID(event.TaskID) ||
		!validName(event.Type, 64) || len(event.Data) > MaxPayloadSize || len(event.Error) > 4096 {
		return errors.New("Task event fields are invalid")
	}
	if _, err := parseTimestamp(event.Timestamp); err != nil {
		return err
	}
	if event.CommandID != "" && !computerID(event.CommandID) {
		return errors.New("Task event command ID is invalid")
	}
	if event.Stream != "" && event.Stream != "stdout" && event.Stream != "stderr" {
		return errors.New("Task event stream is invalid")
	}
	return nil
}

func equalTaskEvent(left, right TaskEvent) bool {
	leftData, _ := json.Marshal(left)
	rightData, _ := json.Marshal(right)
	return string(leftData) == string(rightData)
}

func validPrincipal(value string) bool {
	return len(value) >= 16 && len(value) <= 1024 && strings.HasPrefix(value, "spiffe://") &&
		utf8.ValidString(value) && strings.IndexByte(value, 0) < 0
}

// ValidPrincipal applies the shared bounded SPIFFE principal contract.
func ValidPrincipal(value string) bool { return validPrincipal(value) }
