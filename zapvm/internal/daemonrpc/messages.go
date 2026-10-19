package daemonrpc

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/url"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"zapvm/internal/credential"
	"zapvm/internal/platform"
	"zapvm/internal/workspacefs"
	"zapvm/internal/workspacepolicy"
)

const MaxComputerRuntimes = 1024

const ArtifactOutputRoot = "artifacts"

// ArtifactOutputPath is the only workspace location a Remote Agent Task may
// declare for Host-side output collection.
func ArtifactOutputPath(taskID string) (string, error) {
	if !validToken(taskID, 128) {
		return "", errors.New("invalid Artifact Task ID")
	}
	return path.Join(ArtifactOutputRoot, taskID), nil
}

const (
	TypePing                           = "ping"
	TypeStatus                         = "status"
	TypeExec                           = "exec"
	TypePause                          = "pause"
	TypeResume                         = "resume"
	TypeShutdown                       = "shutdown"
	TypeComputerCreate                 = "computer.create"
	TypeComputerList                   = "computer.list"
	TypeComputerInspect                = "computer.inspect"
	TypeComputerStart                  = "computer.start"
	TypeComputerExec                   = "computer.exec"
	TypeComputerStop                   = "computer.stop"
	TypeComputerTaskSubmit             = "computer.task.submit"
	TypeComputerTaskSubmitCredentialed = "computer.task.submit.credentialed"
	TypeComputerTaskList               = "computer.task.list"
	TypeComputerTaskInspect            = "computer.task.inspect"
	TypeComputerTaskAttach             = "computer.task.attach"
	TypeComputerTaskCancel             = "computer.task.cancel"
	TypeComputerTaskRetry              = "computer.task.retry"
	TypeComputerTaskPrune              = "computer.task.prune"
	TypeComputerWorkspaceList          = "computer.workspace.list"
	TypeComputerWorkspaceRead          = "computer.workspace.read"
	TypeComputerWorkspaceDiff          = "computer.workspace.diff"
	TypeComputerArtifactCollect        = "computer.artifact.collect"
	TypeComputerArtifactOpen           = "computer.artifact.open"
	TypeComputerGitPush                = "computer.git.push"

	TypePong                = "pong"
	TypeAccepted            = "accepted"
	TypeEvent               = "event"
	TypeError               = "error"
	TypeStopped             = "stopped"
	TypePaused              = "paused"
	TypeResumed             = "resumed"
	TypeComputer            = "computer"
	TypeComputers           = "computers"
	TypeComputerStopped     = "computer.stopped"
	TypeComputerTask        = "computer.task"
	TypeComputerTasks       = "computer.tasks"
	TypeComputerTaskEvent   = "computer.task.event"
	TypeComputerTaskEnd     = "computer.task.end"
	TypeComputerTasksPruned = "computer.tasks.pruned"
	TypeWorkspaceListing    = "workspace.listing"
	TypeWorkspaceFile       = "workspace.file"
	TypeWorkspaceDiff       = "workspace.diff"
	TypeArtifactCollection  = "artifact.collection"
	TypeArtifactChunk       = "artifact.chunk"
	TypeArtifactEnd         = "artifact.end"
	TypeGitPushResult       = "git.push.result"
)

const (
	MaxArguments      = 256
	MaxCommands       = 32
	MaxAllowedDomains = 128
	MaxAllowedPorts   = 64
)

type Empty struct{}

type ExecRequest struct {
	ComputerID        string               `json:"computer_id,omitempty"`
	Workspace         string               `json:"workspace"`
	WorkspaceReadOnly bool                 `json:"workspace_read_only,omitempty"`
	Network           platform.NetworkMode `json:"network"`
	AllowedDomains    []string             `json:"allowed_domains,omitempty"`
	AllowedPorts      []uint16             `json:"allowed_ports,omitempty"`
	Command           Command              `json:"command"`
	CredentialValues  map[string][]byte    `json:"-"`
}

