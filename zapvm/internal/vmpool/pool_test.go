package vmpool

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"zapvm/internal/platform"
)

type fakeWorker struct {
	id        int
	stops     atomic.Int32
	pauses    atomic.Int32
	resumes   atomic.Int32
	stopErr   error
	pauseErr  error
	resumeErr error
}

type blockingStopWorker struct {
	entered chan<- struct{}
	release <-chan struct{}
}

func (*blockingStopWorker) Pause(context.Context) error   { return nil }
func (*blockingStopWorker) Suspend(context.Context) error { return nil }
func (*blockingStopWorker) Resume(context.Context) error  { return nil }

func (worker *blockingStopWorker) Stop(ctx context.Context) error {
	worker.entered <- struct{}{}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-worker.release:
		return nil
	}
}

func (worker *fakeWorker) Stop(context.Context) error {
	worker.stops.Add(1)
	return worker.stopErr
}

func (worker *fakeWorker) Pause(context.Context) error {
	worker.pauses.Add(1)
	return worker.pauseErr
}

func (worker *fakeWorker) Suspend(ctx context.Context) error { return worker.Pause(ctx) }

func (worker *fakeWorker) Resume(context.Context) error {
	worker.resumes.Add(1)
	return worker.resumeErr
}

type fakeStarter struct {
	mu        sync.Mutex
	count     int
	workers   []*fakeWorker
	gate      <-chan struct{}
	stopErr   error
	pauseErr  error
	resumeErr error
}

func (starter *fakeStarter) Start(ctx context.Context, _ Route) (Worker, error) {
	if starter.gate != nil {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-starter.gate:
		}
	}
	starter.mu.Lock()
	defer starter.mu.Unlock()
	starter.count++
	worker := &fakeWorker{id: starter.count, stopErr: starter.stopErr, pauseErr: starter.pauseErr, resumeErr: starter.resumeErr}
	starter.workers = append(starter.workers, worker)
	return worker, nil
}

func (starter *fakeStarter) Count() int {
	starter.mu.Lock()
	defer starter.mu.Unlock()
	return starter.count
}

func testRoute(workspace string) Route {
	return Route{
		Workspace: workspace, Network: platform.NetworkOff,
		ImageDigest: strings.Repeat("a", 64), CPUCount: 2, MemoryBytes: 512 * platform.MiB,
	}
}

