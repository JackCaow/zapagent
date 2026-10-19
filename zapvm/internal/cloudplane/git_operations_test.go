package cloudplane

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"zapvm/internal/daemonrpc"
	"zapvm/internal/gitprovider"
)

type trackingGitIssuer struct {
	backing        []byte
	mintCalls      int
	reconcileCalls int
}

type failingGitIssuer struct{ backing []byte }

type pullRequestFailingIssuer struct {
	trackingGitIssuer
	err            error
	reconcileCalls int
}

func (issuer *failingGitIssuer) List(tenantID, projectID string) []gitprovider.Descriptor {
	if tenantID == "acme" && projectID == "weather" {
		return []gitprovider.Descriptor{{ID: "github", Owner: "example", Repository: "repository", DefaultBaseBranch: "main"}}
	}
	return []gitprovider.Descriptor{}
}

func (issuer *failingGitIssuer) Mint(context.Context, string, string, string) (gitprovider.Capability, error) {
	issuer.backing = []byte("ghs_partial_token_must_be_cleared")
	return gitprovider.Capability{Token: issuer.backing}, errors.New("upstream unavailable")
}

func (issuer *failingGitIssuer) ReconcilePullRequest(context.Context, string, string, string, string, string, string) (gitprovider.PullRequest, error) {
	panic("ReconcilePullRequest must not follow a failed capability mint")
}

func (issuer *trackingGitIssuer) List(tenantID, projectID string) []gitprovider.Descriptor {
	if tenantID == "acme" && projectID == "weather" {
		return []gitprovider.Descriptor{{ID: "github", Owner: "example", Repository: "repository", DefaultBaseBranch: "main"}}
	}
	return []gitprovider.Descriptor{}
}

func (issuer *trackingGitIssuer) Mint(_ context.Context, tenantID, projectID, providerID string) (gitprovider.Capability, error) {
	issuer.mintCalls++
	issuer.backing = []byte("ghs_variable_length_test_token_2026")
	return gitprovider.Capability{
		ProviderID: providerID, Owner: "example", Repository: "repository", BaseBranch: "main",
		HTTPSCloneURL: "https://github.com/example/repository.git", Token: issuer.backing, ExpiresAt: time.Now().Add(time.Hour),
	}, nil
}

func (issuer *trackingGitIssuer) ReconcilePullRequest(_ context.Context, tenantID, projectID, providerID, operationID, branch, commitSHA string) (gitprovider.PullRequest, error) {
	issuer.reconcileCalls++
	if tenantID != "acme" || projectID != "weather" || providerID != "github" || operationID != "git-operation-1" || branch != "zapvm/git-operation-1" || commitSHA != strings.Repeat("a", 40) {
		return gitprovider.PullRequest{}, errors.New("unexpected pull request reconciliation input")
	}
	return gitprovider.PullRequest{Number: 7, URL: "https://github.com/example/repository/pull/7", State: "open"}, nil
}

func (issuer *pullRequestFailingIssuer) ReconcilePullRequest(context.Context, string, string, string, string, string, string) (gitprovider.PullRequest, error) {
	issuer.reconcileCalls++
	return gitprovider.PullRequest{}, issuer.err
}