type Command struct {
	ID                      string   `json:"id"`
	SessionID               string   `json:"session_id"`
	Title                   string   `json:"title,omitempty"`
	Argv                    []string `json:"argv"`
	Cwd                     string   `json:"cwd,omitempty"`
	CredentialIDs           []string `json:"credential_ids,omitempty"`
	ProtectedWorkspacePaths []string `json:"protected_workspace_paths,omitempty"`
	DeniedWorkspacePatterns []string `json:"denied_workspace_patterns,omitempty"`
	TimeoutMillis           uint64   `json:"timeout_ms,omitempty"`
}

type Event struct {
	Timestamp string `json:"timestamp"`
	CommandID string `json:"command_id,omitempty"`
	Type      string `json:"type"`
	Stream    string `json:"stream,omitempty"`
	Data      []byte `json:"data,omitempty"`
	PID       int    `json:"pid,omitempty"`
	OK        *bool  `json:"ok,omitempty"`
	ExitCode  *int   `json:"exit_code,omitempty"`
	Error     string `json:"error,omitempty"`
}

type Status struct {
	Version                  string            `json:"version,omitempty"`
	ImageDigest              string            `json:"image_digest,omitempty"`
	Workers                  int               `json:"workers"`
	Starting                 int               `json:"starting"`
	Stopping                 int               `json:"stopping"`
	Leases                   int               `json:"leases"`
	Degraded                 bool              `json:"degraded"`
	Paused                   bool              `json:"paused"`
	RouteIDs                 []string          `json:"route_ids,omitempty"`
	StartAttempts            uint64            `json:"start_attempts"`
	StartFailures            uint64            `json:"start_failures"`
	StartDurationMillisTotal uint64            `json:"start_duration_ms_total"`
	StartDurationMillisMax   uint64            `json:"start_duration_ms_max"`
	ComputerRuntimes         []ComputerRuntime `json:"computer_runtimes,omitempty"`
}

// ComputerRuntime is the daemon-observed state of a durable Agent Computer.
// It intentionally excludes workspace paths and policy details because Node
// heartbeats forward this inventory to the control plane.
type ComputerRuntime struct {
	ID    string `json:"id"`
	State string `json:"state"`
}

type ComputerSpec struct {
	ID                string               `json:"id"`
	Agent             string               `json:"agent,omitempty"`
	Workspace         string               `json:"workspace"`
	WorkspaceReadOnly bool                 `json:"workspace_read_only,omitempty"`
	Network           platform.NetworkMode `json:"network"`
	AllowedDomains    []string             `json:"allowed_domains,omitempty"`
	AllowedPorts      []uint16             `json:"allowed_ports,omitempty"`
	CPUCount          uint                 `json:"cpus,omitempty"`
	MemoryMiB         uint64               `json:"memory_mib,omitempty"`
	CreatedAt         string               `json:"created_at,omitempty"`
	RuntimeState      string               `json:"runtime_state,omitempty"`
}

type ComputerCreateRequest struct {
	Computer ComputerSpec `json:"computer"`
}

type ComputerReference struct {
	ID string `json:"id"`
}

type ComputerExecRequest struct {
	ID      string  `json:"id"`
	Command Command `json:"command"`
}

type ComputerList struct {
	Computers []ComputerSpec `json:"computers"`
}

type ComputerWorkspaceRequest struct {
	ComputerID string `json:"computer_id"`
	Path       string `json:"path,omitempty"`
}

type ComputerGitPushRequest struct {
	OperationID   string `json:"operation_id"`
	ComputerID    string `json:"computer_id"`
	Owner         string `json:"owner"`
	Repository    string `json:"repository"`
	BaseBranch    string `json:"base_branch"`
	Branch        string `json:"branch"`
	HTTPSCloneURL string `json:"https_clone_url"`
	Token         []byte `json:"token"`
}

type GitPushResult struct {
	OperationID       string `json:"operation_id"`
	Branch            string `json:"branch"`
	CommitSHA         string `json:"commit_sha"`
	PullRequestNumber uint64 `json:"pull_request_number,omitempty"`
	PullRequestURL    string `json:"pull_request_url,omitempty"`
	PullRequestState  string `json:"pull_request_state,omitempty"`
}

