package cloudplane

import (
	"net/http"
)

type agentGitOperationRequest struct {
	ID         string `json:"id"`
	TaskID     string `json:"task_id"`
	ProviderID string `json:"provider_id"`
}

func (api *API) agentComputerGitOperation(writer http.ResponseWriter, request *http.Request, principal string, scope Scope, parts []string) {
	selectedComputerID := parts[0]
	if len(parts) == 3 {
		if request.Method != http.MethodPost {
			writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		var body agentGitOperationRequest
		if err := decodeAPIRequest(writer, request, &body); err != nil {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		if !api.gitProviderConfigured(scope, body.ProviderID) {
			writeAPIError(writer, http.StatusNotFound, "not_found")
			return
		}
		operation, created, err := api.store.SubmitWorkspaceOperation(principal, WorkspaceOperationRequest{
			ID: body.ID, Scope: scope, ComputerID: selectedComputerID, Kind: WorkspaceOperationGitPush,
			TaskID: body.TaskID, ProviderID: body.ProviderID,
		})
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		status := http.StatusOK
		if created {
			status = http.StatusAccepted
		}
		writeJSON(writer, status, publicAgentGitOperation(operation))
		return
	}
	if !computerID(parts[3]) {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	var operation WorkspaceOperation
	var err error
	switch request.Method {
	case http.MethodGet:
		operation, err = api.store.InspectWorkspaceOperation(scope, parts[3])
	case http.MethodDelete:
		operation, err = api.store.DeleteWorkspaceOperation(principal, scope, parts[3])
	default:
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if err != nil || operation.ComputerID != selectedComputerID || operation.Kind != WorkspaceOperationGitPush {
		if err == nil {
			err = ErrNotFound
		}
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, publicAgentGitOperation(operation))
}

func (api *API) gitProviderConfigured(scope Scope, providerID string) bool {
	if api.gitProviders == nil {
		return false
	}
	for _, provider := range api.gitProviders.List(scope.TenantID, scope.ProjectID) {
		if provider.ID == providerID {
			return true
		}
	}
	return false
}
