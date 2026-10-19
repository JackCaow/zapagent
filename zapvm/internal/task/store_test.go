package task

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStoreTaskLifecycleAndCursorReads(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "tasks"))
	if err != nil {
		t.Fatal(err)
	}
	current := time.Date(2026, 8, 6, 1, 2, 3, 0, time.UTC)
	store.now = func() time.Time {
		value := current
		current = current.Add(time.Second)
		return value
	}
	digest := testDigest("request-a")
	created, fresh, err := store.Create("task-a", "computer-a", digest)
	if err != nil || !fresh || created.State != StateQueued || created.LastCursor != 1 {
		t.Fatalf("Create = %+v fresh=%t err=%v", created, fresh, err)
	}
	again, fresh, err := store.Create("task-a", "computer-a", digest)
	if err != nil || fresh || again != created {
		t.Fatalf("idempotent Create = %+v fresh=%t err=%v", again, fresh, err)
	}
	if _, _, err := store.Create("task-a", "computer-a", testDigest("different")); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting Create error = %v", err)
	}

	started, running, err := store.Append("task-a", Event{Type: "task.started"})
	if err != nil || started.Cursor != 2 || running.State != StateRunning {
		t.Fatalf("start append = %+v view=%+v err=%v", started, running, err)
	}
	if _, _, err := store.Append("task-a", Event{Type: "exec.output", Stream: "stdout", Data: []byte("hello")}); err != nil {
		t.Fatal(err)
	}
	ok := true
	result, completed, err := store.Append("task-a", Event{Type: "exec.result", OK: &ok})
	if err != nil || result.Cursor != 4 || completed.State != StateSucceeded {
		t.Fatalf("result append = %+v view=%+v err=%v", result, completed, err)
	}
	if _, _, err := store.Append("task-a", Event{Type: "exec.output", Stream: "stdout"}); !errors.Is(err, ErrTerminal) {
		t.Fatalf("terminal append error = %v", err)
	}

	events, view, err := store.Read("task-a", 1, 2)
	if err != nil || len(events) != 2 || events[0].Cursor != 2 || events[1].Cursor != 3 || view.State != StateSucceeded {
		t.Fatalf("Read = %+v view=%+v err=%v", events, view, err)
	}
	if _, _, err := store.Read("task-a", 99, 2); !errors.Is(err, ErrCursorAhead) {
		t.Fatalf("ahead cursor error = %v", err)
	}
}

