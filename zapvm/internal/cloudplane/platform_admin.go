package cloudplane

import (
	"encoding/json"
	"errors"
	"strings"
)

const (
	RoleOwner    = "owner"
	RoleAdmin    = "admin"
	RoleOperator = "operator"
	RoleMember   = "member"
	RoleViewer   = "viewer"
)

type WorkspaceMember struct {
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name,omitempty"`
	Email       string `json:"email,omitempty"`
	Role        string `json:"role"`
	Status      string `json:"status"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

type HostPool struct {
	ID           string            `json:"id"`
	DisplayName  string            `json:"display_name"`
	Region       string            `json:"region,omitempty"`
	Enabled      bool              `json:"enabled"`
	MaxComputers uint16            `json:"max_computers"`
	Labels       map[string]string `json:"labels,omitempty"`
	NodeIDs      []string          `json:"node_ids,omitempty"`
	CreatedAt    string            `json:"created_at"`
	UpdatedAt    string            `json:"updated_at"`
}

type ModelProfile struct {
	ID            string `json:"id"`
	DisplayName   string `json:"display_name"`
	ProviderURL   string `json:"provider_url"`
	ProviderModel string `json:"provider_model"`
	CredentialID  string `json:"credential_id"`
	Enabled       bool   `json:"enabled"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

type AgentProfile struct {
	ID            string          `json:"id"`
	DisplayName   string          `json:"display_name"`
	RuntimeRef    string          `json:"runtime_ref"`
	ModelID       string          `json:"model_id"`
	Enabled       bool            `json:"enabled"`
	Configuration json.RawMessage `json:"configuration,omitempty"`
	CreatedAt     string          `json:"created_at"`
	UpdatedAt     string          `json:"updated_at"`
}

type ComputerProfile struct {
	ID             string `json:"id"`
	DisplayName    string `json:"display_name"`
	PoolID         string `json:"pool_id"`
	AgentID        string `json:"agent_id"`
	VCPU           uint16 `json:"vcpu"`
	MemoryBytes    uint64 `json:"memory_bytes"`
	BrowserEnabled bool   `json:"browser_enabled"`
	CreatedBy      string `json:"created_by"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
}

type WorkspaceQuota struct {
	MaxComputers       uint16 `json:"max_computers"`
	MaxConcurrentTasks uint16 `json:"max_concurrent_tasks"`
	MonthlyTaskSeconds uint64 `json:"monthly_task_seconds"`
	ArtifactBytes      uint64 `json:"artifact_bytes"`
	UpdatedAt          string `json:"updated_at"`
}

type WorkspaceUsage struct {
	PeriodStart   string `json:"period_start"`
	TaskCount     uint64 `json:"task_count"`
	TaskSeconds   uint64 `json:"task_seconds"`
	ArtifactBytes uint64 `json:"artifact_bytes"`
	RunningTasks  uint64 `json:"running_tasks"`
	ComputerCount uint64 `json:"computer_count"`
}

// ComputerRuntimeSelection is the effective, secret-free runtime selected for
// a Computer. Credential values remain in the credential broker; only IDs are
// returned to the trusted Web BFF for task capability construction.
type ComputerRuntimeSelection struct {
	ComputerID         string `json:"computer_id"`
	AgentID            string `json:"agent_id"`
	DisplayName        string `json:"display_name"`
	RuntimeRef         string `json:"runtime_ref"`
	ProviderBaseURL    string `json:"provider_base_url"`
	Model              string `json:"model"`
	ModelCredentialID  string `json:"model_credential_id"`
	SearchCredentialID string `json:"search_credential_id,omitempty"`
	MaxTurns           uint16 `json:"max_turns,omitempty"`
	TimeoutSeconds     uint32 `json:"timeout_seconds,omitempty"`
}

// PlatformAdminBackend is the durable, project-scoped administration surface.
// It is optional so the single-file development backend cannot accidentally
// pretend to provide production identity, quota, or secret-management state.
type PlatformAdminBackend interface {
	EnsureWorkspaceOwner(principal string, scope Scope, userID, displayName, email string) (WorkspaceMember, error)
	ResolveWorkspaceMember(scope Scope, userID string) (WorkspaceMember, error)
	ListWorkspaceMembers(scope Scope) ([]WorkspaceMember, error)
	PutWorkspaceMember(principal string, scope Scope, member WorkspaceMember) (WorkspaceMember, error)
	DeleteWorkspaceMember(principal string, scope Scope, userID string) error

	ListHostPools(scope Scope) ([]HostPool, error)
	PutHostPool(principal string, scope Scope, pool HostPool) (HostPool, error)
	DeleteHostPool(principal string, scope Scope, id string) error

	ListModelProfiles(scope Scope) ([]ModelProfile, error)
	PutModelProfile(principal string, scope Scope, profile ModelProfile) (ModelProfile, error)
	DeleteModelProfile(principal string, scope Scope, id string) error
	ListAgentProfiles(scope Scope) ([]AgentProfile, error)
	PutAgentProfile(principal string, scope Scope, profile AgentProfile) (AgentProfile, error)
	DeleteAgentProfile(principal string, scope Scope, id string) error

	ListComputerProfiles(scope Scope) ([]ComputerProfile, error)
	CreateComputerProfile(principal string, scope Scope, profile ComputerProfile) (ComputerProfile, error)
	DeleteComputerProfile(principal string, scope Scope, id string) error

	GetWorkspaceQuota(scope Scope) (WorkspaceQuota, error)
	PutWorkspaceQuota(principal string, scope Scope, quota WorkspaceQuota) (WorkspaceQuota, error)
	GetWorkspaceUsage(scope Scope) (WorkspaceUsage, error)
	ResolveComputerRuntime(scope Scope, computerID string) (ComputerRuntimeSelection, error)
}

func ValidWorkspaceRole(role string) bool {
	switch role {
	case RoleOwner, RoleAdmin, RoleOperator, RoleMember, RoleViewer:
		return true
	default:
		return false
	}
}

func RoleAllows(role, permission string) bool {
	levels := map[string]int{RoleViewer: 1, RoleMember: 2, RoleOperator: 3, RoleAdmin: 4, RoleOwner: 5}
	required := map[string]int{
		"workspace.read": 1, "task.run": 2, "computer.operate": 3,
		"computer.manage": 4, "node.manage": 4, "runtime.manage": 4,
		"quota.manage": 4, "member.manage": 4, "owner.manage": 5,
	}[permission]
	return required > 0 && levels[role] >= required
}

func ValidateWorkspaceMember(member WorkspaceMember) error {
	if !validName(member.UserID, 128) || !ValidWorkspaceRole(member.Role) || (member.Status != "active" && member.Status != "suspended") || len(member.DisplayName) > 256 || len(member.Email) > 320 || strings.IndexByte(member.DisplayName, 0) >= 0 || strings.IndexByte(member.Email, 0) >= 0 {
		return errors.New("Workspace member is invalid")
	}
	return nil
}
