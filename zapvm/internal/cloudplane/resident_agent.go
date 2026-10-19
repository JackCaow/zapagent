package cloudplane

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"zapvm/internal/credential"
	"zapvm/internal/daemonrpc"
)

const (
	residentAgentBinary    = "/usr/local/sbin/zapvm-resident-agent"
	residentAgentMaxPrompt = 128 << 10
	residentAgentDefaultMS = uint64(2 * 60 * 60 * 1000)
	agentStreamWindow      = 25 * time.Second
)

type residentAgentSubmitRequest struct {
	ID                 string `json:"id"`
	ComputerID         string `json:"computer_id"`
	SessionID          string `json:"session_id"`
	Title              string `json:"title,omitempty"`
	Prompt             string `json:"prompt"`
	ProviderBaseURL    string `json:"provider_base_url"`
	Model              string `json:"model"`
	ModelCredentialID  string `json:"model_credential_id"`
	SearchCredentialID string `json:"search_credential_id,omitempty"`
	Continue           bool   `json:"continue,omitempty"`
	MaxTurns           uint16 `json:"max_turns,omitempty"`
	TimeoutMillis      uint64 `json:"timeout_ms,omitempty"`
}

func (request *residentAgentSubmitRequest) command() (daemonrpc.ComputerTaskSubmitRequest, []string, error) {
	if !computerID(request.ID) || !computerID(request.ComputerID) || !computerID(request.SessionID) {
		return daemonrpc.ComputerTaskSubmitRequest{}, nil, errors.New("resident Agent IDs are invalid")
	}
	if request.Prompt == "" || len(request.Prompt) > residentAgentMaxPrompt || !utf8.ValidString(request.Prompt) || strings.IndexByte(request.Prompt, 0) >= 0 {
		return daemonrpc.ComputerTaskSubmitRequest{}, nil, errors.New("resident Agent prompt is invalid")
	}
	providerURL, err := url.Parse(request.ProviderBaseURL)
	if err != nil || providerURL.Scheme != "https" || providerURL.Host == "" || providerURL.User != nil || providerURL.RawQuery != "" || providerURL.Fragment != "" {
		return daemonrpc.ComputerTaskSubmitRequest{}, nil, errors.New("resident Agent provider_base_url must be an HTTPS URL without credentials, query, or fragment")
	}
	if len(request.ProviderBaseURL) > 2048 || len(request.Model) == 0 || len(request.Model) > 256 || !utf8.ValidString(request.Model) || strings.IndexByte(request.Model, 0) >= 0 {
		return daemonrpc.ComputerTaskSubmitRequest{}, nil, errors.New("resident Agent model is invalid")
	}
	if !credential.ValidID(request.ModelCredentialID) || (request.SearchCredentialID != "" && !credential.ValidID(request.SearchCredentialID)) || request.SearchCredentialID == request.ModelCredentialID {
		return daemonrpc.ComputerTaskSubmitRequest{}, nil, errors.New("resident Agent credential IDs are invalid")
	}
	if request.MaxTurns > 200 {
		return daemonrpc.ComputerTaskSubmitRequest{}, nil, errors.New("resident Agent max_turns exceeds compatibility limit")
	}
	if request.TimeoutMillis == 0 {
		request.TimeoutMillis = residentAgentDefaultMS
	}
	credentials := []string{request.ModelCredentialID}
	artifactOutput, err := daemonrpc.ArtifactOutputPath(request.ID)
	if err != nil {
		return daemonrpc.ComputerTaskSubmitRequest{}, nil, err
	}
	argv := []string{
		residentAgentBinary,
		"--provider-base-url", request.ProviderBaseURL,
		"--model", request.Model,
		"--api-key-credential", request.ModelCredentialID,
		"--artifact-output-dir", artifactOutput,
	}
	if request.SearchCredentialID != "" {
		credentials = append(credentials, request.SearchCredentialID)
		argv = append(argv, "--search-key-credential", request.SearchCredentialID)
	}
	if request.Continue {
		// Keep the continuation bit in the fixed Resident runner authority
		// rather than mixing it into caller-adjacent Zap argv.
		argv = append(argv, "--continue-session")
	}
	argv = append(argv, "--prompt", request.Prompt)
	command := daemonrpc.Command{
		ID: "agent-" + request.ID, SessionID: request.SessionID, Title: strings.TrimSpace(request.Title), Argv: argv, Cwd: ".",
		CredentialIDs: credentials, ProtectedWorkspacePaths: []string{".git", ".zapcode"}, TimeoutMillis: request.TimeoutMillis,
	}
	if err := command.Validate(); err != nil {
		return daemonrpc.ComputerTaskSubmitRequest{}, nil, err
	}
	return daemonrpc.ComputerTaskSubmitRequest{ID: request.ID, ComputerID: request.ComputerID, Command: command}, credentials, nil
}

