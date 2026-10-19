package cloudplane

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"zapvm/internal/daemonrpc"
)

func TestAPIReadinessRequestCorrelationAndRedactedMetrics(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 3, 0, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	var logs bytes.Buffer
	api, err := NewAPIWithLogger(store, "example.test", []string{testPrincipalA}, log.New(&logs, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	request := apiRequest(t, http.MethodGet, "/readyz", testPrincipalA, nil)
	request.Header.Set(RequestIDHeader, "browser-request-0001")
	ready := callAPI(t, handler, request)
	if ready.Code != http.StatusOK || ready.Header().Get(RequestIDHeader) != "browser-request-0001" ||
		!strings.Contains(logs.String(), "request_id=browser-request-0001 component=control method=GET route=/readyz status=200") {
		t.Fatalf("ready status=%d request_id=%q logs=%q body=%s", ready.Code, ready.Header().Get(RequestIDHeader), logs.String(), ready.Body.String())
	}
	store.mu.Lock()
	store.degraded = errors.New("/private/secret/state.json: disk failure")
	store.mu.Unlock()
	degraded := callAPI(t, handler, apiRequest(t, http.MethodGet, "/readyz", testPrincipalA, nil))
	live := callAPI(t, handler, apiRequest(t, http.MethodGet, "/healthz", testPrincipalA, nil))
	if degraded.Code != http.StatusServiceUnavailable || !strings.Contains(degraded.Body.String(), `"code":"store_degraded"`) ||
		strings.Contains(degraded.Body.String(), "/private/") || live.Code != http.StatusOK {
		t.Fatalf("degraded ready=%d body=%s live=%d body=%s", degraded.Code, degraded.Body.String(), live.Code, live.Body.String())
	}
	metrics := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/admin/metrics", testPrincipalA, nil))
	if metrics.Code != http.StatusOK || !strings.Contains(metrics.Body.String(), `"ready":false`) ||
		!strings.Contains(metrics.Body.String(), `GET /readyz 200`) || strings.Contains(metrics.Body.String(), "/private/") {
		t.Fatalf("metrics status=%d body=%s", metrics.Code, metrics.Body.String())
	}
	denied := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/admin/metrics", testPrincipalB, nil))
	if denied.Code != http.StatusForbidden {
		t.Fatalf("non-admin metrics status=%d body=%s", denied.Code, denied.Body.String())
	}
}

func TestOperationalSnapshotContainsOnlyAggregateLatencyAndLag(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 3, 10, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	clock.Advance(2 * time.Second)
	if _, _, err := store.Submit(testPrincipalA, SubmitRequest{
		ID: "metrics-task", Scope: Scope{TenantID: "acme", ProjectID: "weather"}, ComputerID: "computer-a",
		Payload: taskPayload(t, "metrics-task"), CredentialIDs: []string{"github"},
	}); err != nil {
		t.Fatal(err)
	}
	clock.Advance(3 * time.Second)
	snapshot := store.OperationalSnapshot()
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !snapshot.Ready || snapshot.NodesByState[NodeOnline] != 1 || snapshot.TasksByState[TaskPending] != 1 ||
		snapshot.OldestQueueAgeMillis != 3000 || snapshot.OldestNodeHeartbeatAgeMillis != 5000 ||
		strings.Contains(string(encoded), "metrics-task") || strings.Contains(string(encoded), "computer-a") || strings.Contains(string(encoded), "github") {
		t.Fatalf("unexpected operational snapshot: %s", encoded)
	}
	clock.Advance(3 * time.Minute)
	snapshot = store.OperationalSnapshot()
	if len(snapshot.Alerts) == 0 || snapshot.Alerts[0].Code != "task_queue_stuck" {
		t.Fatalf("stuck queue did not produce a stable alert: %#v", snapshot.Alerts)
	}
}

func TestRoutineNodePollingLogsOnlyFailures(t *testing.T) {
	for _, route := range []string{
		"/v1/node/heartbeat",
		"/v1/node/cancellations",
		"/v1/node/claim",
		"/v1/node/computers/claim",
		"/v1/node/workspace/claim",
	} {
		if shouldLogRequest(route, http.StatusOK) {
			t.Fatalf("successful routine poll %s should not flood the Control log", route)
		}
		if !shouldLogRequest(route, http.StatusConflict) {
			t.Fatalf("failed routine poll %s must remain observable", route)
		}
	}
	if !shouldLogRequest("/readyz", http.StatusOK) {
		t.Fatal("non-polling request was unexpectedly suppressed")
	}
}

func apiRequest(t *testing.T, method, path, principal string, body any) *http.Request {
	t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	request := httptest.NewRequest(method, path, reader)
	uri, err := url.Parse(principal)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{URIs: []*url.URL{uri}}
	request.TLS = &tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{leaf},
		VerifiedChains:   [][]*x509.Certificate{{leaf}},
	}
	return request
}

func callAPI(t *testing.T, handler http.Handler, request *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestAPIMTLSIdentityIsolationAndNodeLifecycle(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 4, 0, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	api, err := NewAPI(store, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	submit := map[string]any{
		"id": "cloud-task", "computer_id": "computer-a",
		"payload": json.RawMessage(taskPayload(t, "cloud-task")), "credential_ids": []string{"github"},
	}
	response := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/tasks", testPrincipalA, submit))
	if response.Code != http.StatusCreated {
		t.Fatalf("submit status=%d body=%s", response.Code, response.Body.String())
	}
	wrongSurface := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/sessions/cloud-task", testPrincipalA, nil))
	if wrongSurface.Code != http.StatusNotFound {
		t.Fatalf("generic Task through Agent Session API status=%d body=%s", wrongSurface.Code, wrongSurface.Body.String())
	}
	wrongEvents := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/sessions/cloud-task/events", testPrincipalA, nil))
	wrongStream := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/sessions/cloud-task/stream", testPrincipalA, nil))
	wrongCancel := callAPI(t, handler, apiRequest(t, http.MethodDelete, "/v1/agent/sessions/cloud-task", testPrincipalA, nil))
	if wrongEvents.Code != http.StatusNotFound || wrongStream.Code != http.StatusNotFound || wrongCancel.Code != http.StatusNotFound || store.state.Tasks["cloud-task"].State != TaskPending {
		t.Fatalf("generic Task was exposed or mutated: events=%d stream=%d cancel=%d task=%#v", wrongEvents.Code, wrongStream.Code, wrongCancel.Code, store.state.Tasks["cloud-task"])
	}

	nodePrincipal := "spiffe://example.test/node/node-a"
	register := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/register", nodePrincipal, map[string]any{
		"generation": "generation-00001",
	}))
	if register.Code != http.StatusOK {
		t.Fatalf("register status=%d body=%s", register.Code, register.Body.String())
	}
	claim := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/claim", nodePrincipal, map[string]any{
		"generation": "generation-00001", "maximum": 1,
	}))
	if claim.Code != http.StatusOK || strings.Contains(claim.Body.String(), "lease_token_hash") {
		t.Fatalf("claim status=%d body=%s", claim.Code, claim.Body.String())
	}
	var claimed struct {
		Leases []Lease `json:"leases"`
	}
	if err := json.Unmarshal(claim.Body.Bytes(), &claimed); err != nil || len(claimed.Leases) != 1 {
		t.Fatalf("decode claim: %#v, %v", claimed, err)
	}
	lease := claimed.Leases[0]
	ack := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/cloud-task/ack", nodePrincipal, map[string]any{
		"generation": "generation-00001", "lease_token": lease.LeaseToken,
	}))
	if ack.Code != http.StatusOK {
		t.Fatalf("ack status=%d body=%s", ack.Code, ack.Body.String())
	}
	event := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/cloud-task/events", nodePrincipal, map[string]any{
		"generation": "generation-00001", "lease_token": lease.LeaseToken,
		"event": map[string]any{
			"cursor": 1, "timestamp": "2026-08-07T04:00:00Z", "task_id": "cloud-task",
			"type": "exec.output", "stream": "stdout", "data": []byte("ok\n"),
		},
	}))
	if event.Code != http.StatusCreated {
		t.Fatalf("event status=%d body=%s", event.Code, event.Body.String())
	}
	events := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/tasks/cloud-task/events?after=0&limit=10", testPrincipalA, nil))
	if events.Code != http.StatusOK || !strings.Contains(events.Body.String(), "source_cursor") {
		t.Fatalf("events status=%d body=%s", events.Code, events.Body.String())
	}
	complete := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/cloud-task/complete", nodePrincipal, map[string]any{
		"generation": "generation-00001", "lease_token": lease.LeaseToken, "succeeded": true,
	}))
	if complete.Code != http.StatusOK {
		t.Fatalf("complete status=%d body=%s", complete.Code, complete.Body.String())
	}
	crossTenant := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/tasks/cloud-task", testPrincipalB, nil))
	if crossTenant.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant inspect status=%d body=%s", crossTenant.Code, crossTenant.Body.String())
	}
	admin := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/admin/nodes", testPrincipalA, nil))
	if admin.Code != http.StatusOK {
		t.Fatalf("admin status=%d body=%s", admin.Code, admin.Body.String())
	}
	nonAdmin := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/admin/nodes", testPrincipalB, nil))
	if nonAdmin.Code != http.StatusForbidden {
		t.Fatalf("non-admin status=%d body=%s", nonAdmin.Code, nonAdmin.Body.String())
	}
}

