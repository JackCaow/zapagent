package cloudplane

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"zapvm/internal/daemonrpc"
	"zapvm/internal/gitprovider"
)

type agentWorkspaceOperationRequest struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Path string `json:"path,omitempty"`
}

type agentComputerLifecycleRequest struct {
	Action string `json:"action"`
}

func (api *API) agentComputerWorkspace(writer http.ResponseWriter, request *http.Request) {
	identity, err := api.clientIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "client_identity_required")
		return
	}
	remainder := strings.TrimPrefix(request.URL.Path, "/v1/agent/computers/")
	parts := strings.Split(remainder, "/")
	if len(parts) == 2 && computerID(parts[0]) && parts[1] == "lifecycle" {
		if request.Method != http.MethodPost {
			writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		backend, ok := api.store.(AgentComputerLifecycleBackend)
		if !ok {
			writeAPIError(writer, http.StatusServiceUnavailable, "unavailable")
			return
		}
		var body agentComputerLifecycleRequest
		if err := decodeAPIRequest(writer, request, &body); err != nil || (body.Action != ComputerLifecycleWake && body.Action != ComputerLifecycleRelease) {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		result, err := backend.RequestAgentComputerLifecycle(identity.URI, Scope{TenantID: identity.TenantID, ProjectID: identity.ProjectID}, parts[0], body.Action)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		status := http.StatusOK
		if result.Accepted {
			status = http.StatusAccepted
		}
		writeJSON(writer, status, result)
		return
	}
	if len(parts) >= 3 && len(parts) <= 4 && computerID(parts[0]) && parts[1] == "git" && parts[2] == "operations" {
		api.agentComputerGitOperation(writer, request, identity.URI, Scope{TenantID: identity.TenantID, ProjectID: identity.ProjectID}, parts)
		return
	}
	if len(parts) < 3 || len(parts) > 4 || !computerID(parts[0]) || parts[1] != "workspace" || parts[2] != "operations" {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	scope := Scope{TenantID: identity.TenantID, ProjectID: identity.ProjectID}
	if len(parts) == 3 {
		if request.Method != http.MethodPost {
			writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		var body agentWorkspaceOperationRequest
		if err := decodeAPIRequest(writer, request, &body); err != nil {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		operation, created, err := api.store.SubmitWorkspaceOperation(identity.URI, WorkspaceOperationRequest{
			ID: body.ID, Scope: scope, ComputerID: parts[0], Kind: body.Kind, Path: body.Path,
		})
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		status := http.StatusOK
		if created {
			status = http.StatusAccepted
		}
		writeJSON(writer, status, publicAgentWorkspaceOperation(operation))
		return
	}
	if !computerID(parts[3]) {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	var operation WorkspaceOperation
	switch request.Method {
	case http.MethodGet:
		operation, err = api.store.InspectWorkspaceOperation(scope, parts[3])
	case http.MethodDelete:
		operation, err = api.store.DeleteWorkspaceOperation(identity.URI, scope, parts[3])
	default:
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if err != nil || operation.ComputerID != parts[0] {
		if err == nil {
			err = ErrNotFound
		}
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, publicAgentWorkspaceOperation(operation))
}

type nodeWorkspaceClaimRequest struct {
	Generation string `json:"generation"`
	Maximum    int    `json:"maximum"`
}

func (api *API) nodeWorkspaceClaim(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	nodeID, err := api.nodeIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "node_identity_required")
		return
	}
	var body nodeWorkspaceClaimRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	leases, err := api.store.ClaimWorkspaceOperations(nodeID, body.Generation, body.Maximum)
	if err != nil {
		if errors.Is(err, ErrCapacityReached) {
			writeJSON(writer, http.StatusOK, map[string]any{"leases": []WorkspaceOperationLease{}})
			return
		}
		writeStoreError(writer, err)
		return
	}
	defer func() {
		for index := range leases {
			leases[index].Git.Destroy()
		}
	}()
	for index := range leases {
		leases[index].Operation.LeaseTokenHash = ""
		if leases[index].Operation.Kind != WorkspaceOperationGitPush {
			continue
		}
		var capability gitprovider.Capability
		var mintErr error
		if api.gitProviders == nil {
			mintErr = errors.New("Git provider is unavailable")
		} else {
			capability, mintErr = api.gitProviders.Mint(request.Context(), leases[index].Operation.TenantID, leases[index].Operation.ProjectID, leases[index].Operation.ProviderID)
		}
		if mintErr != nil {
			capability.Destroy()
			_, completeErr := api.store.CompleteWorkspaceOperation(nodeID, body.Generation, leases[index].Operation.ID, leases[index].LeaseToken, WorkspaceOperationCompletion{
				Succeeded: false, FailureCode: "credential_unavailable",
			})
			if completeErr != nil {
				writeStoreError(writer, completeErr)
				return
			}
			leases[index].LeaseToken = ""
			continue
		}
		leases[index].Git = &GitLeaseCapability{
			Owner: capability.Owner, Repository: capability.Repository, BaseBranch: capability.BaseBranch,
			HTTPSCloneURL: capability.HTTPSCloneURL, Token: append([]byte(nil), capability.Token...),
		}
		capability.Destroy()
	}
	ready := leases[:0]
	for index := range leases {
		if leases[index].LeaseToken != "" {
			ready = append(ready, leases[index])
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"leases": ready})
}

type nodeWorkspaceCompletionRequest struct {
	Generation  string          `json:"generation"`
	LeaseToken  string          `json:"lease_token"`
	Succeeded   bool            `json:"succeeded"`
	Result      json.RawMessage `json:"result,omitempty"`
	FailureCode string          `json:"failure_code,omitempty"`
}

func (api *API) nodeWorkspaceOperation(writer http.ResponseWriter, request *http.Request) {
	nodeID, err := api.nodeIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "node_identity_required")
		return
	}
	remainder := strings.TrimPrefix(request.URL.Path, "/v1/node/workspace/operations/")
	parts := strings.Split(remainder, "/")
	if len(parts) != 2 || !computerID(parts[0]) || parts[1] != "complete" || request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	var body nodeWorkspaceCompletionRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	leased, err := api.store.InspectWorkspaceOperationLease(nodeID, body.Generation, parts[0], body.LeaseToken)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	if leased.Kind == WorkspaceOperationGitPush && body.Succeeded {
		var push daemonrpc.GitPushResult
		if err := strictUnmarshal(body.Result, &push); err != nil || push.OperationID != leased.ID || push.Branch != leased.Branch ||
			!validGitObjectID(push.CommitSHA) || push.PullRequestNumber != 0 || push.PullRequestURL != "" || push.PullRequestState != "" {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		if api.gitProviders == nil {
			writeAPIError(writer, http.StatusServiceUnavailable, "control_unavailable")
			return
		}
		pullRequest, reconcileErr := api.gitProviders.ReconcilePullRequest(
			request.Context(), leased.TenantID, leased.ProjectID, leased.ProviderID, leased.ID, leased.Branch, push.CommitSHA,
		)
		if reconcileErr != nil {
			if gitprovider.Retryable(reconcileErr) {
				writeAPIError(writer, http.StatusServiceUnavailable, "control_unavailable")
				return
			}
			body.Succeeded = false
			body.Result = nil
			body.FailureCode = gitProviderFailureCode(reconcileErr)
		} else {
			push.PullRequestNumber = pullRequest.Number
			push.PullRequestURL = pullRequest.URL
			push.PullRequestState = pullRequest.State
			body.Result, err = json.Marshal(push)
			if err != nil {
				writeAPIError(writer, http.StatusInternalServerError, "internal_error")
				return
			}
		}
	}
	operation, err := api.store.CompleteWorkspaceOperation(nodeID, body.Generation, parts[0], body.LeaseToken, WorkspaceOperationCompletion{
		Succeeded: body.Succeeded, Result: body.Result, FailureCode: body.FailureCode,
	})
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	if operation.Kind == WorkspaceOperationGitPush {
		writeJSON(writer, http.StatusOK, publicAgentGitOperation(operation))
		return
	}
	writeJSON(writer, http.StatusOK, publicAgentWorkspaceOperation(operation))
}

func strictUnmarshal(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("JSON value has trailing content")
	}
	return nil
}

func gitProviderFailureCode(err error) string {
	var providerError *gitprovider.ProviderError
	if errors.As(err, &providerError) && validFailureCode(providerError.Code) {
		return providerError.Code
	}
	return "pull_request_failed"
}