func (api *API) agentSessions(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		api.listAgentSessions(writer, request)
		return
	case http.MethodPost:
	default:
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	identity, err := api.clientIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "client_identity_required")
		return
	}
	var body residentAgentSubmitRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	command, credentials, err := body.command()
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	payload, err := json.Marshal(command)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	task, created, err := api.store.SubmitAgentSession(identity.URI, SubmitRequest{
		ID: body.ID, Scope: Scope{TenantID: identity.TenantID, ProjectID: identity.ProjectID},
		ComputerID: body.ComputerID, Payload: payload, CredentialIDs: credentials,
	}, body.SessionID, body.Continue)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	response, err := publicAgentSession(task)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	api.logger.Printf("request_id=%s component=control operation=task_submit task_id=%s result=%s", requestID(request), task.ID, map[bool]string{true: "created", false: "replayed"}[created])
	writeJSON(writer, status, response)
}

func (api *API) listAgentSessions(writer http.ResponseWriter, request *http.Request) {
	identity, err := api.clientIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "client_identity_required")
		return
	}
	after, limit, ok := parsePage(request)
	if !ok {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	tasks, next, err := api.store.ListAgentSessions(Scope{TenantID: identity.TenantID, ProjectID: identity.ProjectID}, after, limit)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	sessions := make([]AgentSession, 0, len(tasks))
	for _, task := range tasks {
		session, err := publicAgentSession(task)
		if err != nil {
			writeAPIError(writer, http.StatusInternalServerError, "internal_error")
			return
		}
		sessions = append(sessions, session)
	}
	writeJSON(writer, http.StatusOK, AgentSessionList{Sessions: sessions, NextCursor: next})
}

func (api *API) agentComputers(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	identity, err := api.clientIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "client_identity_required")
		return
	}
	computers, err := api.store.ListAgentComputers(Scope{TenantID: identity.TenantID, ProjectID: identity.ProjectID})
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, AgentComputerList{Computers: computers})
}

