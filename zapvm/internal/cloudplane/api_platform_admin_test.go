package cloudplane

import (
	"errors"
	"net/http"
	"testing"
	"time"
)

type platformAPITestBackend struct {
	Backend
	PlatformAdminBackend
	members map[string]WorkspaceMember
}

func TestWorkspaceRoleMatrix(t *testing.T) {
	permissions := []string{"workspace.read", "task.run", "computer.operate", "computer.manage", "node.manage", "runtime.manage", "quota.manage", "member.manage", "owner.manage"}
	expected := map[string]int{RoleViewer: 1, RoleMember: 2, RoleOperator: 3, RoleAdmin: 8, RoleOwner: 9}
	for role, allowed := range expected {
		for index, permission := range permissions {
			if got := RoleAllows(role, permission); got != (index < allowed) {
				t.Fatalf("role=%s permission=%s allowed=%t", role, permission, got)
			}
		}
	}
	if RoleAllows(RoleOwner, "unknown.permission") || RoleAllows("unknown", "workspace.read") {
		t.Fatal("unknown role or permission was allowed")
	}
}

func (backend *platformAPITestBackend) ResolveWorkspaceMember(_ Scope, userID string) (WorkspaceMember, error) {
	member, ok := backend.members[userID]
	if !ok {
		return WorkspaceMember{}, ErrNotFound
	}
	return member, nil
}
func (backend *platformAPITestBackend) EnsureWorkspaceOwner(_ string, _ Scope, userID, displayName, email string) (WorkspaceMember, error) {
	if len(backend.members) != 0 {
		return WorkspaceMember{}, errors.New("already bootstrapped")
	}
	member := WorkspaceMember{UserID: userID, DisplayName: displayName, Email: email, Role: RoleOwner, Status: "active"}
	backend.members[userID] = member
	return member, nil
}
func (backend *platformAPITestBackend) ListWorkspaceMembers(_ Scope) ([]WorkspaceMember, error) {
	result := make([]WorkspaceMember, 0, len(backend.members))
	for _, member := range backend.members {
		result = append(result, member)
	}
	return result, nil
}

func TestWorkspaceAdminBootstrapsAuthenticatedScopedWebIdentityAndEnforcesRBAC(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 15, 15, 0, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	backend := &platformAPITestBackend{Backend: store, members: map[string]WorkspaceMember{}}
	const web = "spiffe://example.test/tenant/acme/project/weather/client/web"
	api, err := NewAPI(backend, "example.test", []string{"spiffe://example.test/tenant/platform/project/operations/client/admin"})
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	bootstrap := apiRequest(t, http.MethodGet, "/v1/workspace/me", web, nil)
	bootstrap.Header.Set(workspaceUserIDHeader, "owner")
	bootstrap.Header.Set(workspaceBootstrapHeader, "owner")
	response := callAPI(t, handler, bootstrap)
	if response.Code != http.StatusOK || !stringsContains(response.Body.String(), `"role":"owner"`) {
		t.Fatalf("bootstrap status=%d body=%s", response.Code, response.Body.String())
	}
	backend.members["viewer"] = WorkspaceMember{UserID: "viewer", Role: RoleViewer, Status: "active"}
	backend.members["admin"] = WorkspaceMember{UserID: "admin", Role: RoleAdmin, Status: "active"}
	denied := apiRequest(t, http.MethodGet, "/v1/workspace/members", web, nil)
	denied.Header.Set(workspaceUserIDHeader, "viewer")
	deniedResponse := callAPI(t, handler, denied)
	if deniedResponse.Code != http.StatusForbidden {
		t.Fatalf("viewer member list status=%d body=%s", deniedResponse.Code, deniedResponse.Body.String())
	}
	allowed := apiRequest(t, http.MethodGet, "/v1/workspace/members", web, nil)
	allowed.Header.Set(workspaceUserIDHeader, "owner")
	allowedResponse := callAPI(t, handler, allowed)
	if allowedResponse.Code != http.StatusOK || !stringsContains(allowedResponse.Body.String(), `"members"`) {
		t.Fatalf("owner member list status=%d body=%s", allowedResponse.Code, allowedResponse.Body.String())
	}
	if _, err := store.RegisterNode("node-shared", "generation-shared-01"); err != nil {
		t.Fatal(err)
	}
	drainShared := apiRequest(t, http.MethodPost, "/v1/workspace/nodes/node-shared/drain", web, map[string]any{"generation": "generation-shared-01", "draining": true})
	drainShared.Header.Set(workspaceUserIDHeader, "owner")
	if result := callAPI(t, handler, drainShared); result.Code != http.StatusConflict || !stringsContains(result.Body.String(), `"code":"shared_node_requires_platform_operator"`) {
		t.Fatalf("shared Node drain status=%d body=%s", result.Code, result.Body.String())
	}
	demoteOwner := apiRequest(t, http.MethodPut, "/v1/workspace/members", web, WorkspaceMember{UserID: "owner", Role: RoleAdmin, Status: "active"})
	demoteOwner.Header.Set(workspaceUserIDHeader, "admin")
	if result := callAPI(t, handler, demoteOwner); result.Code != http.StatusForbidden || !stringsContains(result.Body.String(), `"code":"owner_role_required"`) {
		t.Fatalf("admin owner mutation status=%d body=%s", result.Code, result.Body.String())
	}
	nonWeb := apiRequest(t, http.MethodGet, "/v1/workspace/me", testPrincipalA, nil)
	nonWeb.Header.Set(workspaceUserIDHeader, "owner")
	if result := callAPI(t, handler, nonWeb); result.Code != http.StatusForbidden {
		t.Fatalf("non-web status=%d body=%s", result.Code, result.Body.String())
	}
}

func stringsContains(value, needle string) bool {
	return len(value) >= len(needle) && containsString(value, needle)
}
func containsString(value, needle string) bool {
	for index := 0; index+len(needle) <= len(value); index++ {
		if value[index:index+len(needle)] == needle {
			return true
		}
	}
	return false
}
