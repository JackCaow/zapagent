package controlpostgres

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"

	"zapvm/internal/cloudplane"
	"zapvm/internal/daemonrpc"
)

func TestPostgreSQLBackendMultiReplicaEventRecoveryIntegration(t *testing.T) {
	dsn := os.Getenv("ZAPVM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAPVM_TEST_POSTGRES_DSN is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	migratorA, err := Open(ctx, dsn, OpenOptions{AllowInsecureLocalhost: true})
	if err != nil {
		t.Fatal(err)
	}
	migratorAClosed := false
	defer func() {
		if !migratorAClosed {
			migratorA.Close()
		}
	}()
	if _, err := migratorA.Apply(ctx); err != nil {
		t.Fatal(err)
	}
	migratorB, err := Open(ctx, dsn, OpenOptions{AllowInsecureLocalhost: true})
	if err != nil {
		t.Fatal(err)
	}
	defer migratorB.Close()
	if err := resetQueueIntegrationState(ctx, migratorA); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := resetQueueIntegrationState(context.Background(), migratorB); err != nil {
			t.Errorf("reset PostgreSQL Backend integration state: %v", err)
		}
	}()

	provisions := []cloudplane.NodeProvision{{
		ID: "node-backend", Capacity: 2,
		Scopes:    []cloudplane.Scope{{TenantID: "acme", ProjectID: "backend"}},
		Computers: []cloudplane.ComputerProvision{{ID: "computer-backend", TenantID: "acme", ProjectID: "backend"}},
	}}
	now := time.Date(2026, 8, 8, 10, 0, 0, 0, time.UTC)
	options := BackendOptions{
		OperationTimeout: 5 * time.Second, Provisions: provisions,
		Queue: QueueOptions{LeaseTTL: 30 * time.Second, Now: func() time.Time { return now }},
	}
	replicaA, err := NewBackend(ctx, migratorA, options)
	if err != nil {
		t.Fatal(err)
	}
	replicaB, err := NewBackend(ctx, migratorB, options)
	if err != nil {
		t.Fatal(err)
	}
	if err := replicaA.Ready(); err != nil {
		t.Fatal(err)
	}
	const generation = "generation-backend-0001"
	if _, err := replicaA.RegisterNodeWithReport("node-backend", generation, cloudplane.NodeReport{DaemonState: cloudplane.DaemonHealthy}); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
		ID: "task-backend", ComputerID: "computer-backend",
		Command: daemonrpc.Command{ID: "command-backend", SessionID: "session-backend", Argv: []string{"echo", "backend"}, TimeoutMillis: 60000},
	})
	if err != nil {
		t.Fatal(err)
	}
	principal := "spiffe://example.test/tenant/acme/project/backend/client/integration"
	task, created, err := replicaA.Submit(principal, cloudplane.SubmitRequest{
		ID: "task-backend", Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "backend"}, ComputerID: "computer-backend", Payload: payload,
	})
	if err != nil || !created {
		t.Fatalf("submit through replica A=%#v created=%t err=%v", task, created, err)
	}
	leases, err := replicaB.Claim("node-backend", generation, 1)
	if err != nil || len(leases) != 1 || leases[0].Task.ID != task.ID {
		t.Fatalf("claim through replica B=%#v err=%v", leases, err)
	}
	if _, err := replicaA.Acknowledge("node-backend", generation, task.ID, leases[0].LeaseToken); err != nil {
		t.Fatal(err)
	}
	type waitResult struct {
		task   cloudplane.Task
		events []cloudplane.TaskEvent
		err    error
	}
	waitContext, waitCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer waitCancel()
	waited := make(chan waitResult, 1)
	go func() {
		observedTask, events, err := replicaA.WaitTaskEvents(waitContext, task.Scope(), task.ID, 0, 10)
		waited <- waitResult{task: observedTask, events: events, err: err}
	}()
	time.Sleep(100 * time.Millisecond)
	event, created, err := replicaB.AppendTaskEvent("node-backend", generation, task.ID, leases[0].LeaseToken, daemonrpc.ComputerTaskEvent{
		Cursor: 1, Timestamp: now.Add(time.Second).Format(time.RFC3339Nano), TaskID: task.ID,
		Type: "command.stdout", CommandID: "command-backend", Stream: "stdout", Data: []byte("replica-event\n"),
	})
	if err != nil || !created || event.Cursor != 1 {
		t.Fatalf("append through replica B=%#v created=%t err=%v", event, created, err)
	}
	select {
	case result := <-waited:
		if result.err != nil || result.task.ID != task.ID || len(result.events) != 1 || string(result.events[0].Data) != "replica-event\n" {
			t.Fatalf("replica A wait=%#v events=%#v err=%v", result.task, result.events, result.err)
		}
	case <-waitContext.Done():
		t.Fatal("replica A did not observe replica B event")
	}
	if completed, err := replicaA.Complete("node-backend", generation, task.ID, leases[0].LeaseToken, cloudplane.Completion{Succeeded: true}); err != nil || completed.State != cloudplane.TaskSucceeded {
		t.Fatalf("complete through replica A=%#v err=%v", completed, err)
	}
	computers, err := replicaB.ListAgentComputers(task.Scope())
	if err != nil || len(computers) != 1 || computers[0].ID != "computer-backend" || computers[0].State != cloudplane.NodeOnline {
		t.Fatalf("replica B Computers=%#v err=%v", computers, err)
	}
	if snapshot := replicaA.OperationalSnapshot(); !snapshot.Ready || snapshot.TasksByState[cloudplane.TaskSucceeded] != 1 || snapshot.NodesByState[cloudplane.NodeOnline] != 1 {
		t.Fatalf("PostgreSQL operational snapshot=%#v", snapshot)
	}
	migratorA.Close()
	migratorAClosed = true
	if err := replicaA.Ready(); err == nil {
		t.Fatal("terminated replica A remained ready")
	}
	secondPayload, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
		ID: "task-backend-sweep", ComputerID: "computer-backend",
		Command: daemonrpc.Command{ID: "command-backend-sweep", SessionID: "session-backend-sweep", Argv: []string{"echo", "sweep"}, TimeoutMillis: 60000},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, created, err := replicaB.Submit(principal, cloudplane.SubmitRequest{
		ID: "task-backend-sweep", Scope: task.Scope(), ComputerID: "computer-backend", Payload: secondPayload,
	})
	if err != nil || !created {
		t.Fatalf("submit sweep Task=%#v created=%t err=%v", second, created, err)
	}
	secondLease, err := replicaB.Claim("node-backend", generation, 1)
	if err != nil || len(secondLease) != 1 || secondLease[0].Task.ID != second.ID {
		t.Fatalf("claim sweep Task=%#v err=%v", secondLease, err)
	}
	migratorC, err := Open(ctx, dsn, OpenOptions{AllowInsecureLocalhost: true})
	if err != nil {
		t.Fatal(err)
	}
	defer migratorC.Close()
	replicaC, err := NewBackend(ctx, migratorC, options)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(46 * time.Second)
	if err := replicaC.Sweep(); err != nil {
		t.Fatal(err)
	}
	requeued, err := replicaC.InspectTask(second.Scope(), second.ID)
	if err != nil || requeued.State != cloudplane.TaskPending || requeued.NodeID != "" {
		t.Fatalf("swept Task=%#v err=%v", requeued, err)
	}
	nodes := replicaB.ListNodes()
	if len(nodes) != 1 || nodes[0].State != cloudplane.NodeOffline || nodes[0].InFlight != 0 {
		t.Fatalf("swept Nodes=%#v", nodes)
	}
	if container := os.Getenv("ZAPVM_TEST_POSTGRES_CONTAINER"); container != "" {
		if output, err := exec.Command("docker", "pause", container).CombinedOutput(); err != nil {
			t.Fatalf("pause PostgreSQL container: %v output=%s", err, output)
		}
		paused := true
		defer func() {
			if paused {
				_ = exec.Command("docker", "unpause", container).Run()
			}
		}()
		if err := replicaB.Ready(); err == nil {
			t.Fatal("PostgreSQL Backend remained ready while the database was paused")
		}
		if output, err := exec.Command("docker", "unpause", container).CombinedOutput(); err != nil {
			t.Fatalf("unpause PostgreSQL container: %v output=%s", err, output)
		}
		paused = false
		deadline := time.Now().Add(10 * time.Second)
		for {
			if err := replicaB.Ready(); err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("PostgreSQL Backend did not recover after database unpause")
			}
			time.Sleep(100 * time.Millisecond)
		}
		persisted, err := replicaB.InspectTask(second.Scope(), second.ID)
		if err != nil || persisted.State != cloudplane.TaskPending {
			t.Fatalf("Task state after PostgreSQL recovery=%#v err=%v", persisted, err)
		}
	}
}

