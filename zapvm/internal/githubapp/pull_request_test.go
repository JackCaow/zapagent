package githubapp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"zapvm/internal/gitprovider"
)

func TestReconcilePullRequestCreatesAndReturnsStrictResult(t *testing.T) {
	now := time.Date(2026, 8, 8, 8, 0, 0, 0, time.UTC)
	_, keyPath := testPrivateKey(t, 2048)
	var listCalls atomic.Int32
	var createCalls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/app/installations/42/access_tokens":
			writeInstallationToken(t, writer, now)
		case request.Method == http.MethodGet && request.URL.Path == "/repos/example/repository/pulls":
			listCalls.Add(1)
			assertPullQuery(t, request.URL.Query())
			assertInstallationAuthorization(t, request)
			_ = json.NewEncoder(writer).Encode([]any{})
		case request.Method == http.MethodPost && request.URL.Path == "/repos/example/repository/pulls":
			createCalls.Add(1)
			assertInstallationAuthorization(t, request)
			var body struct {
				Title               string `json:"title"`
				Head                string `json:"head"`
				Base                string `json:"base"`
				Draft               bool   `json:"draft"`
				MaintainerCanModify bool   `json:"maintainer_can_modify"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil || body.Head != "zapvm/git-op" || body.Base != "main" ||
				body.Title != "zapVM Agent operation git-op" || body.Draft || body.MaintainerCanModify {
				t.Fatalf("create body=%#v err=%v", body, err)
			}
			writer.WriteHeader(http.StatusCreated)
			writePullRequest(t, writer, serverURLFromRequest(request), 7, "zapvm/git-op", strings.Repeat("a", 40), "main", "open")
		default:
			http.Error(writer, "unexpected", http.StatusNotFound)
		}
	}))
	defer server.Close()
	broker := testPullRequestBroker(t, server, keyPath, now)
	result, err := broker.ReconcilePullRequest(context.Background(), "acme", "weather", "github", "git-op", "zapvm/git-op", strings.Repeat("a", 40))
	if err != nil || result.Number != 7 || result.URL != server.URL+"/example/repository/pull/7" || result.State != "open" || listCalls.Load() != 1 || createCalls.Load() != 1 {
		t.Fatalf("result=%#v list=%d create=%d err=%v", result, listCalls.Load(), createCalls.Load(), err)
	}
}

func TestReconcilePullRequestReusesExistingAndRejectsCommitConflict(t *testing.T) {
	now := time.Date(2026, 8, 8, 8, 30, 0, 0, time.UTC)
	_, keyPath := testPrivateKey(t, 2048)
	requestedSHA := strings.Repeat("b", 40)
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/app/installations/42/access_tokens" {
			writeInstallationToken(t, writer, now)
			return
		}
		if request.Method != http.MethodGet || request.URL.Path != "/repos/example/repository/pulls" {
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		writePullRequestList(t, writer, serverURLFromRequest(request), 8, "zapvm/git-op", requestedSHA, "main", "open")
	}))
	defer server.Close()
	broker := testPullRequestBroker(t, server, keyPath, now)
	result, err := broker.ReconcilePullRequest(context.Background(), "acme", "weather", "github", "git-op", "zapvm/git-op", requestedSHA)
	if err != nil || result.Number != 8 {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	_, err = broker.ReconcilePullRequest(context.Background(), "acme", "weather", "github", "git-op", "zapvm/git-op", strings.Repeat("c", 40))
	if err == nil || err.Error() != "pull_request_conflict" || gitprovider.Retryable(err) {
		t.Fatalf("conflict error=%v retryable=%t", err, gitprovider.Retryable(err))
	}
}

func TestReconcilePullRequestRecoversCreateRaceWithoutDuplicate(t *testing.T) {
	now := time.Date(2026, 8, 8, 8, 45, 0, 0, time.UTC)
	_, keyPath := testPrivateKey(t, 2048)
	requestedSHA := strings.Repeat("d", 40)
	var listCalls atomic.Int32
	var createCalls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.URL.Path == "/app/installations/42/access_tokens":
			writeInstallationToken(t, writer, now)
		case request.Method == http.MethodGet && request.URL.Path == "/repos/example/repository/pulls":
			if listCalls.Add(1) == 1 {
				_ = json.NewEncoder(writer).Encode([]any{})
				return
			}
			writePullRequestList(t, writer, serverURLFromRequest(request), 9, "zapvm/git-op", requestedSHA, "main", "open")
		case request.Method == http.MethodPost && request.URL.Path == "/repos/example/repository/pulls":
			createCalls.Add(1)
			writer.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = writer.Write([]byte(`{"message":"already exists"}`))
		default:
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()
	broker := testPullRequestBroker(t, server, keyPath, now)
	result, err := broker.ReconcilePullRequest(context.Background(), "acme", "weather", "github", "git-op", "zapvm/git-op", requestedSHA)
	if err != nil || result.Number != 9 || listCalls.Load() != 2 || createCalls.Load() != 1 {
		t.Fatalf("result=%#v list=%d create=%d err=%v", result, listCalls.Load(), createCalls.Load(), err)
	}
}

func testPullRequestBroker(t *testing.T, server *httptest.Server, keyPath string, now time.Time) *Broker {
	t.Helper()
	broker, err := Open([]Config{{
		ID: "github", TenantID: "acme", ProjectID: "weather", APIBaseURL: server.URL, WebBaseURL: server.URL,
		AppID: 1234, InstallationID: 42, PrivateKeyFile: keyPath, Owner: "example", Repository: "repository", DefaultBaseBranch: "main",
	}}, server.Client(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	return broker
}

func writeInstallationToken(t *testing.T, writer http.ResponseWriter, now time.Time) {
	t.Helper()
	writer.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(writer).Encode(map[string]any{
		"token": "ghs_variable_length_test_token_2026", "expires_at": now.Add(time.Hour).Format(time.RFC3339),
	}); err != nil {
		t.Fatal(err)
	}
}

func assertPullQuery(t *testing.T, query url.Values) {
	t.Helper()
	if query.Get("state") != "all" || query.Get("head") != "example:zapvm/git-op" || query.Get("base") != "main" || query.Get("per_page") != "10" {
		t.Fatalf("query=%v", query)
	}
}

func assertInstallationAuthorization(t *testing.T, request *http.Request) {
	t.Helper()
	if request.Header.Get("Authorization") != "Bearer ghs_variable_length_test_token_2026" || request.Header.Get("X-GitHub-Api-Version") != apiVersion {
		t.Fatalf("headers=%v", request.Header)
	}
}

func serverURLFromRequest(request *http.Request) string { return "https://" + request.Host }

func writePullRequestList(t *testing.T, writer http.ResponseWriter, baseURL string, number uint64, branch, sha, base, state string) {
	t.Helper()
	response := pullResponse(baseURL, number, branch, sha, base, state)
	if err := json.NewEncoder(writer).Encode([]any{response}); err != nil {
		t.Fatal(err)
	}
}

func writePullRequest(t *testing.T, writer http.ResponseWriter, baseURL string, number uint64, branch, sha, base, state string) {
	t.Helper()
	if err := json.NewEncoder(writer).Encode(pullResponse(baseURL, number, branch, sha, base, state)); err != nil {
		t.Fatal(err)
	}
}

func pullResponse(baseURL string, number uint64, branch, sha, base, state string) map[string]any {
	return map[string]any{
		"number": number, "html_url": baseURL + "/example/repository/pull/" + jsonNumber(number), "state": state, "merged_at": nil,
		"head": map[string]any{"ref": branch, "sha": sha}, "base": map[string]any{"ref": base},
	}
}

func jsonNumber(value uint64) string {
	data, _ := json.Marshal(value)
	return string(data)
}