func TestGitOperationAPILeaseCompletionAuditAndSecretBoundary(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 8, 6, 0, 0, 0, time.UTC)}
	store, root := openWorkspaceOperationStore(t, clock)
	task := submitAndCompleteResidentTurn(t, store, "git-source-task", "git-session", false)
	issuer := &trackingGitIssuer{}
	api, err := NewAPIWithDependencies(store, "example.test", []string{testPrincipalA}, nil, issuer, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	create := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/computers/computer-a/git/operations", testPrincipalA, map[string]any{
		"id": "git-operation-1", "task_id": task.ID, "provider_id": "github",
	}))
	if create.Code != http.StatusAccepted || !strings.Contains(create.Body.String(), `"branch":"zapvm/git-operation-1"`) ||
		strings.Contains(create.Body.String(), "tenant_id") || strings.Contains(create.Body.String(), "token") || strings.Contains(create.Body.String(), "base_branch") {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	cross := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/computers/computer-a/git/operations/git-operation-1", testPrincipalB, nil))
	if cross.Code != http.StatusNotFound {
		t.Fatalf("cross status=%d body=%s", cross.Code, cross.Body.String())
	}
	nodePrincipal := "spiffe://example.test/node/node-a"
	claim := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/workspace/claim", nodePrincipal, map[string]any{
		"generation": "generation-00001", "maximum": 1,
	}))
	var claimed struct {
		Leases []WorkspaceOperationLease `json:"leases"`
	}
	if claim.Code != http.StatusOK || json.Unmarshal(claim.Body.Bytes(), &claimed) != nil || len(claimed.Leases) != 1 || claimed.Leases[0].Git == nil ||
		string(claimed.Leases[0].Git.Token) != "ghs_variable_length_test_token_2026" || strings.Contains(claim.Body.String(), "lease_token_hash") {
		t.Fatalf("claim status=%d body=%s", claim.Code, claim.Body.String())
	}
	if issuer.mintCalls != 1 {
		t.Fatalf("mint calls=%d", issuer.mintCalls)
	}
	for _, value := range issuer.backing {
		if value != 0 {
			t.Fatal("Control did not clear broker capability after copying it to the Node response")
		}
	}
	complete := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/workspace/operations/git-operation-1/complete", nodePrincipal, map[string]any{
		"generation": "generation-00001", "lease_token": claimed.Leases[0].LeaseToken, "succeeded": true,
		"result": daemonrpc.GitPushResult{OperationID: "git-operation-1", Branch: "zapvm/git-operation-1", CommitSHA: strings.Repeat("a", 40)},
	}))
	if complete.Code != http.StatusOK || strings.Contains(complete.Body.String(), "token") || !strings.Contains(complete.Body.String(), `"state":"succeeded"`) ||
		!strings.Contains(complete.Body.String(), `"pull_request_url":"https://github.com/example/repository/pull/7"`) {
		t.Fatalf("complete status=%d body=%s", complete.Code, complete.Body.String())
	}
	if issuer.reconcileCalls != 1 {
		t.Fatalf("reconcile calls=%d", issuer.reconcileCalls)
	}
	inspect := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/computers/computer-a/git/operations/git-operation-1", testPrincipalA, nil))
	if inspect.Code != http.StatusOK || !strings.Contains(inspect.Body.String(), strings.Repeat("a", 40)) ||
		!strings.Contains(inspect.Body.String(), `"pull_request_number":7`) || strings.Contains(inspect.Body.String(), "https_clone_url") {
		t.Fatalf("inspect status=%d body=%s", inspect.Code, inspect.Body.String())
	}
	audit, err := store.Audit(Scope{TenantID: "acme", ProjectID: "weather"}, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	actions := make(map[string]AuditRecord)
	for _, record := range audit {
		actions[record.Action] = record
	}
	for _, action := range []string{"git_operation_submit", "git_operation_lease", "git_operation_complete"} {
		record, exists := actions[action]
		if !exists || record.TaskID != task.ID || record.OperationID != "git-operation-1" {
			t.Fatalf("missing bound audit %q in %#v", action, audit)
		}
	}
	stateData, err := os.ReadFile(filepath.Join(root, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stateData), "ghs_variable_length") || strings.Contains(string(stateData), "https_clone_url") {
		t.Fatal("Git capability persisted in Control state")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(root, []NodeProvision{
		{ID: "node-a", Capacity: 4, Scopes: []Scope{{TenantID: "acme", ProjectID: "weather"}}, Computers: []ComputerProvision{{ID: "computer-a", TenantID: "acme", ProjectID: "weather"}}},
		{ID: "node-b", Capacity: 4, Scopes: []Scope{{TenantID: "beta", ProjectID: "build"}}, Computers: []ComputerProvision{{ID: "computer-b", TenantID: "beta", ProjectID: "build"}}},
	}, Options{Now: clock.Now, HeartbeatTTL: 20 * time.Second, LeaseTTL: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if operation, err := reopened.InspectWorkspaceOperation(Scope{TenantID: "acme", ProjectID: "weather"}, "git-operation-1"); err != nil || operation.State != WorkspaceOperationSucceeded {
		t.Fatalf("reopened operation=%#v err=%v", operation, err)
	}
}

func TestGitOperationRequiresConfiguredProviderAndSucceededBoundTask(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 8, 6, 30, 0, 0, time.UTC)}
	store, _ := openWorkspaceOperationStore(t, clock)
	issuer := &trackingGitIssuer{}
	api, err := NewAPIWithDependencies(store, "example.test", []string{testPrincipalA}, nil, issuer, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	missingProvider := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/computers/computer-a/git/operations", testPrincipalA, map[string]any{
		"id": "git-missing-provider", "task_id": "task", "provider_id": "other",
	}))
	if missingProvider.Code != http.StatusNotFound {
		t.Fatalf("provider status=%d body=%s", missingProvider.Code, missingProvider.Body.String())
	}
	if _, _, err := store.Submit(testPrincipalA, SubmitRequest{
		ID: "pending-git-task", Scope: Scope{TenantID: "acme", ProjectID: "weather"}, ComputerID: "computer-a",
		Payload: taskPayload(t, "pending-git-task"), CredentialIDs: []string{"github"},
	}); err != nil {
		t.Fatal(err)
	}
	pending := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/computers/computer-a/git/operations", testPrincipalA, map[string]any{
		"id": "git-pending-task", "task_id": "pending-git-task", "provider_id": "github",
	}))
	if pending.Code != http.StatusConflict {
		t.Fatalf("pending status=%d body=%s", pending.Code, pending.Body.String())
	}
}

