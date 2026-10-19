package cloudplane

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type testStateMirror struct {
	mu           sync.Mutex
	reconciles   int
	enqueues     int
	closes       int
	health       StateMirrorHealth
	reconcileErr error
	enqueueErr   error
}

func (mirror *testStateMirror) Reconcile(_ context.Context, _ OfflineSnapshot) error {
	mirror.mu.Lock()
	defer mirror.mu.Unlock()
	mirror.reconciles++
	return mirror.reconcileErr
}

func (mirror *testStateMirror) Enqueue(_ OfflineSnapshot) error {
	mirror.mu.Lock()
	defer mirror.mu.Unlock()
	mirror.enqueues++
	return mirror.enqueueErr
}

func (mirror *testStateMirror) Health() StateMirrorHealth {
	mirror.mu.Lock()
	defer mirror.mu.Unlock()
	return mirror.health
}

func (mirror *testStateMirror) Close(_ context.Context) error {
	mirror.mu.Lock()
	defer mirror.mu.Unlock()
	mirror.closes++
	return nil
}

func TestStoreReconcilesObservesAndClosesStateMirror(t *testing.T) {
	root := t.TempDir()
	now := time.Date(2026, 8, 8, 4, 5, 6, 0, time.UTC)
	mirror := &testStateMirror{}
	store, err := Open(root, testProvisions(), Options{
		Now: func() time.Time { return now }, Random: bytes.NewReader(bytes.Repeat([]byte{0x4a}, 1024)), StateMirror: mirror,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	mirror.mu.Lock()
	if mirror.reconciles != 1 || mirror.enqueues != 1 {
		t.Fatalf("mirror reconciles=%d enqueues=%d", mirror.reconciles, mirror.enqueues)
	}
	mirror.health = StateMirrorHealth{Pending: true, Failed: true, ConsecutiveFailures: 2, PendingSince: now.Add(-time.Minute), LastSuccess: now.Add(-2 * time.Minute)}
	mirror.mu.Unlock()
	if !errors.Is(store.Ready(), ErrStoreDegraded) {
		t.Fatal("Store remained ready after State mirror failure")
	}
	snapshot := store.OperationalSnapshot()
	if snapshot.Ready || !snapshot.StateMirrorEnabled || !snapshot.StateMirrorFailed || snapshot.StateMirrorConsecutiveErrors != 2 || snapshot.StateMirrorPendingAgeMS != 60000 || len(snapshot.Alerts) == 0 || snapshot.Alerts[0].Code != "state_mirror_failed" {
		t.Fatalf("operational State mirror snapshot=%#v", snapshot)
	}
	mirror.mu.Lock()
	mirror.health = StateMirrorHealth{LastSuccess: now}
	mirror.mu.Unlock()
	if err := store.Ready(); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	mirror.mu.Lock()
	defer mirror.mu.Unlock()
	if mirror.closes != 1 {
		t.Fatalf("mirror closes=%d", mirror.closes)
	}
}

func TestStateMirrorEnqueueFailureKeepsFilePrimaryDurable(t *testing.T) {
	root := t.TempDir()
	mirror := &testStateMirror{enqueueErr: errors.New("private PostgreSQL detail")}
	store, err := Open(root, testProvisions(), Options{StateMirror: mirror})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterNode("node-a", "generation-00001"); err == nil {
		t.Fatal("State mirror enqueue failure did not fail the mutation")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(root, testProvisions(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	nodes := reopened.ListNodes()
	if len(nodes) != 1 || nodes[0].ID != "node-a" {
		t.Fatalf("durable file-primary Nodes=%#v", nodes)
	}
}