func TestAPIAdministratorSeesRedactedNodeOperability(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 4, 30, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	api, err := NewAPI(store, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	nodePrincipal := "spiffe://example.test/node/node-a"
	register := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/register", nodePrincipal, map[string]any{
		"generation": "generation-00001", "node_version": "0.2.0", "daemon_version": "0.2.0",
		"image_digest": strings.Repeat("b", 64), "daemon_state": DaemonDegraded, "failure_code": "daemon_degraded",
	}))
	if register.Code != http.StatusOK {
		t.Fatalf("register status=%d body=%s", register.Code, register.Body.String())
	}
	admin := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/admin/nodes", testPrincipalA, nil))
	if admin.Code != http.StatusOK || !strings.Contains(admin.Body.String(), `"daemon_state":"degraded"`) ||
		!strings.Contains(admin.Body.String(), `"failure_code":"daemon_degraded"`) || strings.Contains(admin.Body.String(), "/Users/") {
		t.Fatalf("admin nodes status=%d body=%s", admin.Code, admin.Body.String())
	}
	denied := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/admin/nodes", testPrincipalB, nil))
	if denied.Code != http.StatusForbidden {
		t.Fatalf("non-admin node inventory status=%d body=%s", denied.Code, denied.Body.String())
	}
	invalid := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/heartbeat", nodePrincipal, map[string]any{
		"generation": "generation-00001", "daemon_state": DaemonUnreachable, "failure_code": "/private/path/error",
	}))
	if invalid.Code != http.StatusBadRequest || strings.Contains(invalid.Body.String(), "/private/path/error") {
		t.Fatalf("invalid report status=%d body=%s", invalid.Code, invalid.Body.String())
	}
}

