package webbff

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	webapp "zapvm/web/client/app"
)

const (
	maxLoginBody = 2048
	maxProxyBody = 256 << 10
)

type Server struct {
	publicOrigin string
	publicHost   string
	socketOrigin string
	cookieName   string
	secureCookie bool
	signingKey   []byte
	sessionTTL   time.Duration
	projects     map[string]ProjectRuntime
	proxies      map[string]*httputil.ReverseProxy
	now          func() time.Time
	logger       *log.Logger
	requests     chan struct{}
	loginSlots   chan struct{}
	mu           sync.Mutex
	active       map[string]int
	streams      map[string]int
	static       http.Handler
	oidc         *oidcRuntime
}

type loginRequest struct {
	AccessToken string `json:"access_token"`
}

type inviteRequest struct {
	InviteToken string `json:"invite_token"`
}

type sessionResponse struct {
	Authenticated   bool                   `json:"authenticated"`
	ProjectID       string                 `json:"project_id"`
	UserID          string                 `json:"user_id"`
	DisplayName     string                 `json:"display_name,omitempty"`
	UserDisplayName string                 `json:"user_display_name,omitempty"`
	AuthMethod      string                 `json:"auth_method"`
	Role            string                 `json:"role"`
	CSRFToken       string                 `json:"csrf_token"`
	ExpiresAt       string                 `json:"expires_at"`
	RuntimeProfile  *sessionRuntimeProfile `json:"runtime_profile,omitempty"`
}

type sessionRuntimeProfile struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name,omitempty"`
	Model       string `json:"model"`
}

type browserAgentSessionSubmit struct {
	ID         string `json:"id"`
	ComputerID string `json:"computer_id"`
	SessionID  string `json:"session_id"`
	Title      string `json:"title,omitempty"`
	Prompt     string `json:"prompt"`
	Continue   bool   `json:"continue,omitempty"`
}

type upstreamAgentSessionSubmit struct {
	browserAgentSessionSubmit
	ProviderBaseURL    string `json:"provider_base_url"`
	Model              string `json:"model"`
	ModelCredentialID  string `json:"model_credential_id"`
	SearchCredentialID string `json:"search_credential_id,omitempty"`
	MaxTurns           uint16 `json:"max_turns"`
	TimeoutMillis      uint64 `json:"timeout_ms"`
}

func New(config Config, signingKey []byte, projects []ProjectRuntime, logger *log.Logger) (*Server, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if len(signingKey) != 32 {
		return nil, errors.New("Web BFF signing key must be 32 bytes")
	}
	if len(projects) != len(config.Projects) {
		return nil, errors.New("Web BFF project runtime count does not match config")
	}
	if logger == nil {
		logger = log.New(io.Discard, "", 0)
	}
	publicOrigin, _ := url.Parse(config.PublicOrigin)
	socketScheme := "wss"
	if publicOrigin.Scheme == "http" {
		socketScheme = "ws"
	}
	server := &Server{
		publicOrigin: config.PublicOrigin, publicHost: publicOrigin.Host, socketOrigin: socketScheme + "://" + publicOrigin.Host, cookieName: config.CookieName, secureCookie: strings.HasPrefix(config.PublicOrigin, "https://"),
		signingKey: append([]byte(nil), signingKey...), sessionTTL: time.Duration(config.SessionSeconds) * time.Second,
		projects: make(map[string]ProjectRuntime, len(projects)), proxies: make(map[string]*httputil.ReverseProxy, len(projects)),
		now: time.Now, logger: logger, requests: make(chan struct{}, 128), loginSlots: make(chan struct{}, 8), active: make(map[string]int), streams: make(map[string]int),
		static: webapp.Handler(),
	}
	if config.OIDC != nil {
		oidcRuntime, err := newOIDCRuntime(*config.OIDC, config.PublicOrigin)
		if err != nil {
			return nil, err
		}
		server.oidc = oidcRuntime
	}
	for _, project := range projects {
		if !canonicalName(project.ID) || !canonicalName(project.UserID) || project.ControlURL == nil || project.Transport == nil {
			return nil, errors.New("Web BFF project runtime is invalid")
		}
		if _, exists := server.projects[project.ID]; exists {
			return nil, errors.New("Web BFF project runtimes must be unique")
		}
		server.projects[project.ID] = project
		server.proxies[project.ID] = server.newProxy(project)
	}
	return server, nil
}

