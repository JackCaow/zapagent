package cloudplane

import (
	"encoding/json"
	"errors"

	"zapvm/internal/daemonrpc"
)

const (
	// APIVersion is the compatibility version exposed by the HTTP control-plane
	// API. Additive response fields remain compatible inside a version; removed
	// fields, changed meanings, or newly required request fields require a new
	// versioned route and contract.
	APIVersion = "1"

	// APIVersionHeader lets clients reject an unsupported server before they
	// interpret a response body.
	APIVersionHeader = "X-ZapVM-API-Version"
)

// APIError is the stable, non-sensitive error returned to API clients.
type APIError struct {
	Code      string `json:"code"`
	Category  string `json:"category,omitempty"`
	Action    string `json:"action,omitempty"`
	Retryable bool   `json:"retryable"`
}

func classifyAPIError(code string) APIError {
	result := APIError{Code: code, Category: "request", Action: "fix_request"}
	switch code {
	case "mutual_tls_required", "client_identity_required", "unauthenticated", "invalid_credentials":
		result.Category, result.Action = "authentication", "login"
	case "csrf_required":
		result.Category, result.Action = "session", "refresh"
	case "forbidden", "administrator_required":
		result.Category, result.Action = "authorization", "contact_admin"
	case "not_found":
		result.Category, result.Action = "not_found", "refresh"
	case "conflict", "lease_fenced":
		result.Category, result.Action = "conflict", "refresh"
	case "unavailable", "computer_offline", "store_degraded", "overloaded", "control_unavailable", "internal_error":
		result.Category, result.Action, result.Retryable = "infrastructure", "retry", true
	case "rate_limited":
		result.Category, result.Action, result.Retryable = "rate_limit", "retry", true
	case "quota_exceeded":
		result.Category, result.Action = "quota", "reduce_usage"
	}
	return result
}

// APIErrorEnvelope keeps error responses extensible without exposing internal
// errors, Host paths, node identities, prompts, or credentials.
type APIErrorEnvelope struct {
	Error APIError `json:"error"`
}

