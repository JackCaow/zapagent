package cloudplane

import (
	"io"
	"log"
	"net/http"
	"strings"
	"testing"
)

type computerOperationAPIBackend struct {
	Backend
	lease      ComputerOperationLease
	completion ComputerOperationCompletion
	lifecycle  AgentComputerLifecycle
	principal  string
	scope      Scope
	computerID string
	action     string
}

func (backend *computerOperationAPIBackend) RequestAgentComputerLifecycle(principal string, scope Scope, computerID, action string) (AgentComputerLifecycle, error) {
	backend.principal = principal
	backend.scope = scope
	backend.computerID = computerID
	backend.action = action
	return backend.lifecycle, nil
}

func (backend *computerOperationAPIBackend) ClaimComputerOperations(nodeID, generation string, maximum int) ([]ComputerOperationLease, error) {
	if nodeID != "node-a" || generation != "generation-computer-0001" || maximum != 1 {
		return nil, ErrFenced
	}
	return []ComputerOperationLease{backend.lease}, nil
}

func (backend *computerOperationAPIBackend) CompleteComputerOperation(nodeID, generation, operationID, leaseToken string, completion ComputerOperationCompletion) (ComputerOperation, error) {
	if nodeID != "node-a" || generation != "generation-computer-0001" || operationID != backend.lease.Operation.ID || leaseToken != backend.lease.LeaseToken {
		return ComputerOperation{}, ErrFenced
	}
	backend.completion = completion
	operation := backend.lease.Operation
	operation.State = ComputerOperationSucceeded
	return operation, nil
}

func TestNodeComputerOperationAPIClaimsAndCompletesStart(t *testing.T) {
	backend := &computerOperationAPIBackend{lease: ComputerOperationLease{
		Operation:  ComputerOperation{ID: "start-operation", ComputerID: "computer-a", State: ComputerOperationLeased, LeaseTokenHash: "secret-digest"},
		LeaseToken: "lease-token-computer-operation-000000000000000000000000",
	}}
	api, err := NewAPIWithLogger(backend, "example.test", []string{testPrincipalA}, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	principal := "spiffe://example.test/node/node-a"
	claim := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/computers/claim", principal, map[string]any{
		"generation": "generation-computer-0001", "maximum": 1,
	}))
	if claim.Code != http.StatusOK || !strings.Contains(claim.Body.String(), `"lease_token":"`+backend.lease.LeaseToken+`"`) || strings.Contains(claim.Body.String(), "secret-digest") {
		t.Fatalf("Computer operation claim status=%d body=%s", claim.Code, claim.Body.String())
	}
	complete := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/computers/operations/start-operation/complete", principal, map[string]any{
		"generation": "generation-computer-0001", "lease_token": backend.lease.LeaseToken, "succeeded": true,
	}))
	if complete.Code != http.StatusOK || !backend.completion.Succeeded || strings.Contains(complete.Body.String(), "secret-digest") {
		t.Fatalf("Computer operation complete status=%d completion=%#v body=%s", complete.Code, backend.completion, complete.Body.String())
	}
}

func TestAgentComputerLifecycleAPIUsesTenantScopeAndStrictActions(t *testing.T) {
	backend := &computerOperationAPIBackend{lifecycle: AgentComputerLifecycle{
		Action: ComputerLifecycleRelease, Accepted: true, OperationID: "stop-operation",
	}}
	api, err := NewAPIWithLogger(backend, "example.test", []string{testPrincipalA}, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	release := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/computers/computer-a/lifecycle", testPrincipalA, map[string]any{
		"action": ComputerLifecycleRelease,
	}))
	if release.Code != http.StatusAccepted || !strings.Contains(release.Body.String(), `"operation_id":"stop-operation"`) {
		t.Fatalf("Computer release status=%d body=%s", release.Code, release.Body.String())
	}
	if backend.principal != testPrincipalA || backend.scope != (Scope{TenantID: "acme", ProjectID: "weather"}) || backend.computerID != "computer-a" || backend.action != ComputerLifecycleRelease {
		t.Fatalf("Computer lifecycle authority principal=%q scope=%#v computer=%q action=%q", backend.principal, backend.scope, backend.computerID, backend.action)
	}
	invalid := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/computers/computer-a/lifecycle", testPrincipalA, map[string]any{
		"action": "delete",
	}))
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid Computer lifecycle status=%d body=%s", invalid.Code, invalid.Body.String())
	}
	wrongMethod := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/computers/computer-a/lifecycle", testPrincipalA, nil))
	if wrongMethod.Code != http.StatusMethodNotAllowed {
		t.Fatalf("Computer lifecycle GET status=%d body=%s", wrongMethod.Code, wrongMethod.Body.String())
	}
}
