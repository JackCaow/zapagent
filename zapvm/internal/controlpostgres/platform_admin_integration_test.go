package controlpostgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"zapvm/internal/cloudplane"
	"zapvm/internal/daemonrpc"
)

func TestPostgreSQLPlatformAdminFoundationIntegration(t *testing.T) {
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
			t.Errorf("reset Platform Admin state: %v", err)
		}
	}()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	queue, err := NewQueue(migrator, QueueOptions{PlacementMode: cloudplane.PlacementModeDynamic, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	scope := cloudplane.Scope{TenantID: "acme", ProjectID: "platform"}
	principal := "spiffe://example.test/tenant/acme/project/platform/client/web"
	provisions := []cloudplane.NodeProvision{{ID: "node-platform", Capacity: 4, Scopes: []cloudplane.Scope{scope}}}
	if err := queue.ReconcileProvisions(ctx, provisions); err != nil {
		t.Fatal(err)
	}
	owner, err := queue.EnsureWorkspaceOwner(ctx, principal, scope, "workspace-owner", "Workspace Owner", "owner@example.test")
	if err != nil || owner.Role != cloudplane.RoleOwner {
		t.Fatalf("owner=%#v err=%v", owner, err)
	}
	owner.Role = cloudplane.RoleAdmin
	if _, err := queue.PutWorkspaceMember(ctx, principal, scope, owner); !errors.Is(err, cloudplane.ErrConflict) {
		t.Fatalf("last active owner demotion error=%v", err)
	}
	owner.Role = cloudplane.RoleOwner
	if _, err := queue.PutWorkspaceMember(ctx, principal, scope, cloudplane.WorkspaceMember{UserID: "backup-owner", Role: cloudplane.RoleOwner, Status: "active"}); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.PutWorkspaceMember(ctx, principal, scope, cloudplane.WorkspaceMember{UserID: "backup-owner", Role: cloudplane.RoleAdmin, Status: "active"}); err != nil {
		t.Fatalf("demote owner while another active owner exists: %v", err)
	}
	if _, err := queue.PutWorkspaceMember(ctx, principal, scope, cloudplane.WorkspaceMember{UserID: "operator", Role: cloudplane.RoleOperator, Status: "active"}); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.PutWorkspaceMember(ctx, principal, scope, cloudplane.WorkspaceMember{UserID: "retired-owner", Role: cloudplane.RoleOwner, Status: "suspended"}); err != nil {
		t.Fatal(err)
	}
	if err := queue.DeleteWorkspaceMember(ctx, principal, scope, "retired-owner"); err != nil {
		t.Fatalf("delete suspended owner while retaining active owner: %v", err)
	}
	members, err := queue.ListWorkspaceMembers(ctx, scope)
	if err != nil || len(members) != 3 {
		t.Fatalf("members=%#v err=%v", members, err)
	}
	pool, err := queue.PutHostPool(ctx, principal, scope, cloudplane.HostPool{ID: "default", DisplayName: "Default Pool", Region: "jp-east", Enabled: true, MaxComputers: 1, NodeIDs: []string{"node-platform"}})
	if err != nil || len(pool.NodeIDs) != 1 {
		t.Fatalf("pool=%#v err=%v", pool, err)
	}
	model, err := queue.PutModelProfile(ctx, principal, scope, cloudplane.ModelProfile{ID: "gpt", DisplayName: "GPT", ProviderURL: "https://api.example.test/v1", ProviderModel: "gpt-test", CredentialID: "model-key", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := queue.PutAgentProfile(ctx, principal, scope, cloudplane.AgentProfile{ID: "zapcode", DisplayName: "ZapCode", RuntimeRef: "zapcode@1.0.0", ModelID: model.ID, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	profile, err := queue.CreateComputerProfile(ctx, principal, scope, cloudplane.ComputerProfile{ID: "computer-self", DisplayName: "Self Service", PoolID: pool.ID, AgentID: agent.ID, VCPU: 2, MemoryBytes: 4 << 30, CreatedBy: owner.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if profile.CreatedAt == "" {
		t.Fatal("Computer profile lacks timestamps")
	}
	secondProfile := cloudplane.ComputerProfile{ID: "computer-second", DisplayName: "Second Computer", PoolID: pool.ID, AgentID: agent.ID, VCPU: 1, MemoryBytes: 2 << 30, CreatedBy: owner.UserID}
	if _, err := queue.CreateComputerProfile(ctx, principal, scope, secondProfile); !errors.Is(err, cloudplane.ErrQuotaReached) {
		t.Fatalf("Host Pool capacity error=%v", err)
	}
	pool.MaxComputers = 3
	if _, err := queue.PutHostPool(ctx, principal, scope, pool); err != nil {
		t.Fatalf("increase Host Pool capacity: %v", err)
	}
	if err := queue.ReconcileProvisions(ctx, provisions); err != nil {
		t.Fatalf("self-service Computer broke config reconciliation: %v", err)
	}
	usage, err := queue.GetWorkspaceUsage(ctx, scope)
	if err != nil || usage.ComputerCount != 1 {
		t.Fatalf("usage=%#v err=%v", usage, err)
	}
	quota, err := queue.PutWorkspaceQuota(ctx, principal, scope, cloudplane.WorkspaceQuota{MaxComputers: 2, MaxConcurrentTasks: 1, MonthlyTaskSeconds: 3600, ArtifactBytes: 5 << 30})
	if err != nil || quota.MaxComputers != 2 {
		t.Fatalf("quota=%#v err=%v", quota, err)
	}
	if _, err := queue.CreateComputerProfile(ctx, principal, scope, secondProfile); err != nil {
		t.Fatalf("create second Computer after increasing capacity: %v", err)
	}
	thirdProfile := secondProfile
	thirdProfile.ID = "computer-third"
	thirdProfile.DisplayName = "Third Computer"
	if _, err := queue.CreateComputerProfile(ctx, principal, scope, thirdProfile); !errors.Is(err, cloudplane.ErrQuotaReached) {
		t.Fatalf("Workspace Computer quota error=%v", err)
	}
	resolved, err := queue.ResolveComputerRuntime(ctx, scope, profile.ID)
	if err != nil || resolved.AgentID != agent.ID || resolved.Model != model.ProviderModel || resolved.ModelCredentialID != model.CredentialID {
		t.Fatalf("runtime=%#v err=%v", resolved, err)
	}
	const generation = "generation-platform-0001"
	if _, err := queue.RegisterNodeWithReport(ctx, "node-platform", generation, cloudplane.NodeReport{DaemonState: cloudplane.DaemonHealthy}); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
		ID: "task-platform-one", ComputerID: profile.ID,
		Command: daemonrpc.Command{ID: "command-platform-one", SessionID: "session-platform", Argv: []string{"echo", "one"}, TimeoutMillis: 60000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, created, err := queue.Submit(ctx, principal, cloudplane.SubmitRequest{ID: "task-platform-one", Scope: scope, ComputerID: profile.ID, Payload: payload}); err != nil || !created {
		t.Fatalf("first quota Task created=%t err=%v", created, err)
	}
	operations, err := queue.ClaimComputerOperations(ctx, "node-platform", generation, 1)
	if err != nil || len(operations) != 1 || operations[0].Provision == nil || operations[0].Provision.Agent != agent.RuntimeRef || operations[0].Provision.CPUCount != 2 || operations[0].Provision.MemoryMiB != 4096 {
		t.Fatalf("Computer provision leases=%#v err=%v", operations, err)
	}
	payload, err = json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
		ID: "task-platform-two", ComputerID: profile.ID,
		Command: daemonrpc.Command{ID: "command-platform-two", SessionID: "session-platform-two", Argv: []string{"echo", "two"}, TimeoutMillis: 60000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := queue.Submit(ctx, principal, cloudplane.SubmitRequest{ID: "task-platform-two", Scope: scope, ComputerID: profile.ID, Payload: payload}); !errors.Is(err, cloudplane.ErrQuotaReached) {
		t.Fatalf("second quota Task error=%v", err)
	}
	if err := queue.DeleteWorkspaceMember(ctx, principal, scope, owner.UserID); err != cloudplane.ErrConflict {
		t.Fatalf("last owner deletion error=%v", err)
	}
}