// AgentSession is the public view of one Resident Agent turn. It deliberately
// omits the dispatch payload, prompt, argv, credential IDs, node identity, lease
// material, and Host topology.
type AgentSession struct {
	ID            string `json:"id"`
	ComputerID    string `json:"computer_id"`
	SessionID     string `json:"session_id"`
	Title         string `json:"title"`
	RetryOf       string `json:"retry_of,omitempty"`
	State         string `json:"state"`
	Attempt       uint8  `json:"attempt"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
	ResultSHA256  string `json:"result_sha256,omitempty"`
	FailureCode   string `json:"failure_code,omitempty"`
	QueueReason   string `json:"queue_reason,omitempty"`
	QueueDeadline string `json:"queue_deadline,omitempty"`
}

// AgentSessionEvents is the cursor-paged event response used for reconnects.
type AgentSessionEvents struct {
	Events []TaskEvent `json:"events"`
}

// AgentSessionTranscriptPage is the tenant-scoped, cursor-paged transcript for
// one Resident Agent turn. The catalog deliberately omits prompts; clients
// fetch this narrower resource only when opening a conversation.
type AgentSessionTranscriptPage struct {
	Session    AgentSession `json:"session"`
	Prompt     string       `json:"prompt"`
	Events     []TaskEvent  `json:"events"`
	NextCursor uint64       `json:"next_cursor"`
}

// AgentSessionList is a stable creation-order page of Resident Agent turns.
// NextCursor is the CreatedSequence of the last returned turn and can be
// supplied as the next request's after value.
type AgentSessionList struct {
	Sessions   []AgentSession `json:"sessions"`
	NextCursor uint64         `json:"next_cursor"`
}

// AgentArtifact is the public, tenant-scoped metadata view of an Agent output.
// It excludes tenant keys, Node identity, Host paths, and storage authority.
type AgentArtifact struct {
	ID               string `json:"id"`
	ComputerID       string `json:"computer_id"`
	SessionID        string `json:"session_id"`
	TaskID           string `json:"task_id"`
	Path             string `json:"path"`
	Name             string `json:"name"`
	ContentType      string `json:"content_type"`
	Size             uint64 `json:"size"`
	SHA256           string `json:"sha256"`
	State            string `json:"state"`
	RetentionSeconds uint64 `json:"retention_seconds"`
	CreatedAt        string `json:"created_at"`
	UpdatedAt        string `json:"updated_at"`
	ExpiresAt        string `json:"expires_at"`
	AvailableAt      string `json:"available_at,omitempty"`
	FailureCode      string `json:"failure_code,omitempty"`
}

type AgentArtifactList struct {
	Artifacts  []AgentArtifact `json:"artifacts"`
	NextCursor uint64          `json:"next_cursor"`
}

type AgentArtifactDownload struct {
	ArtifactID string `json:"artifact_id"`
	URL        string `json:"url"`
	ExpiresAt  string `json:"expires_at"`
}

func publicAgentArtifact(artifact Artifact) AgentArtifact {
	return AgentArtifact{
		ID: artifact.ID, ComputerID: artifact.ComputerID, SessionID: artifact.SessionID, TaskID: artifact.TaskID,
		Path: artifact.Path, Name: artifact.Name, ContentType: artifact.ContentType, Size: artifact.Size,
		SHA256: artifact.SHA256, State: artifact.State, RetentionSeconds: artifact.RetentionSeconds,
		CreatedAt: artifact.CreatedAt, UpdatedAt: artifact.UpdatedAt, ExpiresAt: artifact.ExpiresAt, FailureCode: artifact.FailureCode,
		AvailableAt: artifact.AvailableAt,
	}
}

type AgentComputer struct {
	ID             string `json:"id"`
	State          string `json:"state"`
	DesiredState   string `json:"desired_state"`
	ObservedState  string `json:"observed_state"`
	AssignedNodeID string `json:"assigned_node_id,omitempty"`
	PlacementEpoch uint64 `json:"placement_epoch,omitempty"`
	LastActivityAt string `json:"last_activity_at,omitempty"`
	FailureCode    string `json:"failure_code,omitempty"`
}

type AgentComputerList struct {
	Computers []AgentComputer `json:"computers"`
}

// AgentWorkspaceOperation is the public, tenant-scoped view of one bounded
// workspace read operation. It excludes Host paths, Node topology, and lease
// authority. Result is one strict daemonrpc WorkspaceListing/File/Diff value.
type AgentWorkspaceOperation struct {
	ID           string          `json:"id"`
	ComputerID   string          `json:"computer_id"`
	Kind         string          `json:"kind"`
	Path         string          `json:"path,omitempty"`
	State        string          `json:"state"`
	Attempt      uint8           `json:"attempt"`
	CreatedAt    string          `json:"created_at"`
	UpdatedAt    string          `json:"updated_at"`
	Result       json.RawMessage `json:"result,omitempty"`
	ResultSHA256 string          `json:"result_sha256,omitempty"`
	FailureCode  string          `json:"failure_code,omitempty"`
}

type AgentGitOperation struct {
	ID           string          `json:"id"`
	ComputerID   string          `json:"computer_id"`
	TaskID       string          `json:"task_id"`
	ProviderID   string          `json:"provider_id"`
	Branch       string          `json:"branch"`
	State        string          `json:"state"`
	Attempt      uint8           `json:"attempt"`
	CreatedAt    string          `json:"created_at"`
	UpdatedAt    string          `json:"updated_at"`
	Result       json.RawMessage `json:"result,omitempty"`
	ResultSHA256 string          `json:"result_sha256,omitempty"`
	FailureCode  string          `json:"failure_code,omitempty"`
}

func publicAgentGitOperation(operation WorkspaceOperation) AgentGitOperation {
	return AgentGitOperation{
		ID: operation.ID, ComputerID: operation.ComputerID, TaskID: operation.TaskID, ProviderID: operation.ProviderID,
		Branch: operation.Branch, State: operation.State, Attempt: operation.Attempt, CreatedAt: operation.CreatedAt,
		UpdatedAt: operation.UpdatedAt, Result: append(json.RawMessage(nil), operation.Result...),
		ResultSHA256: operation.ResultSHA256, FailureCode: operation.FailureCode,
	}
}

func publicAgentWorkspaceOperation(operation WorkspaceOperation) AgentWorkspaceOperation {
	return AgentWorkspaceOperation{
		ID: operation.ID, ComputerID: operation.ComputerID, Kind: operation.Kind, Path: operation.Path,
		State: operation.State, Attempt: operation.Attempt, CreatedAt: operation.CreatedAt, UpdatedAt: operation.UpdatedAt,
		Result: append(json.RawMessage(nil), operation.Result...), ResultSHA256: operation.ResultSHA256, FailureCode: operation.FailureCode,
	}
}

func publicAgentSession(task Task) (AgentSession, error) {
	command, err := residentAgentCommand(task)
	if err != nil {
		return AgentSession{}, errors.New("task is not a Resident Agent session")
	}
	return AgentSession{
		ID: task.ID, ComputerID: task.ComputerID, SessionID: command.Command.SessionID, Title: agentSessionTitle(command.Command.Title), RetryOf: task.RetryOf,
		State: task.State, Attempt: task.Attempt, CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt,
		ResultSHA256: task.ResultSHA256, FailureCode: task.FailureCode,
		QueueReason: task.QueueReason, QueueDeadline: task.QueueDeadline,
	}, nil
}

func residentAgentCommand(task Task) (daemonrpc.ComputerTaskSubmitRequest, error) {
	command, err := daemonrpc.DecodeComputerTaskSubmit(task.Payload)
	if err != nil || command.ComputerID != task.ComputerID || len(command.Command.Argv) == 0 || command.Command.Argv[0] != residentAgentBinary {
		return daemonrpc.ComputerTaskSubmitRequest{}, errors.New("task is not a Resident Agent session")
	}
	return command, nil
}

func agentSessionPrompt(task Task) (string, error) {
	command, err := residentAgentCommand(task)
	if err != nil {
		return "", err
	}
	arguments := command.Command.Argv
	for index := 1; index+1 < len(arguments); index++ {
		if arguments[index] == "--prompt" {
			return arguments[index+1], nil
		}
	}
	// Preserve transcript readability for tasks created by the previous
	// Zap-specific Resident adapter while current tasks use the ACP contract.
	separator := -1
	for index, argument := range arguments {
		if argument == "--" {
			separator = index
			break
		}
	}
	for index := separator + 1; separator >= 0 && index+1 < len(arguments); index++ {
		if arguments[index] == "-p" {
			return arguments[index+1], nil
		}
	}
	return "", errors.New("Resident Agent prompt is missing")
}

func agentSessionTitle(title string) string {
	if title != "" {
		return title
	}
	return "Agent 对话"
}
