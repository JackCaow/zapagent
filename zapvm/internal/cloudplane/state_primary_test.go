package cloudplane

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type testStatePrimary struct {
	snapshot  OfflineSnapshot
	exists    bool
	loads     int
	commits   int
	commitErr error
}

func (primary *testStatePrimary) Load(_ context.Context) (OfflineSnapshot, bool, error) {
	primary.loads++
	return primary.snapshot, primary.exists, nil
}

func (primary *testStatePrimary) Commit(_ context.Context, snapshot OfflineSnapshot) error {
	primary.commits++
	if primary.commitErr != nil {
		return primary.commitErr
	}
	primary.snapshot = snapshot
	primary.exists = true
	return nil
}

func TestStatePrimaryBootstrapsAndCommitsBeforeFileCache(t *testing.T) {
	root := t.TempDir()
	primary := &testStatePrimary{}
	store, err := Open(root, testProvisions(), Options{StatePrimary: primary})
	if err != nil {
		t.Fatal(err)
	}
	if primary.loads != 1 || primary.commits != 1 || !primary.exists {
		t.Fatalf("primary bootstrap loads=%d commits=%d exists=%t", primary.loads, primary.commits, primary.exists)
	}
	if operational := store.OperationalSnapshot(); !operational.Ready || !operational.StatePrimaryEnabled || operational.StateMirrorEnabled {
		t.Fatalf("primary operational snapshot=%#v", operational)
	}
	primary.commitErr = errors.New("private PostgreSQL primary failure")
	if _, err := store.RegisterNode("node-a", "generation-00001"); err == nil {
		t.Fatal("State primary failure did not fail the mutation")
	}
	if !errors.Is(store.Ready(), ErrStoreDegraded) {
		t.Fatal("Store remained ready after State primary failure")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(root, testProvisions(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if nodes := reopened.ListNodes(); len(nodes) != 0 {
		t.Fatalf("failed primary commit leaked into file rollback cache: %#v", nodes)
	}
}

func TestStatePrimaryOverridesAndRepairsCorruptFileCache(t *testing.T) {
	root := t.TempDir()
	source, err := Open(root, testProvisions(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := source.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	snapshot, err := source.OfflineSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if err := source.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "state.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	primary := &testStatePrimary{snapshot: snapshot, exists: true}
	store, err := Open(root, testProvisions(), Options{StatePrimary: primary})
	if err != nil {
		t.Fatal(err)
	}
	if primary.loads != 1 || primary.commits != 0 {
		t.Fatalf("primary recovery loads=%d commits=%d", primary.loads, primary.commits)
	}
	if nodes := store.ListNodes(); len(nodes) != 1 || nodes[0].ID != "node-a" {
		t.Fatalf("primary recovered Nodes=%#v", nodes)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	rollback, err := Open(root, testProvisions(), Options{})
	if err != nil {
		t.Fatalf("reopen repaired file rollback cache: %v", err)
	}
	defer rollback.Close()
	if nodes := rollback.ListNodes(); len(nodes) != 1 || nodes[0].ID != "node-a" {
		t.Fatalf("rollback cache Nodes=%#v", nodes)
	}
}

func TestStatePrimaryRejectsMirrorAndReconcilesProvisionDrift(t *testing.T) {
	if _, err := Open(t.TempDir(), testProvisions(), Options{StatePrimary: &testStatePrimary{}, StateMirror: &testStateMirror{}}); err == nil {
		t.Fatal("Store accepted simultaneous State primary and mirror")
	}
	source, err := Open(t.TempDir(), testProvisions(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := source.OfflineSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if err := source.Close(); err != nil {
		t.Fatal(err)
	}
	different := testProvisions()
	different[0].Capacity++
	primary := &testStatePrimary{snapshot: snapshot, exists: true}
	reconciled, err := Open(t.TempDir(), different, Options{StatePrimary: primary})
	if err != nil {
		t.Fatal(err)
	}
	defer reconciled.Close()
	if primary.commits != 1 || primary.snapshot.Provisions[0].Capacity != different[0].Capacity {
		t.Fatalf("State primary provision reconcile commits=%d snapshot=%#v", primary.commits, primary.snapshot.Provisions)
	}
}
