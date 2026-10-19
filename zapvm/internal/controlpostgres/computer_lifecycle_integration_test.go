package controlpostgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"zapvm/internal/cloudplane"
)

func TestPostgreSQLComputerAdminLifecycleIntegration(t *testing.T) {
	dsn := os.Getenv("ZAPVM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAPVM_TEST_POSTGRES_DSN is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
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
			t.Errorf("reset PostgreSQL Computer lifecycle state: %v", err)
		}
	}()

	now := time.Date(2026, 8, 15, 7, 0, 0, 0, time.UTC)
	queue, err := NewQueue(migrator, QueueOptions{
		HeartbeatTTL: 10 * time.Minute, LeaseTTL: 10 * time.Minute,
		DispatchTimeout: 2 * time.Minute, PlacementMode: cloudplane.PlacementModeDynamic,
		ComputerStartTimeout: 30 * time.Second, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	scope := cloudplane.Scope{TenantID: "acme", ProjectID: "admin"}
	computer := cloudplane.ComputerProvision{ID: "computer-admin", TenantID: scope.TenantID, ProjectID: scope.ProjectID}
	if err := queue.ReconcileProvisions(ctx, []cloudplane.NodeProvision{{
		ID: "node-admin", Capacity: 1, Scopes: []cloudplane.Scope{scope}, Computers: []cloudplane.ComputerProvision{computer},
	}}); err != nil {
		t.Fatal(err)
	}
	const nodeID = "node-admin"
	const generation = "generation-admin-0001"
	const principal = "spiffe://example.test/tenant/acme/project/admin/client/web"
	if _, err := queue.RegisterNodeWithReport(ctx, nodeID, generation, cloudplane.NodeReport{DaemonState: cloudplane.DaemonHealthy}); err != nil {
		t.Fatal(err)
	}

	wake, err := queue.RequestAgentComputerLifecycle(ctx, principal, scope, computer.ID, cloudplane.ComputerLifecycleWake)
	if err != nil || !wake.Accepted || wake.Action != cloudplane.ComputerLifecycleWake || wake.OperationID == "" {
		t.Fatalf("wake Computer=%#v err=%v", wake, err)
	}
	starts, err := queue.ClaimComputerOperations(ctx, nodeID, generation, 1)
	if err != nil || len(starts) != 1 || starts[0].Operation.Kind != cloudplane.ComputerOperationStart || starts[0].Operation.ID != wake.OperationID {
		t.Fatalf("claim Computer start=%#v err=%v", starts, err)
	}
	if _, err := queue.CompleteComputerOperation(ctx, nodeID, generation, starts[0].Operation.ID, starts[0].LeaseToken, cloudplane.ComputerOperationCompletion{Succeeded: true}); err != nil {
		t.Fatal(err)
	}

	release, err := queue.RequestAgentComputerLifecycle(ctx, principal, scope, computer.ID, cloudplane.ComputerLifecycleRelease)
	if err != nil || !release.Accepted || release.Action != cloudplane.ComputerLifecycleRelease || release.OperationID == "" {
		t.Fatalf("release Computer=%#v err=%v", release, err)
	}
	replayed, err := queue.RequestAgentComputerLifecycle(ctx, principal, scope, computer.ID, cloudplane.ComputerLifecycleRelease)
	if err != nil || !replayed.Accepted || replayed.OperationID != release.OperationID {
		t.Fatalf("idempotent Computer release=%#v err=%v", replayed, err)
	}
	if _, err := queue.RequestAgentComputerLifecycle(ctx, principal, scope, computer.ID, cloudplane.ComputerLifecycleWake); !errors.Is(err, cloudplane.ErrConflict) {
		t.Fatalf("wake during Computer release error=%v", err)
	}
	// The only VM slot is occupied by the running Computer. Stop operations
	// must still be claimable because they release capacity.
	stops, err := queue.ClaimComputerOperations(ctx, nodeID, generation, 1)
	if err != nil || len(stops) != 1 || stops[0].Operation.Kind != cloudplane.ComputerOperationStop || stops[0].Operation.ID != release.OperationID {
		t.Fatalf("claim Computer stop=%#v err=%v", stops, err)
	}
	if _, err := queue.CompleteComputerOperation(ctx, nodeID, generation, stops[0].Operation.ID, stops[0].LeaseToken, cloudplane.ComputerOperationCompletion{Succeeded: true}); err != nil {
		t.Fatal(err)
	}
	computers, err := queue.ListAgentComputers(ctx, scope)
	if err != nil || len(computers) != 1 || computers[0].ObservedState != cloudplane.ComputerObservedUnavailable || computers[0].AssignedNodeID != "" || computers[0].State != cloudplane.NodeOnline {
		t.Fatalf("released Computer inventory=%#v err=%v", computers, err)
	}

	rewake, err := queue.RequestAgentComputerLifecycle(ctx, principal, scope, computer.ID, cloudplane.ComputerLifecycleWake)
	if err != nil || !rewake.Accepted || rewake.OperationID == "" || rewake.OperationID == wake.OperationID {
		t.Fatalf("rewake Computer=%#v err=%v", rewake, err)
	}
}
