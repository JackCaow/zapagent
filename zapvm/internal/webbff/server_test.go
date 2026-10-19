package webbff

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

const (
	testTokenA = "project-a-access-token-with-more-than-32-bytes"
	testTokenB = "project-b-access-token-with-more-than-32-bytes"
)

type upstreamRequest struct {
	Path          string
	Query         string
	Cookie        string
	Authorization string
	Tenant        string
	Project       string
	CSRF          string
	RequestID     string
	Accept        string
	LastEventID   string
	Body          string
}

func TestBFFSessionCSRFAndServerSelectedProject(t *testing.T) {
	var mu sync.Mutex
	requestsA := make([]upstreamRequest, 0)
	requestsB := make([]upstreamRequest, 0)
	upstream := func(target *[]upstreamRequest) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			body, _ := io.ReadAll(request.Body)
			mu.Lock()
			*target = append(*target, upstreamRequest{
				Path: request.URL.Path, Query: request.URL.RawQuery, Cookie: request.Header.Get("Cookie"),
				Authorization: request.Header.Get("Authorization"), Tenant: request.Header.Get("X-Tenant-ID"),
				Project: request.Header.Get("X-Project-ID"), CSRF: request.Header.Get("X-CSRF-Token"),
				RequestID: request.Header.Get("X-Request-ID"), Accept: request.Header.Get("Accept"), LastEventID: request.Header.Get("Last-Event-ID"), Body: string(body),
			})
			mu.Unlock()
			writer.Header().Set("Content-Type", "application/json")
			writer.Header().Set("X-ZapVM-API-Version", "1")
			writer.Header().Set("Set-Cookie", "control-secret=must-not-escape")
			if request.Method == http.MethodPost {
				writer.WriteHeader(http.StatusCreated)
			}
			_, _ = io.WriteString(writer, `{"upstream":"ok"}`)
		}))
	}
	controlA := upstream(&requestsA)
	defer controlA.Close()
	controlB := upstream(&requestsB)
	defer controlB.Close()

	config := testConfig(t)
	projects := []ProjectRuntime{
		testRuntime(t, config.Projects[0], testTokenA, controlA.URL),
		testRuntime(t, config.Projects[1], testTokenB, controlB.URL),
	}
	projectBTransport := projects[1].Transport
	projects[1].Transport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/v1/workspace/runtime" && request.URL.Query().Get("computer_id") == "computer-b" {
			body := `{"computer_id":"computer-b","agent_id":"managed-agent","display_name":"Managed Agent","runtime_ref":"zapcode@2.0.0","provider_base_url":"https://managed.example.test/v1","model":"managed-model","model_credential_id":"managed-key","max_turns":32,"timeout_seconds":900}`
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
		}
		return projectBTransport.RoundTrip(request)
	})
	var logs bytes.Buffer
	server, err := New(config, bytes.Repeat([]byte{7}, 32), projects, log.New(&logs, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := time.Date(2026, 8, 7, 8, 0, 0, 0, time.UTC)
	server.now = func() time.Time { return fixedNow }
	handler := server.Handler()

	login := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"access_token":"`+testTokenB+`"}`))
	login.Host = "web.example.test"
	login.Header.Set("Origin", config.PublicOrigin)
	login.Header.Set("Content-Type", "application/json")
	loginResponse := httptest.NewRecorder()
	handler.ServeHTTP(loginResponse, login)
	if loginResponse.Code != http.StatusOK || strings.Contains(loginResponse.Body.String(), testTokenB) {
		t.Fatalf("login status=%d body=%s", loginResponse.Code, loginResponse.Body.String())
	}
	var session sessionResponse
	if err := json.Unmarshal(loginResponse.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	if session.ProjectID != "project-b" || session.UserID != "user-b" || session.Role != "owner" || len(session.CSRFToken) != 43 {
		t.Fatalf("session = %#v", session)
	}
	if session.RuntimeProfile == nil || session.RuntimeProfile.ID != "default" || session.RuntimeProfile.Model != "model-1" ||
		session.RuntimeProfile.DisplayName != "Default Agent" {
		t.Fatalf("session runtime profile = %#v", session.RuntimeProfile)
	}
	cookies := loginResponse.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].Path != "/" {
		t.Fatalf("session cookies = %#v", cookies)
	}

	get := authenticatedRequest(t, http.MethodGet, "/api/agent/computers?project=project-a", nil, cookies[0])
	get.Header.Set("Authorization", "Bearer browser-secret")
	get.Header.Set("X-Tenant-ID", "other-tenant")
	get.Header.Set("X-Project-ID", "project-a")
	get.Header.Set("Accept", "text/event-stream")
	get.Header.Set("Last-Event-ID", "4")
	getResponse := httptest.NewRecorder()
	handler.ServeHTTP(getResponse, get)
	if getResponse.Code != http.StatusOK || getResponse.Header().Get("Set-Cookie") != "" || getResponse.Header().Get("X-ZapVM-API-Version") != "1" {
		t.Fatalf("proxy GET status=%d headers=%v body=%s", getResponse.Code, getResponse.Header(), getResponse.Body.String())
	}
	mu.Lock()
	if len(requestsA) != 0 || len(requestsB) != 1 {
		mu.Unlock()
		t.Fatalf("upstream routing A=%d B=%d", len(requestsA), len(requestsB))
	}
	forwarded := requestsB[0]
	mu.Unlock()
	if forwarded.Path != "/v1/agent/computers" || forwarded.Query != "project=project-a" || forwarded.Cookie != "" || forwarded.Authorization != "" || forwarded.Tenant != "" || forwarded.Project != "" || forwarded.CSRF != "" || forwarded.RequestID == "" || forwarded.Accept != "text/event-stream" || forwarded.LastEventID != "4" {
		t.Fatalf("forwarded request = %#v", forwarded)
	}

	denied := authenticatedRequest(t, http.MethodPost, "/api/agent/sessions", strings.NewReader(`{"prompt":"private prompt"}`), cookies[0])
	denied.Header.Set("Content-Type", "application/json")
	deniedResponse := httptest.NewRecorder()
	handler.ServeHTTP(deniedResponse, denied)
	if deniedResponse.Code != http.StatusForbidden || !strings.Contains(deniedResponse.Body.String(), `"code":"csrf_required"`) ||
		!strings.Contains(deniedResponse.Body.String(), `"category":"session"`) || !strings.Contains(deniedResponse.Body.String(), `"action":"refresh"`) ||
		!strings.Contains(deniedResponse.Body.String(), `"retryable":false`) || deniedResponse.Header().Get("X-Request-ID") == "" {
		t.Fatalf("missing CSRF status=%d body=%s", deniedResponse.Code, deniedResponse.Body.String())
	}

	allowed := authenticatedRequest(t, http.MethodPost, "/api/agent/sessions", strings.NewReader(`{"id":"turn-1","computer_id":"computer-b","session_id":"session-b","title":"Safe project audit","prompt":"private prompt"}`), cookies[0])
	allowed.Header.Set("Content-Type", "application/json")
	allowed.Header.Set("X-CSRF-Token", session.CSRFToken)
	allowed.Header.Set("Origin", config.PublicOrigin)
	allowedResponse := httptest.NewRecorder()
	handler.ServeHTTP(allowedResponse, allowed)
	if allowedResponse.Code != http.StatusCreated {
		t.Fatalf("valid CSRF status=%d body=%s", allowedResponse.Code, allowedResponse.Body.String())
	}
	mu.Lock()
	forwardedPost := requestsB[len(requestsB)-1]
	mu.Unlock()
	if forwardedPost.CSRF != "" || forwardedPost.Cookie != "" {
		t.Fatalf("BFF secrets reached Control: %#v", forwardedPost)
	}
	var upstreamBody map[string]any
	if err := json.Unmarshal([]byte(forwardedPost.Body), &upstreamBody); err != nil {
		t.Fatal(err)
	}
	if upstreamBody["provider_base_url"] != "https://managed.example.test/v1" || upstreamBody["model"] != "managed-model" ||
		upstreamBody["model_credential_id"] != "managed-key" || upstreamBody["max_turns"] != float64(32) || upstreamBody["timeout_ms"] != float64(900000) ||
		upstreamBody["prompt"] != "private prompt" || upstreamBody["title"] != "Safe project audit" {
		t.Fatalf("server-selected runtime body = %#v", upstreamBody)
	}
	tampered := authenticatedRequest(t, http.MethodPost, "/api/agent/sessions", strings.NewReader(`{"id":"turn-2","computer_id":"computer-b","session_id":"session-b","prompt":"private prompt","model":"attacker-model"}`), cookies[0])
	tampered.Header.Set("Content-Type", "application/json")
	tampered.Header.Set("X-CSRF-Token", session.CSRFToken)
	tamperedResponse := httptest.NewRecorder()
	handler.ServeHTTP(tamperedResponse, tampered)
	if tamperedResponse.Code != http.StatusBadRequest || !strings.Contains(tamperedResponse.Body.String(), `"code":"invalid_request"`) {
		t.Fatalf("runtime tampering status=%d body=%s", tamperedResponse.Code, tamperedResponse.Body.String())
	}
	if strings.Contains(logs.String(), testTokenB) || strings.Contains(logs.String(), "private prompt") {
		t.Fatalf("audit log contains secret input: %s", logs.String())
	}
}

func TestBFFProxiesPlatformAdminToWorkspaceAPI(t *testing.T) {
	var path, userID, userName string
	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		path = request.URL.Path
		userID = request.Header.Get("X-ZapVM-User-ID")
		userName = request.Header.Get("X-ZapVM-User-Name")
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"members":[]}`)
	}))
	defer control.Close()

	config := testConfig(t)
	projects := []ProjectRuntime{
		testRuntime(t, config.Projects[0], testTokenA, control.URL),
		testRuntime(t, config.Projects[1], testTokenB, control.URL),
	}
	server, err := New(config, bytes.Repeat([]byte{14}, 32), projects, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	handler := server.Handler()
	login := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"access_token":"`+testTokenB+`"}`))
	login.Host = "web.example.test"
	login.Header.Set("Origin", config.PublicOrigin)
	login.Header.Set("Content-Type", "application/json")
	loginResponse := httptest.NewRecorder()
	handler.ServeHTTP(loginResponse, login)
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("login status=%d body=%s", loginResponse.Code, loginResponse.Body.String())
	}

	request := authenticatedRequest(t, http.MethodGet, "/api/admin/platform/members", nil, loginResponse.Result().Cookies()[0])
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || path != "/v1/workspace/members" || userID != config.Projects[1].UserID || userName != config.Projects[1].UserID {
		t.Fatalf("status=%d path=%q user_id=%q user_name=%q body=%s", response.Code, path, userID, userName, response.Body.String())
	}
}

func TestBFFComputerAdminRequiresPersistentRoleAndPreservesCSRF(t *testing.T) {
	var mu sync.Mutex
	requests := make([]upstreamRequest, 0, 2)
	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		mu.Lock()
		requests = append(requests, upstreamRequest{Path: request.URL.Path, Body: string(body)})
		mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		if request.Method == http.MethodPost {
			writer.WriteHeader(http.StatusAccepted)
			_, _ = io.WriteString(writer, `{"action":"release","accepted":true,"operation_id":"stop-a"}`)
			return
		}
		_, _ = io.WriteString(writer, `{"computers":[]}`)
	}))
	defer control.Close()

	config := testConfig(t)
	projects := []ProjectRuntime{
		testRuntime(t, config.Projects[0], testTokenA, control.URL),
		testRuntime(t, config.Projects[1], testTokenB, control.URL),
	}
	key := bytes.Repeat([]byte{13}, 32)
	server, err := New(config, key, projects, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := time.Date(2026, 8, 15, 7, 0, 0, 0, time.UTC)
	server.now = func() time.Time { return fixedNow }
	handler := server.Handler()

	login := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"access_token":"`+testTokenB+`"}`))
	login.Host = "web.example.test"
	login.Header.Set("Origin", config.PublicOrigin)
	login.Header.Set("Content-Type", "application/json")
	loginResponse := httptest.NewRecorder()
	handler.ServeHTTP(loginResponse, login)
	var admin sessionResponse
	if loginResponse.Code != http.StatusOK || json.Unmarshal(loginResponse.Body.Bytes(), &admin) != nil || admin.Role != "owner" {
		t.Fatalf("admin login status=%d body=%s", loginResponse.Code, loginResponse.Body.String())
	}
	adminCookie := loginResponse.Result().Cookies()[0]

	list := authenticatedRequest(t, http.MethodGet, "/api/admin/computers", nil, adminCookie)
	listResponse := httptest.NewRecorder()
	handler.ServeHTTP(listResponse, list)
	if listResponse.Code != http.StatusOK {
		t.Fatalf("admin Computer list status=%d body=%s", listResponse.Code, listResponse.Body.String())
	}

	withoutCSRF := authenticatedRequest(t, http.MethodPost, "/api/admin/computers/computer-a/lifecycle", strings.NewReader(`{"action":"release"}`), adminCookie)
	withoutCSRF.Header.Set("Content-Type", "application/json")
	withoutCSRFResponse := httptest.NewRecorder()
	handler.ServeHTTP(withoutCSRFResponse, withoutCSRF)
	if withoutCSRFResponse.Code != http.StatusForbidden || !strings.Contains(withoutCSRFResponse.Body.String(), `"code":"csrf_required"`) {
		t.Fatalf("admin lifecycle without CSRF status=%d body=%s", withoutCSRFResponse.Code, withoutCSRFResponse.Body.String())
	}

	release := authenticatedRequest(t, http.MethodPost, "/api/admin/computers/computer-a/lifecycle", strings.NewReader(`{"action":"release"}`), adminCookie)
	release.Header.Set("Content-Type", "application/json")
	release.Header.Set("Origin", config.PublicOrigin)
	release.Header.Set("X-CSRF-Token", admin.CSRFToken)
	releaseResponse := httptest.NewRecorder()
	handler.ServeHTTP(releaseResponse, release)
	if releaseResponse.Code != http.StatusAccepted {
		t.Fatalf("admin Computer release status=%d body=%s", releaseResponse.Code, releaseResponse.Body.String())
	}
	mu.Lock()
	forwarded := append([]upstreamRequest(nil), requests...)
	mu.Unlock()
	if len(forwarded) != 2 || forwarded[0].Path != "/v1/agent/computers" || forwarded[1].Path != "/v1/agent/computers/computer-a/lifecycle" || forwarded[1].Body != `{"action":"release"}` {
		t.Fatalf("admin Computer forwarding=%#v", forwarded)
	}

	inviteURL, err := IssueInviteURL(key, config.PublicOrigin, "project-b", "member-b", fixedNow, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(inviteURL)
	if err != nil {
		t.Fatal(err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	invite := httptest.NewRequest(http.MethodPost, "/auth/invite", strings.NewReader(`{"invite_token":"`+fragment.Get("invite")+`"}`))
	invite.Host = "web.example.test"
	invite.Header.Set("Origin", config.PublicOrigin)
	invite.Header.Set("Content-Type", "application/json")
	inviteResponse := httptest.NewRecorder()
	handler.ServeHTTP(inviteResponse, invite)
	memberCookie := inviteResponse.Result().Cookies()[0]
	memberList := authenticatedRequest(t, http.MethodGet, "/api/admin/computers", nil, memberCookie)
	memberListResponse := httptest.NewRecorder()
	handler.ServeHTTP(memberListResponse, memberList)
	if memberListResponse.Code != http.StatusForbidden || !strings.Contains(memberListResponse.Body.String(), `"code":"administrator_required"`) {
		t.Fatalf("member Computer admin status=%d body=%s", memberListResponse.Code, memberListResponse.Body.String())
	}
	mu.Lock()
	requestCount := len(requests)
	mu.Unlock()
	if requestCount != 2 {
		t.Fatalf("member Computer request reached Control: %d", requestCount)
	}
	viewerValue, viewerClaims, err := server.issueSession(projects[1], "viewer-user", "Viewer", "invite", "viewer")
	if err != nil {
		t.Fatal(err)
	}
	viewerCookie := &http.Cookie{Name: config.CookieName, Value: viewerValue}
	viewerSubmit := authenticatedRequest(t, http.MethodPost, "/api/agent/sessions", strings.NewReader(`{"id":"viewer-task","computer_id":"computer-a","session_id":"viewer-session","prompt":"deny"}`), viewerCookie)
	viewerSubmit.Header.Set("Content-Type", "application/json")
	viewerSubmit.Header.Set("X-CSRF-Token", viewerClaims.CSRF)
	viewerSubmitResponse := httptest.NewRecorder()
	handler.ServeHTTP(viewerSubmitResponse, viewerSubmit)
	if viewerSubmitResponse.Code != http.StatusForbidden || !strings.Contains(viewerSubmitResponse.Body.String(), `"code":"task_permission_required"`) {
		t.Fatalf("viewer task submit status=%d body=%s", viewerSubmitResponse.Code, viewerSubmitResponse.Body.String())
	}
}

func TestBrowserWebSocketBridgesAuthenticatedControlSSE(t *testing.T) {
	var upstreamPaths, upstreamQueries []string
	var upstreamCookie, upstreamRequestID string
	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		upstreamPaths = append(upstreamPaths, request.URL.Path)
		upstreamQueries = append(upstreamQueries, request.URL.RawQuery)
		upstreamCookie = request.Header.Get("Cookie")
		upstreamRequestID = request.Header.Get("X-Request-ID")
		writer.Header().Set("Content-Type", "text/event-stream")
		writer.WriteHeader(http.StatusOK)
		if len(upstreamPaths) == 1 {
			_, _ = io.WriteString(writer, "retry: 1000\n\nevent: session\ndata: {\"id\":\"turn-stream\",\"computer_id\":\"cloud-smoke\",\"session_id\":\"session-stream\",\"state\":\"running\"}\n\nevent: task-event\nid: 5\ndata: {\"cursor\":5,\"type\":\"exec.output\"}\n\n: keepalive\n\n")
			return
		}
		_, _ = io.WriteString(writer, "event: session\ndata: {\"id\":\"turn-stream\",\"computer_id\":\"cloud-smoke\",\"session_id\":\"session-stream\",\"state\":\"succeeded\"}\n\n")
	}))
	defer control.Close()

	var handler http.Handler
	web := httptest.NewUnstartedServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		handler.ServeHTTP(writer, request)
	}))
	web.StartTLS()
	defer web.Close()

	config := testConfig(t)
	config.PublicOrigin = web.URL
	config.Projects = config.Projects[:1]
	projects := []ProjectRuntime{testRuntime(t, config.Projects[0], testTokenA, control.URL)}
	server, err := New(config, bytes.Repeat([]byte{7}, 32), projects, nil)
	if err != nil {
		t.Fatal(err)
	}
	server.now = func() time.Time { return time.Date(2026, 8, 9, 8, 0, 0, 0, time.UTC) }
	handler = server.Handler()
	cookieValue, _, err := server.issueSession(projects[0], "user-a", "User A", "invite", "member")
	if err != nil {
		t.Fatal(err)
	}

	socketURL := "wss" + strings.TrimPrefix(web.URL, "https") + "/api/agent/sessions/turn-stream/stream/socket?after=4&limit=1000&ignored=secret"
	socketConfig, err := websocket.NewConfig(socketURL, web.URL)
	if err != nil {
		t.Fatal(err)
	}
	socketConfig.Protocol = []string{browserStreamProtocol}
	socketConfig.Header.Set("Cookie", config.CookieName+"="+cookieValue)
	socketConfig.TlsConfig = &tls.Config{InsecureSkipVerify: true} // #nosec G402 -- httptest certificate only.
	connection, err := websocket.DialConfig(socketConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()

	frames := make([]browserStreamFrame, 4)
	for index := range frames {
		if err := websocket.JSON.Receive(connection, &frames[index]); err != nil {
			t.Fatalf("receive frame %d: %v", index, err)
		}
	}
	if frames[0].Type != "session" || frames[1].Type != "task-event" || frames[1].Cursor != 5 || frames[2].Type != "keepalive" || frames[3].Type != "session" || !strings.Contains(string(frames[3].Data), `"state":"succeeded"`) {
		t.Fatalf("frames = %#v", frames)
	}
	if len(upstreamPaths) != 2 || upstreamPaths[0] != "/v1/agent/sessions/turn-stream/stream" || upstreamPaths[1] != upstreamPaths[0] || upstreamQueries[0] != "after=4&limit=1000" || upstreamQueries[1] != "after=5&limit=1000" || upstreamCookie != "" || upstreamRequestID == "" {
		t.Fatalf("upstream paths=%q queries=%q cookie=%q request_id=%q", upstreamPaths, upstreamQueries, upstreamCookie, upstreamRequestID)
	}
}

