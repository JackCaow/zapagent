package cloudplane

import (
	"errors"
	"net/http"
	"strings"

	"zapvm/internal/credential"
)

const (
	workspaceUserIDHeader    = "X-ZapVM-User-ID"
	workspaceUserNameHeader  = "X-ZapVM-User-Name"
	workspaceUserEmailHeader = "X-ZapVM-User-Email"
	workspaceBootstrapHeader = "X-ZapVM-Bootstrap-Owner"
)

func (api *API) platformBackend(writer http.ResponseWriter) (PlatformAdminBackend, bool) {
	backend, ok := api.store.(PlatformAdminBackend)
	if !ok {
		writeAPIError(writer, http.StatusServiceUnavailable, "platform_admin_unavailable")
	}
	return backend, ok
}

func (api *API) workspaceActor(writer http.ResponseWriter, request *http.Request, permission string) (PlatformAdminBackend, Scope, WorkspaceMember, string, bool) {
	backend, ok := api.platformBackend(writer)
	if !ok {
		return nil, Scope{}, WorkspaceMember{}, "", false
	}
	identity, err := api.clientIdentity(request)
	if err != nil || identity.ClientID != "web" {
		writeAPIError(writer, http.StatusForbidden, "workspace_web_identity_required")
		return nil, Scope{}, WorkspaceMember{}, "", false
	}
	userID := request.Header.Get(workspaceUserIDHeader)
	if !validName(userID, 128) {
		writeAPIError(writer, http.StatusForbidden, "workspace_user_required")
		return nil, Scope{}, WorkspaceMember{}, "", false
	}
	scope := Scope{TenantID: identity.TenantID, ProjectID: identity.ProjectID}
	member, err := backend.ResolveWorkspaceMember(scope, userID)
	// The mTLS-authenticated Web BFF is already bound to this tenant/project by
	// its SPIFFE identity. It may bootstrap only the first Workspace owner; the
	// store transaction refuses bootstrap once any member exists. Platform-wide
	// administrator privileges remain separate for shared infrastructure.
	if errors.Is(err, ErrNotFound) && request.Header.Get(workspaceBootstrapHeader) == "owner" {
		member, err = backend.EnsureWorkspaceOwner(identity.URI, scope, userID, request.Header.Get(workspaceUserNameHeader), request.Header.Get(workspaceUserEmailHeader))
	}
	if err != nil || member.Status != "active" || !RoleAllows(member.Role, permission) {
		writeAPIError(writer, http.StatusForbidden, "workspace_permission_required")
		return nil, Scope{}, WorkspaceMember{}, "", false
	}
	return backend, scope, member, identity.URI, true
}

func (api *API) workspaceMe(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	_, _, member, _, ok := api.workspaceActor(writer, request, "workspace.read")
	if ok {
		writeJSON(writer, http.StatusOK, member)
	}
}

