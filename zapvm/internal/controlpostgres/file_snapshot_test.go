package controlpostgres

import (
	"encoding/json"
	"testing"
	"time"

	"zapvm/internal/cloudplane"
	"zapvm/internal/daemonrpc"
)

func TestResidentAgentSessionIDExcludesOrdinaryCommandSessions(t *testing.T) {
	ordinary := daemonrpc.ComputerTaskSubmitRequest{Command: daemonrpc.Command{
		SessionID: "shared-command-session", Argv: []string{"sh", "-lc", "echo ok"},
	}}
	if sessionID := residentAgentSessionID(ordinary); sessionID != "" {
		t.Fatalf("ordinary command projected as Agent Session %q", sessionID)
	}
	resident := daemonrpc.ComputerTaskSubmitRequest{Command: daemonrpc.Command{
		SessionID: "resident-session", Argv: []string{residentAgentCommand, "--", "prompt"},
	}}
	if sessionID := residentAgentSessionID(resident); sessionID != "resident-session" {
		t.Fatalf("Resident Agent Session ID=%q", sessionID)
	}
}

func TestFileSnapshotAllowsOrdinarySessionIDAcrossComputers(t *testing.T) {
	provisions := []cloudplane.NodeProvision{{
		ID: "node-session-import", Capacity: 2,
		Scopes: []cloudplane.Scope{{TenantID: "acme", ProjectID: "sessions"}},
		Computers: []cloudplane.ComputerProvision{
			{ID: "computer-a", TenantID: "acme", ProjectID: "sessions"},
			{ID: "computer-b", TenantID: "acme", ProjectID: "sessions"},
		},
	}}
	store, err := cloudplane.Open(t.TempDir(), provisions, cloudplane.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	scope := cloudplane.Scope{TenantID: "acme", ProjectID: "sessions"}
	principal := "spiffe://example.test/tenant/acme/project/sessions/client/import"
	for _, computerID := range []string{"computer-a", "computer-b"} {
		taskID := "task-" + computerID
		payload, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
			ID: taskID, ComputerID: computerID,
			Command: daemonrpc.Command{ID: "command-" + computerID, SessionID: "shared-command-session", Argv: []string{"echo", computerID}, TimeoutMillis: 60000},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, created, err := store.Submit(principal, cloudplane.SubmitRequest{ID: taskID, Scope: scope, ComputerID: computerID, Payload: payload}); err != nil || !created {
			t.Fatalf("submit ordinary command for %s created=%t err=%v", computerID, created, err)
		}
	}
	snapshot, err := store.OfflineSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	projection, _, err := buildSnapshotProjection(snapshot)
	if err != nil {
		t.Fatalf("project ordinary shared SessionID: %v", err)
	}
	for _, table := range projection.tables {
		switch table.name {
		case "agent_sessions":
			if len(table.rows) != 0 {
				t.Fatalf("ordinary commands created Agent Sessions: %#v", table.rows)
			}
		case "tasks":
			if len(table.rows) != 2 || table.rows[0][4] != nil || table.rows[1][4] != nil {
				t.Fatalf("ordinary command Task Session projection=%#v", table.rows)
			}
		}
	}
}

func TestProjectComputersPreservesMultiNodeAndLegacyScopeScheduling(t *testing.T) {
	createdAt := time.Date(2026, 8, 8, 3, 4, 5, 0, time.UTC).Format(time.RFC3339Nano)
	state := snapshotState{
		Nodes: map[string]cloudplane.Node{
			"node-a": {ID: "node-a"}, "node-b": {ID: "node-b"},
			"node-c": {ID: "node-c"}, "node-d": {ID: "node-d"},
		},
		Tasks: map[string]cloudplane.Task{
			"legacy-task": {TenantID: "acme", ProjectID: "legacy", ComputerID: "legacy-computer", CreatedAt: createdAt},
		},
		WorkspaceOperations: map[string]cloudplane.WorkspaceOperation{}, Artifacts: map[string]cloudplane.Artifact{},
	}
	provisions := []cloudplane.NodeProvision{
		{ID: "node-a", Capacity: 1, Scopes: []cloudplane.Scope{{TenantID: "acme", ProjectID: "explicit"}}, Computers: []cloudplane.ComputerProvision{{ID: "shared-computer", TenantID: "acme", ProjectID: "explicit"}}},
		{ID: "node-b", Capacity: 1, Scopes: []cloudplane.Scope{{TenantID: "acme", ProjectID: "explicit"}}, Computers: []cloudplane.ComputerProvision{{ID: "shared-computer", TenantID: "acme", ProjectID: "explicit"}}},
		{ID: "node-c", Capacity: 1, Scopes: []cloudplane.Scope{{TenantID: "acme", ProjectID: "legacy"}}},
		{ID: "node-d", Capacity: 1, Scopes: []cloudplane.Scope{{TenantID: "acme", ProjectID: "legacy"}}},
		{ID: "node-offline", Capacity: 1, Scopes: []cloudplane.Scope{{TenantID: "acme", ProjectID: "explicit"}}, Computers: []cloudplane.ComputerProvision{{ID: "offline-computer", TenantID: "acme", ProjectID: "explicit"}}},
	}
	computers, err := projectComputers(state, provisions)
	if err != nil {
		t.Fatal(err)
	}
	shared := computers[scopeKey("acme", "explicit")+"\x00shared-computer"]
	if shared == nil || len(shared.nodes) != 2 {
		t.Fatalf("shared Computer projection=%#v", shared)
	}
	legacy := computers[scopeKey("acme", "legacy")+"\x00legacy-computer"]
	if legacy == nil || len(legacy.nodes) != 2 {
		t.Fatalf("legacy Computer projection=%#v", legacy)
	}
	offline := computers[scopeKey("acme", "explicit")+"\x00offline-computer"]
	if offline == nil || len(offline.nodes) != 0 {
		t.Fatalf("offline Computer projection=%#v", offline)
	}
}