func TestBFFServesWorkspaceOnlyOnConfiguredHost(t *testing.T) {
	config := testConfig(t)
	projects := []ProjectRuntime{
		testRuntime(t, config.Projects[0], testTokenA, "http://127.0.0.1:1"),
		testRuntime(t, config.Projects[1], testTokenB, "http://127.0.0.1:1"),
	}
	server, err := New(config, bytes.Repeat([]byte{5}, 32), projects, nil)
	if err != nil {
		t.Fatal(err)
	}
	handler := server.Handler()
	// Fingerprinted Vite assets are separately verified in web/client/app. The
	// BFF boundary only needs to prove that the public application entrypoint
	// remains available without an authenticated browser session.
	for _, path := range []string{"/", "/index.html", "/new", "/sessions/session-123", "/admin", "/admin/platform"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Host = "web.example.test"
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK || response.Header().Get("Content-Security-Policy") == "" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("static %s status=%d headers=%v body=%s", path, response.Code, response.Header(), response.Body.String())
		}
	}
	for _, path := range []string{"/sessions/", "/sessions/a/files", "/admin/computers", "/admin/computers/node-a", "/settings"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Host = "web.example.test"
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("unknown application path %s status=%d", path, response.Code)
		}
	}
	wrongHost := httptest.NewRequest(http.MethodGet, "/", nil)
	wrongHost.Host = "attacker.example"
	wrongHostResponse := httptest.NewRecorder()
	handler.ServeHTTP(wrongHostResponse, wrongHost)
	if wrongHostResponse.Code != http.StatusForbidden {
		t.Fatalf("wrong Host static status=%d", wrongHostResponse.Code)
	}
}