func TestPostgreSQLBackendReconcilesTrackedLegacyComputersIntegration(t *testing.T) {
	dsn := os.Getenv("ZAPVM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAPVM_TEST_POSTGRES_DSN is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	migrator, err := Open(ctx, dsn, OpenOptions{AllowInsecureLocalhost: true})
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	if _, err := migrator.Apply(ctx); err != nil {
		t.Fatal(err)
	}
	if err := resetQueueIntegrationState(ctx, migrator); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := resetQueueIntegrationState(context.Background(), migrator); err != nil {
			t.Errorf("reset legacy Computer integration state: %v", err)
		}
	}()

	provisions := []cloudplane.NodeProvision{{
		ID: "node-legacy", Capacity: 2,
		Scopes: []cloudplane.Scope{{TenantID: "acme", ProjectID: "legacy"}},
	}}
	store, err := cloudplane.Open(t.TempDir(), provisions, cloudplane.Options{})
	if err != nil {
		t.Fatal(err)
	}
	scope := cloudplane.Scope{TenantID: "acme", ProjectID: "legacy"}
	principal := "spiffe://example.test/tenant/acme/project/legacy/client/integration"
	for _, computerID := range []string{"computer-a", "computer-b"} {
		taskID := "task-legacy-" + computerID
		payload, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
			ID: taskID, ComputerID: computerID,
			Command: daemonrpc.Command{ID: "command-" + computerID, SessionID: "shared-command-session", Argv: []string{"echo", computerID}, TimeoutMillis: 60000},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, created, err := store.Submit(principal, cloudplane.SubmitRequest{ID: taskID, Scope: scope, ComputerID: computerID, Payload: payload}); err != nil || !created {
			t.Fatalf("submit legacy Computer %s created=%t err=%v", computerID, created, err)
		}
	}
	snapshot, err := store.OfflineSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := migrator.CommitPrimarySnapshot(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	backend, err := NewBackend(ctx, migrator, BackendOptions{OperationTimeout: 5 * time.Second, Provisions: provisions})
	if err != nil {
		t.Fatalf("open Backend over tracked legacy Computers: %v", err)
	}
	computers, err := backend.ListAgentComputers(scope)
	if err != nil || len(computers) != 2 || computers[0].ID != "computer-a" || computers[1].ID != "computer-b" {
		t.Fatalf("legacy Computers=%#v err=%v", computers, err)
	}

	transaction, err := migrator.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()
	if _, err := transaction.Exec(ctx, `SELECT set_config('zapvm.bypass_rls','on',true)`); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `INSERT INTO zapvm.computers (tenant_id,project_id,computer_id,created_at) VALUES ('acme','legacy','computer-untracked',clock_timestamp())`); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `INSERT INTO zapvm.computer_nodes (tenant_id,project_id,computer_id,node_id) VALUES ('acme','legacy','computer-untracked','node-legacy')`); err != nil {
		t.Fatal(err)
	}
	if err := transaction.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := NewBackend(ctx, migrator, BackendOptions{OperationTimeout: 5 * time.Second, Provisions: provisions}); err == nil {
		t.Fatal("untracked legacy Computer authority was accepted")
	}
}
