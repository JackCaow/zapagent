package cloudplane

import (
	"bytes"
	"testing"
	"time"
)

func TestOfflineSnapshotIsDeterministicAndDetached(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 8, 1, 2, 3, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	first, err := store.OfflineSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	firstJSON, err := first.CanonicalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Provisions) == 0 || len(first.Provisions[0].Scopes) == 0 {
		t.Fatal("offline snapshot omitted provisions")
	}
	first.StateJSON[0] ^= 1
	first.Provisions[0].ID = "mutated"
	first.Provisions[0].Scopes[0].TenantID = "mutated"
	second, err := store.OfflineSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	secondJSON, err := second.CanonicalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(firstJSON, secondJSON) {
		t.Fatal("offline snapshot is not deterministic or retained caller mutations")
	}
	if second.Provisions[0].ID == "mutated" || second.Provisions[0].Scopes[0].TenantID == "mutated" {
		t.Fatal("offline snapshot retained caller mutations")
	}
	second.StateSchemaVersion++
	if _, err := second.CanonicalJSON(); err == nil {
		t.Fatal("offline snapshot accepted a mismatched state schema")
	}
}

func TestOfflineSnapshotRejectsClosedStore(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 8, 1, 2, 3, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.OfflineSnapshot(); err == nil {
		t.Fatal("closed Store returned an offline snapshot")
	}
}