func TestStoreRecoversOnlyIncompleteTasks(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tasks")
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"queued", "running", "canceling", "done"} {
		if _, _, err := store.Create(id, "computer-a", testDigest(id)); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := store.Append("running", Event{Type: "task.started"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Append("canceling", Event{Type: "task.cancel_requested"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Append("done", Event{Type: "task.started"}); err != nil {
		t.Fatal(err)
	}
	ok := true
	if _, _, err := store.Append("done", Event{Type: "exec.result", OK: &ok}); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := reopened.RecoverInterrupted()
	if err != nil || len(recovered) != 3 || recovered[0] != "queued" || recovered[1] != "running" || recovered[2] != "canceling" {
		t.Fatalf("RecoverInterrupted = %v, %v", recovered, err)
	}
	for _, id := range []string{"queued", "running"} {
		view, err := reopened.Inspect(id)
		if err != nil || view.State != StateInterrupted {
			t.Fatalf("recovered %s = %+v, %v", id, view, err)
		}
	}
	canceled, err := reopened.Inspect("canceling")
	if err != nil || canceled.State != StateCanceled {
		t.Fatalf("recovered canceling Task = %+v, %v", canceled, err)
	}
	view, err := reopened.Inspect("done")
	if err != nil || view.State != StateSucceeded {
		t.Fatalf("completed Task changed = %+v, %v", view, err)
	}
}

func TestStoreCancelLifecycleAndRetryLink(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tasks")
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	digest := testDigest("request")
	if _, _, err := store.Create("source", "computer-a", digest); err != nil {
		t.Fatal(err)
	}
	if _, canceling, err := store.Append("source", Event{Type: "task.cancel_requested"}); err != nil || canceling.State != StateCanceling {
		t.Fatalf("cancel request = %+v, %v", canceling, err)
	}
	if _, canceling, err := store.Append("source", Event{Type: "task.started"}); err != nil || canceling.State != StateCanceling {
		t.Fatalf("started after cancel = %+v, %v", canceling, err)
	}
	if _, canceled, err := store.Append("source", Event{Type: "task.canceled", Error: "user_requested"}); err != nil || canceled.State != StateCanceled {
		t.Fatalf("canceled = %+v, %v", canceled, err)
	}
	retry, fresh, err := store.CreateRetry("retry-a", "computer-a", digest, "source")
	if err != nil || !fresh || retry.RetryOf != "source" {
		t.Fatalf("CreateRetry = %+v fresh=%t err=%v", retry, fresh, err)
	}
	if _, _, err := store.CreateRetry("source", "computer-a", digest, "source"); err == nil {
		t.Fatal("retry reused its source Task ID")
	}
	reopened, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	retry, err = reopened.Inspect("retry-a")
	if err != nil || retry.RetryOf != "source" {
		t.Fatalf("reopened retry = %+v, %v", retry, err)
	}
}

func TestStorePruneRemovesOnlyExpiredTerminalTasks(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tasks")
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	current := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return current }
	staleTemporary := filepath.Join(root, ".task-stale.tmp")
	if err := os.Mkdir(staleTemporary, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"old-a", "old-b", "running", "new"} {
		if _, _, err := store.Create(id, "computer-a", testDigest(id)); err != nil {
			t.Fatal(err)
		}
	}
	ok := true
	if _, _, err := store.Append("old-a", Event{Type: "task.started"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Append("old-a", Event{Type: "exec.result", OK: &ok}); err != nil {
		t.Fatal(err)
	}
	current = current.Add(time.Hour)
	if _, _, err := store.Append("old-b", Event{Type: "task.cancel_requested"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Append("old-b", Event{Type: "task.canceled"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Append("running", Event{Type: "task.started"}); err != nil {
		t.Fatal(err)
	}
	current = current.Add(10 * 24 * time.Hour)
	if _, _, err := store.Append("new", Event{Type: "task.started"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Append("new", Event{Type: "exec.result", OK: &ok}); err != nil {
		t.Fatal(err)
	}

	cutoff := time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC)
	removed, err := store.Prune(cutoff, 1)
	if err != nil || len(removed) != 1 || removed[0] != "old-a" {
		t.Fatalf("first Prune = %v, %v", removed, err)
	}
	if _, err := os.Lstat(staleTemporary); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale Task staging path survived Prune: %v", err)
	}
	if _, err := store.Inspect("old-a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pruned Task inspect error = %v", err)
	}
	removed, err = store.Prune(cutoff, 10)
	if err != nil || len(removed) != 1 || removed[0] != "old-b" {
		t.Fatalf("second Prune = %v, %v", removed, err)
	}
	for _, id := range []string{"running", "new"} {
		if _, err := store.Inspect(id); err != nil {
			t.Fatalf("Prune removed %s: %v", id, err)
		}
	}
}

func TestStoreRejectsInvalidTransition(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "tasks"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Create("task-a", "computer-a", testDigest("request")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Append("task-a", Event{Type: "exec.output", Stream: "stdout"}); err == nil {
		t.Fatal("queued Task accepted output before start")
	}
}

func TestStoreReservesFinalJournalSlotForTerminalEvent(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "tasks"))
	if err != nil {
		t.Fatal(err)
	}
	digest := testDigest("request")
	if _, _, err := store.Create("task-a", "computer-a", digest); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Append("task-a", Event{Type: "task.started"}); err != nil {
		t.Fatal(err)
	}
	store.views["task-a"] = View{
		ID: "task-a", ComputerID: "computer-a", RequestSHA256: digest,
		State: StateRunning, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano), LastCursor: MaxEvents - 1,
	}
	if _, _, err := store.Append("task-a", Event{Type: "exec.output", Stream: "stdout"}); !errors.Is(err, ErrJournalFull) {
		t.Fatal("non-terminal event consumed the reserved terminal slot")
	}
}

func testDigest(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}
