package vmpool

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sort"
	"sync"
	"time"

	"zapvm/internal/hostpolicy"
	"zapvm/internal/platform"
)

var (
	ErrClosed        = errors.New("VM pool is closed")
	ErrPaused        = errors.New("VM pool is paused")
	ErrQuota         = errors.New("VM pool quota is exhausted")
	ErrDegraded      = errors.New("VM pool is degraded after a worker stop failure")
	ErrLeaseReleased = errors.New("VM pool lease was already released")
	ErrComputerBusy  = errors.New("Agent Computer has an active command")
)

// Route contains every authorization or resource property that may affect VM
// reuse. Digests are opaque SHA-256 values produced by the future daemon from
// verified image, state, egress-policy, and credential-binding inputs. A field
// must never be omitted when the corresponding authority is present.
type Route struct {
	ComputerID            string `json:"ComputerID,omitempty"`
	Workspace             string
	WorkspaceReadOnly     bool
	Network               platform.NetworkMode
	NetworkPolicyDigest   string
	ImageDigest           string
	AgentReference        string
	AgentDigest           string
	StateDigest           string
	CredentialScopeDigest string
	CPUCount              uint
	MemoryBytes           uint64
}

type Worker interface {
	Pause(context.Context) error
	Suspend(context.Context) error
	Resume(context.Context) error
	Stop(context.Context) error
}

type Starter func(context.Context, Route) (Worker, error)

type Options struct {
	MaxWorkers      int
	MaxPerWorkspace int
	IdleTimeout     time.Duration
	StopTimeout     time.Duration
	Now             func() time.Time
}

type Pool struct {
	mu                  sync.Mutex
	controlMu           sync.Mutex
	starter             Starter
	maxWorkers          int
	maxPerWorkspace     int
	idleTimeout         time.Duration
	stopTimeout         time.Duration
	now                 func() time.Time
	closed              bool
	paused              bool
	degraded            error
	entries             map[string]*entry
	starting            map[string]*startCall
	stopping            int
	stoppingByWorkspace map[string]int
	stoppingByComputer  map[string]int
	startAttempts       uint64
	startFailures       uint64
	startDurationTotal  uint64
	startDurationMax    uint64
}

type entry struct {
	key           string
	route         Route
	workspaceInfo os.FileInfo
	worker        Worker
	active        int
	lastUsed      time.Time
	stopOnce      sync.Once
	stopErr       error
}

type startCall struct {
	done      chan struct{}
	workspace string
	computer  string
	err       error
}

type Lease struct {
	mu       sync.Mutex
	pool     *Pool
	entry    *entry
	released bool
}

type Stats struct {
	Workers                  int
	Starting                 int
	Stopping                 int
	Leases                   int
	Degraded                 bool
	Paused                   bool
	StartAttempts            uint64
	StartFailures            uint64
	StartDurationMillisTotal uint64
	StartDurationMillisMax   uint64
}

const (
	ComputerStopped  = "stopped"
	ComputerStarting = "starting"
	ComputerRunning  = "running"
	ComputerBusy     = "busy"
	ComputerPaused   = "paused"
	ComputerStopping = "stopping"
)