type WorkspaceEntry struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Size       int64  `json:"size,omitempty"`
	ModifiedAt string `json:"modified_at"`
}

type WorkspaceListing struct {
	Path      string           `json:"path"`
	Entries   []WorkspaceEntry `json:"entries"`
	Truncated bool             `json:"truncated,omitempty"`
}

type WorkspaceFile struct {
	Path        string `json:"path"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"content_type"`
	Data        []byte `json:"data"`
}

type WorkspaceDiff struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Data   []byte `json:"data"`
}

type ComputerTaskSubmitRequest struct {
	ID         string  `json:"id,omitempty"`
	ComputerID string  `json:"computer_id"`
	Command    Command `json:"command"`
}

// ComputerTaskCredentialSubmitRequest is accepted only on the daemon's
// owner-only local IPC endpoint. Gateway authorization intentionally does not
// expose its message type. Values are request-scoped and must be destroyed by
// both sender and receiver after the Task is admitted.
type ComputerTaskCredentialSubmitRequest struct {
	Task   ComputerTaskSubmitRequest `json:"task"`
	Values map[string][]byte         `json:"values"`
}

type ComputerTaskListRequest struct {
	ComputerID string `json:"computer_id,omitempty"`
}

type ComputerTaskReference struct {
	ID string `json:"id"`
}

type ComputerTaskAttachRequest struct {
	ID          string `json:"id"`
	AfterCursor uint64 `json:"after_cursor,omitempty"`
	Follow      bool   `json:"follow,omitempty"`
}

type ComputerTaskRetryRequest struct {
	SourceID string  `json:"source_id"`
	ID       string  `json:"id,omitempty"`
	Command  Command `json:"command"`
}

type ComputerTaskPruneRequest struct {
	RetentionMillis uint64 `json:"retention_ms"`
	Limit           int    `json:"limit"`
}

type ComputerArtifactCollectRequest struct {
	TaskID     string `json:"task_id"`
	ComputerID string `json:"computer_id"`
}

type CollectedArtifact struct {
	ID          string `json:"id"`
	Path        string `json:"path"`
	ContentType string `json:"content_type"`
	Size        uint64 `json:"size"`
	SHA256      string `json:"sha256"`
}

type ArtifactCollection struct {
	Capability string              `json:"capability,omitempty"`
	ExpiresAt  string              `json:"expires_at,omitempty"`
	Artifacts  []CollectedArtifact `json:"artifacts"`
}

type ComputerArtifactOpenRequest struct {
	Capability string `json:"capability"`
	ArtifactID string `json:"artifact_id"`
}

type ArtifactChunk struct {
	Offset uint64 `json:"offset"`
	Data   []byte `json:"data"`
}

type ArtifactEnd struct {
	Size   uint64 `json:"size"`
	SHA256 string `json:"sha256"`
}