func TestEmptyComputerIDDoesNotChangeLegacyRouteEncoding(t *testing.T) {
	encoded, err := json.Marshal(testRoute("/workspace"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "ComputerID") {
		t.Fatalf("empty Computer ID changed legacy route encoding: %s", encoded)
	}
}

func TestPoolRecordsBoundedVMStartTelemetry(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 8, 1, 0, 0, 0, time.UTC)
	pool, err := New(Options{
		MaxWorkers: 1, MaxPerWorkspace: 1, IdleTimeout: time.Minute, StopTimeout: time.Second,
		Now: func() time.Time { return now },
	}, func(context.Context, Route) (Worker, error) {
		now = now.Add(1250 * time.Millisecond)
		return &fakeWorker{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pool.Close(context.Background()) })
	lease, err := pool.Acquire(context.Background(), testRoute(workspace))
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Release(); err != nil {
		t.Fatal(err)
	}
	stats := pool.Stats()
	if stats.StartAttempts != 1 || stats.StartFailures != 0 || stats.StartDurationMillisTotal != 1250 || stats.StartDurationMillisMax != 1250 {
		t.Fatalf("VM start telemetry = %+v", stats)
	}
}

func TestComputerStatusAndStopPreservePoolHealth(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	starter := &fakeStarter{}
	pool := newTestPool(t, Options{MaxWorkers: 2, MaxPerWorkspace: 2}, starter)
	route := testRoute(workspace)
	route.ComputerID = "project-a"
	if got := pool.ComputerStatus(route.ComputerID); got != ComputerStopped {
		t.Fatalf("initial Computer status = %q", got)
	}
	lease, err := pool.Acquire(context.Background(), route)
	if err != nil {
		t.Fatal(err)
	}
	if got := pool.ComputerStatus(route.ComputerID); got != ComputerBusy {
		t.Fatalf("leased Computer status = %q", got)
	}
	if err := pool.StopComputer(context.Background(), route.ComputerID); !errors.Is(err, ErrComputerBusy) {
		t.Fatalf("busy Computer stop error = %v", err)
	}
	if err := lease.Release(); err != nil {
		t.Fatal(err)
	}
	if got := pool.ComputerStatus(route.ComputerID); got != ComputerRunning {
		t.Fatalf("idle Computer status = %q", got)
	}
	if err := pool.StopComputer(context.Background(), route.ComputerID); err != nil {
		t.Fatal(err)
	}
	if got := pool.ComputerStatus(route.ComputerID); got != ComputerStopped {
		t.Fatalf("stopped Computer status = %q", got)
	}
	if starter.workers[0].stops.Load() != 1 || pool.Stats().Degraded {
		t.Fatalf("worker stops=%d stats=%+v", starter.workers[0].stops.Load(), pool.Stats())
	}
}

func TestComputerRouteChangeRetiresIdleWorkerBeforeStateReuse(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	starter := &fakeStarter{}
	pool := newTestPool(t, Options{MaxWorkers: 2, MaxPerWorkspace: 2}, starter)
	first := testRoute(workspace)
	first.ComputerID = "project-a"
	first.StateDigest = strings.Repeat("b", 64)
	lease, err := pool.Acquire(context.Background(), first)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Release(); err != nil {
		t.Fatal(err)
	}
	second := first
	second.ImageDigest = strings.Repeat("c", 64)
	lease, err = pool.Acquire(context.Background(), second)
	if err != nil {
		t.Fatal(err)
	}
	if starter.Count() != 2 || starter.workers[0].stops.Load() != 1 {
		t.Fatalf("starts=%d first stops=%d", starter.Count(), starter.workers[0].stops.Load())
	}
	if err := lease.Release(); err != nil {
		t.Fatal(err)
	}
}

func newTestPool(t *testing.T, options Options, starter *fakeStarter) *Pool {
	t.Helper()
	if options.IdleTimeout == 0 {
		options.IdleTimeout = time.Minute
	}
	if options.StopTimeout == 0 {
		options.StopTimeout = time.Second
	}
	pool, err := New(options, starter.Start)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = pool.Close(ctx)
	})
	return pool
}

func TestConcurrentAcquireStartsOneWorkerAndSharesLease(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	gate := make(chan struct{})
	starter := &fakeStarter{gate: gate}
	pool := newTestPool(t, Options{MaxWorkers: 4, MaxPerWorkspace: 2}, starter)

	const clients = 16
	leases := make(chan *Lease, clients)
	errorsSeen := make(chan error, clients)
	for index := 0; index < clients; index++ {
		go func() {
			lease, err := pool.Acquire(context.Background(), testRoute(workspace))
			leases <- lease
			errorsSeen <- err
		}()
	}
	deadline := time.Now().Add(time.Second)
	for pool.Stats().Starting != 1 {
		if time.Now().After(deadline) {
			t.Fatal("concurrent acquire did not create one starting reservation")
		}
		time.Sleep(time.Millisecond)
	}
	close(gate)
	var first Worker
	for index := 0; index < clients; index++ {
		if err := <-errorsSeen; err != nil {
			t.Fatal(err)
		}
		lease := <-leases
		if first == nil {
			first = lease.Worker()
		} else if lease.Worker() != first {
			t.Fatal("same route was assigned to different workers")
		}
		if err := lease.Release(); err != nil {
			t.Fatal(err)
		}
	}
	if starter.Count() != 1 {
		t.Fatalf("starter count = %d, want 1", starter.Count())
	}
	if stats := pool.Stats(); stats.Workers != 1 || stats.Leases != 0 || stats.Starting != 0 {
		t.Fatalf("pool stats = %+v", stats)
	}
}

