package cloudplane

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"zapvm/internal/daemonrpc"
)

func openWorkspaceOperationStore(t *testing.T, clock *testClock) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	randomData := make([]byte, 4096)
	for index := range randomData {
		randomData[index] = byte(index)
	}
	provisions := []NodeProvision{
		{ID: "node-a", Capacity: 4, Scopes: []Scope{{TenantID: "acme", ProjectID: "weather"}}, Computers: []ComputerProvision{{ID: "computer-a", TenantID: "acme", ProjectID: "weather"}}},
		{ID: "node-b", Capacity: 4, Scopes: []Scope{{TenantID: "beta", ProjectID: "build"}}, Computers: []ComputerProvision{{ID: "computer-b", TenantID: "beta", ProjectID: "build"}}},
	}
	store, err := Open(root, provisions, Options{Now: clock.Now, Random: bytes.NewReader(randomData), HeartbeatTTL: 20 * time.Second, LeaseTTL: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, root
}

func TestWorkspaceOperationStoreIsolationLeaseCompletionAndExpiry(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 7, 0, 0, 0, time.UTC)}
	store, _ := openWorkspaceOperationStore(t, clock)
	acme := Scope{TenantID: "acme", ProjectID: "weather"}
	beta := Scope{TenantID: "beta", ProjectID: "build"}
	request := WorkspaceOperationRequest{ID: "workspace-op-a", Scope: acme, ComputerID: "computer-a", Kind: WorkspaceOperationList}
	created, fresh, err := store.SubmitWorkspaceOperation(testPrincipalA, request)
	if err != nil || !fresh || created.State != WorkspaceOperationPending {
		t.Fatalf("submit = %#v, %t, %v", created, fresh, err)
	}
	duplicate, fresh, err := store.SubmitWorkspaceOperation(testPrincipalA, request)
	if err != nil || fresh || duplicate.ID != created.ID {
		t.Fatalf("idempotent submit = %#v, %t, %v", duplicate, fresh, err)
	}
	if _, err := store.InspectWorkspaceOperation(beta, created.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-scope inspect = %v", err)
	}
	if _, _, err := store.SubmitWorkspaceOperation(testPrincipalA, WorkspaceOperationRequest{ID: "unsafe", Scope: acme, ComputerID: "computer-a", Kind: WorkspaceOperationRead, Path: ".git/config"}); err == nil {
		t.Fatal("protected workspace path was accepted")
	}
	if _, _, err := store.SubmitWorkspaceOperation(testPrincipalA, WorkspaceOperationRequest{ID: "unprovisioned", Scope: acme, ComputerID: "other", Kind: WorkspaceOperationList}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unprovisioned Computer error = %v", err)
	}
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterNode("node-b", "generation-00002"); err != nil {
		t.Fatal(err)
	}
	wrong, err := store.ClaimWorkspaceOperations("node-b", "generation-00002", 1)
	if err != nil || len(wrong) != 0 {
		t.Fatalf("cross-scope claim = %#v, %v", wrong, err)
	}
	leases, err := store.ClaimWorkspaceOperations("node-a", "generation-00001", 1)
	if err != nil || len(leases) != 1 || leases[0].Operation.ID != created.ID || leases[0].LeaseToken == "" {
		t.Fatalf("claim = %#v, %v", leases, err)
	}
	lease := leases[0]
	result, err := json.Marshal(daemonrpc.WorkspaceListing{Entries: []daemonrpc.WorkspaceEntry{{Path: "README.md", Name: "README.md", Type: "file", Size: 4, ModifiedAt: clock.Now().Format(time.RFC3339Nano)}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteWorkspaceOperation("node-a", "generation-00001", created.ID, "wrong-token", WorkspaceOperationCompletion{Succeeded: true, Result: result}); !errors.Is(err, ErrFenced) {
		t.Fatalf("wrong-token completion = %v", err)
	}
	completed, err := store.CompleteWorkspaceOperation("node-a", "generation-00001", created.ID, lease.LeaseToken, WorkspaceOperationCompletion{Succeeded: true, Result: result})
	if err != nil || completed.State != WorkspaceOperationSucceeded || len(completed.Result) == 0 || completed.NodeID != "" || len(completed.ResultSHA256) != 64 {
		t.Fatalf("complete = %#v, %v", completed, err)
	}

	clock.Advance(workspaceOperationRetention)
	if err := store.Sweep(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.InspectWorkspaceOperation(acme, created.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("retained operation was not pruned: %v", err)
	}
}

func TestWorkspaceOperationAPIEndToEndAndRedaction(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 7, 30, 0, 0, time.UTC)}
	store, _ := openWorkspaceOperationStore(t, clock)
	api, err := NewAPI(store, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	create := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/computers/computer-a/workspace/operations", testPrincipalA, map[string]any{
		"id": "workspace-api-op", "kind": "read", "path": "README.md",
	}))
	if create.Code != http.StatusAccepted || strings.Contains(create.Body.String(), "tenant_id") || strings.Contains(create.Body.String(), "node_id") {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	nodePrincipal := "spiffe://example.test/node/node-a"
	register := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/register", nodePrincipal, map[string]any{"generation": "generation-00001"}))
	if register.Code != http.StatusOK {
		t.Fatalf("register status=%d body=%s", register.Code, register.Body.String())
	}
	claim := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/workspace/claim", nodePrincipal, map[string]any{"generation": "generation-00001", "maximum": 1}))
	var claimed struct {
		Leases []WorkspaceOperationLease `json:"leases"`
	}
	if claim.Code != http.StatusOK || json.Unmarshal(claim.Body.Bytes(), &claimed) != nil || len(claimed.Leases) != 1 || strings.Contains(claim.Body.String(), "lease_token_hash") {
		t.Fatalf("claim status=%d body=%s", claim.Code, claim.Body.String())
	}
	data := []byte("hello\n")
	digest := digestHex(data)
	complete := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/workspace/operations/workspace-api-op/complete", nodePrincipal, map[string]any{
		"generation": "generation-00001", "lease_token": claimed.Leases[0].LeaseToken, "succeeded": true,
		"result": daemonrpc.WorkspaceFile{Path: "README.md", Size: int64(len(data)), SHA256: digest, ContentType: "text/plain; charset=utf-8", Data: data},
	}))
	if complete.Code != http.StatusOK || strings.Contains(complete.Body.String(), "node_id") || !strings.Contains(complete.Body.String(), "aGVsbG8K") {
		t.Fatalf("complete status=%d body=%s", complete.Code, complete.Body.String())
	}
	inspect := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/computers/computer-a/workspace/operations/workspace-api-op", testPrincipalA, nil))
	if inspect.Code != http.StatusOK || !strings.Contains(inspect.Body.String(), `"state":"succeeded"`) {
		t.Fatalf("inspect status=%d body=%s", inspect.Code, inspect.Body.String())
	}
	cross := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/computers/computer-a/workspace/operations/workspace-api-op", testPrincipalB, nil))
	if cross.Code != http.StatusNotFound {
		t.Fatalf("cross-scope inspect status=%d body=%s", cross.Code, cross.Body.String())
	}
	deleted := callAPI(t, handler, apiRequest(t, http.MethodDelete, "/v1/agent/computers/computer-a/workspace/operations/workspace-api-op", testPrincipalA, nil))
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	missing := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/computers/computer-a/workspace/operations/workspace-api-op", testPrincipalA, nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("deleted inspect status=%d body=%s", missing.Code, missing.Body.String())
	}
}

func digestHex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