func TestAPIStrictJSONAndNodeProvisioning(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 5, 0, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	api, err := NewAPI(store, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	unknown := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/register", "spiffe://example.test/node/node-a", map[string]any{
		"generation": "generation-00001", "unexpected": true,
	}))
	if unknown.Code != http.StatusBadRequest {
		t.Fatalf("unknown-field status=%d body=%s", unknown.Code, unknown.Body.String())
	}
	if unknown.Header().Get(APIVersionHeader) != APIVersion || unknown.Body.String() != `{"error":{"code":"invalid_request","category":"request","action":"fix_request","retryable":false}}`+"\n" {
		t.Fatalf("unknown-field contract header=%q body=%s", unknown.Header().Get(APIVersionHeader), unknown.Body.String())
	}
	unprovisioned := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/register", "spiffe://example.test/node/node-unknown", map[string]any{
		"generation": "generation-00001",
	}))
	if unprovisioned.Code != http.StatusForbidden {
		t.Fatalf("unprovisioned status=%d body=%s", unprovisioned.Code, unprovisioned.Body.String())
	}
}

func TestAPIResidentAgentSessionBuildsBoundedGuestTask(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 6, 0, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	registerTestNodeA(t, store)
	api, err := NewAPI(store, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	body := map[string]any{
		"id": "agent-turn-1", "computer_id": "computer-a", "session_id": "web-session-1",
		"prompt": "inspect the project and run tests", "provider_base_url": "https://api.example.test/v1",
		"model": "model-1", "model_credential_id": "model-api-key", "search_credential_id": "search-api-key",
		"continue": false, "max_turns": 12, "timeout_ms": 60000,
	}
	response := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, body))
	if response.Code != http.StatusCreated || response.Header().Get(APIVersionHeader) != APIVersion || strings.Contains(response.Body.String(), "inspect the project") {
		t.Fatalf("resident submit status=%d body=%s", response.Code, response.Body.String())
	}
	var public AgentSession
	if err := json.Unmarshal(response.Body.Bytes(), &public); err != nil {
		t.Fatal(err)
	}
	if public.ID != "agent-turn-1" || public.ComputerID != "computer-a" || public.SessionID != "web-session-1" || public.State != TaskPending {
		t.Fatalf("resident public response = %#v", public)
	}
	for _, forbidden := range []string{"payload", "credential", "node_id", "lease_token", "argv", "prompt"} {
		if strings.Contains(response.Body.String(), forbidden) {
			t.Fatalf("resident response exposes %q: %s", forbidden, response.Body.String())
		}
	}
	stored := store.state.Tasks["agent-turn-1"]
	command, err := daemonrpc.DecodeComputerTaskSubmit(stored.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if command.ComputerID != "computer-a" || command.Command.SessionID != "web-session-1" || command.Command.Argv[0] != residentAgentBinary {
		t.Fatalf("resident command = %#v", command)
	}
	joined := strings.Join(command.Command.Argv, "\n")
	for _, expected := range []string{"inspect the project and run tests", "--prompt", "api.example.test"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("resident argv missing %q: %#v", expected, command.Command.Argv)
		}
	}
	if strings.Contains(joined, "secret-value") || strings.Join(command.Command.CredentialIDs, ",") != "model-api-key,search-api-key" {
		t.Fatalf("resident credential authority = %#v", command.Command)
	}
	inspect := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/sessions/agent-turn-1", testPrincipalA, nil))
	if inspect.Code != http.StatusOK || inspect.Header().Get(APIVersionHeader) != APIVersion {
		t.Fatalf("resident inspect status=%d body=%s", inspect.Code, inspect.Body.String())
	}
	events := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/sessions/agent-turn-1/events?after=0&limit=10", testPrincipalA, nil))
	if events.Code != http.StatusOK || events.Header().Get(APIVersionHeader) != APIVersion || !strings.Contains(events.Body.String(), "events") {
		t.Fatalf("resident events status=%d body=%s", events.Code, events.Body.String())
	}
	canceled := callAPI(t, handler, apiRequest(t, http.MethodDelete, "/v1/agent/sessions/agent-turn-1", testPrincipalA, nil))
	if canceled.Code != http.StatusOK || !strings.Contains(canceled.Body.String(), `"state":"canceled"`) {
		t.Fatalf("resident cancel status=%d body=%s", canceled.Code, canceled.Body.String())
	}
}