func (server *Server) Handler() http.Handler {
	return server.securityHeaders(server.limitRequests(http.HandlerFunc(server.route)))
}

func (server *Server) route(writer http.ResponseWriter, request *http.Request) {
	requestID := newRequestID()
	writer.Header().Set("X-Request-ID", requestID)
	if request.URL.Path == "/healthz" && request.Method == http.MethodGet {
		writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	if !server.sameOrigin(request) {
		server.audit(requestID, "", "", request.Method, request.URL.Path, "origin_denied")
		writeError(writer, http.StatusForbidden, "forbidden")
		return
	}
	if (request.Method == http.MethodGet || request.Method == http.MethodHead) && webapp.PublicPath(request.URL.Path) {
		server.static.ServeHTTP(writer, request)
		return
	}
	switch {
	case request.URL.Path == "/auth/options":
		server.authOptions(writer, request)
		return
	case request.URL.Path == "/auth/login":
		server.login(writer, request, requestID)
		return
	case request.URL.Path == "/auth/invite":
		server.redeemInvite(writer, request, requestID)
		return
	case request.URL.Path == "/auth/oidc/start":
		server.beginOIDC(writer, request, requestID)
		return
	case request.URL.Path == "/auth/oidc/callback":
		server.finishOIDC(writer, request, requestID)
		return
	}
	project, claims, err := server.authenticate(request)
	if err != nil {
		server.audit(requestID, "", "", request.Method, request.URL.Path, "unauthenticated")
		server.clearSessionCookie(writer)
		writeError(writer, http.StatusUnauthorized, "unauthenticated")
		return
	}
	if strings.HasPrefix(request.URL.Path, "/api/") {
		role, roleErr := server.resolveWorkspaceRole(request.Context(), project, claims.UserID, claims.UserName, false)
		if roleErr != nil {
			server.audit(requestID, project.ID, claims.UserID, request.Method, request.URL.Path, "workspace_membership_required")
			writeError(writer, http.StatusForbidden, "workspace_membership_required")
			return
		}
		claims.Role = role
	}
	if request.URL.Path == "/api/session" {
		if request.Method != http.MethodGet {
			writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		server.writeSession(writer, project, claims)
		return
	}
	if request.URL.Path == "/auth/logout" {
		if request.Method != http.MethodPost {
			writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		if !validCSRF(request, claims) {
			server.audit(requestID, project.ID, project.UserID, request.Method, request.URL.Path, "csrf_denied")
			writeError(writer, http.StatusForbidden, "csrf_required")
			return
		}
		server.clearSessionCookie(writer)
		server.audit(requestID, project.ID, project.UserID, request.Method, request.URL.Path, "logout")
		writer.WriteHeader(http.StatusNoContent)
		return
	}
	originalPath := request.URL.Path
	if strings.HasPrefix(request.URL.Path, "/api/admin/") || request.URL.Path == "/api/admin" {
		mapped, platform := adminPlatformPath(request.URL.Path)
		var ok bool
		if platform {
			request.URL.Path = mapped
		} else if claims.Role != "owner" && claims.Role != "admin" && claims.Role != "operator" {
			server.audit(requestID, project.ID, claims.UserID, request.Method, request.URL.Path, "administrator_required")
			writeError(writer, http.StatusForbidden, "administrator_required")
			return
		} else {
			mapped, ok = adminComputerAgentPath(request.URL.Path, request.Method)
			if !ok {
				writeError(writer, http.StatusNotFound, "not_found")
				return
			}
			request.URL.Path = mapped
		}
	}
	if !strings.HasPrefix(request.URL.Path, "/api/agent/") && request.URL.Path != "/api/agent" && !strings.HasPrefix(request.URL.Path, "/v1/workspace/") {
		writeError(writer, http.StatusNotFound, "not_found")
		return
	}
	if strings.HasPrefix(request.URL.Path, "/api/agent/") && request.Method != http.MethodGet && request.Method != http.MethodHead && claims.Role == "viewer" {
		server.audit(requestID, project.ID, claims.UserID, request.Method, originalPath, "task_permission_required")
		writeError(writer, http.StatusForbidden, "task_permission_required")
		return
	}
	if request.URL.RawPath != "" || request.URL.EscapedPath() != request.URL.Path {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	if taskID, ok := browserStreamTaskID(request.URL.Path); ok {
		server.streamAgentSession(writer, request, requestID, project, claims, taskID)
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodHead && !validCSRF(request, claims) {
		server.audit(requestID, project.ID, project.UserID, request.Method, request.URL.Path, "csrf_denied")
		writeError(writer, http.StatusForbidden, "csrf_required")
		return
	}
	release, ok := server.acquireProject(project.ID)
	if !ok {
		writeError(writer, http.StatusTooManyRequests, "rate_limited")
		return
	}
	defer release()
	request.Body = http.MaxBytesReader(writer, request.Body, maxProxyBody)
	if request.Method == http.MethodPost && request.URL.Path == "/api/agent/sessions" {
		browser, err := decodeBrowserAgentSession(request)
		if err != nil {
			writeError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		profile, configured, err := server.resolveComputerRuntime(request.Context(), project, claims.UserID, claims.UserName, browser.ComputerID)
		if err != nil {
			writeError(writer, http.StatusServiceUnavailable, "runtime_configuration_unavailable")
			return
		}
		if !configured {
			profile, configured = project.RuntimeProfile, project.RuntimeProfile.configured()
		}
		if err := encodeAgentSessionRequest(request, browser, profile, configured); err != nil {
			writeError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
	}
	request.Header.Set("X-Request-ID", requestID)
	request.Header.Set("X-ZapVM-User-ID", claims.UserID)
	request.Header.Set("X-ZapVM-User-Name", claims.UserName)
	request.Header.Del("X-ZapVM-User-Email")
	request.Header.Del("X-ZapVM-Bootstrap-Owner")
	server.audit(requestID, project.ID, project.UserID, request.Method, originalPath, "forwarded")
	server.proxies[project.ID].ServeHTTP(writer, request)
}

func (server *Server) login(writer http.ResponseWriter, request *http.Request, requestID string) {
	if request.Method != http.MethodPost {
		writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if request.Header.Get("Origin") != server.publicOrigin || !jsonContentType(request.Header.Get("Content-Type")) {
		writeError(writer, http.StatusForbidden, "forbidden")
		return
	}
	select {
	case server.loginSlots <- struct{}{}:
		defer func() { <-server.loginSlots }()
	default:
		writeError(writer, http.StatusTooManyRequests, "rate_limited")
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, maxLoginBody)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var body loginRequest
	if err := decoder.Decode(&body); err != nil || len(body.AccessToken) < 32 || len(body.AccessToken) > 512 {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	project, ok := matchAccessToken(server.projects, body.AccessToken)
	if !ok {
		server.audit(requestID, "", "", request.Method, request.URL.Path, "login_denied")
		writeError(writer, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	role, err := server.resolveWorkspaceRole(request.Context(), project, project.UserID, project.UserID, true)
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "workspace_authorization_unavailable")
		return
	}
	value, claims, err := server.issueSession(project, project.UserID, project.UserID, "token", role)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	server.setSessionCookie(writer, value, time.Unix(claims.ExpiresAt, 0))
	server.audit(requestID, project.ID, project.UserID, request.Method, request.URL.Path, "login")
	server.writeSession(writer, project, claims)
}

func (server *Server) redeemInvite(writer http.ResponseWriter, request *http.Request, requestID string) {
	if request.Method != http.MethodPost || request.Header.Get("Origin") != server.publicOrigin || !jsonContentType(request.Header.Get("Content-Type")) {
		writeError(writer, http.StatusForbidden, "forbidden")
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, 8<<10)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var body inviteRequest
	if err := decoder.Decode(&body); err != nil || len(body.InviteToken) < 64 || len(body.InviteToken) > 4096 {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	project, invite, err := server.verifyInvite(body.InviteToken)
	if err != nil {
		server.audit(requestID, "", "", request.Method, request.URL.Path, "invite_denied")
		writeError(writer, http.StatusUnauthorized, "invalid_invite")
		return
	}
	// A signed invitation is an administrator-issued credential. Allow it to
	// bootstrap the first Workspace owner, while the Control transaction still
	// requires every later invitee to exist in the persistent member table.
	role, err := server.resolveWorkspaceRole(request.Context(), project, invite.UserID, invite.UserID, true)
	if err != nil {
		writeError(writer, http.StatusForbidden, "workspace_membership_required")
		return
	}
	value, claims, err := server.issueSession(project, invite.UserID, invite.UserID, "invite", role)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	server.setSessionCookie(writer, value, time.Unix(claims.ExpiresAt, 0))
	server.audit(requestID, project.ID, invite.UserID, request.Method, request.URL.Path, "invite_redeemed")
	server.writeSession(writer, project, claims)
}

func (server *Server) writeSession(writer http.ResponseWriter, project ProjectRuntime, claims sessionClaims) {
	var runtimeProfile *sessionRuntimeProfile
	if project.RuntimeProfile.configured() {
		runtimeRuntime := project.RuntimeProfile
		runtimeProfile = &sessionRuntimeProfile{ID: runtimeRuntime.ID, DisplayName: runtimeRuntime.DisplayName, Model: runtimeRuntime.Model}
	}
	authMethod := claims.AuthMethod
	if authMethod == "" {
		authMethod = "token"
	}
	writeJSON(writer, http.StatusOK, sessionResponse{
		Authenticated: true, ProjectID: project.ID, UserID: claims.UserID, DisplayName: project.DisplayName,
		UserDisplayName: claims.UserName, AuthMethod: authMethod, Role: claims.Role,
		CSRFToken: claims.CSRF, ExpiresAt: time.Unix(claims.ExpiresAt, 0).UTC().Format(time.RFC3339),
		RuntimeProfile: runtimeProfile,
	})
}

func adminPlatformPath(path string) (string, bool) {
	const prefix = "/api/admin/platform"
	if path != prefix && !strings.HasPrefix(path, prefix+"/") {
		return "", false
	}
	remainder := strings.TrimPrefix(path, prefix)
	if remainder == "" {
		remainder = "/me"
	}
	return "/v1/workspace" + remainder, true
}

func adminComputerAgentPath(path, method string) (string, bool) {
	if path == "/api/admin/computers" && method == http.MethodGet {
		return "/api/agent/computers", true
	}
	const prefix = "/api/admin/computers/"
	if !strings.HasPrefix(path, prefix) || method != http.MethodPost {
		return "", false
	}
	remainder := strings.TrimPrefix(path, prefix)
	parts := strings.Split(remainder, "/")
	if len(parts) != 2 || !browserComputerID(parts[0]) || parts[1] != "lifecycle" {
		return "", false
	}
	return "/api/agent/computers/" + parts[0] + "/lifecycle", true
}

func browserComputerID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && character != '.' && character != '_' && character != '-' {
			return false
		}
	}
	return true
}

func decodeBrowserAgentSession(request *http.Request) (browserAgentSessionSubmit, error) {
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var browser browserAgentSessionSubmit
	if err := decoder.Decode(&browser); err != nil {
		return browserAgentSessionSubmit{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return browserAgentSessionSubmit{}, errors.New("Agent request contains trailing JSON")
	}
	return browser, nil
}

func encodeAgentSessionRequest(request *http.Request, browser browserAgentSessionSubmit, profile RuntimeProfile, configured bool) error {
	var value any = browser
	if configured {
		value = upstreamAgentSessionSubmit{
			browserAgentSessionSubmit: browser,
			ProviderBaseURL:           profile.ProviderBaseURL,
			Model:                     profile.Model,
			ModelCredentialID:         profile.ModelCredentialID,
			SearchCredentialID:        profile.SearchCredentialID,
			MaxTurns:                  profile.MaxTurns,
			TimeoutMillis:             uint64(profile.TimeoutSeconds) * 1000,
		}
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	request.Body = io.NopCloser(bytes.NewReader(payload))
	request.ContentLength = int64(len(payload))
	return nil
}

func (server *Server) newProxy(project ProjectRuntime) *httputil.ReverseProxy {
	proxy := &httputil.ReverseProxy{Transport: project.Transport, FlushInterval: -1}
	proxy.Rewrite = func(proxyRequest *httputil.ProxyRequest) {
		requestID := proxyRequest.In.Header.Get("X-Request-ID")
		proxyRequest.Out.URL.Scheme = project.ControlURL.Scheme
		proxyRequest.Out.URL.Host = project.ControlURL.Host
		if strings.HasPrefix(proxyRequest.In.URL.Path, "/api/agent") {
			proxyRequest.Out.URL.Path = "/v1/agent" + strings.TrimPrefix(proxyRequest.In.URL.Path, "/api/agent")
		} else {
			proxyRequest.Out.URL.Path = proxyRequest.In.URL.Path
		}
		proxyRequest.Out.URL.RawPath = ""
		proxyRequest.Out.Host = project.ControlURL.Host
		proxyRequest.Out.Header = make(http.Header)
		for _, name := range []string{"Accept", "Content-Type", "Last-Event-ID", "X-ZapVM-User-ID", "X-ZapVM-User-Name"} {
			if value := proxyRequest.In.Header.Get(name); value != "" {
				proxyRequest.Out.Header.Set(name, value)
			}
		}
		proxyRequest.Out.Header.Set("X-Request-ID", requestID)
	}
	proxy.ModifyResponse = func(response *http.Response) error {
		contentType := response.Header.Get("Content-Type")
		cacheControl := response.Header.Get("Cache-Control")
		apiVersion := response.Header.Get("X-ZapVM-API-Version")
		buffering := response.Header.Get("X-Accel-Buffering")
		response.Header = make(http.Header)
		if contentType != "" {
			response.Header.Set("Content-Type", contentType)
		}
		if cacheControl != "" {
			response.Header.Set("Cache-Control", cacheControl)
		}
		if apiVersion != "" {
			response.Header.Set("X-ZapVM-API-Version", apiVersion)
		}
		if buffering != "" {
			response.Header.Set("X-Accel-Buffering", buffering)
		}
		return nil
	}
	proxy.ErrorHandler = func(writer http.ResponseWriter, request *http.Request, err error) {
		server.logger.Printf("request_id=%s component=web_bff result=upstream_error", request.Header.Get("X-Request-ID"))
		writeError(writer, http.StatusBadGateway, "control_unavailable")
	}
	return proxy
}

func (server *Server) sameOrigin(request *http.Request) bool {
	origin := request.Header.Get("Origin")
	return request.Host == server.publicHost && (origin == "" || origin == server.publicOrigin)
}

func validCSRF(request *http.Request, claims sessionClaims) bool {
	provided := request.Header.Get("X-CSRF-Token")
	return len(provided) == len(claims.CSRF) && hmac.Equal([]byte(provided), []byte(claims.CSRF))
}

func jsonContentType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	return err == nil && mediaType == "application/json"
}

func (server *Server) acquireProject(projectID string) (func(), bool) {
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.active[projectID] >= 8 {
		return nil, false
	}
	server.active[projectID]++
	return func() {
		server.mu.Lock()
		server.active[projectID]--
		server.mu.Unlock()
	}, true
}

func (server *Server) acquireStream(projectID string) (func(), bool) {
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.streams[projectID] >= 32 {
		return nil, false
	}
	server.streams[projectID]++
	return func() {
		server.mu.Lock()
		server.streams[projectID]--
		server.mu.Unlock()
	}, true
}

func (server *Server) limitRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		select {
		case server.requests <- struct{}{}:
			defer func() { <-server.requests }()
			next.ServeHTTP(writer, request)
		default:
			writeError(writer, http.StatusServiceUnavailable, "overloaded")
		}
	})
}

func (server *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self' "+server.socketOrigin)
		writer.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		writer.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(writer, request)
	})
}

func (server *Server) audit(requestID, projectID, userID, method, path, result string) {
	server.logger.Printf("request_id=%s component=web_bff project=%s user=%s method=%s path=%s result=%s", requestID, projectID, userID, method, path, result)
}

func newRequestID() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "unavailable"
	}
	return base64.RawURLEncoding.EncodeToString(value)
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, code string) {
	category, action, retryable := "request", "fix_request", false
	switch code {
	case "unauthenticated", "invalid_credentials", "invalid_invite":
		category, action = "authentication", "login"
	case "csrf_required":
		category, action = "session", "refresh"
	case "forbidden":
		category, action = "authorization", "contact_admin"
	case "not_found":
		category, action = "not_found", "refresh"
	case "conflict":
		category, action = "conflict", "refresh"
	case "control_unavailable", "overloaded", "internal_error":
		category, action, retryable = "infrastructure", "retry", true
	case "rate_limited":
		category, action, retryable = "rate_limit", "retry", true
	}
	writeJSON(writer, status, map[string]any{"error": map[string]any{
		"code": code, "category": category, "action": action, "retryable": retryable,
	}})
}