func TestBFFRedeemsTimeLimitedInviteWithoutLoggingToken(t *testing.T) {
	config := testConfig(t)
	projects := []ProjectRuntime{
		testRuntime(t, config.Projects[0], testTokenA, "http://127.0.0.1:1"),
		testRuntime(t, config.Projects[1], testTokenB, "http://127.0.0.1:1"),
	}
	var bootstrapHeader string
	baseTransport := projects[1].Transport
	projects[1].Transport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/v1/workspace/me" && request.Header.Get("X-ZapVM-User-ID") == "invited-user" {
			bootstrapHeader = request.Header.Get("X-ZapVM-Bootstrap-Owner")
		}
		return baseTransport.RoundTrip(request)
	})
	key := bytes.Repeat([]byte{6}, 32)
	var logs bytes.Buffer
	server, err := New(config, key, projects, log.New(&logs, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := time.Date(2026, 8, 8, 5, 0, 0, 0, time.UTC)
	server.now = func() time.Time { return fixedNow }
	inviteURL, err := IssueInviteURL(key, config.PublicOrigin, "project-b", "invited-user", fixedNow, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(inviteURL)
	if err != nil {
		t.Fatal(err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	token := fragment.Get("invite")
	request := httptest.NewRequest(http.MethodPost, "/auth/invite", strings.NewReader(`{"invite_token":"`+token+`"}`))
	request.Host = "web.example.test"
	request.Header.Set("Origin", config.PublicOrigin)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), token) || strings.Contains(logs.String(), token) {
		t.Fatalf("invite status=%d body=%s logs=%s", response.Code, response.Body.String(), logs.String())
	}
	var session sessionResponse
	if err := json.Unmarshal(response.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	if session.ProjectID != "project-b" || session.UserID != "invited-user" || session.AuthMethod != "invite" || session.Role != "member" {
		t.Fatalf("invite session = %#v", session)
	}
	if bootstrapHeader != "owner" {
		t.Fatalf("signed invite bootstrap header=%q", bootstrapHeader)
	}
	if cookies := response.Result().Cookies(); len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("invite cookies = %#v", cookies)
	}

	server.now = func() time.Time { return fixedNow.Add(2 * time.Hour) }
	expired := httptest.NewRequest(http.MethodPost, "/auth/invite", strings.NewReader(`{"invite_token":"`+token+`"}`))
	expired.Host = "web.example.test"
	expired.Header.Set("Origin", config.PublicOrigin)
	expired.Header.Set("Content-Type", "application/json")
	expiredResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(expiredResponse, expired)
	if expiredResponse.Code != http.StatusUnauthorized || !strings.Contains(expiredResponse.Body.String(), `"code":"invalid_invite"`) {
		t.Fatalf("expired invite status=%d body=%s", expiredResponse.Code, expiredResponse.Body.String())
	}
}

func TestBFFRejectsCrossOriginTamperingAndExpiredSession(t *testing.T) {
	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		t.Fatal("denied request reached upstream")
	}))
	defer control.Close()
	config := testConfig(t)
	projects := []ProjectRuntime{
		testRuntime(t, config.Projects[0], testTokenA, control.URL),
		testRuntime(t, config.Projects[1], testTokenB, control.URL),
	}
	server, err := New(config, bytes.Repeat([]byte{9}, 32), projects, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 7, 9, 0, 0, 0, time.UTC)
	server.now = func() time.Time { return now }
	handler := server.Handler()

	wrongOrigin := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"access_token":"`+testTokenA+`"}`))
	wrongOrigin.Host = "web.example.test"
	wrongOrigin.Header.Set("Origin", "https://attacker.example")
	wrongOrigin.Header.Set("Content-Type", "application/json")
	wrongOriginResponse := httptest.NewRecorder()
	handler.ServeHTTP(wrongOriginResponse, wrongOrigin)
	if wrongOriginResponse.Code != http.StatusForbidden {
		t.Fatalf("cross origin login status=%d", wrongOriginResponse.Code)
	}

	value, claims, err := server.issueSession(projects[0], projects[0].UserID, projects[0].UserID, "token", "owner")
	if err != nil {
		t.Fatal(err)
	}
	cookie := &http.Cookie{Name: config.CookieName, Value: value}
	tampered := *cookie
	parts := strings.Split(value, ".")
	if len(parts) != 2 {
		t.Fatal("issued session cookie is malformed")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(signature) == 0 {
		t.Fatalf("decode session signature: %v", err)
	}
	signature[0] ^= 0x01
	tampered.Value = parts[0] + "." + base64.RawURLEncoding.EncodeToString(signature)
	tamperedRequest := authenticatedRequest(t, http.MethodGet, "/api/session", nil, &tampered)
	tamperedResponse := httptest.NewRecorder()
	handler.ServeHTTP(tamperedResponse, tamperedRequest)
	if tamperedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("tampered session status=%d", tamperedResponse.Code)
	}

	now = time.Unix(claims.ExpiresAt+1, 0)
	expiredRequest := authenticatedRequest(t, http.MethodGet, "/api/session", nil, cookie)
	expiredResponse := httptest.NewRecorder()
	handler.ServeHTTP(expiredResponse, expiredRequest)
	if expiredResponse.Code != http.StatusUnauthorized {
		t.Fatalf("expired session status=%d", expiredResponse.Code)
	}
}

func TestConfigRejectsBrowserSelectedOrInsecureIdentityInputs(t *testing.T) {
	config := testConfig(t)
	config.PublicOrigin = "http://public.example"
	if err := config.Validate(); err == nil {
		t.Fatal("insecure public origin was accepted")
	}
	config = testConfig(t)
	config.Projects[1].AccessTokenHash = config.Projects[0].AccessTokenHash
	if err := config.Validate(); err == nil {
		t.Fatal("duplicate access token hashes were accepted")
	}
	config = testConfig(t)
	config.Projects[0].ControlURL = "http://control.example"
	if err := config.Validate(); err == nil {
		t.Fatal("insecure Control origin was accepted")
	}
	config = testConfig(t)
	config.Projects[0].RuntimeProfile.ProviderBaseURL = "http://provider.example/v1"
	if err := config.Validate(); err == nil {
		t.Fatal("insecure runtime provider origin was accepted")
	}
	config = testConfig(t)
	config.Projects[0].RuntimeProfile.SearchCredentialID = "model-api-key"
	if err := config.Validate(); err == nil {
		t.Fatal("duplicate runtime credential authority was accepted")
	}
	config = testConfig(t)
	config.PublicOrigin = "http://127.0.0.1:8080"
	config.DevelopmentHTTP = true
	config.CookieName = ""
	if err := config.Validate(); err != nil || config.CookieName != "zapvm_session" {
		t.Fatalf("loopback development config = %q, %v", config.CookieName, err)
	}
}

func testConfig(t *testing.T) Config {
	t.Helper()
	return Config{
		SchemaVersion: 1, Listen: "127.0.0.1:8080", PublicOrigin: "https://web.example.test",
		CookieName: "__Host-zapvm_session", SigningKey: "/owner/signing-key", SessionSeconds: 3600,
		Projects: []ProjectConfig{
			testProject("project-a", "user-a", testTokenA),
			testProject("project-b", "user-b", testTokenB),
		},
	}
}

func testProject(id, userID, token string) ProjectConfig {
	digest := sha256.Sum256([]byte(token))
	return ProjectConfig{
		ID: id, UserID: userID, DisplayName: id, AccessTokenHash: hex.EncodeToString(digest[:]),
		ControlURL: "https://control.example.test", ServerCA: "/owner/ca.pem", Certificate: "/owner/client.pem", PrivateKey: "/owner/client.key",
		ClientURI: "spiffe://example.test/tenant/" + id + "/project/default/client/web", ControlURI: "spiffe://example.test/control/cloud",
		RuntimeProfile: RuntimeProfile{ID: "default", DisplayName: "Default Agent", ProviderBaseURL: "https://api.example.test/v1", Model: "model-1", ModelCredentialID: "model-api-key"},
	}
}

func testRuntime(t *testing.T, project ProjectConfig, token, control string) ProjectRuntime {
	t.Helper()
	parsed, err := url.Parse(control)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(token))
	return ProjectRuntime{
		ID: project.ID, UserID: project.UserID, DisplayName: project.DisplayName, RuntimeProfile: project.RuntimeProfile, TokenHash: digest,
		ControlURL: parsed, Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			if request.URL.Path == "/v1/workspace/me" {
				role := "member"
				if request.Header.Get("X-ZapVM-User-ID") == project.UserID {
					role = "owner"
				} else if request.Header.Get("X-ZapVM-User-ID") == "viewer-user" {
					role = "viewer"
				}
				body := `{"user_id":"` + request.Header.Get("X-ZapVM-User-ID") + `","display_name":"Test User","email":"","role":"` + role + `","status":"active","created_at":"2026-08-15T19:00:00Z","updated_at":"2026-08-15T19:00:00Z"}`
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
			}
			if request.URL.Path == "/v1/workspace/runtime" {
				return &http.Response{StatusCode: http.StatusNotFound, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"error":{"code":"not_found"}}`)), Request: request}, nil
			}
			return http.DefaultTransport.RoundTrip(request)
		}),
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (function roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func authenticatedRequest(t *testing.T, method, target string, body io.Reader, cookie *http.Cookie) *http.Request {
	t.Helper()
	request := httptest.NewRequest(method, target, body)
	request.Host = "web.example.test"
	request.AddCookie(cookie)
	return request
}