func New(options Options, starter Starter) (*Pool, error) {
	if starter == nil {
		return nil, errors.New("VM pool starter is required")
	}
	if options.MaxWorkers == 0 {
		options.MaxWorkers = 4
	}
	if options.MaxPerWorkspace == 0 {
		options.MaxPerWorkspace = 1
	}
	if options.IdleTimeout == 0 {
		options.IdleTimeout = time.Hour
	}
	if options.StopTimeout == 0 {
		options.StopTimeout = 10 * time.Second
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.MaxWorkers < 1 || options.MaxWorkers > 64 {
		return nil, errors.New("VM pool MaxWorkers must be between 1 and 64")
	}
	if options.MaxPerWorkspace < 1 || options.MaxPerWorkspace > options.MaxWorkers {
		return nil, errors.New("VM pool MaxPerWorkspace must be between 1 and MaxWorkers")
	}
	if options.IdleTimeout < time.Second || options.IdleTimeout > 24*time.Hour {
		return nil, errors.New("VM pool IdleTimeout must be between 1s and 24h")
	}
	if options.StopTimeout < time.Second || options.StopTimeout > time.Minute {
		return nil, errors.New("VM pool StopTimeout must be between 1s and 1m")
	}
	return &Pool{
		starter: starter, maxWorkers: options.MaxWorkers, maxPerWorkspace: options.MaxPerWorkspace,
		idleTimeout: options.IdleTimeout, stopTimeout: options.StopTimeout, now: options.Now,
		entries: make(map[string]*entry), starting: make(map[string]*startCall),
		stoppingByWorkspace: make(map[string]int), stoppingByComputer: make(map[string]int),
	}, nil
}

func (pool *Pool) Acquire(ctx context.Context, route Route) (*Lease, error) {
	normalized, workspaceInfo, key, err := normalizeRoute(route)
	if err != nil {
		return nil, err
	}
	for {
		pool.mu.Lock()
		if pool.closed {
			pool.mu.Unlock()
			return nil, ErrClosed
		}
		if pool.paused {
			pool.mu.Unlock()
			return nil, ErrPaused
		}
		if pool.degraded != nil {
			err := errors.Join(ErrDegraded, pool.degraded)
			pool.mu.Unlock()
			return nil, err
		}
		if current := pool.entries[key]; current != nil {
			if os.SameFile(current.workspaceInfo, workspaceInfo) {
				current.active++
				pool.mu.Unlock()
				return &Lease{pool: pool, entry: current}, nil
			}
			pool.removeLocked(current)
			pool.mu.Unlock()
			if err := pool.retire(current); err != nil {
				return nil, fmt.Errorf("retire replaced workspace VM: %w", err)
			}
			continue
		}
		if call := pool.starting[key]; call != nil {
			pool.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-call.done:
				if call.err != nil {
					return nil, call.err
				}
				continue
			}
		}
		// A durable Computer has exactly one state disk. If an image or other
		// authority input changes, retire its idle old route before starting the
		// replacement so two VMs can never race to attach that disk.
		if normalized.ComputerID != "" {
			var variant *entry
			for _, candidate := range pool.entries {
				if candidate.route.ComputerID == normalized.ComputerID && candidate.key != key {
					variant = candidate
					break
				}
			}
			if variant != nil {
				if variant.active != 0 {
					pool.mu.Unlock()
					return nil, ErrComputerBusy
				}
				pool.removeLocked(variant)
				pool.mu.Unlock()
				if err := pool.retire(variant); err != nil {
					return nil, fmt.Errorf("retire stale Agent Computer VM: %w", err)
				}
				continue
			}
			var variantStart *startCall
			for variantKey, candidate := range pool.starting {
				if candidate.computer == normalized.ComputerID && variantKey != key {
					variantStart = candidate
					break
				}
			}
			if variantStart != nil {
				pool.mu.Unlock()
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-variantStart.done:
					continue
				}
			}
		}
		if pool.quotaReachedLocked(normalized.Workspace) {
			victim := pool.idleVictimLocked(normalized.Workspace)
			if victim == nil {
				pool.mu.Unlock()
				return nil, ErrQuota
			}
			pool.removeLocked(victim)
			pool.mu.Unlock()
			if err := pool.retire(victim); err != nil {
				return nil, fmt.Errorf("retire idle VM for quota: %w", err)
			}
			continue
		}
		call := &startCall{done: make(chan struct{}), workspace: normalized.Workspace, computer: normalized.ComputerID}
		pool.starting[key] = call
		pool.startAttempts++
		pool.mu.Unlock()

		startTime := pool.now()
		worker, startErr := pool.starter(ctx, normalized)
		startDuration := pool.now().Sub(startTime)
		if startDuration < 0 {
			startDuration = 0
		}
		if workerIsNil(worker) {
			worker = nil
		}
		if startErr == nil && worker == nil {
			startErr = errors.New("VM pool starter returned a nil worker")
		}
		if startErr == nil && ctx.Err() != nil {
			startErr = ctx.Err()
		}
		if startErr == nil {
			currentPath, pathErr := hostpolicy.ValidateWorkspace(normalized.Workspace)
			currentInfo, statErr := os.Stat(currentPath)
			if pathErr != nil {
				startErr = pathErr
			} else if statErr != nil {
				startErr = statErr
			} else if currentPath != normalized.Workspace || !os.SameFile(workspaceInfo, currentInfo) {
				startErr = errors.New("workspace identity changed while starting VM")
			}
		}

		pool.mu.Lock()
		startDurationMillis := uint64(startDuration / time.Millisecond)
		pool.startDurationTotal += startDurationMillis
		if startDurationMillis > pool.startDurationMax {
			pool.startDurationMax = startDurationMillis
		}
		delete(pool.starting, key)
		if startErr == nil && pool.closed {
			startErr = ErrClosed
		}
		if startErr == nil && pool.paused {
			startErr = ErrPaused
		}
		if startErr != nil {
			pool.startFailures++
		}
		if startErr == nil {
			created := &entry{key: key, route: normalized, workspaceInfo: workspaceInfo, worker: worker, active: 1, lastUsed: pool.now()}
			pool.entries[key] = created
			close(call.done)
			pool.mu.Unlock()
			return &Lease{pool: pool, entry: created}, nil
		}
		call.err = startErr
		var rejected *entry
		if worker != nil {
			rejected = &entry{route: normalized, worker: worker}
			pool.stopping++
			pool.stoppingByWorkspace[normalized.Workspace]++
			if normalized.ComputerID != "" {
				pool.stoppingByComputer[normalized.ComputerID]++
			}
		}
		pool.mu.Unlock()
		if rejected != nil {
			stopCtx, cancel := context.WithTimeout(context.Background(), pool.stopTimeout)
			stopErr := pool.retireWithContext(stopCtx, rejected)
			cancel()
			if stopErr != nil {
				call.err = errors.Join(call.err, fmt.Errorf("stop rejected VM start: %w", stopErr))
			}
		}
		close(call.done)
		return nil, call.err
	}
}

