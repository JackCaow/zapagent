package controlpostgres

import (
	"context"
	"errors"
	"math"
	"sync"
	"time"

	"zapvm/internal/cloudplane"
)

type OnlineMirrorOptions struct {
	RetryInterval time.Duration
	Now           func() time.Time
}

type OnlineMirror struct {
	apply         func(context.Context, cloudplane.OfflineSnapshot) error
	retryInterval time.Duration
	now           func() time.Time

	mu                  sync.Mutex
	latest              cloudplane.OfflineSnapshot
	generation          uint64
	appliedGeneration   uint64
	pendingSince        time.Time
	lastSuccess         time.Time
	lastError           error
	consecutiveFailures uint64
	reconciled          bool
	closed              bool

	ctx    context.Context
	cancel context.CancelFunc
	wake   chan struct{}
	status chan struct{}
	done   chan struct{}
}

func NewOnlineMirror(migrator *Migrator, options OnlineMirrorOptions) (*OnlineMirror, error) {
	if migrator == nil || migrator.pool == nil {
		return nil, errors.New("PostgreSQL migrator is not open")
	}
	return newOnlineMirror(func(ctx context.Context, snapshot cloudplane.OfflineSnapshot) error {
		_, err := migrator.ImportFileSnapshot(ctx, snapshot, FileImportOptions{})
		return err
	}, options)
}

func newOnlineMirror(apply func(context.Context, cloudplane.OfflineSnapshot) error, options OnlineMirrorOptions) (*OnlineMirror, error) {
	if apply == nil {
		return nil, errors.New("PostgreSQL online mirror apply function is required")
	}
	if options.RetryInterval == 0 {
		options.RetryInterval = 5 * time.Second
	}
	if options.RetryInterval < 100*time.Millisecond || options.RetryInterval > 5*time.Minute {
		return nil, errors.New("PostgreSQL online mirror retry interval must be between 100 milliseconds and 5 minutes")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	ctx, cancel := context.WithCancel(context.Background())
	mirror := &OnlineMirror{
		apply: apply, retryInterval: options.RetryInterval, now: options.Now,
		ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1), status: make(chan struct{}, 1), done: make(chan struct{}),
	}
	go mirror.run()
	return mirror, nil
}

func (mirror *OnlineMirror) Reconcile(ctx context.Context, snapshot cloudplane.OfflineSnapshot) error {
	if mirror == nil || ctx == nil {
		return errors.New("PostgreSQL online mirror is not open")
	}
	if _, err := snapshot.CanonicalJSON(); err != nil {
		return err
	}
	mirror.mu.Lock()
	if mirror.closed || mirror.reconciled || mirror.generation != 0 {
		mirror.mu.Unlock()
		return errors.New("PostgreSQL online mirror reconcile is not available")
	}
	mirror.mu.Unlock()
	err := mirror.apply(ctx, snapshot)
	now := mirror.now().UTC()
	mirror.mu.Lock()
	defer mirror.mu.Unlock()
	if err != nil {
		mirror.lastError = errors.New("PostgreSQL online mirror reconcile failed")
		mirror.consecutiveFailures = 1
		mirror.notifyStatusLocked()
		return err
	}
	mirror.latest = snapshot
	mirror.generation = 1
	mirror.appliedGeneration = 1
	mirror.lastSuccess = now
	mirror.reconciled = true
	mirror.lastError = nil
	mirror.consecutiveFailures = 0
	mirror.notifyStatusLocked()
	return nil
}

func (mirror *OnlineMirror) Enqueue(snapshot cloudplane.OfflineSnapshot) error {
	if mirror == nil {
		return errors.New("PostgreSQL online mirror is not open")
	}
	mirror.mu.Lock()
	defer mirror.mu.Unlock()
	if mirror.closed || !mirror.reconciled {
		return errors.New("PostgreSQL online mirror is not accepting snapshots")
	}
	if mirror.generation == math.MaxUint64 {
		return errors.New("PostgreSQL online mirror generation is exhausted")
	}
	wasPending := mirror.appliedGeneration != mirror.generation
	mirror.latest = snapshot
	mirror.generation++
	if !wasPending {
		mirror.pendingSince = mirror.now().UTC()
	}
	mirror.notifyWakeLocked()
	mirror.notifyStatusLocked()
	return nil
}

func (mirror *OnlineMirror) Health() cloudplane.StateMirrorHealth {
	if mirror == nil {
		return cloudplane.StateMirrorHealth{Failed: true, ConsecutiveFailures: 1}
	}
	mirror.mu.Lock()
	defer mirror.mu.Unlock()
	return cloudplane.StateMirrorHealth{
		Pending: mirror.appliedGeneration != mirror.generation, Failed: mirror.lastError != nil,
		ConsecutiveFailures: mirror.consecutiveFailures, PendingSince: mirror.pendingSince, LastSuccess: mirror.lastSuccess,
	}
}

func (mirror *OnlineMirror) Close(ctx context.Context) error {
	if mirror == nil || ctx == nil {
		return errors.New("PostgreSQL online mirror is not open")
	}
	mirror.mu.Lock()
	if mirror.closed {
		done := mirror.done
		mirror.mu.Unlock()
		select {
		case <-done:
			return nil
		case <-ctx.Done():
			return errors.New("PostgreSQL online mirror close timed out")
		}
	}
	mirror.closed = true
	mirror.notifyWakeLocked()
	mirror.mu.Unlock()
	for {
		mirror.mu.Lock()
		flushed := mirror.appliedGeneration == mirror.generation
		mirror.mu.Unlock()
		if flushed {
			mirror.cancel()
			select {
			case <-mirror.done:
				return nil
			case <-ctx.Done():
				return errors.New("PostgreSQL online mirror close timed out")
			}
		}
		select {
		case <-mirror.status:
		case <-ctx.Done():
			mirror.cancel()
			return errors.New("PostgreSQL online mirror did not flush before timeout")
		}
	}
}

func (mirror *OnlineMirror) run() {
	defer close(mirror.done)
	ticker := time.NewTicker(mirror.retryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-mirror.ctx.Done():
			return
		case <-mirror.wake:
		case <-ticker.C:
		}
		for {
			mirror.mu.Lock()
			if mirror.appliedGeneration == mirror.generation {
				mirror.mu.Unlock()
				break
			}
			snapshot := mirror.latest
			generation := mirror.generation
			mirror.mu.Unlock()

			err := mirror.apply(mirror.ctx, snapshot)
			now := mirror.now().UTC()
			mirror.mu.Lock()
			if err != nil {
				mirror.lastError = errors.New("PostgreSQL online mirror apply failed")
				if mirror.consecutiveFailures != math.MaxUint64 {
					mirror.consecutiveFailures++
				}
				mirror.notifyStatusLocked()
				mirror.mu.Unlock()
				break
			}
			mirror.appliedGeneration = generation
			mirror.lastSuccess = now
			mirror.lastError = nil
			mirror.consecutiveFailures = 0
			if mirror.appliedGeneration == mirror.generation {
				mirror.pendingSince = time.Time{}
			}
			mirror.notifyStatusLocked()
			mirror.mu.Unlock()
		}
	}
}

func (mirror *OnlineMirror) notifyWakeLocked() {
	select {
	case mirror.wake <- struct{}{}:
	default:
	}
}

func (mirror *OnlineMirror) notifyStatusLocked() {
	select {
	case mirror.status <- struct{}{}:
	default:
	}
}
