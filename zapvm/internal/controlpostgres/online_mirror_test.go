package controlpostgres

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"zapvm/internal/cloudplane"
)

func TestOnlineMirrorRecoversAndFlushesLatestSnapshot(t *testing.T) {
	snapshot := controlFileSnapshot(t)
	var mu sync.Mutex
	var fail bool
	var appliedLengths []int
	mirror, err := newOnlineMirror(func(_ context.Context, candidate cloudplane.OfflineSnapshot) error {
		mu.Lock()
		defer mu.Unlock()
		if fail {
			return errors.New("private database failure")
		}
		appliedLengths = append(appliedLengths, len(candidate.StateJSON))
		return nil
	}, OnlineMirrorOptions{RetryInterval: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if err := mirror.Reconcile(context.Background(), snapshot); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	fail = true
	mu.Unlock()
	second := snapshot
	second.StateJSON = append(append([]byte(nil), snapshot.StateJSON...), ' ')
	if err := mirror.Enqueue(second); err != nil {
		t.Fatal(err)
	}
	waitMirrorHealth(t, mirror, func(health cloudplane.StateMirrorHealth) bool {
		return health.Pending && health.Failed && health.ConsecutiveFailures >= 1
	})
	mu.Lock()
	fail = false
	mu.Unlock()
	third := snapshot
	third.StateJSON = append(append([]byte(nil), snapshot.StateJSON...), ' ', ' ')
	if err := mirror.Enqueue(third); err != nil {
		t.Fatal(err)
	}
	waitMirrorHealth(t, mirror, func(health cloudplane.StateMirrorHealth) bool {
		return !health.Pending && !health.Failed && !health.LastSuccess.IsZero()
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := mirror.Close(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(appliedLengths) < 2 || appliedLengths[len(appliedLengths)-1] != len(third.StateJSON) {
		t.Fatalf("online mirror applied lengths=%v latest=%d", appliedLengths, len(third.StateJSON))
	}
}

func TestOnlineMirrorCloseFailsWhenLatestSnapshotCannotFlush(t *testing.T) {
	snapshot := controlFileSnapshot(t)
	var failed atomic.Bool
	mirror, err := newOnlineMirror(func(_ context.Context, _ cloudplane.OfflineSnapshot) error {
		if failed.Load() {
			return errors.New("database unavailable")
		}
		return nil
	}, OnlineMirrorOptions{RetryInterval: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if err := mirror.Reconcile(context.Background(), snapshot); err != nil {
		t.Fatal(err)
	}
	failed.Store(true)
	if err := mirror.Enqueue(snapshot); err != nil {
		t.Fatal(err)
	}
	waitMirrorHealth(t, mirror, func(health cloudplane.StateMirrorHealth) bool { return health.Failed })
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if err := mirror.Close(ctx); err == nil || !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("online mirror close error=%v context=%v", err, ctx.Err())
	}
}

func waitMirrorHealth(t *testing.T, mirror *OnlineMirror, accepted func(cloudplane.StateMirrorHealth) bool) {
	t.Helper()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for {
		if accepted(mirror.Health()) {
			return
		}
		select {
		case <-mirror.status:
		case <-deadline.C:
			t.Fatalf("online mirror health did not converge: %#v", mirror.Health())
		}
	}
}