func TestAPIResidentAgentSessionRejectsOfflineComputer(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 6, 10, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	api, err := NewAPI(store, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]any{
		"id": "agent-turn-offline", "computer_id": "computer-a", "session_id": "web-session-offline",
		"prompt": "run while offline", "provider_base_url": "https://api.example.test/v1", "model": "model-1",
		"model_credential_id": "model-api-key", "timeout_ms": 60000,
	}
	response := callAPI(t, api.Handler(), apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, body))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"code":"computer_offline"`) ||
		!strings.Contains(response.Body.String(), `"retryable":true`) {
		t.Fatalf("offline submit status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestAPIResidentAgentContinuationIsAtomicAndComputerBound(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 6, 20, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	registerTestNodeA(t, store)
	api, err := NewAPI(store, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	body := map[string]any{
		"id": "agent-turn-continue-1", "computer_id": "computer-a", "session_id": "web-session-continue",
		"prompt": "first turn", "provider_base_url": "https://api.example.test/v1", "model": "model-1",
		"model_credential_id": "model-api-key", "timeout_ms": 60000,
	}
	body["continue"] = true
	missing := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, body))
	if missing.Code != http.StatusConflict {
		t.Fatalf("missing continuation status=%d body=%s", missing.Code, missing.Body.String())
	}
	body["continue"] = false
	first := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, body))
	if first.Code != http.StatusCreated {
		t.Fatalf("first turn status=%d body=%s", first.Code, first.Body.String())
	}

	body["id"] = "agent-turn-continue-2"
	body["prompt"] = "second turn"
	reusedWithoutContinue := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, body))
	if reusedWithoutContinue.Code != http.StatusConflict {
		t.Fatalf("implicit reuse status=%d body=%s", reusedWithoutContinue.Code, reusedWithoutContinue.Body.String())
	}
	body["continue"] = true
	whileActive := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, body))
	if whileActive.Code != http.StatusConflict {
		t.Fatalf("active continuation status=%d body=%s", whileActive.Code, whileActive.Body.String())
	}
	body["computer_id"] = "computer-b"
	differentComputer := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, body))
	if differentComputer.Code != http.StatusConflict {
		t.Fatalf("cross-Computer continuation status=%d body=%s", differentComputer.Code, differentComputer.Body.String())
	}

	canceled := callAPI(t, handler, apiRequest(t, http.MethodDelete, "/v1/agent/sessions/agent-turn-continue-1", testPrincipalA, nil))
	if canceled.Code != http.StatusOK || !strings.Contains(canceled.Body.String(), `"state":"canceled"`) {
		t.Fatalf("cancel first status=%d body=%s", canceled.Code, canceled.Body.String())
	}
	body["computer_id"] = "computer-a"
	thirdBody := make(map[string]any, len(body))
	for key, value := range body {
		thirdBody[key] = value
	}
	thirdBody["id"] = "agent-turn-continue-3"
	thirdBody["prompt"] = "concurrent third turn"
	requests := []*http.Request{
		apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, body),
		apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, thirdBody),
	}
	recorders := []*httptest.ResponseRecorder{httptest.NewRecorder(), httptest.NewRecorder()}
	done := make(chan int, 2)
	for index := range requests {
		go func(index int) {
			handler.ServeHTTP(recorders[index], requests[index])
			done <- index
		}(index)
	}
	<-done
	<-done
	winnerID := ""
	winnerBody := body
	createdCount := 0
	conflictCount := 0
	for index, recorder := range recorders {
		switch recorder.Code {
		case http.StatusCreated:
			createdCount++
			winnerID = []string{"agent-turn-continue-2", "agent-turn-continue-3"}[index]
			if index == 1 {
				winnerBody = thirdBody
			}
		case http.StatusConflict:
			conflictCount++
		default:
			t.Fatalf("concurrent continuation %d status=%d body=%s", index, recorder.Code, recorder.Body.String())
		}
	}
	if createdCount != 1 || conflictCount != 1 {
		t.Fatalf("concurrent continuation created=%d conflict=%d", createdCount, conflictCount)
	}
	stored := store.state.Tasks[winnerID]
	command, err := daemonrpc.DecodeComputerTaskSubmit(stored.Payload)
	if err != nil || !strings.Contains(strings.Join(command.Command.Argv, "\n"), "--continue-session") {
		t.Fatalf("continued command=%#v err=%v", command, err)
	}
	idempotent := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, winnerBody))
	if idempotent.Code != http.StatusOK || len(store.state.Tasks) != 2 {
		t.Fatalf("idempotent continuation status=%d tasks=%d body=%s", idempotent.Code, len(store.state.Tasks), idempotent.Body.String())
	}
}

func TestAPIResidentAgentSessionRejectsUnsafeProviderAndUnknownFields(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 6, 30, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	api, err := NewAPI(store, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	base := map[string]any{
		"id": "agent-turn-unsafe", "computer_id": "computer-a", "session_id": "web-session-1",
		"prompt": "hello", "provider_base_url": "http://127.0.0.1:8080/v1", "model": "model-1",
		"model_credential_id": "model-api-key",
	}
	response := callAPI(t, api.Handler(), apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, base))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unsafe provider status=%d body=%s", response.Code, response.Body.String())
	}
	base["provider_base_url"] = "https://api.example.test/v1"
	base["unexpected"] = true
	response = callAPI(t, api.Handler(), apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, base))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown resident field status=%d body=%s", response.Code, response.Body.String())
	}
	delete(base, "unexpected")
	base["title"] = strings.Repeat("x", 81)
	response = callAPI(t, api.Handler(), apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, base))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("oversized resident title status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestAPIResidentAgentSSEReplayAndResume(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 6, 35, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	registerTestNodeA(t, store)
	api, err := NewAPI(store, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	body := map[string]any{
		"id": "agent-turn-stream", "computer_id": "computer-a", "session_id": "web-session-stream",
		"prompt": "private stream prompt", "provider_base_url": "https://api.example.test/v1", "model": "model-1",
		"model_credential_id": "model-api-key", "timeout_ms": 60000,
	}
	created := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, body))
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	nodePrincipal := "spiffe://example.test/node/node-a"
	if response := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/register", nodePrincipal, map[string]any{"generation": "generation-00001"})); response.Code != http.StatusOK {
		t.Fatalf("register status=%d body=%s", response.Code, response.Body.String())
	}
	claim := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/claim", nodePrincipal, map[string]any{
		"generation": "generation-00001", "maximum": 1,
	}))
	var claimed struct {
		Leases []Lease `json:"leases"`
	}
	if claim.Code != http.StatusOK || json.Unmarshal(claim.Body.Bytes(), &claimed) != nil || len(claimed.Leases) != 1 {
		t.Fatalf("claim status=%d body=%s", claim.Code, claim.Body.String())
	}
	lease := claimed.Leases[0]
	proof := map[string]any{"generation": "generation-00001", "lease_token": lease.LeaseToken}
	if response := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/agent-turn-stream/ack", nodePrincipal, proof)); response.Code != http.StatusOK {
		t.Fatalf("ack status=%d body=%s", response.Code, response.Body.String())
	}
	eventBody := map[string]any{
		"generation": "generation-00001", "lease_token": lease.LeaseToken,
		"event": map[string]any{
			"cursor": 1, "timestamp": "2026-08-07T06:35:00Z", "task_id": "agent-turn-stream",
			"type": "exec.output", "stream": "stdout", "data": []byte("safe output\n"),
		},
	}
	if response := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/agent-turn-stream/events", nodePrincipal, eventBody)); response.Code != http.StatusCreated {
		t.Fatalf("event status=%d body=%s", response.Code, response.Body.String())
	}
	eventBody["event"] = map[string]any{
		"cursor": 2, "timestamp": "2026-08-07T06:35:01Z", "task_id": "agent-turn-stream",
		"type": "exec.output", "stream": "stdout", "data": []byte("final output\n"),
	}
	if response := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/agent-turn-stream/events", nodePrincipal, eventBody)); response.Code != http.StatusCreated {
		t.Fatalf("second event status=%d body=%s", response.Code, response.Body.String())
	}
	if response := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/agent-turn-stream/complete", nodePrincipal, map[string]any{
		"generation": "generation-00001", "lease_token": lease.LeaseToken, "succeeded": true,
	})); response.Code != http.StatusOK {
		t.Fatalf("complete status=%d body=%s", response.Code, response.Body.String())
	}

	stream := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/sessions/agent-turn-stream/stream?after=0&limit=10", testPrincipalA, nil))
	streamBody := stream.Body.String()
	if stream.Code != http.StatusOK || stream.Header().Get("Content-Type") != "text/event-stream" || stream.Header().Get(APIVersionHeader) != APIVersion {
		t.Fatalf("stream status=%d headers=%v body=%s", stream.Code, stream.Header(), streamBody)
	}
	for _, expected := range []string{"retry: 1000", "id: 1", "id: 2", "event: task-event", "c2FmZSBvdXRwdXQK", "event: session", `"state":"succeeded"`} {
		if !strings.Contains(streamBody, expected) {
			t.Fatalf("stream missing %q: %s", expected, streamBody)
		}
	}
	for _, forbidden := range []string{"private stream prompt", "model-api-key", "credential_ids", "lease_token", "argv", "payload"} {
		if strings.Contains(streamBody, forbidden) {
			t.Fatalf("stream exposes %q: %s", forbidden, streamBody)
		}
	}

	firstPage := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/sessions/agent-turn-stream/stream?after=0&limit=1", testPrincipalA, nil))
	if firstPage.Code != http.StatusOK || !strings.Contains(firstPage.Body.String(), "id: 1") || strings.Contains(firstPage.Body.String(), `"state":"succeeded"`) {
		t.Fatalf("bounded first stream status=%d body=%s", firstPage.Code, firstPage.Body.String())
	}
	resumeRequest := apiRequest(t, http.MethodGet, "/v1/agent/sessions/agent-turn-stream/stream?limit=1", testPrincipalA, nil)
	resumeRequest.Header.Set("Last-Event-ID", "1")
	resumed := callAPI(t, handler, resumeRequest)
	if resumed.Code != http.StatusOK || !strings.Contains(resumed.Body.String(), "id: 2") || !strings.Contains(resumed.Body.String(), `"state":"succeeded"`) {
		t.Fatalf("resumed stream status=%d body=%s", resumed.Code, resumed.Body.String())
	}
	aheadRequest := apiRequest(t, http.MethodGet, "/v1/agent/sessions/agent-turn-stream/stream", testPrincipalA, nil)
	aheadRequest.Header.Set("Last-Event-ID", "3")
	ahead := callAPI(t, handler, aheadRequest)
	if ahead.Code != http.StatusBadRequest || !strings.Contains(ahead.Body.String(), "invalid_request") {
		t.Fatalf("ahead stream status=%d body=%s", ahead.Code, ahead.Body.String())
	}
}

func TestAPIResidentAgentCancellationDownlinkAndConfirmation(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 6, 40, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	registerTestNodeA(t, store)
	api, err := NewAPI(store, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	body := map[string]any{
		"id": "agent-turn-cancel", "computer_id": "computer-a", "session_id": "web-session-cancel",
		"prompt": "wait until canceled", "provider_base_url": "https://api.example.test/v1", "model": "model-1",
		"model_credential_id": "model-api-key", "timeout_ms": 60000,
	}
	created := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, body))
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	nodePrincipal := "spiffe://example.test/node/node-a"
	register := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/register", nodePrincipal, map[string]any{"generation": "generation-00001"}))
	if register.Code != http.StatusOK {
		t.Fatalf("register status=%d body=%s", register.Code, register.Body.String())
	}
	claim := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/claim", nodePrincipal, map[string]any{
		"generation": "generation-00001", "maximum": 1,
	}))
	var claimed struct {
		Leases []Lease `json:"leases"`
	}
	if claim.Code != http.StatusOK || json.Unmarshal(claim.Body.Bytes(), &claimed) != nil || len(claimed.Leases) != 1 {
		t.Fatalf("claim status=%d body=%s", claim.Code, claim.Body.String())
	}
	lease := claimed.Leases[0]
	proof := map[string]any{"generation": "generation-00001", "lease_token": lease.LeaseToken}
	ack := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/agent-turn-cancel/ack", nodePrincipal, proof))
	if ack.Code != http.StatusOK {
		t.Fatalf("ack status=%d body=%s", ack.Code, ack.Body.String())
	}
	canceling := callAPI(t, handler, apiRequest(t, http.MethodDelete, "/v1/agent/sessions/agent-turn-cancel", testPrincipalA, nil))
	if canceling.Code != http.StatusOK || !strings.Contains(canceling.Body.String(), `"state":"canceling"`) {
		t.Fatalf("cancel intent status=%d body=%s", canceling.Code, canceling.Body.String())
	}
	cancellations := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/cancellations", nodePrincipal, map[string]any{
		"generation": "generation-00001", "leases": []map[string]any{{"task_id": lease.Task.ID, "lease_token": lease.LeaseToken}},
	}))
	if cancellations.Code != http.StatusOK || !strings.Contains(cancellations.Body.String(), "agent-turn-cancel") {
		t.Fatalf("cancellations status=%d body=%s", cancellations.Code, cancellations.Body.String())
	}
	confirmed := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/agent-turn-cancel/canceled", nodePrincipal, proof))
	if confirmed.Code != http.StatusOK || !strings.Contains(confirmed.Body.String(), `"state":"canceled"`) {
		t.Fatalf("confirm status=%d body=%s", confirmed.Code, confirmed.Body.String())
	}
	final := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/sessions/agent-turn-cancel", testPrincipalA, nil))
	if final.Code != http.StatusOK || !strings.Contains(final.Body.String(), `"state":"canceled"`) {
		t.Fatalf("final status=%d body=%s", final.Code, final.Body.String())
	}
}

func TestAPIResidentAgentExplicitRetryPreservesLineageAndIsIdempotent(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 6, 45, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	registerTestNodeA(t, store)
	api, err := NewAPI(store, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	body := map[string]any{
		"id": "agent-retry-source", "computer_id": "computer-a", "session_id": "web-session-retry",
		"title":  "Safe retry title",
		"prompt": "private prompt that must stay server-side", "provider_base_url": "https://api.example.test/v1", "model": "model-1",
		"model_credential_id": "model-api-key", "timeout_ms": 60000,
	}
	created := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, body))
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	nodePrincipal := "spiffe://example.test/node/node-a"
	if response := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/register", nodePrincipal, map[string]any{"generation": "generation-00001"})); response.Code != http.StatusOK {
		t.Fatalf("register status=%d body=%s", response.Code, response.Body.String())
	}
	claim := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/claim", nodePrincipal, map[string]any{"generation": "generation-00001", "maximum": 1}))
	var claimed struct {
		Leases []Lease `json:"leases"`
	}
	if claim.Code != http.StatusOK || json.Unmarshal(claim.Body.Bytes(), &claimed) != nil || len(claimed.Leases) != 1 {
		t.Fatalf("claim status=%d body=%s", claim.Code, claim.Body.String())
	}
	proof := map[string]any{"generation": "generation-00001", "lease_token": claimed.Leases[0].LeaseToken}
	if response := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/agent-retry-source/ack", nodePrincipal, proof)); response.Code != http.StatusOK {
		t.Fatalf("ack status=%d body=%s", response.Code, response.Body.String())
	}
	proof["succeeded"] = false
	proof["failure_code"] = "execution_failed"
	if response := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/node/tasks/agent-retry-source/complete", nodePrincipal, proof)); response.Code != http.StatusOK {
		t.Fatalf("complete status=%d body=%s", response.Code, response.Body.String())
	}
	retryBody := map[string]any{"id": "agent-retry-new"}
	retry := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions/agent-retry-source/retry", testPrincipalA, retryBody))
	if retry.Code != http.StatusCreated || !strings.Contains(retry.Body.String(), `"retry_of":"agent-retry-source"`) || !strings.Contains(retry.Body.String(), `"title":"Safe retry title"`) || strings.Contains(retry.Body.String(), "private prompt") {
		t.Fatalf("retry status=%d body=%s", retry.Code, retry.Body.String())
	}
	stored := store.state.Tasks["agent-retry-new"]
	command, err := daemonrpc.DecodeComputerTaskSubmit(stored.Payload)
	if err != nil || stored.RetryOf != "agent-retry-source" || command.ID != "agent-retry-new" || !contains(string(stored.Payload), "private prompt") {
		t.Fatalf("stored retry = %#v command=%#v err=%v", stored, command, err)
	}
	duplicate := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions/agent-retry-source/retry", testPrincipalA, retryBody))
	if duplicate.Code != http.StatusOK {
		t.Fatalf("idempotent retry status=%d body=%s", duplicate.Code, duplicate.Body.String())
	}
	concurrent := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions/agent-retry-source/retry", testPrincipalA, map[string]any{"id": "agent-retry-concurrent"}))
	if concurrent.Code != http.StatusConflict {
		t.Fatalf("concurrent retry status=%d body=%s", concurrent.Code, concurrent.Body.String())
	}
}

func TestAPIResidentAgentSessionCatalogPaginationAndIsolation(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 7, 6, 50, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	registerTestNodeA(t, store)
	api, err := NewAPI(store, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	body := map[string]any{
		"id": "agent-turn-list-a", "computer_id": "computer-a", "session_id": "web-session-list-a",
		"prompt": "private first prompt", "provider_base_url": "https://api.example.test/v1", "model": "model-1",
		"model_credential_id": "model-api-key", "timeout_ms": 60000,
	}
	first := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, body))
	if first.Code != http.StatusCreated {
		t.Fatalf("first create status=%d body=%s", first.Code, first.Body.String())
	}
	generic := map[string]any{
		"id": "generic-between-agent-turns", "computer_id": "computer-a",
		"payload": json.RawMessage(taskPayload(t, "generic-between-agent-turns")), "credential_ids": []string{"github"},
	}
	if response := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/tasks", testPrincipalA, generic)); response.Code != http.StatusCreated {
		t.Fatalf("generic create status=%d body=%s", response.Code, response.Body.String())
	}
	clock.Advance(time.Millisecond)
	body["id"] = "agent-turn-list-b"
	body["session_id"] = "web-session-list-b"
	body["prompt"] = "private second prompt"
	second := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/agent/sessions", testPrincipalA, body))
	if second.Code != http.StatusCreated {
		t.Fatalf("second create status=%d body=%s", second.Code, second.Body.String())
	}

	pageOne := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/sessions?after=0&limit=1", testPrincipalA, nil))
	var firstPage AgentSessionList
	if pageOne.Code != http.StatusOK || json.Unmarshal(pageOne.Body.Bytes(), &firstPage) != nil || len(firstPage.Sessions) != 1 {
		t.Fatalf("first page status=%d body=%s", pageOne.Code, pageOne.Body.String())
	}
	if firstPage.Sessions[0].ID != "agent-turn-list-a" || firstPage.NextCursor == 0 {
		t.Fatalf("first page = %#v", firstPage)
	}
	pageTwo := callAPI(t, handler, apiRequest(t, http.MethodGet, fmt.Sprintf("/v1/agent/sessions?after=%d&limit=1", firstPage.NextCursor), testPrincipalA, nil))
	var secondPage AgentSessionList
	if pageTwo.Code != http.StatusOK || json.Unmarshal(pageTwo.Body.Bytes(), &secondPage) != nil || len(secondPage.Sessions) != 1 || secondPage.Sessions[0].ID != "agent-turn-list-b" {
		t.Fatalf("second page status=%d body=%s", pageTwo.Code, pageTwo.Body.String())
	}
	for _, forbidden := range []string{"private first prompt", "private second prompt", "generic-between-agent-turns", "payload", "credential", "argv"} {
		if strings.Contains(pageOne.Body.String()+pageTwo.Body.String(), forbidden) {
			t.Fatalf("catalog exposes %q: %s %s", forbidden, pageOne.Body.String(), pageTwo.Body.String())
		}
	}
	transcript := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/sessions/agent-turn-list-a/transcript?after=0&limit=1000", testPrincipalA, nil))
	var transcriptPage AgentSessionTranscriptPage
	if transcript.Code != http.StatusOK || json.Unmarshal(transcript.Body.Bytes(), &transcriptPage) != nil ||
		transcriptPage.Session.ID != "agent-turn-list-a" || transcriptPage.Prompt != "private first prompt" || transcriptPage.Events == nil {
		t.Fatalf("transcript status=%d body=%s", transcript.Code, transcript.Body.String())
	}
	for _, forbidden := range []string{"api.example.test", "model-api-key", "credential_ids", "provider_base_url", "argv"} {
		if strings.Contains(transcript.Body.String(), forbidden) {
			t.Fatalf("transcript exposes dispatch authority %q: %s", forbidden, transcript.Body.String())
		}
	}
	crossTenantTranscript := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/sessions/agent-turn-list-a/transcript?after=0&limit=1000", testPrincipalB, nil))
	if crossTenantTranscript.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant transcript status=%d body=%s", crossTenantTranscript.Code, crossTenantTranscript.Body.String())
	}
	crossTenant := callAPI(t, handler, apiRequest(t, http.MethodGet, "/v1/agent/sessions?after=0&limit=100", testPrincipalB, nil))
	if crossTenant.Code != http.StatusOK || crossTenant.Body.String() != `{"sessions":[],"next_cursor":0}`+"\n" {
		t.Fatalf("cross-tenant catalog status=%d body=%s", crossTenant.Code, crossTenant.Body.String())
	}
}