func workerIsNil(worker Worker) bool {
	if worker == nil {
		return true
	}
	value := reflect.ValueOf(worker)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

func (lease *Lease) Worker() Worker {
	if lease == nil {
		return nil
	}
	return lease.entry.worker
}

func (lease *Lease) Release() error {
	return lease.finish(context.Background(), false)
}

func (lease *Lease) Discard(ctx context.Context) error {
	return lease.finish(ctx, true)
}

func (lease *Lease) finish(ctx context.Context, discard bool) error {
	if lease == nil || lease.pool == nil || lease.entry == nil {
		return ErrLeaseReleased
	}
	lease.mu.Lock()
	if lease.released {
		lease.mu.Unlock()
		return ErrLeaseReleased
	}
	lease.released = true
	lease.mu.Unlock()

	pool, item := lease.pool, lease.entry
	pool.mu.Lock()
	if item.active > 0 {
		item.active--
	}
	item.lastUsed = pool.now()
	retire := discard && pool.entries[item.key] == item
	if retire {
		pool.removeLocked(item)
	}
	pool.mu.Unlock()
	if !retire {
		return nil
	}
	return pool.retireWithContext(ctx, item)
}

func (pool *Pool) SweepIdle(ctx context.Context) error {
	pool.mu.Lock()
	if pool.closed {
		pool.mu.Unlock()
		return ErrClosed
	}
	if pool.paused {
		pool.mu.Unlock()
		return nil
	}
	now := pool.now()
	var victims []*entry
	for _, item := range pool.entries {
		if item.active == 0 && now.Sub(item.lastUsed) >= pool.idleTimeout {
			pool.removeLocked(item)
			victims = append(victims, item)
		}
	}
	pool.mu.Unlock()
	var result error
	for _, victim := range victims {
		if err := pool.retireWithContext(ctx, victim); err != nil {
			result = errors.Join(result, err)
		}
	}
	return result
}

func (pool *Pool) Close(ctx context.Context) error {
	pool.controlMu.Lock()
	defer pool.controlMu.Unlock()
	pool.mu.Lock()
	if pool.closed {
		result := pool.degraded
		pool.mu.Unlock()
		return result
	}
	pool.closed = true
	entries := make([]*entry, 0, len(pool.entries))
	for _, item := range pool.entries {
		pool.removeLocked(item)
		entries = append(entries, item)
	}
	calls := make([]*startCall, 0, len(pool.starting))
	for _, call := range pool.starting {
		calls = append(calls, call)
	}
	result := pool.degraded
	pool.mu.Unlock()

	results := make(chan error, len(entries)+len(calls))
	for _, item := range entries {
		item := item
		go func() { results <- pool.retireWithContext(ctx, item) }()
	}
	for _, call := range calls {
		call := call
		go func() {
			select {
			case <-ctx.Done():
				results <- ctx.Err()
			case <-call.done:
				if call.err != nil && call.err != ErrClosed {
					results <- call.err
				} else {
					results <- nil
				}
			}
		}()
	}
	for count := 0; count < cap(results); count++ {
		result = errors.Join(result, <-results)
	}
	return result
}

// Pause quiesces every worker and rejects new leases until Resume succeeds.
// Workers perform their own command drain before pausing the underlying VMM.
func (pool *Pool) Pause(ctx context.Context) error {
	_, err := pool.pause(ctx, true, func(worker Worker, ctx context.Context) error { return worker.Pause(ctx) })
	return err
}

// Suspend immediately freezes workers without draining active commands. It is
// reserved for an imminent Host sleep notification with a bounded OS deadline.
func (pool *Pool) Suspend(ctx context.Context) (bool, error) {
	return pool.pause(ctx, false, func(worker Worker, ctx context.Context) error { return worker.Suspend(ctx) })
}

func (pool *Pool) pause(ctx context.Context, rollback bool, operation func(Worker, context.Context) error) (bool, error) {
	pool.controlMu.Lock()
	defer pool.controlMu.Unlock()
	pool.mu.Lock()
	if pool.closed {
		pool.mu.Unlock()
		return false, ErrClosed
	}
	if pool.degraded != nil {
		err := errors.Join(ErrDegraded, pool.degraded)
		pool.mu.Unlock()
		return false, err
	}
	if pool.paused {
		pool.mu.Unlock()
		return false, nil
	}
	pool.paused = true
	calls := make([]*startCall, 0, len(pool.starting))
	for _, call := range pool.starting {
		calls = append(calls, call)
	}
	pool.mu.Unlock()
	for _, call := range calls {
		select {
		case <-ctx.Done():
			pool.mu.Lock()
			pool.paused = false
			pool.mu.Unlock()
			return false, ctx.Err()
		case <-call.done:
		}
	}
	pool.mu.Lock()
	entries := make([]*entry, 0, len(pool.entries))
	for _, item := range pool.entries {
		entries = append(entries, item)
	}
	pool.mu.Unlock()
	if err := controlWorkers(ctx, entries, operation); err != nil {
		if !rollback {
			// Host sleep is imminent and platform callbacks have a hard deadline.
			// Keep admission closed and let the matching wake Resume every worker;
			// a synchronous rollback here could overrun the OS suspend window.
			return true, err
		}
		rollbackCtx, rollbackCancel := context.WithTimeout(context.Background(), pool.stopTimeout)
		rollbackErr := controlWorkers(rollbackCtx, entries, func(worker Worker, ctx context.Context) error { return worker.Resume(ctx) })
		rollbackCancel()
		pool.mu.Lock()
		if rollbackErr == nil {
			pool.paused = false
		} else {
			pool.degraded = errors.Join(pool.degraded, rollbackErr)
		}
		pool.mu.Unlock()
		return false, errors.Join(err, rollbackErr)
	}
	return true, nil
}

// Resume returns every paused worker to Running before allowing new leases.
func (pool *Pool) Resume(ctx context.Context) error {
	pool.controlMu.Lock()
	defer pool.controlMu.Unlock()
	pool.mu.Lock()
	if pool.closed {
		pool.mu.Unlock()
		return ErrClosed
	}
	if !pool.paused {
		pool.mu.Unlock()
		return nil
	}
	entries := make([]*entry, 0, len(pool.entries))
	for _, item := range pool.entries {
		entries = append(entries, item)
	}
	pool.mu.Unlock()
	if err := controlWorkers(ctx, entries, func(worker Worker, ctx context.Context) error { return worker.Resume(ctx) }); err != nil {
		return err
	}
	pool.mu.Lock()
	pool.paused = false
	pool.mu.Unlock()
	return nil
}

func controlWorkers(ctx context.Context, entries []*entry, operation func(Worker, context.Context) error) error {
	results := make(chan error, len(entries))
	for _, item := range entries {
		item := item
		go func() { results <- operation(item.worker, ctx) }()
	}
	var result error
	for range entries {
		result = errors.Join(result, <-results)
	}
	return result
}

func (pool *Pool) Stats() Stats {
	pool.mu.Lock()
	defer pool.mu.Unlock()
	stats := Stats{
		Workers: len(pool.entries), Starting: len(pool.starting), Stopping: pool.stopping,
		Degraded: pool.degraded != nil, Paused: pool.paused,
		StartAttempts: pool.startAttempts, StartFailures: pool.startFailures,
		StartDurationMillisTotal: pool.startDurationTotal, StartDurationMillisMax: pool.startDurationMax,
	}
	for _, item := range pool.entries {
		stats.Leases += item.active
	}
	return stats
}

// ComputerStatus derives runtime state from the live pool. Durable Computer
// definitions live outside the pool, so daemon restarts naturally report them
// as stopped until the next execution starts a worker.
func (pool *Pool) ComputerStatus(id string) string {
	pool.mu.Lock()
	defer pool.mu.Unlock()
	for _, call := range pool.starting {
		if call.computer == id {
			return ComputerStarting
		}
	}
	for _, item := range pool.entries {
		if item.route.ComputerID == id {
			if pool.paused {
				return ComputerPaused
			}
			if item.active != 0 {
				return ComputerBusy
			}
			return ComputerRunning
		}
	}
	if pool.stoppingByComputer[id] != 0 {
		return ComputerStopping
	}
	return ComputerStopped
}

// StopComputer cleanly retires an idle Computer worker while preserving its
// state disk and durable definition. Active commands are never interrupted.
func (pool *Pool) StopComputer(ctx context.Context, id string) error {
	pool.controlMu.Lock()
	defer pool.controlMu.Unlock()
	for {
		pool.mu.Lock()
		if pool.closed {
			pool.mu.Unlock()
			return ErrClosed
		}
		var starting *startCall
		for _, call := range pool.starting {
			if call.computer == id {
				starting = call
				break
			}
		}
		if starting != nil {
			pool.mu.Unlock()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-starting.done:
				continue
			}
		}
		var victims []*entry
		for _, item := range pool.entries {
			if item.route.ComputerID != id {
				continue
			}
			if item.active != 0 {
				pool.mu.Unlock()
				return ErrComputerBusy
			}
			pool.removeLocked(item)
			victims = append(victims, item)
		}
		pool.mu.Unlock()
		var result error
		for _, victim := range victims {
			if err := pool.retireWithContext(ctx, victim); err != nil {
				result = errors.Join(result, err)
			}
		}
		return result
	}
}

