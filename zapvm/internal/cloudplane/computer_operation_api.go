package cloudplane

import (
	"errors"
	"net/http"
	"strings"
)

type nodeComputerOperationCompleteRequest struct {
	Generation  string `json:"generation"`
	LeaseToken  string `json:"lease_token"`
	Succeeded   bool   `json:"succeeded"`
	FailureCode string `json:"failure_code,omitempty"`
}

func (api *API) nodeComputerClaim(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	nodeID, err := api.nodeIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "node_identity_required")
		return
	}
	var body nodeClaimRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	backend, ok := api.store.(ComputerOperationBackend)
	if !ok {
		writeJSON(writer, http.StatusOK, map[string]any{"leases": []ComputerOperationLease{}})
		return
	}
	leases, err := backend.ClaimComputerOperations(nodeID, body.Generation, body.Maximum)
	if err != nil {
		if errors.Is(err, ErrCapacityReached) {
			writeJSON(writer, http.StatusOK, map[string]any{"leases": []ComputerOperationLease{}})
			return
		}
		writeStoreError(writer, err)
		return
	}
	for index := range leases {
		leases[index].Operation.LeaseTokenHash = ""
	}
	writeJSON(writer, http.StatusOK, map[string]any{"leases": leases})
}

func (api *API) nodeComputerOperation(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	nodeID, err := api.nodeIdentity(request)
	if err != nil {
		writeAPIError(writer, http.StatusForbidden, "node_identity_required")
		return
	}
	remainder := strings.TrimPrefix(request.URL.Path, "/v1/node/computers/operations/")
	parts := strings.Split(remainder, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] != "complete" {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	backend, ok := api.store.(ComputerOperationBackend)
	if !ok {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	var body nodeComputerOperationCompleteRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	operation, err := backend.CompleteComputerOperation(nodeID, body.Generation, parts[0], body.LeaseToken, ComputerOperationCompletion{
		Succeeded: body.Succeeded, FailureCode: body.FailureCode,
	})
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	operation.LeaseTokenHash = ""
	writeJSON(writer, http.StatusOK, operation)
}
