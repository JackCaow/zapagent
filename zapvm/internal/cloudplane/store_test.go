package cloudplane

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"zapvm/internal/daemonrpc"
)

const (
	testPrincipalA = "spiffe://example.test/tenant/acme/project/weather/client/codex"
	testPrincipalB = "spiffe://example.test/tenant/beta/project/build/client/claude"
)

type testClock struct{ now time.Time }

func (clock *testClock) Now() time.Time { return clock.now }

func (clock *testClock) Advance(duration time.Duration) { clock.now = clock.now.Add(duration) }

func testProvisions() []NodeProvision {
	return []NodeProvision{
		{ID: "node-a", Capacity: 4, Scopes: []Scope{{TenantID: "acme", ProjectID: "weather"}}},
		{ID: "node-b", Capacity: 1, Scopes: []Scope{{TenantID: "beta", ProjectID: "build"}}},
		{ID: "node-shared", Capacity: 4, Scopes: []Scope{{TenantID: "acme", ProjectID: "weather"}, {TenantID: "beta", ProjectID: "build"}}},
	}
}

func openTestStore(t *testing.T, clock *testClock) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	randomData := make([]byte, 4096)
	for index := range randomData {
		randomData[index] = byte(index)
	}
	random := bytes.NewReader(randomData)
	store, err := Open(root, testProvisions(), Options{
		Now: clock.Now, Random: random, HeartbeatTTL: 20 * time.Second, LeaseTTL: 30 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, root
}

func registerTestNodeA(t *testing.T, store *Store) {
	t.Helper()
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
}

func submitTask(t *testing.T, store *Store, principal, id string, scope Scope) Task {
	t.Helper()
	payload := taskPayload(t, id)
	task, created, err := store.Submit(principal, SubmitRequest{
		ID: id, Scope: scope, ComputerID: "computer-a", Payload: payload, CredentialIDs: []string{"github"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatalf("Task %s was not created", id)
	}
	return task
}

func TestAgentSessionPendingDispatchTimesOut(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 2, 0, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	store.dispatchTimeout = 30 * time.Second
	registerTestNodeA(t, store)
	request := residentAgentSubmitRequest{
		ID: "dispatch-timeout", ComputerID: "computer-a", SessionID: "dispatch-timeout-session", Prompt: "wait for a node",
		ProviderBaseURL: "https://api.example.test/v1", Model: "model-1", ModelCredentialID: "model-api-key", TimeoutMillis: 60000,
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
		ID: request.ID, Scope: Scope{TenantID: "acme", ProjectID: "weather"}, ComputerID: request.ComputerID,
		Payload: payload, CredentialIDs: credentials,
	}, request.SessionID, false)
	if err != nil || !created || task.State != TaskPending || task.QueueReason != QueueReasonDispatchWait || task.QueueDeadline == "" {
		t.Fatalf("pending submit=%#v created=%t err=%v", task, created, err)
	}
	clock.Advance(31 * time.Second)
	if err := store.Sweep(); err != nil {
		t.Fatal(err)
	}
	task, err = store.InspectTask(task.Scope(), task.ID)
	if err != nil || task.State != TaskFailed || task.FailureCode != "computer_offline" || task.QueueReason != QueueReasonNodeOffline {
		t.Fatalf("expired pending Task=%#v err=%v", task, err)
	}
}

func TestPendingTaskReportsCapacityWaitAndTimesOut(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 2, 30, 0, 0, time.UTC)}
	root := t.TempDir()
	store, err := Open(root, []NodeProvision{{
		ID: "node-capacity", Capacity: 1,
		Scopes: []Scope{{TenantID: "acme", ProjectID: "weather"}},
	}}, Options{
		Now: clock.Now, Random: bytes.NewReader(bytes.Repeat([]byte{0x31}, 4096)),
		HeartbeatTTL: 20 * time.Second, LeaseTTL: 2 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	store.dispatchTimeout = 30 * time.Second
	if _, err := store.RegisterNode("node-capacity", "generation-capacity-01"); err != nil {
		t.Fatal(err)
	}
	scope := Scope{TenantID: "acme", ProjectID: "weather"}
	first, created, err := store.Submit(testPrincipalA, SubmitRequest{
		ID: "capacity-holder", Scope: scope, ComputerID: "computer-a",
		Payload: taskPayload(t, "capacity-holder"), CredentialIDs: []string{"github"},
	})
	if err != nil || !created {
		t.Fatalf("submit capacity holder=%#v created=%t err=%v", first, created, err)
	}
	leases, err := store.Claim("node-capacity", "generation-capacity-01", 1)
	if err != nil || len(leases) != 1 || leases[0].Task.ID != first.ID {
		t.Fatalf("claim capacity holder=%#v err=%v", leases, err)
	}

	waiting, created, err := store.Submit(testPrincipalA, SubmitRequest{
		ID: "capacity-waiter", Scope: scope, ComputerID: "computer-a",
		Payload: taskPayload(t, "capacity-waiter"), CredentialIDs: []string{"github"},
	})
	if err != nil || !created || waiting.QueueReason != QueueReasonCapacityWait || waiting.QueueDeadline == "" {
		t.Fatalf("submit capacity waiter=%#v created=%t err=%v", waiting, created, err)
	}
	clock.Advance(15 * time.Second)
	if _, err := store.Heartbeat("node-capacity", "generation-capacity-01", nil); err != nil {
		t.Fatal(err)
	}
	clock.Advance(16 * time.Second)
	if err := store.Sweep(); err != nil {
		t.Fatal(err)
	}
	waiting, err = store.InspectTask(scope, waiting.ID)
	if err != nil || waiting.State != TaskFailed || waiting.FailureCode != "capacity_timeout" || waiting.QueueReason != QueueReasonCapacityWait {
		t.Fatalf("expired capacity waiter=%#v err=%v", waiting, err)
	}
}

func taskPayload(t *testing.T, id string) json.RawMessage {
	return taskPayloadForComputer(t, id, "computer-a")
}

func taskPayloadForComputer(t *testing.T, id, computerID string) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
		ID: id, ComputerID: computerID,
		Command: daemonrpc.Command{
			ID: "command-a", SessionID: "cloud-session", Argv: []string{"echo", "ok"},
			CredentialIDs: []string{"github"}, TimeoutMillis: 60000,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestStoreTenantIsolationLifecycleAndRecovery(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 1, 2, 3, 0, time.UTC)}
	store, root := openTestStore(t, clock)
	acme := Scope{TenantID: "acme", ProjectID: "weather"}
	beta := Scope{TenantID: "beta", ProjectID: "build"}
	submitTask(t, store, testPrincipalA, "task-acme", acme)
	submitTask(t, store, testPrincipalB, "task-beta", beta)

	duplicate, created, err := store.Submit(testPrincipalA, SubmitRequest{
		ID: "task-acme", Scope: acme, ComputerID: "computer-a",
		Payload: taskPayload(t, "task-acme"), CredentialIDs: []string{"github"},
	})
	if err != nil || created || duplicate.ID != "task-acme" {
		t.Fatalf("idempotent submit = %#v, %t, %v", duplicate, created, err)
	}
	if _, _, err := store.Submit(testPrincipalA, SubmitRequest{
		ID: "task-acme", Scope: acme, ComputerID: "computer-a",
		Payload:       bytes.Replace(taskPayload(t, "task-acme"), []byte(`"ok"`), []byte(`"different"`), 1),
		CredentialIDs: []string{"github"},
	}); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting submit error = %v", err)
	}

	node, err := store.RegisterNode("node-a", "generation-00001")
	if err != nil || node.State != NodeOnline {
		t.Fatalf("register node = %#v, %v", node, err)
	}
	leases, err := store.Claim("node-a", "generation-00001", 1)
	if err != nil || len(leases) != 1 || leases[0].Task.ID != "task-acme" {
		t.Fatalf("first fair lease = %#v, %v", leases, err)
	}
	lease := leases[0]
	if _, err := store.Acknowledge("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	result := strings.Repeat("a", 64)
	completed, err := store.Complete("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken, Completion{Succeeded: true, ResultSHA256: result})
	if err != nil || completed.State != TaskSucceeded {
		t.Fatalf("complete = %#v, %v", completed, err)
	}
	if _, err := store.InspectTask(beta, "task-acme"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant inspect error = %v", err)
	}
	audit, err := store.Audit(acme, 0, 100)
	if err != nil || len(audit) != 5 || audit[1].Action != "task_queue_reason" || audit[1].Outcome != QueueReasonDispatchWait {
		t.Fatalf("tenant audit count = %d, %v: %#v", len(audit), err, audit)
	}
	data, err := os.ReadFile(filepath.Join(root, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte(lease.LeaseToken)) || bytes.Contains(data, []byte(testPrincipalA)) {
		t.Fatal("state persisted a raw lease token or principal")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(root, testProvisions(), Options{
		Now: clock.Now, Random: bytes.NewReader(bytes.Repeat([]byte{0x6b}, 1024)),
		HeartbeatTTL: 20 * time.Second, LeaseTTL: 30 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	recovered, err := reopened.InspectTask(acme, "task-acme")
	if err != nil || recovered.State != TaskSucceeded || recovered.ResultSHA256 != result {
		t.Fatalf("recovered Task = %#v, %v", recovered, err)
	}
}

func TestStoreCancellationIntentRequiresNodeConfirmation(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 1, 20, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	scope := Scope{TenantID: "acme", ProjectID: "weather"}
	submitTask(t, store, testPrincipalA, "task-cancel", scope)
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	leases, err := store.Claim("node-a", "generation-00001", 1)
	if err != nil || len(leases) != 1 {
		t.Fatalf("claim = %#v, %v", leases, err)
	}
	lease := leases[0]
	if _, err := store.Acknowledge("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	canceling, err := store.Cancel(testPrincipalA, scope, lease.Task.ID)
	if err != nil || canceling.State != TaskCanceling || canceling.NodeID != "node-a" || canceling.LeaseTokenHash == "" {
		t.Fatalf("cancel intent = %#v, %v", canceling, err)
	}
	repeated, err := store.Cancel(testPrincipalA, scope, lease.Task.ID)
	if err != nil || repeated.State != TaskCanceling {
		t.Fatalf("repeated cancel = %#v, %v", repeated, err)
	}
	proof := LeaseProof{TaskID: lease.Task.ID, LeaseToken: lease.LeaseToken}
	taskIDs, err := store.Cancellations("node-a", "generation-00001", []LeaseProof{proof})
	if err != nil || len(taskIDs) != 1 || taskIDs[0] != lease.Task.ID {
		t.Fatalf("cancellations = %#v, %v", taskIDs, err)
	}
	if _, err := store.Cancellations("node-a", "generation-00001", []LeaseProof{{TaskID: lease.Task.ID, LeaseToken: "wrong"}}); !errors.Is(err, ErrFenced) {
		t.Fatalf("wrong cancellation proof error = %v", err)
	}
	if _, _, err := store.AppendTaskEvent("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken, daemonrpc.ComputerTaskEvent{
		Cursor: 1, Timestamp: timestamp(clock.Now()), TaskID: lease.Task.ID, Type: "task.cancel_requested",
	}); err != nil {
		t.Fatalf("append cancellation event: %v", err)
	}
	canceled, err := store.ConfirmCanceled("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken)
	if err != nil || canceled.State != TaskCanceled || canceled.NodeID != "" || canceled.LeaseTokenHash != "" {
		t.Fatalf("confirmed cancellation = %#v, %v", canceled, err)
	}
	if again, err := store.Cancel(testPrincipalA, scope, lease.Task.ID); err != nil || again.State != TaskCanceled {
		t.Fatalf("idempotent terminal cancel = %#v, %v", again, err)
	}

	submitTask(t, store, testPrincipalA, "task-pending-cancel", scope)
	if pending, err := store.Cancel(testPrincipalA, scope, "task-pending-cancel"); err != nil || pending.State != TaskCanceled {
		t.Fatalf("pending cancellation = %#v, %v", pending, err)
	}
}

func TestStoreWaitTaskEventsWakesOnDurableAppend(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 1, 24, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	scope := Scope{TenantID: "acme", ProjectID: "weather"}
	submitTask(t, store, testPrincipalA, "task-stream", scope)
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	leases, err := store.Claim("node-a", "generation-00001", 1)
	if err != nil || len(leases) != 1 {
		t.Fatalf("claim = %#v, %v", leases, err)
	}
	lease := leases[0]
	if _, err := store.Acknowledge("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	type waitResult struct {
		task   Task
		events []TaskEvent
		err    error
	}
	result := make(chan waitResult, 1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	go func() {
		task, events, err := store.WaitTaskEvents(ctx, scope, lease.Task.ID, 0, 10)
		result <- waitResult{task: task, events: events, err: err}
	}()
	if _, _, err := store.AppendTaskEvent("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken, daemonrpc.ComputerTaskEvent{
		Cursor: 1, Timestamp: timestamp(clock.Now()), TaskID: lease.Task.ID, Type: "exec.output", Stream: "stdout", Data: []byte("ok\n"),
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-result:
		if got.err != nil || got.task.State != TaskRunning || len(got.events) != 1 || got.events[0].Cursor != 1 {
			t.Fatalf("wait result = %#v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Task event waiter did not wake")
	}
}

func TestStoreUnconfirmedCancellationNeverRequeues(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 1, 25, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	scope := Scope{TenantID: "acme", ProjectID: "weather"}
	submitTask(t, store, testPrincipalA, "task-cancel-timeout", scope)
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	leases, err := store.Claim("node-a", "generation-00001", 1)
	if err != nil || len(leases) != 1 {
		t.Fatalf("claim = %#v, %v", leases, err)
	}
	if _, err := store.Acknowledge("node-a", "generation-00001", leases[0].Task.ID, leases[0].LeaseToken); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Cancel(testPrincipalA, scope, leases[0].Task.ID); err != nil {
		t.Fatal(err)
	}
	clock.Advance(31 * time.Second)
	if err := store.Sweep(); err != nil {
		t.Fatal(err)
	}
	failed, err := store.InspectTask(scope, leases[0].Task.ID)
	if err != nil || failed.State != TaskFailed || failed.FailureCode != "cancel_unconfirmed" {
		t.Fatalf("expired cancellation = %#v, %v", failed, err)
	}
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	if leases, err := store.Claim("node-a", "generation-00001", 1); err != nil || len(leases) != 0 {
		t.Fatalf("unconfirmed cancellation was requeued: %#v, %v", leases, err)
	}
}

func TestStoreCancellationSurvivesControlRestartAndNodeReconnect(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 1, 27, 0, 0, time.UTC)}
	store, root := openTestStore(t, clock)
	scope := Scope{TenantID: "acme", ProjectID: "weather"}
	submitTask(t, store, testPrincipalA, "task-cancel-restart", scope)
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	leases, err := store.Claim("node-a", "generation-00001", 1)
	if err != nil || len(leases) != 1 {
		t.Fatalf("claim = %#v, %v", leases, err)
	}
	lease := leases[0]
	if _, err := store.Acknowledge("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Cancel(testPrincipalA, scope, lease.Task.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(root, testProvisions(), Options{
		Now: clock.Now, Random: bytes.NewReader(bytes.Repeat([]byte{0x4c}, 1024)),
		HeartbeatTTL: 20 * time.Second, LeaseTTL: 30 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	proof := LeaseProof{TaskID: lease.Task.ID, LeaseToken: lease.LeaseToken}
	taskIDs, err := reopened.Cancellations("node-a", "generation-00001", []LeaseProof{proof})
	if err != nil || len(taskIDs) != 1 || taskIDs[0] != lease.Task.ID {
		t.Fatalf("recovered cancellations = %#v, %v", taskIDs, err)
	}
	confirmed, err := reopened.ConfirmCanceled("node-a", "generation-00001", lease.Task.ID, lease.LeaseToken)
	if err != nil || confirmed.State != TaskCanceled {
		t.Fatalf("reconnected Node confirmation = %#v, %v", confirmed, err)
	}
}

func TestStoreExplicitComputerProvisioningCatalogAndScheduling(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 1, 29, 0, 0, time.UTC)}
	root := t.TempDir()
	provisions := []NodeProvision{
		{ID: "node-a", Capacity: 1, Scopes: []Scope{{TenantID: "acme", ProjectID: "weather"}}, Computers: []ComputerProvision{{ID: "computer-a", TenantID: "acme", ProjectID: "weather", Agent: "zapcode@1.12.0"}}},
		{ID: "node-shadow", Capacity: 1, Scopes: []Scope{{TenantID: "acme", ProjectID: "weather"}}, Computers: []ComputerProvision{{ID: "computer-b", TenantID: "acme", ProjectID: "weather"}}},
		{ID: "node-legacy", Capacity: 1, Scopes: []Scope{{TenantID: "acme", ProjectID: "weather"}}},
	}
	store, err := Open(root, provisions, Options{Now: clock.Now, Random: bytes.NewReader(bytes.Repeat([]byte{0x2a}, 1024))})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	scope := Scope{TenantID: "acme", ProjectID: "weather"}
	computers, err := store.ListAgentComputers(scope)
	wantOfflineA := AgentComputer{ID: "computer-a", State: NodeOffline, DesiredState: ComputerDesiredRunning, ObservedState: ComputerObservedUnavailable, FailureCode: QueueReasonNodeOffline}
	wantOfflineB := AgentComputer{ID: "computer-b", State: NodeOffline, DesiredState: ComputerDesiredRunning, ObservedState: ComputerObservedUnavailable, FailureCode: QueueReasonNodeOffline}
	if err != nil || len(computers) != 2 || computers[0] != wantOfflineA || computers[1] != wantOfflineB {
		t.Fatalf("offline Computer catalog = %#v, %v", computers, err)
	}
	if _, _, err := store.Submit(testPrincipalA, SubmitRequest{
		ID: "unknown-computer-task", Scope: scope, ComputerID: "computer-unknown",
		Payload: taskPayloadForComputer(t, "unknown-computer-task", "computer-unknown"), CredentialIDs: []string{"github"},
	}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unknown Computer submit error = %v", err)
	}
	task, created, err := store.Submit(testPrincipalA, SubmitRequest{
		ID: "explicit-computer-task", Scope: scope, ComputerID: "computer-a",
		Payload: taskPayloadForComputer(t, "explicit-computer-task", "computer-a"), CredentialIDs: []string{"github"},
	})
	if err != nil || !created || task.ComputerID != "computer-a" {
		t.Fatalf("explicit Computer submit = %#v, %t, %v", task, created, err)
	}
	if _, err := store.RegisterNode("node-shadow", "generation-shadow-01"); err != nil {
		t.Fatal(err)
	}
	if leases, err := store.Claim("node-shadow", "generation-shadow-01", 1); err != nil || len(leases) != 0 {
		t.Fatalf("wrong Computer Node claimed Task: %#v, %v", leases, err)
	}
	if _, err := store.RegisterNode("node-legacy", "generation-legacy-01"); err != nil {
		t.Fatal(err)
	}
	if leases, err := store.Claim("node-legacy", "generation-legacy-01", 1); err != nil || len(leases) != 0 {
		t.Fatalf("legacy wildcard bypassed explicit Computer catalog: %#v, %v", leases, err)
	}
	if _, err := store.RegisterNode("node-a", "generation-node-a-1"); err != nil {
		t.Fatal(err)
	}
	computers, err = store.ListAgentComputers(scope)
	if err != nil || computers[0].State != NodeOnline || computers[0].ObservedState != ComputerObservedReady || computers[0].AssignedNodeID != "node-a" ||
		computers[1].State != NodeOnline || computers[1].ObservedState != ComputerObservedReady || computers[1].AssignedNodeID != "node-shadow" {
		t.Fatalf("online Computer catalog = %#v, %v", computers, err)
	}
	if leases, err := store.Claim("node-a", "generation-node-a-1", 1); err != nil || len(leases) != 1 || leases[0].Task.ID != task.ID || leases[0].Agent != "zapcode@1.12.0" {
		t.Fatalf("explicit Computer lease = %#v, %v", leases, err)
	}
	if cross, err := store.ListAgentComputers(Scope{TenantID: "beta", ProjectID: "build"}); err != nil || len(cross) != 0 {
		t.Fatalf("cross-tenant Computer catalog = %#v, %v", cross, err)
	}
}

func TestStoreComputerRuntimeSelectsAssignedNodeDeterministically(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 1, 30, 0, 0, time.UTC)}
	scope := Scope{TenantID: "acme", ProjectID: "weather"}
	computer := ComputerProvision{ID: "computer-a", TenantID: scope.TenantID, ProjectID: scope.ProjectID, Agent: "zapcode@1.12.0"}
	store, err := Open(t.TempDir(), []NodeProvision{
		{ID: "node-z", Capacity: 1, Scopes: []Scope{scope}, Computers: []ComputerProvision{computer}},
		{ID: "node-a", Capacity: 1, Scopes: []Scope{scope}, Computers: []ComputerProvision{computer}},
	}, Options{Now: clock.Now, Random: bytes.NewReader(bytes.Repeat([]byte{0x2b}, 1024))})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.RegisterNode("node-z", "generation-node-z-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterNode("node-a", "generation-node-a-1"); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 32; attempt++ {
		computers, err := store.ListAgentComputers(scope)
		if err != nil || len(computers) != 1 || computers[0].AssignedNodeID != "node-a" {
			t.Fatalf("attempt=%d deterministic Computer runtime=%#v err=%v", attempt, computers, err)
		}
	}
}

func TestStoreRejectsConflictingComputerAgentPlacements(t *testing.T) {
	provisions := []NodeProvision{
		{ID: "node-a", Capacity: 1, Scopes: []Scope{{TenantID: "acme", ProjectID: "weather"}}, Computers: []ComputerProvision{{ID: "computer-a", TenantID: "acme", ProjectID: "weather", Agent: "zapcode@1.12.0"}}},
		{ID: "node-b", Capacity: 1, Scopes: []Scope{{TenantID: "acme", ProjectID: "weather"}}, Computers: []ComputerProvision{{ID: "computer-a", TenantID: "acme", ProjectID: "weather", Agent: "zapcode@1.13.0"}}},
	}
	if _, err := Open(t.TempDir(), provisions, Options{}); err == nil {
		t.Fatal("Store accepted conflicting Computer Agent placements")
	}
}

func TestStoreNormalizesPayloadBeforeDigestAndRecovery(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 1, 30, 0, 0, time.UTC)}
	store, root := openTestStore(t, clock)
	payload := taskPayload(t, "task-pretty")
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, payload, "", "  "); err != nil {
		t.Fatal(err)
	}
	task, created, err := store.Submit(testPrincipalA, SubmitRequest{
		ID: "task-pretty", Scope: Scope{TenantID: "acme", ProjectID: "weather"},
		ComputerID: "computer-a", Payload: pretty.Bytes(), CredentialIDs: []string{"github"},
	})
	if err != nil || !created {
		t.Fatalf("submit pretty Task = %#v, %t, %v", task, created, err)
	}
	if bytes.Contains(task.Payload, []byte("\n")) {
		t.Fatalf("stored payload was not normalized: %q", task.Payload)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(root, testProvisions(), Options{Now: clock.Now})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, err := reopened.InspectTask(Scope{TenantID: "acme", ProjectID: "weather"}, "task-pretty"); err != nil {
		t.Fatal(err)
	}
}

func TestStoreMigratesLegacyPayloadDigest(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 1, 45, 0, 0, time.UTC)}
	store, root := openTestStore(t, clock)
	task := submitTask(t, store, testPrincipalA, "task-legacy", Scope{TenantID: "acme", ProjectID: "weather"})
	prettyPayload := append([]byte(" \n\t"), task.Payload...)
	legacyDigest := sha256.Sum256(prettyPayload)
	task.PayloadSHA256 = hex.EncodeToString(legacyDigest[:])
	store.state.Tasks[task.ID] = task
	store.state.SchemaVersion = 1
	if err := writeState(root, store.state); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(root, testProvisions(), Options{Now: clock.Now})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.state.SchemaVersion != stateSchemaVersion {
		t.Fatalf("state schema = %d, want %d", reopened.state.SchemaVersion, stateSchemaVersion)
	}
	recovered, err := reopened.InspectTask(Scope{TenantID: "acme", ProjectID: "weather"}, "task-legacy")
	if err != nil {
		t.Fatal(err)
	}
	expected := sha256.Sum256(recovered.Payload)
	if recovered.PayloadSHA256 != hex.EncodeToString(expected[:]) {
		t.Fatalf("migrated payload digest = %q", recovered.PayloadSHA256)
	}
}