func (pool *Pool) quotaReachedLocked(workspace string) bool {
	total := len(pool.entries) + len(pool.starting) + pool.stopping
	workspaceTotal := pool.stoppingByWorkspace[workspace]
	for _, item := range pool.entries {
		if item.route.Workspace == workspace {
			workspaceTotal++
		}
	}
	for _, call := range pool.starting {
		if call.workspace == workspace {
			workspaceTotal++
		}
	}
	return total >= pool.maxWorkers || workspaceTotal >= pool.maxPerWorkspace
}

func (pool *Pool) idleVictimLocked(workspace string) *entry {
	workspaceBlocked := pool.stoppingByWorkspace[workspace] >= pool.maxPerWorkspace
	if !workspaceBlocked {
		count := pool.stoppingByWorkspace[workspace]
		for _, item := range pool.entries {
			if item.route.Workspace == workspace {
				count++
			}
		}
		for _, call := range pool.starting {
			if call.workspace == workspace {
				count++
			}
		}
		workspaceBlocked = count >= pool.maxPerWorkspace
	}
	var victim *entry
	for _, item := range pool.entries {
		if item.active != 0 || (workspaceBlocked && item.route.Workspace != workspace) {
			continue
		}
		if victim == nil || item.lastUsed.Before(victim.lastUsed) {
			victim = item
		}
	}
	return victim
}