func TestPauseRejectsLeasesAndResumeReopensPool(t *testing.T) {
	root := t.TempDir()
	workspaces := []string{filepath.Join(root, "a"), filepath.Join(root, "b")}
	for _, workspace := range workspaces {
		if err := os.Mkdir(workspace, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	starter := &fakeStarter{}
	pool := newTestPool(t, Options{MaxWorkers: 2, MaxPerWorkspace: 1}, starter)
	for _, workspace := range workspaces {
		lease, err := pool.Acquire(context.Background(), testRoute(workspace))
		if err != nil {
			t.Fatal(err)
		}
		if err := lease.Release(); err != nil {
			t.Fatal(err)
		}
	}
	if err := pool.Pause(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !pool.Stats().Paused {
		t.Fatal("pool did not report paused")
	}
	if _, err := pool.Acquire(context.Background(), testRoute(workspaces[0])); !errors.Is(err, ErrPaused) {
		t.Fatalf("paused acquire error = %v", err)
	}
	for _, worker := range starter.workers {
		if worker.pauses.Load() != 1 {
			t.Fatalf("worker %d pause count = %d", worker.id, worker.pauses.Load())
		}
	}
	if err := pool.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	if pool.Stats().Paused {
		t.Fatal("pool remained paused")
	}
	lease, err := pool.Acquire(context.Background(), testRoute(workspaces[0]))
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Release(); err != nil {
		t.Fatal(err)
	}
	for _, worker := range starter.workers {
		if worker.resumes.Load() != 1 {
			t.Fatalf("worker %d resume count = %d", worker.id, worker.resumes.Load())
		}
	}
}

func TestPauseFailureRollsWorkersBackAndReopensPool(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	starter := &fakeStarter{pauseErr: errors.New("pause failed")}
	pool := newTestPool(t, Options{MaxWorkers: 1, MaxPerWorkspace: 1}, starter)
	lease, err := pool.Acquire(context.Background(), testRoute(workspace))
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Release(); err != nil {
		t.Fatal(err)
	}
	if err := pool.Pause(context.Background()); err == nil || !strings.Contains(err.Error(), "pause failed") {
		t.Fatalf("pause error = %v", err)
	}
	if pool.Stats().Paused {
		t.Fatal("pool remained paused after successful rollback")
	}
	if starter.workers[0].resumes.Load() != 1 {
		t.Fatalf("rollback resume count = %d", starter.workers[0].resumes.Load())
	}
	lease, err = pool.Acquire(context.Background(), testRoute(workspace))
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestSuspendFailureKeepsAdmissionClosedUntilWakeResume(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	starter := &fakeStarter{pauseErr: errors.New("suspend deadline")}
	pool := newTestPool(t, Options{MaxWorkers: 1, MaxPerWorkspace: 1}, starter)
	lease, err := pool.Acquire(context.Background(), testRoute(workspace))
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Release(); err != nil {
		t.Fatal(err)
	}
	owned, err := pool.Suspend(context.Background())
	if !owned || err == nil || !pool.Stats().Paused {
		t.Fatalf("owned=%v err=%v stats=%+v", owned, err, pool.Stats())
	}
	starter.workers[0].resumeErr = nil
	if err := pool.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	if pool.Stats().Paused {
		t.Fatal("wake resume did not reopen admission")
	}
}

func TestStarterTypedNilDoesNotEnterPoolOrStopPath(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, startErr := range []error{errors.New("start failed"), nil} {
		pool, err := New(Options{MaxWorkers: 1, MaxPerWorkspace: 1, IdleTimeout: time.Minute, StopTimeout: time.Second}, func(context.Context, Route) (Worker, error) {
			var worker *fakeWorker
			return worker, startErr
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Acquire(context.Background(), testRoute(workspace)); err == nil {
			t.Fatal("typed nil worker was accepted")
		}
		if stats := pool.Stats(); stats.Workers != 0 || stats.Starting != 0 || stats.Stopping != 0 || stats.Degraded {
			t.Fatalf("typed nil worker changed pool state: %+v", stats)
		}
	}
}

func TestCloseStopsWorkersConcurrently(t *testing.T) {
	root := t.TempDir()
	workspaces := []string{filepath.Join(root, "a"), filepath.Join(root, "b")}
	for _, workspace := range workspaces {
		if err := os.Mkdir(workspace, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	entered := make(chan struct{}, len(workspaces))
	release := make(chan struct{})
	pool, err := New(Options{MaxWorkers: 2, MaxPerWorkspace: 1, IdleTimeout: time.Minute, StopTimeout: time.Second}, func(context.Context, Route) (Worker, error) {
		return &blockingStopWorker{entered: entered, release: release}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, workspace := range workspaces {
		lease, err := pool.Acquire(context.Background(), testRoute(workspace))
		if err != nil {
			t.Fatal(err)
		}
		if err := lease.Release(); err != nil {
			t.Fatal(err)
		}
	}
	closeDone := make(chan error, 1)
	go func() { closeDone <- pool.Close(context.Background()) }()
	for range workspaces {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("pool Close serialized worker stops")
		}
	}
	close(release)
	if err := <-closeDone; err != nil {
		t.Fatal(err)
	}
}

func TestRouteAuthorityChangesDoNotReuseWorker(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	starter := &fakeStarter{}
	pool := newTestPool(t, Options{MaxWorkers: 4, MaxPerWorkspace: 4}, starter)
	base := testRoute(workspace)
	first, err := pool.Acquire(context.Background(), base)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	variants := []Route{base, base, base, base, base}
	variants[0].WorkspaceReadOnly = true
	variants[1].ImageDigest = strings.Repeat("b", 64)
	variants[2].StateDigest = strings.Repeat("c", 64)
	variants[3].CredentialScopeDigest = strings.Repeat("d", 64)
	variants[4].AgentReference = "zapcode@1.12.0"
	variants[4].AgentDigest = strings.Repeat("e", 64)
	for _, route := range variants {
		lease, err := pool.Acquire(context.Background(), route)
		if err != nil {
			t.Fatal(err)
		}
		if lease.Worker() == first.Worker() {
			t.Fatal("authority-changing route reused the original worker")
		}
		if err := lease.Release(); err != nil {
			t.Fatal(err)
		}
	}
	if starter.Count() != 6 {
		t.Fatalf("starter count = %d, want 6", starter.Count())
	}
}

func TestQuotaRejectsActiveAndEvictsIdleWorker(t *testing.T) {
	root := t.TempDir()
	workspaceA := filepath.Join(root, "a")
	workspaceB := filepath.Join(root, "b")
	if err := os.Mkdir(workspaceA, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(workspaceB, 0o700); err != nil {
		t.Fatal(err)
	}
	starter := &fakeStarter{}
	pool := newTestPool(t, Options{MaxWorkers: 1, MaxPerWorkspace: 1}, starter)
	first, err := pool.Acquire(context.Background(), testRoute(workspaceA))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Acquire(context.Background(), testRoute(workspaceB)); !errors.Is(err, ErrQuota) {
		t.Fatalf("active quota error = %v", err)
	}
	firstWorker := first.Worker().(*fakeWorker)
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	second, err := pool.Acquire(context.Background(), testRoute(workspaceB))
	if err != nil {
		t.Fatal(err)
	}
	if firstWorker.stops.Load() != 1 {
		t.Fatalf("evicted worker stops = %d, want 1", firstWorker.stops.Load())
	}
	if second.Worker() == first.Worker() {
		t.Fatal("quota eviction reused stopped worker")
	}
	if err := second.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceReplacementRetiresExistingRoute(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	starter := &fakeStarter{}
	pool := newTestPool(t, Options{MaxWorkers: 2, MaxPerWorkspace: 1}, starter)
	first, err := pool.Acquire(context.Background(), testRoute(workspace))
	if err != nil {
		t.Fatal(err)
	}
	oldWorker := first.Worker().(*fakeWorker)
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(workspace, filepath.Join(root, "old-workspace")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	second, err := pool.Acquire(context.Background(), testRoute(workspace))
	if err != nil {
		t.Fatal(err)
	}
	if oldWorker.stops.Load() != 1 || second.Worker() == oldWorker {
		t.Fatalf("replacement did not retire old worker: stops=%d", oldWorker.stops.Load())
	}
	if err := second.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestIdleSweepAndDiscardStopWorkers(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(100, 0)
	starter := &fakeStarter{}
	pool := newTestPool(t, Options{MaxWorkers: 2, MaxPerWorkspace: 2, IdleTimeout: time.Minute, Now: func() time.Time { return now }}, starter)
	lease, err := pool.Acquire(context.Background(), testRoute(workspace))
	if err != nil {
		t.Fatal(err)
	}
	worker := lease.Worker().(*fakeWorker)
	if err := lease.Release(); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if err := pool.SweepIdle(context.Background()); err != nil {
		t.Fatal(err)
	}
	if worker.stops.Load() != 1 || pool.Stats().Workers != 0 {
		t.Fatalf("idle worker was not retired: stops=%d stats=%+v", worker.stops.Load(), pool.Stats())
	}
	lease, err = pool.Acquire(context.Background(), testRoute(workspace))
	if err != nil {
		t.Fatal(err)
	}
	worker = lease.Worker().(*fakeWorker)
	if err := lease.Discard(context.Background()); err != nil {
		t.Fatal(err)
	}
	if worker.stops.Load() != 1 || pool.Stats().Workers != 0 {
		t.Fatalf("discarded worker was not retired: stops=%d stats=%+v", worker.stops.Load(), pool.Stats())
	}
	if err := lease.Release(); !errors.Is(err, ErrLeaseReleased) {
		t.Fatalf("second lease release error = %v", err)
	}
}

func TestStopFailurePoisonsPoolWithoutReleasingQuota(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	stopErr := errors.New("VMM did not terminate")
	starter := &fakeStarter{stopErr: stopErr}
	pool := newTestPool(t, Options{MaxWorkers: 1, MaxPerWorkspace: 1}, starter)
	lease, err := pool.Acquire(context.Background(), testRoute(workspace))
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Discard(context.Background()); !errors.Is(err, stopErr) {
		t.Fatalf("discard error = %v", err)
	}
	stats := pool.Stats()
	if !stats.Degraded || stats.Stopping != 1 || stats.Workers != 0 {
		t.Fatalf("degraded pool stats = %+v", stats)
	}
	if _, err := pool.Acquire(context.Background(), testRoute(workspace)); !errors.Is(err, ErrDegraded) {
		t.Fatalf("acquire from degraded pool error = %v", err)
	}
}

func TestCloseDuringStartStopsWorkerBeforeReturning(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	gate := make(chan struct{})
	worker := &fakeWorker{id: 1}
	pool, err := New(Options{MaxWorkers: 1, MaxPerWorkspace: 1, IdleTimeout: time.Minute, StopTimeout: time.Second}, func(context.Context, Route) (Worker, error) {
		<-gate
		return worker, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	acquireDone := make(chan error, 1)
	go func() {
		_, acquireErr := pool.Acquire(context.Background(), testRoute(workspace))
		acquireDone <- acquireErr
	}()
	deadline := time.Now().Add(time.Second)
	for pool.Stats().Starting != 1 {
		if time.Now().After(deadline) {
			t.Fatal("worker did not enter starting state")
		}
		time.Sleep(time.Millisecond)
	}
	closeDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		closeDone <- pool.Close(ctx)
	}()
	for {
		pool.mu.Lock()
		closed := pool.closed
		pool.mu.Unlock()
		if closed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("pool close did not begin")
		}
		time.Sleep(time.Millisecond)
	}
	close(gate)
	if err := <-acquireDone; !errors.Is(err, ErrClosed) {
		t.Fatalf("acquire error = %v", err)
	}
	if err := <-closeDone; err != nil {
		t.Fatal(err)
	}
	if worker.stops.Load() != 1 {
		t.Fatalf("rejected worker stops = %d, want 1", worker.stops.Load())
	}
	if stats := pool.Stats(); stats.Workers != 0 || stats.Starting != 0 || stats.Stopping != 0 {
		t.Fatalf("closed pool stats = %+v", stats)
	}
}

func TestCanceledAcquireStopFailurePoisonsPool(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	stopErr := errors.New("rejected worker survived")
	worker := &fakeWorker{id: 1, stopErr: stopErr}
	ctx, cancel := context.WithCancel(context.Background())
	pool, err := New(Options{MaxWorkers: 1, MaxPerWorkspace: 1, IdleTimeout: time.Minute, StopTimeout: time.Second}, func(context.Context, Route) (Worker, error) {
		cancel()
		return worker, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Acquire(ctx, testRoute(workspace)); !errors.Is(err, context.Canceled) || !errors.Is(err, stopErr) {
		t.Fatalf("canceled acquire error = %v", err)
	}
	if stats := pool.Stats(); !stats.Degraded || stats.Stopping != 1 || stats.Workers != 0 {
		t.Fatalf("canceled acquire pool stats = %+v", stats)
	}
}

func TestNormalizeRouteRejectsMissingAuthorizationDigests(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	route := testRoute(workspace)
	route.Network = platform.NetworkRestricted
	if _, _, _, err := normalizeRoute(route); err == nil {
		t.Fatal("restricted route without policy digest was accepted")
	}
	route.NetworkPolicyDigest = strings.Repeat("b", 64)
	if _, _, _, err := normalizeRoute(route); err != nil {
		t.Fatal(err)
	}
	route.Network = platform.NetworkOff
	if _, _, _, err := normalizeRoute(route); err == nil {
		t.Fatal("off route with policy digest was accepted")
	}
}
