package computer

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"zapvm/internal/platform"
)

func TestStoreCreatesGetsAndListsComputers(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "computers"))
	if err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return time.Date(2026, 8, 6, 1, 2, 3, 0, time.UTC) }
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	want, err := store.Create(Record{
		ID: "project-a", Workspace: workspace, Network: platform.NetworkRestricted,
		AllowedDomains: []string{"github.com"}, AllowedPorts: []uint16{443}, CPUCount: 2, MemoryMiB: 2048,
	})
	if err != nil {
		t.Fatal(err)
	}
	if want.SchemaVersion != CurrentSchema || want.CreatedAt != "2026-08-06T01:02:03Z" {
		t.Fatalf("created record = %+v", want)
	}
	got, err := store.Get("project-a")
	if err != nil || got.ID != want.ID || got.Workspace != want.Workspace {
		t.Fatalf("Get = %+v, %v", got, err)
	}
	list, err := store.List()
	if err != nil || len(list) != 1 || list[0].ID != "project-a" {
		t.Fatalf("List = %+v, %v", list, err)
	}
	if _, err := store.Create(want); !errors.Is(err, ErrExists) {
		t.Fatalf("duplicate Create error = %v", err)
	}
}

func TestStoreRejectsUnsafeIDsAndRecords(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "computers"))
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(t.TempDir(), "workspace")
	for _, id := range []string{"", "../escape", "with space", "slash/value"} {
		if _, err := store.Create(Record{ID: id, Workspace: workspace, Network: platform.NetworkOff, CPUCount: 2, MemoryMiB: 2048}); err == nil {
			t.Fatalf("unsafe ID %q was accepted", id)
		}
	}
	if _, err := store.Create(Record{ID: "relative", Workspace: "relative", Network: platform.NetworkOff, CPUCount: 2, MemoryMiB: 2048}); err == nil {
		t.Fatal("relative workspace was accepted")
	}
}

func TestStoreRejectsSymlinkRecord(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation is not generally available to unprivileged Windows tests")
	}
	root := filepath.Join(t.TempDir(), "computers")
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "target.json")
	if err := os.WriteFile(target, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "linked.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get("linked"); err == nil {
		t.Fatal("symlink Computer record was accepted")
	}
}