func (pool *Pool) removeLocked(item *entry) {
	if pool.entries[item.key] != item {
		return
	}
	delete(pool.entries, item.key)
	pool.stopping++
	pool.stoppingByWorkspace[item.route.Workspace]++
	if item.route.ComputerID != "" {
		pool.stoppingByComputer[item.route.ComputerID]++
	}
}

func (pool *Pool) retire(item *entry) error {
	ctx, cancel := context.WithTimeout(context.Background(), pool.stopTimeout)
	defer cancel()
	return pool.retireWithContext(ctx, item)
}

func (pool *Pool) retireWithContext(ctx context.Context, item *entry) error {
	item.stopOnce.Do(func() { item.stopErr = item.worker.Stop(ctx) })
	pool.mu.Lock()
	if item.stopErr != nil {
		pool.degraded = errors.Join(pool.degraded, item.stopErr)
		pool.mu.Unlock()
		return item.stopErr
	}
	if pool.stopping > 0 {
		pool.stopping--
	}
	if pool.stoppingByWorkspace[item.route.Workspace] > 1 {
		pool.stoppingByWorkspace[item.route.Workspace]--
	} else {
		delete(pool.stoppingByWorkspace, item.route.Workspace)
	}
	if item.route.ComputerID != "" {
		if pool.stoppingByComputer[item.route.ComputerID] > 1 {
			pool.stoppingByComputer[item.route.ComputerID]--
		} else {
			delete(pool.stoppingByComputer, item.route.ComputerID)
		}
	}
	pool.mu.Unlock()
	return item.stopErr
}

