package cloudplane

import (
	"context"
	"io"
	"log"
	"net/http"
	"strings"
	"testing"
	"time"

	"zapvm/internal/gitprovider"
)

type fakeGitProviderIssuer struct{}

func (fakeGitProviderIssuer) List(tenantID, projectID string) []gitprovider.Descriptor {
	if tenantID != "acme" || projectID != "weather" {
		return []gitprovider.Descriptor{}
	}
	return []gitprovider.Descriptor{{ID: "github", Owner: "JackCaow", Repository: "zapVM", DefaultBaseBranch: "main"}}
}

func (fakeGitProviderIssuer) Mint(context.Context, string, string, string) (gitprovider.Capability, error) {
	panic("Mint must not be reachable from the public catalog API")
}

func (fakeGitProviderIssuer) ReconcilePullRequest(context.Context, string, string, string, string, string, string) (gitprovider.PullRequest, error) {
	panic("ReconcilePullRequest must not be reachable from the public catalog API")
}

func TestAgentGitProviderCatalogIsTenantScopedAndReadOnly(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 8, 4, 0, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	api, err := NewAPIWithDependencies(store, "example.test", []string{testPrincipalA}, nil, fakeGitProviderIssuer{}, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	allowed := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/git/providers", testPrincipalA, nil))
	if allowed.Code != http.StatusOK || !strings.Contains(allowed.Body.String(), `"repository":"zapVM"`) || strings.Contains(allowed.Body.String(), "token") {
		t.Fatalf("allowed status=%d body=%s", allowed.Code, allowed.Body.String())
	}
	cross := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/git/providers", testPrincipalB, nil))
	if cross.Code != http.StatusOK || cross.Body.String() != "{\"providers\":[]}\n" {
		t.Fatalf("cross status=%d body=%s", cross.Code, cross.Body.String())
	}
	write := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/git/providers", testPrincipalA, map[string]any{}))
	if write.Code != http.StatusMethodNotAllowed {
		t.Fatalf("write status=%d body=%s", write.Code, write.Body.String())
	}
}