func (api *API) workspaceMembers(writer http.ResponseWriter, request *http.Request) {
	backend, scope, actor, principal, ok := api.workspaceActor(writer, request, "member.manage")
	if !ok {
		return
	}
	switch request.Method {
	case http.MethodGet:
		items, err := backend.ListWorkspaceMembers(scope)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"members": items})
	case http.MethodPut:
		var item WorkspaceMember
		if decodeAPIRequest(writer, request, &item) != nil {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		if item.Role == RoleOwner && !RoleAllows(actor.Role, "owner.manage") {
			writeAPIError(writer, http.StatusForbidden, "owner_role_required")
			return
		}
		if existing, err := backend.ResolveWorkspaceMember(scope, item.UserID); err == nil && existing.Role == RoleOwner && !RoleAllows(actor.Role, "owner.manage") {
			writeAPIError(writer, http.StatusForbidden, "owner_role_required")
			return
		} else if err != nil && !errors.Is(err, ErrNotFound) {
			writeStoreError(writer, err)
			return
		}
		result, err := backend.PutWorkspaceMember(principal, scope, item)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, result)
	default:
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}
func (api *API) workspaceMember(writer http.ResponseWriter, request *http.Request) {
	backend, scope, actor, principal, ok := api.workspaceActor(writer, request, "member.manage")
	if !ok {
		return
	}
	id, ok := workspacePathID(request.URL.Path, "/v1/workspace/members/")
	if !ok {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	if request.Method != http.MethodDelete {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	target, err := backend.ResolveWorkspaceMember(scope, id)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	if target.Role == RoleOwner && !RoleAllows(actor.Role, "owner.manage") {
		writeAPIError(writer, http.StatusForbidden, "owner_role_required")
		return
	}
	if err := backend.DeleteWorkspaceMember(principal, scope, id); err != nil {
		writeStoreError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (api *API) workspaceHostPools(writer http.ResponseWriter, request *http.Request) {
	backend, scope, _, principal, ok := api.workspaceActor(writer, request, "node.manage")
	if !ok {
		return
	}
	switch request.Method {
	case http.MethodGet:
		items, err := backend.ListHostPools(scope)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"host_pools": items})
	case http.MethodPut:
		var item HostPool
		if decodeAPIRequest(writer, request, &item) != nil {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		result, err := backend.PutHostPool(principal, scope, item)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, result)
	default:
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}
func (api *API) workspaceHostPool(writer http.ResponseWriter, request *http.Request) {
	backend, scope, _, principal, ok := api.workspaceActor(writer, request, "node.manage")
	if !ok {
		return
	}
	id, valid := workspacePathID(request.URL.Path, "/v1/workspace/host-pools/")
	if !valid || request.Method != http.MethodDelete {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	if err := backend.DeleteHostPool(principal, scope, id); err != nil {
		writeStoreError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (api *API) workspaceNodes(writer http.ResponseWriter, request *http.Request) {
	_, scope, _, _, ok := api.workspaceActor(writer, request, "node.manage")
	if !ok {
		return
	}
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	nodes := []Node{}
	for _, node := range api.store.ListNodes() {
		for _, candidate := range node.Scopes {
			if candidate == scope {
				nodes = append(nodes, node)
				break
			}
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"nodes": nodes})
}
func (api *API) workspaceNode(writer http.ResponseWriter, request *http.Request) {
	_, scope, _, _, ok := api.workspaceActor(writer, request, "node.manage")
	if !ok {
		return
	}
	remainder := strings.TrimPrefix(request.URL.Path, "/v1/workspace/nodes/")
	parts := strings.Split(remainder, "/")
	if len(parts) != 2 || parts[1] != "drain" || request.Method != http.MethodPost {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	authorized := false
	for _, node := range api.store.ListNodes() {
		if node.ID == parts[0] {
			if len(node.Scopes) != 1 {
				writeAPIError(writer, http.StatusConflict, "shared_node_requires_platform_operator")
				return
			}
			for _, candidate := range node.Scopes {
				if candidate == scope {
					authorized = true
				}
			}
		}
	}
	if !authorized {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	var body drainRequest
	if decodeAPIRequest(writer, request, &body) != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	node, err := api.store.SetNodeDraining(parts[0], body.Generation, body.Draining)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, node)
}

func (api *API) workspaceModels(writer http.ResponseWriter, request *http.Request) {
	backend, scope, _, principal, ok := api.workspaceActor(writer, request, "runtime.manage")
	if !ok {
		return
	}
	switch request.Method {
	case http.MethodGet:
		items, err := backend.ListModelProfiles(scope)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"models": items})
	case http.MethodPut:
		var item ModelProfile
		if decodeAPIRequest(writer, request, &item) != nil {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		result, err := backend.PutModelProfile(principal, scope, item)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, result)
	default:
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}
func (api *API) workspaceModel(writer http.ResponseWriter, request *http.Request) {
	backend, scope, _, principal, ok := api.workspaceActor(writer, request, "runtime.manage")
	if !ok {
		return
	}
	id, valid := workspacePathID(request.URL.Path, "/v1/workspace/models/")
	if !valid || request.Method != http.MethodDelete {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	if err := backend.DeleteModelProfile(principal, scope, id); err != nil {
		writeStoreError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (api *API) workspaceAgents(writer http.ResponseWriter, request *http.Request) {
	backend, scope, _, principal, ok := api.workspaceActor(writer, request, "runtime.manage")
	if !ok {
		return
	}
	switch request.Method {
	case http.MethodGet:
		items, err := backend.ListAgentProfiles(scope)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"agents": items})
	case http.MethodPut:
		var item AgentProfile
		if decodeAPIRequest(writer, request, &item) != nil {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		result, err := backend.PutAgentProfile(principal, scope, item)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, result)
	default:
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}
func (api *API) workspaceAgent(writer http.ResponseWriter, request *http.Request) {
	backend, scope, _, principal, ok := api.workspaceActor(writer, request, "runtime.manage")
	if !ok {
		return
	}
	id, valid := workspacePathID(request.URL.Path, "/v1/workspace/agents/")
	if !valid || request.Method != http.MethodDelete {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	if err := backend.DeleteAgentProfile(principal, scope, id); err != nil {
		writeStoreError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (api *API) workspaceComputers(writer http.ResponseWriter, request *http.Request) {
	backend, scope, _, principal, ok := api.workspaceActor(writer, request, "computer.manage")
	if !ok {
		return
	}
	switch request.Method {
	case http.MethodGet:
		items, err := backend.ListComputerProfiles(scope)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"computers": items})
	case http.MethodPost:
		var item ComputerProfile
		if decodeAPIRequest(writer, request, &item) != nil {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		item.CreatedBy = request.Header.Get(workspaceUserIDHeader)
		result, err := backend.CreateComputerProfile(principal, scope, item)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusCreated, result)
	default:
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}
func (api *API) workspaceComputer(writer http.ResponseWriter, request *http.Request) {
	backend, scope, _, principal, ok := api.workspaceActor(writer, request, "computer.manage")
	if !ok {
		return
	}
	id, valid := workspacePathID(request.URL.Path, "/v1/workspace/computers/")
	if !valid || request.Method != http.MethodDelete {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	if err := backend.DeleteComputerProfile(principal, scope, id); err != nil {
		writeStoreError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (api *API) workspaceQuota(writer http.ResponseWriter, request *http.Request) {
	permission := "workspace.read"
	if request.Method != http.MethodGet {
		permission = "quota.manage"
	}
	backend, scope, _, principal, ok := api.workspaceActor(writer, request, permission)
	if !ok {
		return
	}
	switch request.Method {
	case http.MethodGet:
		item, err := backend.GetWorkspaceQuota(scope)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, item)
	case http.MethodPut:
		var item WorkspaceQuota
		if decodeAPIRequest(writer, request, &item) != nil {
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		result, err := backend.PutWorkspaceQuota(principal, scope, item)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, result)
	default:
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}
func (api *API) workspaceUsage(writer http.ResponseWriter, request *http.Request) {
	backend, scope, _, _, ok := api.workspaceActor(writer, request, "workspace.read")
	if !ok {
		return
	}
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	item, err := backend.GetWorkspaceUsage(scope)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, item)
}

func (api *API) workspaceRuntime(writer http.ResponseWriter, request *http.Request) {
	backend, scope, _, _, ok := api.workspaceActor(writer, request, "task.run")
	if !ok {
		return
	}
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	computerID := request.URL.Query().Get("computer_id")
	selection, err := backend.ResolveComputerRuntime(scope, computerID)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, selection)
}

func (api *API) workspaceCredentials(writer http.ResponseWriter, request *http.Request) {
	_, scope, _, _, allowed := api.workspaceActor(writer, request, "runtime.manage")
	if !allowed {
		return
	}
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	backend, ok := api.credentialBackend(writer)
	if !ok {
		return
	}
	items, err := backend.ListCredentials(scope)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"credentials": items})
}

func (api *API) workspaceCredential(writer http.ResponseWriter, request *http.Request) {
	platform, scope, _, principal, allowed := api.workspaceActor(writer, request, "runtime.manage")
	if !allowed {
		return
	}
	id, valid := workspacePathID(request.URL.Path, "/v1/workspace/credentials/")
	if !valid {
		writeAPIError(writer, http.StatusNotFound, "not_found")
		return
	}
	backend, ok := api.credentialBackend(writer)
	if !ok {
		return
	}
	var descriptor CredentialDescriptor
	var err error
	switch request.Method {
	case http.MethodPut:
		var body credentialPutRequest
		if decodeAPIRequest(writer, request, &body) != nil {
			credential.ZeroBytes(body.Value)
			writeAPIError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		defer credential.ZeroBytes(body.Value)
		descriptor, err = backend.PutCredential(principal, scope, id, body.Value)
	case http.MethodDelete:
		models, listErr := platform.ListModelProfiles(scope)
		if listErr != nil {
			writeStoreError(writer, listErr)
			return
		}
		for _, model := range models {
			if model.CredentialID == id {
				writeAPIError(writer, http.StatusConflict, "conflict")
				return
			}
		}
		descriptor, err = backend.RevokeCredential(principal, scope, id)
	default:
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, descriptor)
}

func workspacePathID(path, prefix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	id := strings.TrimPrefix(path, prefix)
	if !validWorkspaceObjectID(id) {
		return "", false
	}
	return id, true
}

func validWorkspaceObjectID(value string) bool {
	if value == "" || len(value) > 128 || strings.Contains(value, "/") {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') && character != '.' && character != '_' && character != '-' {
			return false
		}
	}
	return true
}
