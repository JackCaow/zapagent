package cloudplane

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"zapvm/internal/daemonrpc"
)

func submitAndCompleteResidentTurn(t *testing.T, store *Store, id, sessionID string, continuation bool) Task {
	t.Helper()
	registerTestNodeA(t, store)
	request := residentAgentSubmitRequest{
		ID: id, ComputerID: "computer-a", SessionID: sessionID, Prompt: "retention turn",
		ProviderBaseURL: "https://api.example.test/v1", Model: "model-1", ModelCredentialID: "model-api-key",
		TimeoutMillis: 60000,
	}
	command, credentials, err := request.command()
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(command)
	if err != nil {
		t.Fatal(err)
	}
	task, created, err := store.SubmitAgentSession(testPrincipalA, SubmitRequest{
		ID: id, Scope: Scope{TenantID: "acme", ProjectID: "weather"}, ComputerID: "computer-a",
		Payload: payload, CredentialIDs: credentials,
	}, sessionID, continuation)
	if err != nil || !created {
		t.Fatalf("submit retained turn=%#v created=%t err=%v", task, created, err)
	}
	leases, err := store.Claim("node-a", "generation-00001", 1)
	if err != nil || len(leases) != 1 || leases[0].Task.ID != id {
		t.Fatalf("claim retained turn=%#v err=%v", leases, err)
	}
	lease := leases[0]
	if _, err := store.Acknowledge("node-a", "generation-00001", id, lease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	if _, created, err := store.AppendTaskEvent("node-a", "generation-00001", id, lease.LeaseToken, daemonrpc.ComputerTaskEvent{
		Cursor: 1, Timestamp: timestamp(store.now().UTC()), TaskID: id, Type: "output", Stream: "stdout", Data: []byte("retained output"),
	}); err != nil || !created {
		t.Fatalf("append retained turn event created=%t err=%v", created, err)
	}
	task, err = store.Complete("node-a", "generation-00001", id, lease.LeaseToken, Completion{
		Succeeded: true, ResultSHA256: strings.Repeat("c", 64),
	})
	if err != nil || task.State != TaskSucceeded {
		t.Fatalf("complete retained turn=%#v err=%v", task, err)
	}
	return task
}

func TestTaskRetentionPrunesWholeTerminalSessionOnlyAfterLatestTurnExpires(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 8, 5, 0, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	store.taskRetention = time.Hour
	scope := Scope{TenantID: "acme", ProjectID: "weather"}
	first := submitAndCompleteResidentTurn(t, store, "retained-turn-a", "retained-session", false)
	clock.Advance(30 * time.Minute)
	second := submitAndCompleteResidentTurn(t, store, "retained-turn-b", "retained-session", true)
	clock.Advance(31 * time.Minute)
	if err := store.Sweep(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.InspectTask(scope, first.ID); err != nil {
		t.Fatalf("older turn pruned while the Session latest turn remained recoverable: %v", err)
	}
	if _, err := store.InspectTask(scope, second.ID); err != nil {
		t.Fatalf("latest turn pruned before retention: %v", err)
	}
	clock.Advance(30 * time.Minute)
	if err := store.Sweep(); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{first.ID, second.ID} {
		if _, err := store.InspectTask(scope, id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("expired terminal Session turn %q was retained: %v", id, err)
		}
		if _, err := store.TaskEvents(scope, id, 0, 10); !errors.Is(err, ErrNotFound) {
			t.Fatalf("expired terminal Session event journal %q was retained: %v", id, err)
		}
	}
	audit, err := store.Audit(scope, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	pruned := make(map[string]bool)
	for _, record := range audit {
		if record.Action == "task_prune" && record.Outcome == "retention" {
			pruned[record.TaskID] = true
		}
	}
	if !pruned[first.ID] || !pruned[second.ID] {
		t.Fatalf("Task retention audit is incomplete: %#v", pruned)
	}
	if store.totalEventBytes != 0 || len(store.eventBytes) != 0 {
		t.Fatalf("Task retention did not release event quota: total=%d tasks=%#v", store.totalEventBytes, store.eventBytes)
	}
}

func TestTaskEventAdmissionStopsBeforeJournalExhaustsControlState(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 8, 7, 0, 0, 0, time.UTC)}
	store, root := openTestStore(t, clock)
	residentArtifactTask(t, store, "event-quota-task", Scope{TenantID: "acme", ProjectID: "weather"})
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	leases, err := store.Claim("node-a", "generation-00001", 1)
	if err != nil || len(leases) != 1 {
		t.Fatalf("claim=%#v err=%v", leases, err)
	}
	lease := leases[0]
	if _, err := store.Acknowledge("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	firstEvent := daemonrpc.ComputerTaskEvent{
		Cursor: 1, Timestamp: timestamp(clock.Now()), TaskID: lease.Task.ID, Type: "output", Data: []byte("persisted quota"),
	}
	if _, _, err := store.AppendTaskEvent("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken, firstEvent); err != nil {
		t.Fatal(err)
	}
	expectedWeight := store.eventBytes[lease.Task.ID]
	if expectedWeight == 0 || store.totalEventBytes != expectedWeight {
		t.Fatalf("event accounting task=%d total=%d", expectedWeight, store.totalEventBytes)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(root, testProvisions(), Options{Now: clock.Now, HeartbeatTTL: 20 * time.Second, LeaseTTL: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.eventBytes[lease.Task.ID] != expectedWeight || reopened.totalEventBytes != expectedWeight {
		t.Fatalf("recovered event accounting task=%d total=%d", reopened.eventBytes[lease.Task.ID], reopened.totalEventBytes)
	}
	reopened.eventBytes[lease.Task.ID] = maxEventBytesPerTask
	reopened.totalEventBytes = maxEventBytesPerTask
	if _, _, err := reopened.AppendTaskEvent("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken, daemonrpc.ComputerTaskEvent{
		Cursor: 2, Timestamp: timestamp(clock.Now()), TaskID: lease.Task.ID, Type: "output", Data: []byte("bounded"),
	}); !errors.Is(err, ErrQuotaReached) {
		t.Fatalf("event journal quota error=%v", err)
	}
	if len(reopened.state.Events[lease.Task.ID]) != 1 {
		t.Fatal("quota-rejected event was appended")
	}
}