func (api *API) agentSession(writer http.ResponseWriter, request *http.Request) {
	identity, err := api.clientIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "client_identity_required")
		return
	}
	remainder := strings.TrimPrefix(request.URL.Path, "/v1/agent/sessions/")
	parts := strings.Split(remainder, "/")
	if len(parts) < 1 || len(parts) > 2 || !computerID(parts[0]) {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	scope := Scope{TenantID: identity.TenantID, ProjectID: identity.ProjectID}
	if len(parts) == 2 {
		if parts[1] == "retry" {
			api.retryAgentSession(writer, request, identity.URI, scope, parts[0])
			return
		}
		if request.Method != http.MethodGet {
			writeAPIError(writer, http.StatusNotFound, "not_found")
			return
		}
		if parts[1] == "stream" {
			api.streamAgentSession(writer, request, scope, parts[0])
			return
		}
		if parts[1] == "artifacts" {
			after, limit, ok := parsePage(request)
			if !ok {
				writeAPIError(writer, http.StatusBadRequest, "invalid_request")
				return
			}
			artifacts, next, err := api.store.ListAgentSessionArtifacts(scope, parts[0], after, limit)
			if err != nil {
				writeStoreError(writer, err)
				return
			}
			views := make([]AgentArtifact, 0, len(artifacts))
			for _, artifact := range artifacts {
				views = append(views, publicAgentArtifact(artifact))
			}
			writeJSON(writer, http.StatusOK, AgentArtifactList{Artifacts: views, NextCursor: next})
			return
		}
		if parts[1] == "transcript" {
			api.agentSessionTranscript(writer, request, scope, parts[0])
			return
		}
		if parts[1] != "events" {
			writeAPIError(writer, http.StatusNotFound, "not_found")
			return
		}
		task, err := api.store.InspectTask(scope, parts[0])
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		if _, err := publicAgentSession(task); err != nil {
			writeAPIError(writer, http.StatusNotFound, "not_found")
			return
		}
		after, limit, ok := parsePage(request)
		if !ok {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		events, err := api.store.TaskEvents(scope, parts[0], after, limit)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, AgentSessionEvents{Events: events})
		return
	}
	var task Task
	switch request.Method {
	case http.MethodGet:
		task, err = api.store.InspectTask(scope, parts[0])
	case http.MethodDelete:
		task, err = api.store.InspectTask(scope, parts[0])
		if err == nil {
			if _, viewErr := publicAgentSession(task); viewErr != nil {
				writeAPIError(writer, http.StatusNotFound, "not_found")
				return
			}
			task, err = api.store.Cancel(identity.URI, scope, parts[0])
		}
	default:
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	response, err := publicAgentSession(task)
	if err != nil {
		// A generic Computer Task is not addressable through the narrower Agent
		// Session API, even when its ID is known inside the same project.
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	writeJSON(writer, http.StatusOK, response)
}

func (api *API) agentSessionTranscript(writer http.ResponseWriter, request *http.Request, scope Scope, taskID string) {
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	task, err := api.store.InspectTask(scope, taskID)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	session, err := publicAgentSession(task)
	if err != nil {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	prompt, err := agentSessionPrompt(task)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	after, limit, ok := parsePage(request)
	if !ok {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	events, err := api.store.TaskEvents(scope, taskID, after, limit)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	var next uint64
	if len(events) == limit {
		next = events[len(events)-1].Cursor
	}
	writeJSON(writer, http.StatusOK, AgentSessionTranscriptPage{
		Session: session, Prompt: prompt, Events: events, NextCursor: next,
	})
}

func (api *API) agentArtifact(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	identity, err := api.clientIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "client_identity_required")
		return
	}
	remainder := strings.TrimPrefix(request.URL.Path, "/v1/agent/artifacts/")
	parts := strings.Split(remainder, "/")
	if len(parts) < 1 || len(parts) > 2 || !computerID(parts[0]) {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	artifact, err := api.store.InspectAgentArtifact(Scope{TenantID: identity.TenantID, ProjectID: identity.ProjectID}, parts[0])
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	if len(parts) == 1 {
		writeJSON(writer, http.StatusOK, publicAgentArtifact(artifact))
		return
	}
	if parts[1] != "download" {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	if artifact.State != ArtifactAvailable || api.artifactStore == nil {
		writeAPIError(writer, http.StatusConflict, "conflict")
		return
	}
	expires := api.store.Now().Add(5 * time.Minute)
	downloadURL, err := api.artifactStore.SignedGetURL(request.Context(), artifact.ObjectKey, artifact.Name, artifact.ContentType, 5*time.Minute)
	if err != nil {
		writeAPIError(writer, http.StatusServiceUnavailable, "unavailable")
		return
	}
	writeJSON(writer, http.StatusOK, AgentArtifactDownload{ArtifactID: artifact.ID, URL: downloadURL, ExpiresAt: timestamp(expires)})
}

type retryAgentSessionRequest struct {
	ID string `json:"id"`
}

func (api *API) retryAgentSession(writer http.ResponseWriter, request *http.Request, principal string, scope Scope, sourceID string) {
	if request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	var body retryAgentSessionRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	task, created, err := api.store.RetryAgentSession(principal, scope, sourceID, body.ID)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	view, err := publicAgentSession(task)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(writer, status, view)
}

func (api *API) streamAgentSession(writer http.ResponseWriter, request *http.Request, scope Scope, taskID string) {
	task, err := api.store.InspectTask(scope, taskID)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	view, err := publicAgentSession(task)
	if err != nil {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	after, limit, ok := parseAgentStreamPage(request)
	if !ok {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	if _, err := api.store.TaskEvents(scope, taskID, after, limit); err != nil {
		writeStoreError(writer, err)
		return
	}
	flusher, ok := writer.(http.Flusher)
	if !ok {
		writeAPIError(writer, http.StatusInternalServerError, "streaming_unsupported")
		return
	}

	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Accel-Buffering", "no")
	writer.Header().Set(APIVersionHeader, APIVersion)
	writer.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(writer, "retry: 1000\n\n")
	if !terminalTask(task.State) {
		_ = writeAgentSSE(writer, "session", 0, view)
		flusher.Flush()
	}

	ctx, cancel := context.WithTimeout(request.Context(), agentStreamWindow)
	defer cancel()
	remaining := limit
	for remaining > 0 {
		current, events, err := api.store.WaitTaskEvents(ctx, scope, taskID, after, remaining)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) && request.Context().Err() == nil {
				_, _ = io.WriteString(writer, ": keepalive\n\n")
				flusher.Flush()
			}
			return
		}
		for _, event := range events {
			if err := writeAgentSSE(writer, "task-event", event.Cursor, event); err != nil {
				return
			}
			after = event.Cursor
			remaining--
		}
		currentView, err := publicAgentSession(current)
		if err != nil {
			return
		}
		if terminalTask(current.State) {
			later, err := api.store.TaskEvents(scope, taskID, after, 1)
			if err != nil || len(later) != 0 {
				flusher.Flush()
				return
			}
			_ = writeAgentSSE(writer, "session", 0, currentView)
			flusher.Flush()
			return
		}
		flusher.Flush()
	}
}

func parseAgentStreamPage(request *http.Request) (uint64, int, bool) {
	after, limit, ok := parsePage(request)
	if !ok {
		return 0, 0, false
	}
	if request.URL.Query().Get("after") == "" {
		if raw := request.Header.Get("Last-Event-ID"); raw != "" {
			parsed, err := strconv.ParseUint(raw, 10, 64)
			if err != nil {
				return 0, 0, false
			}
			after = parsed
		}
	}
	return after, limit, limit >= 1 && limit <= 1000
}

func writeAgentSSE(writer io.Writer, eventType string, cursor uint64, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if cursor != 0 {
		if _, err := io.WriteString(writer, "id: "+strconv.FormatUint(cursor, 10)+"\n"); err != nil {
			return err
		}
	}
	if _, err := io.WriteString(writer, "event: "+eventType+"\ndata: "); err != nil {
		return err
	}
	if _, err := writer.Write(data); err != nil {
		return err
	}
	_, err = io.WriteString(writer, "\n\n")
	return err
}