func normalizeRoute(route Route) (Route, os.FileInfo, string, error) {
	workspace, err := hostpolicy.ValidateWorkspace(route.Workspace)
	if err != nil {
		return Route{}, nil, "", err
	}
	info, err := os.Stat(workspace)
	if err != nil {
		return Route{}, nil, "", err
	}
	route.Workspace = workspace
	if route.ComputerID != "" && !validComputerID(route.ComputerID) {
		return Route{}, nil, "", errors.New("VM pool route contains an invalid Computer ID")
	}
	if route.CPUCount == 0 || route.CPUCount > 256 || route.MemoryBytes < 256*platform.MiB || route.MemoryBytes > 1024*1024*platform.MiB || route.MemoryBytes%platform.MiB != 0 {
		return Route{}, nil, "", errors.New("VM pool route contains invalid CPU or memory limits")
	}
	if !validDigest(route.ImageDigest) {
		return Route{}, nil, "", errors.New("VM pool route requires a lowercase SHA-256 image digest")
	}
	if route.AgentReference == "" {
		if route.AgentDigest != "" {
			return Route{}, nil, "", errors.New("VM pool route Agent digest requires an Agent reference")
		}
	} else if !validDigest(route.AgentDigest) {
		return Route{}, nil, "", errors.New("VM pool route requires a lowercase SHA-256 Agent digest")
	}
	if route.StateDigest != "" && !validDigest(route.StateDigest) {
		return Route{}, nil, "", errors.New("VM pool route state digest is invalid")
	}
	if route.CredentialScopeDigest != "" && !validDigest(route.CredentialScopeDigest) {
		return Route{}, nil, "", errors.New("VM pool route credential scope digest is invalid")
	}
	switch route.Network {
	case platform.NetworkRestricted:
		if !validDigest(route.NetworkPolicyDigest) {
			return Route{}, nil, "", errors.New("restricted VM pool route requires a network policy digest")
		}
	case platform.NetworkOff, platform.NetworkUnrestricted:
		if route.NetworkPolicyDigest != "" {
			return Route{}, nil, "", errors.New("network policy digest is only valid for restricted routing")
		}
	default:
		return Route{}, nil, "", errors.New("VM pool route contains an invalid network mode")
	}
	encoded, err := json.Marshal(route)
	if err != nil {
		return Route{}, nil, "", err
	}
	digest := sha256.Sum256(encoded)
	return route, info, hex.EncodeToString(digest[:]), nil
}

func validDigest(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && hex.EncodeToString(decoded) == value
}

func validComputerID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

// Keys returns redacted route identifiers for diagnostics. It deliberately
// never exposes workspace paths or authorization inputs.
func (pool *Pool) Keys() []string {
	pool.mu.Lock()
	defer pool.mu.Unlock()
	keys := make([]string, 0, len(pool.entries))
	for key := range pool.entries {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