func TestGitCapabilityMintFailureFailsOperationWithoutReturningOrRetainingToken(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 8, 7, 0, 0, 0, time.UTC)}
	store, _ := openWorkspaceOperationStore(t, clock)
	task := submitAndCompleteResidentTurn(t, store, "git-mint-source", "git-mint-session", false)
	issuer := &failingGitIssuer{}
	api, err := NewAPIWithDependencies(store, "example.test", []string{testPrincipalA}, nil, issuer, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	created := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/computers/computer-a/git/operations", testPrincipalA, map[string]any{
		"id": "git-mint-failure", "task_id": task.ID, "provider_id": "github",
	}))
	if created.Code != http.StatusAccepted {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	claim := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/workspace/claim", "spiffe://example.test/node/node-a", map[string]any{
		"generation": "generation-00001", "maximum": 1,
	}))
	if claim.Code != http.StatusOK || claim.Body.String() != "{\"leases\":[]}\n" || strings.Contains(claim.Body.String(), "token") {
		t.Fatalf("claim status=%d body=%s", claim.Code, claim.Body.String())
	}
	for _, value := range issuer.backing {
		if value != 0 {
			t.Fatal("failed mint retained partial capability")
		}
	}
	operation, err := store.InspectWorkspaceOperation(Scope{TenantID: "acme", ProjectID: "weather"}, "git-mint-failure")
	if err != nil || operation.State != WorkspaceOperationFailed || operation.FailureCode != "credential_unavailable" {
		t.Fatalf("operation=%#v err=%v", operation, err)
	}
}

func TestGitPullRequestFailureClassifiesRetryabilityWithoutLosingLease(t *testing.T) {
	for _, testCase := range []struct {
		name            string
		providerError   error
		wantHTTP        int
		wantState       string
		wantFailureCode string
	}{
		{name: "retryable", providerError: &gitprovider.ProviderError{Code: "pull_request_unavailable", Retryable: true}, wantHTTP: http.StatusServiceUnavailable, wantState: WorkspaceOperationLeased},
		{name: "permanent", providerError: &gitprovider.ProviderError{Code: "pull_request_rejected"}, wantHTTP: http.StatusOK, wantState: WorkspaceOperationFailed, wantFailureCode: "pull_request_rejected"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			clock := &testClock{now: time.Date(2026, 8, 8, 7, 30, 0, 0, time.UTC)}
			store, _ := openWorkspaceOperationStore(t, clock)
			task := submitAndCompleteResidentTurn(t, store, "git-pr-source-"+testCase.name, "git-pr-session-"+testCase.name, false)
			issuer := &pullRequestFailingIssuer{err: testCase.providerError}
			api, err := NewAPIWithDependencies(store, "example.test", []string{testPrincipalA}, nil, issuer, log.New(io.Discard, "", 0))
			if err != nil {
				t.Fatal(err)
			}
			handler := api.Handler()
			operationID := "git-pr-" + testCase.name
			created := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/computers/computer-a/git/operations", testPrincipalA, map[string]any{
				"id": operationID, "task_id": task.ID, "provider_id": "github",
			}))
			if created.Code != http.StatusAccepted {
				t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
			}
			nodePrincipal := "spiffe://example.test/node/node-a"
			claim := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/workspace/claim", nodePrincipal, map[string]any{
				"generation": "generation-00001", "maximum": 1,
			}))
			var claimed struct {
				Leases []WorkspaceOperationLease `json:"leases"`
			}
			if claim.Code != http.StatusOK || json.Unmarshal(claim.Body.Bytes(), &claimed) != nil || len(claimed.Leases) != 1 {
				t.Fatalf("claim status=%d body=%s", claim.Code, claim.Body.String())
			}
			complete := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/workspace/operations/"+operationID+"/complete", nodePrincipal, map[string]any{
				"generation": "generation-00001", "lease_token": claimed.Leases[0].LeaseToken, "succeeded": true,
				"result": daemonrpc.GitPushResult{OperationID: operationID, Branch: "zapvm/" + operationID, CommitSHA: strings.Repeat("b", 40)},
			}))
			if complete.Code != testCase.wantHTTP {
				t.Fatalf("complete status=%d body=%s", complete.Code, complete.Body.String())
			}
			operation, err := store.InspectWorkspaceOperation(Scope{TenantID: "acme", ProjectID: "weather"}, operationID)
			if err != nil || operation.State != testCase.wantState || operation.FailureCode != testCase.wantFailureCode {
				t.Fatalf("operation=%#v err=%v", operation, err)
			}
			if issuer.reconcileCalls != 1 {
				t.Fatalf("reconcile calls=%d", issuer.reconcileCalls)
			}
		})
	}
}