func TestExplicitRepairRecoversCurrentSchemaPayloadDigestMismatch(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 1, 50, 0, 0, time.UTC)}
	store, root := openTestStore(t, clock)
	task := submitTask(t, store, testPrincipalA, "task-repair", Scope{TenantID: "acme", ProjectID: "weather"})
	task.PayloadSHA256 = strings.Repeat("0", 64)
	store.state.Tasks[task.ID] = task
	if err := writeState(root, store.state); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(root, testProvisions(), Options{Now: clock.Now}); err == nil {
		t.Fatal("normal store open accepted a mismatched payload digest")
	}
	repaired, err := RepairTaskPayloadDigests(root)
	if err != nil || repaired != 1 {
		t.Fatalf("repair = %d, %v", repaired, err)
	}
	reopened, err := Open(root, testProvisions(), Options{Now: clock.Now})
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
	repaired, err = RepairTaskPayloadDigests(root)
	if err != nil || repaired != 0 {
		t.Fatalf("idempotent repair = %d, %v", repaired, err)
	}
}

func TestStoreFairSchedulingLeaseExpiryAndFencing(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 2, 0, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	acme := Scope{TenantID: "acme", ProjectID: "weather"}
	beta := Scope{TenantID: "beta", ProjectID: "build"}
	submitTask(t, store, testPrincipalA, "task-a1", acme)
	clock.Advance(time.Millisecond)
	submitTask(t, store, testPrincipalA, "task-a2", acme)
	clock.Advance(time.Millisecond)
	submitTask(t, store, testPrincipalB, "task-b1", beta)
	if _, err := store.RegisterNode("node-shared", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	blocked, err := store.Claim("node-shared", "generation-00001", 1)
	if err != nil || len(blocked) != 0 {
		t.Fatalf("cross-tenant node received credential-bearing Task: %#v, %v", blocked, err)
	}
	// Fairness is exercised on a credential-free cross-tenant shared node.
	for id, task := range store.state.Tasks {
		task.CredentialIDs = nil
		var decoded daemonrpc.ComputerTaskSubmitRequest
		if err := json.Unmarshal(task.Payload, &decoded); err != nil {
			t.Fatal(err)
		}
		decoded.Command.CredentialIDs = nil
		task.Payload, _ = json.Marshal(decoded)
		digest := sha256.Sum256(task.Payload)
		task.PayloadSHA256 = hex.EncodeToString(digest[:])
		store.state.Tasks[id] = task
	}
	leasing, err := store.Claim("node-shared", "generation-00001", 2)
	if err != nil || len(leasing) != 2 || leasing[0].Task.ID != "task-a1" || leasing[1].Task.ID != "task-b1" {
		t.Fatalf("fair leases = %#v, %v", leasing, err)
	}
	old := leasing[0]
	clock.Advance(31 * time.Second)
	if err := store.Sweep(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterNode("node-shared", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	retry, err := store.Claim("node-shared", "generation-00001", 1)
	if err != nil || len(retry) != 1 || retry[0].Task.Attempt != 2 {
		t.Fatalf("retried lease = %#v, %v", retry, err)
	}
	if _, err := store.Acknowledge("node-shared", "generation-00001", old.Task.ID, old.LeaseToken); !errors.Is(err, ErrFenced) {
		t.Fatalf("old lease acknowledgement error = %v", err)
	}
	if _, err := store.RegisterNode("node-shared", "generation-00002"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Acknowledge("node-shared", "generation-00001", retry[0].Task.ID, retry[0].LeaseToken); !errors.Is(err, ErrFenced) {
		t.Fatalf("old generation acknowledgement error = %v", err)
	}
}

func TestStoreDrainAndAuditTamperFailClosed(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 3, 0, 0, 0, time.UTC)}
	store, root := openTestStore(t, clock)
	submitTask(t, store, testPrincipalA, "task-a", Scope{TenantID: "acme", ProjectID: "weather"})
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetNodeDraining("node-a", "generation-00001", true); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim("node-a", "generation-00001", 1); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("draining node claim error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "state.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	tampered := bytes.Replace(data, []byte(`"action":"task_submit"`), []byte(`"action":"task_cancel"`), 1)
	if bytes.Equal(data, tampered) {
		t.Fatal("test did not alter audit record")
	}
	if err := os.WriteFile(path, tampered, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(root, testProvisions(), Options{}); err == nil {
		t.Fatal("tampered central audit was accepted")
	}
}

func TestStoreNodeOperationalReportGatesAdmission(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 3, 30, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	submitTask(t, store, testPrincipalA, "task-operability", Scope{TenantID: "acme", ProjectID: "weather"})
	report := NodeReport{
		NodeVersion: "0.2.0", DaemonVersion: "0.2.0", ImageDigest: strings.Repeat("a", 64),
		DaemonState: DaemonUnreachable, FailureCode: "daemon_unreachable",
		StartAttempts: 4, StartFailures: 1, StartDurationMillisTotal: 4800, StartDurationMillisMax: 1600,
	}
	node, err := store.RegisterNodeWithReport("node-a", "generation-00001", report)
	if err != nil {
		t.Fatal(err)
	}
	if node.DaemonState != DaemonUnreachable || node.FailureCode != "daemon_unreachable" || node.ImageDigest != report.ImageDigest ||
		node.StartAttempts != 4 || node.StartFailures != 1 || node.StartDurationMillisTotal != 4800 || node.StartDurationMillisMax != 1600 {
		t.Fatalf("registered node report = %#v", node)
	}
	if _, err := store.Claim("node-a", "generation-00001", 1); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unhealthy node claim error = %v", err)
	}
	healthy := report
	healthy.DaemonState, healthy.FailureCode = DaemonHealthy, ""
	node, err = store.HeartbeatWithReport("node-a", "generation-00001", nil, healthy)
	if err != nil || node.DaemonState != DaemonHealthy || node.FailureCode != "" {
		t.Fatalf("healthy heartbeat = %#v, %v", node, err)
	}
	leases, err := store.Claim("node-a", "generation-00001", 1)
	if err != nil || len(leases) != 1 || leases[0].Task.ID != "task-operability" {
		t.Fatalf("healthy claim = %#v, %v", leases, err)
	}
	if _, err := store.HeartbeatWithReport("node-a", "generation-00001", nil, NodeReport{
		DaemonState: DaemonHealthy, FailureCode: "raw-host-error",
	}); err == nil {
		t.Fatal("healthy node report accepted a failure code")
	}
	if _, err := store.HeartbeatWithReport("node-a", "generation-00001", nil, NodeReport{
		DaemonState: DaemonHealthy, StartAttempts: 1, StartFailures: 2,
	}); err == nil {
		t.Fatal("node report accepted inconsistent VM start telemetry")
	}
	if _, err := store.HeartbeatWithReport("node-a", "generation-00001", nil, NodeReport{
		DaemonState:      DaemonHealthy,
		ComputerRuntimes: []ComputerRuntimeReport{{ID: "computer-a", State: "stopped"}, {ID: "computer-a", State: "running"}},
	}); err == nil {
		t.Fatal("node report accepted duplicate Computer runtimes")
	}
	if _, err := store.HeartbeatWithReport("node-a", "generation-00001", nil, NodeReport{
		DaemonState: DaemonHealthy, ComputerRuntimes: []ComputerRuntimeReport{{ID: "computer-a", State: "unknown"}},
	}); err == nil {
		t.Fatal("node report accepted an invalid Computer runtime state")
	}
}

func TestStoreRejectsConcurrentOwner(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 6, 0, 0, 0, time.UTC)}
	store, root := openTestStore(t, clock)
	if _, err := Open(root, testProvisions(), Options{}); err == nil {
		t.Fatal("second control-plane process acquired the same state root")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(root, testProvisions(), Options{})
	if err != nil {
		t.Fatalf("state root remained locked after close: %v", err)
	}
	_ = reopened.Close()
}