type ComputerTask struct {
	ID            string `json:"id"`
	ComputerID    string `json:"computer_id"`
	RequestSHA256 string `json:"request_sha256"`
	RetryOf       string `json:"retry_of,omitempty"`
	State         string `json:"state"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
	LastCursor    uint64 `json:"last_cursor"`
}

type ComputerTaskList struct {
	Tasks []ComputerTask `json:"tasks"`
}

type ComputerTasksPruned struct {
	TaskIDs []string `json:"task_ids"`
	Before  string   `json:"before"`
}

type ComputerTaskEvent struct {
	Cursor    uint64 `json:"cursor"`
	Timestamp string `json:"timestamp"`
	TaskID    string `json:"task_id"`
	Type      string `json:"type"`
	CommandID string `json:"command_id,omitempty"`
	Stream    string `json:"stream,omitempty"`
	Data      []byte `json:"data,omitempty"`
	PID       int    `json:"pid,omitempty"`
	OK        *bool  `json:"ok,omitempty"`
	Error     string `json:"error,omitempty"`
}

type Error struct {
	Message string `json:"message"`
}

func DecodeEmpty(payload []byte) error {
	value, err := DecodePayload[Empty](payload)
	_ = value
	return err
}

func DecodeExec(payload []byte) (ExecRequest, error) {
	request, err := DecodePayload[ExecRequest](payload)
	if err != nil {
		return ExecRequest{}, err
	}
	if err := request.Validate(); err != nil {
		return ExecRequest{}, err
	}
	if request.ComputerID != "" {
		return ExecRequest{}, errors.New("direct daemon exec cannot select an Agent Computer")
	}
	return request, nil
}

func DecodeComputerCreate(payload []byte) (ComputerCreateRequest, error) {
	request, err := DecodePayload[ComputerCreateRequest](payload)
	if err != nil {
		return ComputerCreateRequest{}, err
	}
	if err := request.Computer.Validate(true); err != nil {
		return ComputerCreateRequest{}, err
	}
	return request, nil
}

func DecodeComputerReference(payload []byte) (ComputerReference, error) {
	request, err := DecodePayload[ComputerReference](payload)
	if err != nil {
		return ComputerReference{}, err
	}
	if !validToken(request.ID, 128) {
		return ComputerReference{}, errors.New("invalid Computer ID")
	}
	return request, nil
}

func DecodeComputerWorkspaceRequest(payload []byte) (ComputerWorkspaceRequest, error) {
	request, err := DecodePayload[ComputerWorkspaceRequest](payload)
	if err != nil {
		return ComputerWorkspaceRequest{}, err
	}
	if !validToken(request.ComputerID, 128) {
		return ComputerWorkspaceRequest{}, errors.New("invalid Computer ID")
	}
	if len(request.Path) > 4096 || !utf8.ValidString(request.Path) || strings.IndexByte(request.Path, 0) >= 0 {
		return ComputerWorkspaceRequest{}, errors.New("invalid workspace path")
	}
	return request, nil
}

func DecodeComputerGitPush(payload []byte) (ComputerGitPushRequest, error) {
	request, err := DecodePayload[ComputerGitPushRequest](payload)
	if err != nil {
		return ComputerGitPushRequest{}, err
	}
	if !validToken(request.OperationID, 128) || !validToken(request.ComputerID, 128) ||
		!validGitRepositoryPart(request.Owner) || !validGitRepositoryPart(request.Repository) ||
		!validGitBranch(request.BaseBranch) || request.Branch != "zapvm/"+request.OperationID {
		return ComputerGitPushRequest{}, errors.New("invalid Git push identity or branch")
	}
	parsed, err := url.Parse(request.HTTPSCloneURL)
	expectedPath := "/" + request.Owner + "/" + request.Repository + ".git"
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Path != expectedPath ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return ComputerGitPushRequest{}, errors.New("invalid Git push HTTPS clone URL")
	}
	if len(request.Token) < 16 || len(request.Token) > 4096 {
		return ComputerGitPushRequest{}, errors.New("invalid Git push credential")
	}
	for _, character := range request.Token {
		if character < 0x21 || character > 0x7e {
			return ComputerGitPushRequest{}, errors.New("invalid Git push credential")
		}
	}
	return request, nil
}

func validGitRepositoryPart(value string) bool {
	return validToken(value, 100) && value != "." && value != ".." && !strings.HasSuffix(strings.ToLower(value), ".git")
}

func validGitBranch(value string) bool {
	return value != "" && len(value) <= 255 && !strings.HasPrefix(value, "/") && !strings.HasSuffix(value, "/") &&
		!strings.HasSuffix(value, ".") && !strings.HasSuffix(value, ".lock") && !strings.Contains(value, "..") &&
		!strings.Contains(value, "@{") && !strings.ContainsAny(value, " ~^:?*[\\\x00")
}

func DecodeComputerExec(payload []byte) (ComputerExecRequest, error) {
	request, err := DecodePayload[ComputerExecRequest](payload)
	if err != nil {
		return ComputerExecRequest{}, err
	}
	if !validToken(request.ID, 128) {
		return ComputerExecRequest{}, errors.New("invalid Computer ID")
	}
	if err := request.Command.Validate(); err != nil {
		return ComputerExecRequest{}, err
	}
	return request, nil
}

func DecodeComputerTaskSubmit(payload []byte) (ComputerTaskSubmitRequest, error) {
	request, err := DecodePayload[ComputerTaskSubmitRequest](payload)
	if err != nil {
		return ComputerTaskSubmitRequest{}, err
	}
	if request.ID != "" && !validToken(request.ID, 128) {
		return ComputerTaskSubmitRequest{}, errors.New("invalid Task ID")
	}
	if !validToken(request.ComputerID, 128) {
		return ComputerTaskSubmitRequest{}, errors.New("invalid Computer ID")
	}
	if err := request.Command.Validate(); err != nil {
		return ComputerTaskSubmitRequest{}, err
	}
	return request, nil
}

func DecodeComputerTaskCredentialSubmit(payload []byte) (ComputerTaskCredentialSubmitRequest, error) {
	request, err := DecodePayload[ComputerTaskCredentialSubmitRequest](payload)
	if err != nil {
		return ComputerTaskCredentialSubmitRequest{}, err
	}
	encoded, err := json.Marshal(request.Task)
	if err != nil {
		return ComputerTaskCredentialSubmitRequest{}, errors.New("encode credentialed Task authority")
	}
	task, err := DecodeComputerTaskSubmit(encoded)
	credential.ZeroBytes(encoded)
	if err != nil {
		return ComputerTaskCredentialSubmitRequest{}, err
	}
	request.Task = task
	if err := ValidateCredentialValues(task.Command.CredentialIDs, request.Values); err != nil {
		credential.ZeroValues(request.Values)
		return ComputerTaskCredentialSubmitRequest{}, err
	}
	return request, nil
}

func ValidateCredentialValues(ids []string, values map[string][]byte) error {
	if len(ids) == 0 || len(values) != len(ids) || len(values) > credential.MaxCredentials {
		return errors.New("credential values do not exactly match requested IDs")
	}
	total := 0
	for _, id := range ids {
		value, ok := values[id]
		if !ok || len(value) == 0 || len(value) > credential.MaxValueSize {
			return errors.New("credential value is missing or outside limits")
		}
		total += len(value)
		if total > credential.MaxTotalSize {
			return errors.New("credential values exceed total size limit")
		}
	}
	for id := range values {
		if !credential.ValidID(id) {
			return errors.New("credential values contain an invalid ID")
		}
	}
	return nil
}

func DecodeComputerTaskList(payload []byte) (ComputerTaskListRequest, error) {
	request, err := DecodePayload[ComputerTaskListRequest](payload)
	if err != nil {
		return ComputerTaskListRequest{}, err
	}
	if request.ComputerID != "" && !validToken(request.ComputerID, 128) {
		return ComputerTaskListRequest{}, errors.New("invalid Computer ID")
	}
	return request, nil
}

func DecodeComputerTaskReference(payload []byte) (ComputerTaskReference, error) {
	request, err := DecodePayload[ComputerTaskReference](payload)
	if err != nil {
		return ComputerTaskReference{}, err
	}
	if !validToken(request.ID, 128) {
		return ComputerTaskReference{}, errors.New("invalid Task ID")
	}
	return request, nil
}

func DecodeComputerTaskAttach(payload []byte) (ComputerTaskAttachRequest, error) {
	request, err := DecodePayload[ComputerTaskAttachRequest](payload)
	if err != nil {
		return ComputerTaskAttachRequest{}, err
	}
	if !validToken(request.ID, 128) {
		return ComputerTaskAttachRequest{}, errors.New("invalid Task ID")
	}
	if request.AfterCursor > 100000 {
		return ComputerTaskAttachRequest{}, errors.New("Task cursor exceeds the journal limit")
	}
	return request, nil
}

func DecodeComputerTaskRetry(payload []byte) (ComputerTaskRetryRequest, error) {
	request, err := DecodePayload[ComputerTaskRetryRequest](payload)
	if err != nil {
		return ComputerTaskRetryRequest{}, err
	}
	if !validToken(request.SourceID, 128) || (request.ID != "" && !validToken(request.ID, 128)) {
		return ComputerTaskRetryRequest{}, errors.New("invalid source or new Task ID")
	}
	if request.ID != "" && request.ID == request.SourceID {
		return ComputerTaskRetryRequest{}, errors.New("retried Task must use a new ID")
	}
	if err := request.Command.Validate(); err != nil {
		return ComputerTaskRetryRequest{}, err
	}
	return request, nil
}

func DecodeComputerTaskPrune(payload []byte) (ComputerTaskPruneRequest, error) {
	request, err := DecodePayload[ComputerTaskPruneRequest](payload)
	if err != nil {
		return ComputerTaskPruneRequest{}, err
	}
	minimum := uint64(time.Minute.Milliseconds())
	maximum := uint64((10 * 365 * 24 * time.Hour).Milliseconds())
	if request.RetentionMillis < minimum || request.RetentionMillis > maximum {
		return ComputerTaskPruneRequest{}, errors.New("Task retention must be between 1 minute and 10 years")
	}
	if request.Limit < 1 || request.Limit > 10000 {
		return ComputerTaskPruneRequest{}, errors.New("Task prune limit must be between 1 and 10000")
	}
	return request, nil
}

func DecodeComputerArtifactCollect(payload []byte) (ComputerArtifactCollectRequest, error) {
	request, err := DecodePayload[ComputerArtifactCollectRequest](payload)
	if err != nil {
		return ComputerArtifactCollectRequest{}, err
	}
	if !validToken(request.TaskID, 128) || !validToken(request.ComputerID, 128) {
		return ComputerArtifactCollectRequest{}, errors.New("invalid Artifact collection Task or Computer ID")
	}
	return request, nil
}

func DecodeArtifactCollection(payload []byte) (ArtifactCollection, error) {
	collection, err := DecodePayload[ArtifactCollection](payload)
	if err != nil {
		return ArtifactCollection{}, err
	}
	if len(collection.Artifacts) > 100 {
		return ArtifactCollection{}, errors.New("Artifact collection exceeds file limit")
	}
	if len(collection.Artifacts) == 0 {
		if collection.Capability != "" || collection.ExpiresAt != "" {
			return ArtifactCollection{}, errors.New("empty Artifact collection contains capability authority")
		}
		return collection, nil
	}
	capability, err := base64.RawURLEncoding.DecodeString(collection.Capability)
	if err != nil || len(capability) != 32 {
		return ArtifactCollection{}, errors.New("Artifact collection capability is invalid")
	}
	if _, err := time.Parse(time.RFC3339Nano, collection.ExpiresAt); err != nil {
		return ArtifactCollection{}, errors.New("Artifact collection expiry is invalid")
	}
	seenIDs := make(map[string]struct{}, len(collection.Artifacts))
	seenPaths := make(map[string]struct{}, len(collection.Artifacts))
	var total uint64
	for _, artifact := range collection.Artifacts {
		_, _, mimeErr := mime.ParseMediaType(artifact.ContentType)
		digest, digestErr := hex.DecodeString(artifact.SHA256)
		if !validToken(artifact.ID, 128) || workspacefs.ValidatePath(artifact.Path, false) != nil || mimeErr != nil || len(artifact.ContentType) > 255 ||
			artifact.Size == 0 || artifact.Size > uint64(5<<30) || digestErr != nil || len(digest) != sha256.Size || strings.ToLower(artifact.SHA256) != artifact.SHA256 {
			return ArtifactCollection{}, errors.New("Artifact collection metadata is invalid")
		}
		if _, exists := seenIDs[artifact.ID]; exists {
			return ArtifactCollection{}, errors.New("Artifact collection contains a duplicate ID")
		}
		if _, exists := seenPaths[artifact.Path]; exists {
			return ArtifactCollection{}, errors.New("Artifact collection contains a duplicate path")
		}
		if total > uint64(20<<30)-artifact.Size {
			return ArtifactCollection{}, errors.New("Artifact collection exceeds total size limit")
		}
		seenIDs[artifact.ID] = struct{}{}
		seenPaths[artifact.Path] = struct{}{}
		total += artifact.Size
	}
	return collection, nil
}

func DecodeComputerArtifactOpen(payload []byte) (ComputerArtifactOpenRequest, error) {
	request, err := DecodePayload[ComputerArtifactOpenRequest](payload)
	if err != nil {
		return ComputerArtifactOpenRequest{}, err
	}
	capability, err := base64.RawURLEncoding.DecodeString(request.Capability)
	if err != nil || len(capability) != 32 || !validToken(request.ArtifactID, 128) {
		return ComputerArtifactOpenRequest{}, errors.New("Artifact open capability or ID is invalid")
	}
	return request, nil
}

func DecodeArtifactChunk(payload []byte) (ArtifactChunk, error) {
	chunk, err := DecodePayload[ArtifactChunk](payload)
	if err != nil {
		return ArtifactChunk{}, err
	}
	if len(chunk.Data) < 1 || len(chunk.Data) > 256<<10 {
		return ArtifactChunk{}, errors.New("Artifact chunk size is invalid")
	}
	return chunk, nil
}

func DecodeArtifactEnd(payload []byte) (ArtifactEnd, error) {
	end, err := DecodePayload[ArtifactEnd](payload)
	if err != nil {
		return ArtifactEnd{}, err
	}
	digest, digestErr := hex.DecodeString(end.SHA256)
	if end.Size < 1 || end.Size > uint64(5<<30) || digestErr != nil || len(digest) != sha256.Size || strings.ToLower(end.SHA256) != end.SHA256 {
		return ArtifactEnd{}, errors.New("Artifact end metadata is invalid")
	}
	return end, nil
}

func (request ExecRequest) Validate() error {
	if request.ComputerID != "" && !validToken(request.ComputerID, 128) {
		return errors.New("daemon exec contains an invalid Computer ID")
	}
	if request.Workspace == "" || len(request.Workspace) > 32767 || strings.IndexByte(request.Workspace, 0) >= 0 || !utf8.ValidString(request.Workspace) {
		return errors.New("daemon exec workspace is empty, oversized, invalid UTF-8, or contains NUL")
	}
	if err := validateNetwork(request.Network, request.AllowedDomains, request.AllowedPorts); err != nil {
		return err
	}
	if err := request.Command.Validate(); err != nil {
		return err
	}
	if request.CredentialValues != nil {
		return ValidateCredentialValues(request.Command.CredentialIDs, request.CredentialValues)
	}
	return nil
}

func (computer ComputerSpec) Validate(allowResourceDefaults bool) error {
	if !validToken(computer.ID, 128) {
		return errors.New("Computer ID must contain 1-128 ASCII token characters")
	}
	if computer.Agent != "" {
		id, version, ok := strings.Cut(computer.Agent, "@")
		if !ok || strings.Contains(version, "@") || !validToken(id, 128) || !validVersion(version) {
			return errors.New("Computer Agent must be an id@version reference")
		}
	}
	if computer.Workspace == "" || len(computer.Workspace) > 32767 || strings.IndexByte(computer.Workspace, 0) >= 0 || !utf8.ValidString(computer.Workspace) {
		return errors.New("Computer workspace is empty, oversized, invalid UTF-8, or contains NUL")
	}
	if err := validateNetwork(computer.Network, computer.AllowedDomains, computer.AllowedPorts); err != nil {
		return err
	}
	if (!allowResourceDefaults || computer.CPUCount != 0) && (computer.CPUCount < 1 || computer.CPUCount > 256) {
		return errors.New("Computer CPU count must be between 1 and 256")
	}
	if (!allowResourceDefaults || computer.MemoryMiB != 0) && (computer.MemoryMiB < 256 || computer.MemoryMiB > 1024*1024) {
		return errors.New("Computer memory must be between 256 MiB and 1 TiB")
	}
	if computer.CreatedAt != "" || computer.RuntimeState != "" {
		return errors.New("Computer create request cannot set server-owned fields")
	}
	return nil
}

func validVersion(value string) bool {
	if value == "" || value == "." || value == ".." || len(value) > 128 || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || strings.ContainsRune("._+-", character) {
			continue
		}
		return false
	}
	return true
}

func validateNetwork(network platform.NetworkMode, allowedDomains []string, allowedPorts []uint16) error {
	switch network {
	case platform.NetworkOff, platform.NetworkUnrestricted:
		if len(allowedDomains) != 0 || len(allowedPorts) != 0 {
			return errors.New("network allow rules require restricted mode")
		}
	case platform.NetworkRestricted:
		if len(allowedDomains) == 0 {
			return errors.New("restricted network mode requires allowed domains")
		}
	default:
		return errors.New("invalid network mode")
	}
	if len(allowedDomains) > MaxAllowedDomains || len(allowedPorts) > MaxAllowedPorts {
		return errors.New("too many network allow rules")
	}
	for _, domain := range allowedDomains {
		if domain == "" || len(domain) > 253 || strings.IndexByte(domain, 0) >= 0 || !utf8.ValidString(domain) {
			return errors.New("invalid allowed domain")
		}
	}
	for _, port := range allowedPorts {
		if port == 0 {
			return errors.New("invalid allowed port")
		}
	}
	return nil
}

func (command Command) Validate() error {
	if !validIdentifier(command.ID) || !validIdentifier(command.SessionID) {
		return errors.New("daemon command id and session_id must contain 1-256 valid non-NUL UTF-8 bytes")
	}
	if len(command.Argv) == 0 || len(command.Argv) > MaxArguments || command.Argv[0] == "" {
		return fmt.Errorf("daemon command requires 1-%d argv entries and a non-empty executable", MaxArguments)
	}
	if len(command.Title) > 512 || utf8.RuneCountInString(command.Title) > 80 || strings.IndexByte(command.Title, 0) >= 0 || !utf8.ValidString(command.Title) {
		return errors.New("daemon command contains an invalid title")
	}
	for _, argument := range command.Argv {
		if len(argument) > 128<<10 || strings.IndexByte(argument, 0) >= 0 || !utf8.ValidString(argument) {
			return errors.New("daemon command contains an invalid argument")
		}
	}
	if len(command.Cwd) > 4096 || strings.IndexByte(command.Cwd, 0) >= 0 || !utf8.ValidString(command.Cwd) {
		return errors.New("daemon command contains an invalid cwd")
	}
	if len(command.CredentialIDs) > credential.MaxCredentials {
		return errors.New("daemon command contains too many credential IDs")
	}
	seen := make(map[string]struct{}, len(command.CredentialIDs))
	for _, id := range command.CredentialIDs {
		if !credential.ValidID(id) {
			return fmt.Errorf("daemon command contains invalid credential ID %q", id)
		}
		if _, exists := seen[id]; exists {
			return fmt.Errorf("daemon command repeats credential ID %q", id)
		}
		seen[id] = struct{}{}
	}
	if err := workspacepolicy.ValidateProtectedPaths(command.ProtectedWorkspacePaths); err != nil {
		return err
	}
	if err := workspacepolicy.ValidateDeniedPatterns(command.DeniedWorkspacePatterns); err != nil {
		return err
	}
	if command.TimeoutMillis == 0 || command.TimeoutMillis > uint64((24*time.Hour).Milliseconds()) {
		return errors.New("daemon command timeout must be between 1ms and 24h")
	}
	return nil
}

func validIdentifier(value string) bool {
	return value != "" && len(value) <= 256 && utf8.ValidString(value) && strings.IndexByte(value, 0) < 0
}
