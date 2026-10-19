package cloudplane

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"zapvm/internal/computer"
	"zapvm/internal/credential"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/nodeidentity"
)

const (
	SchemaVersion             = 1
	stateSchemaVersion        = 10
	MaxPayloadSize            = 1 << 20
	MaxScopes                 = 256
	MaxAttempts               = 10
	MaxComputerRuntimeReports = daemonrpc.MaxComputerRuntimes
)

func normalizeTaskPayload(payload json.RawMessage) (json.RawMessage, error) {
	if len(payload) == 0 || len(payload) > MaxPayloadSize || !json.Valid(payload) {
		return nil, errors.New("task payload must be bounded valid JSON")
	}
	var buffer bytes.Buffer
	buffer.Grow(len(payload))
	if err := json.Compact(&buffer, payload); err != nil {
		return nil, err
	}
	return append(json.RawMessage(nil), buffer.Bytes()...), nil
}

// PrepareSubmitRequest applies the same canonical payload and authority checks
// used by the file Store so alternate durable backends cannot weaken the Task
// envelope contract.
func PrepareSubmitRequest(request SubmitRequest) (SubmitRequest, string, error) {
	payload, err := normalizeTaskPayload(request.Payload)
	if err != nil {
		return SubmitRequest{}, "", err
	}
	request.Payload = payload
	digest, err := request.validate()
	if err != nil {
		return SubmitRequest{}, "", err
	}
	return request, digest, nil
}

const (
	NodeOffline  = "offline"
	NodeOnline   = "online"
	NodeDraining = "draining"

	DaemonUnknown     = "unknown"
	DaemonHealthy     = "healthy"
	DaemonPaused      = "paused"
	DaemonDegraded    = "degraded"
	DaemonUnreachable = "unreachable"

	TaskPending   = "pending"
	TaskLeased    = "leased"
	TaskRunning   = "running"
	TaskCanceling = "canceling"
	TaskSucceeded = "succeeded"
	TaskFailed    = "failed"
	TaskCanceled  = "canceled"

	QueueReasonDispatchWait     = "dispatch_wait"
	QueueReasonCapacityWait     = "capacity_wait"
	QueueReasonNodeOffline      = "node_offline"
	QueueReasonComputerStarting = "computer_starting"

	ComputerDesiredRunning = "running"
	ComputerDesiredStopped = "stopped"

	ComputerObservedUnavailable = "unavailable"
	ComputerObservedReady       = "ready"
	ComputerObservedBusy        = "busy"
	ComputerObservedDegraded    = "degraded"

	PlacementModeStatic  = "static"
	PlacementModeDynamic = "dynamic"

	PlacementReady    = "ready"
	PlacementReleased = "released"
	PlacementFailed   = "failed"

	ComputerOperationStart     = "start"
	ComputerOperationStop      = "stop"
	ComputerOperationPending   = "pending"
	ComputerOperationLeased    = "leased"
	ComputerOperationSucceeded = "succeeded"
	ComputerOperationFailed    = "failed"

	ComputerLifecycleWake    = "wake"
	ComputerLifecycleRelease = "release"
)

var (
	ErrNotFound        = errors.New("cloud control-plane object does not exist")
	ErrConflict        = errors.New("cloud control-plane idempotency conflict")
	ErrUnauthorized    = errors.New("cloud control-plane scope is not authorized")
	ErrFenced          = errors.New("cloud control-plane lease is fenced")
	ErrUnavailable     = errors.New("cloud control-plane node is unavailable")
	ErrComputerOffline = errors.New("cloud control-plane Agent Computer is offline")
	ErrTerminal        = errors.New("cloud control-plane task is terminal")
	ErrStoreDegraded   = errors.New("cloud control-plane store is degraded")
	ErrCapacityReached = errors.New("cloud control-plane node capacity is exhausted")
	ErrQuotaReached    = errors.New("cloud control-plane quota is exhausted")
)

type Scope struct {
	TenantID  string `json:"tenant_id"`
	ProjectID string `json:"project_id"`
}

func (scope Scope) Validate() error {
	if !validName(scope.TenantID, 128) || !validName(scope.ProjectID, 128) {
		return errors.New("tenant and project IDs must be canonical lowercase names")
	}
	return nil
}

func (scope Scope) key() string { return scope.TenantID + "\x00" + scope.ProjectID }

type NodeProvision struct {
	ID        string              `json:"id"`
	Capacity  uint16              `json:"capacity"`
	Scopes    []Scope             `json:"scopes"`
	Computers []ComputerProvision `json:"computers,omitempty"`
}

type ComputerProvision struct {
	ID        string `json:"id"`
	TenantID  string `json:"tenant_id"`
	ProjectID string `json:"project_id"`
	Agent     string `json:"agent,omitempty"`
}

func (provision ComputerProvision) Scope() Scope {
	return Scope{TenantID: provision.TenantID, ProjectID: provision.ProjectID}
}

func (provision NodeProvision) Validate() error {
	if !computer.ValidID(provision.ID) {
		return errors.New("node ID is invalid")
	}
	if provision.Capacity < 1 || provision.Capacity > 1024 {
		return errors.New("node capacity must be between 1 and 1024")
	}
	if len(provision.Scopes) < 1 || len(provision.Scopes) > MaxScopes {
		return fmt.Errorf("node must have between 1 and %d authorized scopes", MaxScopes)
	}
	seen := make(map[string]struct{}, len(provision.Scopes))
	for _, scope := range provision.Scopes {
		if err := scope.Validate(); err != nil {
			return err
		}
		if _, exists := seen[scope.key()]; exists {
			return errors.New("node contains duplicate authorized scopes")
		}
		seen[scope.key()] = struct{}{}
	}
	if len(provision.Computers) > 4096 {
		return errors.New("node contains too many Computer provisions")
	}
	seenComputers := make(map[string]struct{}, len(provision.Computers))
	for _, computerProvision := range provision.Computers {
		scope := computerProvision.Scope()
		if !computer.ValidID(computerProvision.ID) || scope.Validate() != nil {
			return errors.New("node contains an invalid Computer provision")
		}
		if computerProvision.Agent != "" {
			id, version, found := strings.Cut(computerProvision.Agent, "@")
			if !found || strings.Contains(version, "@") || !computer.ValidID(id) || !validRuntimeVersion(version) {
				return errors.New("node contains an invalid Computer Agent provision")
			}
		}
		if _, authorized := seen[scope.key()]; !authorized {
			return errors.New("Computer provision scope is not authorized for the node")
		}
		key := scope.key() + "\x00" + computerProvision.ID
		if _, duplicate := seenComputers[key]; duplicate {
			return errors.New("node contains a duplicate Computer provision")
		}
		seenComputers[key] = struct{}{}
	}
	return nil
}

// ValidateComputerAgentPlacements prevents redundant Nodes from assigning
// different Runtime-Agent identities to the same tenant Project Computer. A
// blank legacy assignment also conflicts with an explicit assignment because
// otherwise one placement could bypass the Agent identity preflight.
func ValidateComputerAgentPlacements(provisions []NodeProvision) error {
	agents := make(map[string]string)
	for _, provision := range provisions {
		for _, computerProvision := range provision.Computers {
			key := computerProvision.Scope().key() + "\x00" + computerProvision.ID
			if expected, exists := agents[key]; exists && expected != computerProvision.Agent {
				return errors.New("Computer provisions disagree on Agent identity")
			}
			agents[key] = computerProvision.Agent
		}
	}
	return nil
}

type Node struct {
	ID                       string  `json:"id"`
	Generation               string  `json:"generation"`
	State                    string  `json:"state"`
	Capacity                 uint16  `json:"capacity"`
	InFlight                 uint16  `json:"in_flight"`
	Scopes                   []Scope `json:"scopes"`
	LastHeartbeat            string  `json:"last_heartbeat"`
	NodeVersion              string  `json:"node_version,omitempty"`
	DaemonVersion            string  `json:"daemon_version,omitempty"`
	ImageDigest              string  `json:"image_digest,omitempty"`
	DaemonState              string  `json:"daemon_state"`
	FailureCode              string  `json:"failure_code,omitempty"`
	StartAttempts            uint64  `json:"start_attempts"`
	StartFailures            uint64  `json:"start_failures"`
	StartDurationMillisTotal uint64  `json:"start_duration_ms_total"`
	StartDurationMillisMax   uint64  `json:"start_duration_ms_max"`
}

// NodeReport is self-attested operational metadata from an authenticated Node.
// It is visible only on the administrator API and deliberately carries a
// stable failure code instead of local paths or raw daemon errors.
type NodeReport struct {
	NodeVersion              string                  `json:"node_version,omitempty"`
	DaemonVersion            string                  `json:"daemon_version,omitempty"`
	ImageDigest              string                  `json:"image_digest,omitempty"`
	DaemonState              string                  `json:"daemon_state,omitempty"`
	FailureCode              string                  `json:"failure_code,omitempty"`
	StartAttempts            uint64                  `json:"start_attempts"`
	StartFailures            uint64                  `json:"start_failures"`
	StartDurationMillisTotal uint64                  `json:"start_duration_ms_total"`
	StartDurationMillisMax   uint64                  `json:"start_duration_ms_max"`
	ComputerRuntimes         []ComputerRuntimeReport `json:"computer_runtimes,omitempty"`
}

// ComputerRuntimeReport is a bounded, self-attested observation from the
// authenticated Node daemon. Control-plane backends may use an explicit
// stopped observation to release only that Node generation's idle placement.
type ComputerRuntimeReport struct {
	ID    string `json:"id"`
	State string `json:"state"`
}

func (report NodeReport) normalized() (NodeReport, error) {
	if report.DaemonState == "" {
		report.DaemonState = DaemonUnknown
	}
	if (report.NodeVersion != "" && !validRuntimeVersion(report.NodeVersion)) ||
		(report.DaemonVersion != "" && !validRuntimeVersion(report.DaemonVersion)) {
		return NodeReport{}, errors.New("node report contains an invalid runtime version")
	}
	if report.ImageDigest != "" && !validHex(report.ImageDigest, 64) {
		return NodeReport{}, errors.New("node report contains an invalid image digest")
	}
	switch report.DaemonState {
	case DaemonUnknown, DaemonHealthy, DaemonPaused:
		if report.FailureCode != "" {
			return NodeReport{}, errors.New("healthy, paused, or unknown daemon cannot contain a failure code")
		}
	case DaemonDegraded, DaemonUnreachable:
		if !validFailureCode(report.FailureCode) {
			return NodeReport{}, errors.New("unhealthy daemon requires a canonical failure code")
		}
	default:
		return NodeReport{}, errors.New("node report contains an invalid daemon state")
	}
	if report.StartFailures > report.StartAttempts || report.StartDurationMillisMax > report.StartDurationMillisTotal ||
		(report.StartAttempts == 0 && (report.StartFailures != 0 || report.StartDurationMillisTotal != 0 || report.StartDurationMillisMax != 0)) {
		return NodeReport{}, errors.New("node report contains inconsistent VM start telemetry")
	}
	if len(report.ComputerRuntimes) > MaxComputerRuntimeReports {
		return NodeReport{}, errors.New("node report contains too many Computer runtimes")
	}
	seenComputers := make(map[string]struct{}, len(report.ComputerRuntimes))
	for _, runtime := range report.ComputerRuntimes {
		if !computer.ValidID(runtime.ID) {
			return NodeReport{}, errors.New("node report contains an invalid Computer ID")
		}
		switch runtime.State {
		case "stopped", "starting", "running", "busy", "paused", "stopping":
		default:
			return NodeReport{}, errors.New("node report contains an invalid Computer runtime state")
		}
		if _, duplicate := seenComputers[runtime.ID]; duplicate {
			return NodeReport{}, errors.New("node report contains duplicate Computer runtimes")
		}
		seenComputers[runtime.ID] = struct{}{}
	}
	return report, nil
}

// NormalizeNodeReport exposes the shared validation contract to durable
// backend implementations.
func NormalizeNodeReport(report NodeReport) (NodeReport, error) { return report.normalized() }

func (report NodeReport) schedulable() bool {
	return report.DaemonState == DaemonUnknown || report.DaemonState == DaemonHealthy
}

func reportFromNode(node Node) NodeReport {
	return NodeReport{
		NodeVersion: node.NodeVersion, DaemonVersion: node.DaemonVersion,
		ImageDigest: node.ImageDigest, DaemonState: node.DaemonState, FailureCode: node.FailureCode,
		StartAttempts: node.StartAttempts, StartFailures: node.StartFailures,
		StartDurationMillisTotal: node.StartDurationMillisTotal, StartDurationMillisMax: node.StartDurationMillisMax,
	}
}

func applyNodeReport(node *Node, report NodeReport) {
	node.NodeVersion = report.NodeVersion
	node.DaemonVersion = report.DaemonVersion
	node.ImageDigest = report.ImageDigest
	node.DaemonState = report.DaemonState
	node.FailureCode = report.FailureCode
	node.StartAttempts = report.StartAttempts
	node.StartFailures = report.StartFailures
	node.StartDurationMillisTotal = report.StartDurationMillisTotal
	node.StartDurationMillisMax = report.StartDurationMillisMax
}

type Task struct {
	ID               string          `json:"id"`
	TenantID         string          `json:"tenant_id"`
	ProjectID        string          `json:"project_id"`
	ComputerID       string          `json:"computer_id"`
	Payload          json.RawMessage `json:"payload"`
	PayloadSHA256    string          `json:"payload_sha256"`
	CredentialIDs    []string        `json:"credential_ids,omitempty"`
	RetryOf          string          `json:"retry_of,omitempty"`
	State            string          `json:"state"`
	NodeID           string          `json:"node_id,omitempty"`
	NodeGeneration   string          `json:"node_generation,omitempty"`
	Attempt          uint8           `json:"attempt"`
	LeaseTokenHash   string          `json:"lease_token_hash,omitempty"`
	LeaseExpiresAt   string          `json:"lease_expires_at,omitempty"`
	CreatedAt        string          `json:"created_at"`
	CreatedSequence  uint64          `json:"created_sequence"`
	UpdatedAt        string          `json:"updated_at"`
	ResultSHA256     string          `json:"result_sha256,omitempty"`
	FailureCode      string          `json:"failure_code,omitempty"`
	DispatchSequence uint64          `json:"dispatch_sequence,omitempty"`
	QueueReason      string          `json:"queue_reason,omitempty"`
	QueueDeadline    string          `json:"queue_deadline,omitempty"`
	PlacementEpoch   uint64          `json:"placement_epoch,omitempty"`
}

type ComputerOperation struct {
	ID             string `json:"id"`
	TenantID       string `json:"tenant_id"`
	ProjectID      string `json:"project_id"`
	ComputerID     string `json:"computer_id"`
	PlacementEpoch uint64 `json:"placement_epoch"`
	Kind           string `json:"kind"`
	State          string `json:"state"`
	NodeID         string `json:"node_id,omitempty"`
	NodeGeneration string `json:"node_generation,omitempty"`
	Attempt        uint8  `json:"attempt"`
	LeaseTokenHash string `json:"-"`
	LeaseExpiresAt string `json:"lease_expires_at,omitempty"`
	DeadlineAt     string `json:"deadline_at"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
	CompletedAt    string `json:"completed_at,omitempty"`
	FailureCode    string `json:"failure_code,omitempty"`
}

func (operation ComputerOperation) Scope() Scope {
	return Scope{TenantID: operation.TenantID, ProjectID: operation.ProjectID}
}

type ComputerOperationLease struct {
	Operation  ComputerOperation      `json:"operation"`
	LeaseToken string                 `json:"lease_token"`
	Provision  *ComputerProvisionSpec `json:"provision,omitempty"`
}

// ComputerProvision is attached only to start leases for self-service
// Computers. The Node derives the host workspace path from its own trusted
// workspace_root; Control never sends an arbitrary host path.
type ComputerProvisionSpec struct {
	Agent     string `json:"agent"`
	CPUCount  uint   `json:"cpus"`
	MemoryMiB uint64 `json:"memory_mib"`
}

type ComputerOperationCompletion struct {
	Succeeded   bool   `json:"succeeded"`
	FailureCode string `json:"failure_code,omitempty"`
}

// AgentComputerLifecycle is the tenant-scoped acknowledgement returned when
// a Workspace administrator asks the dynamic Host Pool to wake or release a
// Computer. Accepted distinguishes a newly queued operation from an
// idempotent request that was already satisfied or in progress.
type AgentComputerLifecycle struct {
	Action      string `json:"action"`
	Accepted    bool   `json:"accepted"`
	OperationID string `json:"operation_id,omitempty"`
}

func (task Task) Scope() Scope { return Scope{TenantID: task.TenantID, ProjectID: task.ProjectID} }

func ValidQueueReason(value string) bool {
	switch value {
	case QueueReasonDispatchWait, QueueReasonCapacityWait, QueueReasonNodeOffline, QueueReasonComputerStarting:
		return true
	default:
		return false
	}
}

type SubmitRequest struct {
	ID            string
	Scope         Scope
	ComputerID    string
	Payload       json.RawMessage
	CredentialIDs []string
	RetryOf       string
}

func (request SubmitRequest) validate() (string, error) {
	if !computer.ValidID(request.ID) || !computer.ValidID(request.ComputerID) {
		return "", errors.New("task or Computer ID is invalid")
	}
	if request.RetryOf != "" && (!computer.ValidID(request.RetryOf) || request.RetryOf == request.ID) {
		return "", errors.New("task retry source is invalid")
	}
	if err := request.Scope.Validate(); err != nil {
		return "", err
	}
	if len(request.Payload) == 0 || len(request.Payload) > MaxPayloadSize || !json.Valid(request.Payload) {
		return "", errors.New("task payload must be bounded valid JSON")
	}
	decoder := json.NewDecoder(bytes.NewReader(request.Payload))
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", err
	}
	if len(request.CredentialIDs) > credential.MaxCredentials {
		return "", errors.New("task contains too many credential IDs")
	}
	seen := make(map[string]struct{}, len(request.CredentialIDs))
	for _, id := range request.CredentialIDs {
		if !credential.ValidID(id) {
			return "", errors.New("task contains an invalid credential ID")
		}
		if _, exists := seen[id]; exists {
			return "", errors.New("task contains duplicate credential IDs")
		}
		seen[id] = struct{}{}
	}
	digest := sha256.Sum256(request.Payload)
	command, err := daemonrpc.DecodeComputerTaskSubmit(request.Payload)
	if err != nil {
		return "", fmt.Errorf("task payload is not a strict Computer Task submit request: %w", err)
	}
	if command.ComputerID != request.ComputerID || (command.ID != "" && command.ID != request.ID) ||
		!equalStrings(command.Command.CredentialIDs, request.CredentialIDs) {
		return "", errors.New("task payload authority does not match its control-plane envelope")
	}
	return hex.EncodeToString(digest[:]), nil
}

type Lease struct {
	Task                 Task                  `json:"task"`
	Agent                string                `json:"agent,omitempty"`
	LeaseToken           string                `json:"lease_token"`
	CredentialCapability *CredentialCapability `json:"credential_capability,omitempty"`
}

// CredentialCapability is Node-only, one-time authority returned with a
// PostgreSQL Task lease. Secret is never persisted; only its SHA-256 digest is
// stored. Browser/client APIs and Task/Event views must never expose it.
type CredentialCapability struct {
	ID        string `json:"id"`
	Secret    []byte `json:"secret"`
	ExpiresAt string `json:"expires_at"`
}

func (capability *CredentialCapability) Destroy() {
	if capability == nil {
		return
	}
	credential.ZeroBytes(capability.Secret)
	capability.Secret = nil
}

type CredentialBundle struct {
	Values map[string][]byte `json:"values"`
}

func (bundle *CredentialBundle) Destroy() {
	if bundle == nil {
		return
	}
	credential.ZeroValues(bundle.Values)
	clear(bundle.Values)
}

type CredentialDescriptor struct {
	ID        string `json:"id"`
	Version   uint64 `json:"version"`
	State     string `json:"state"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// CredentialBackend is implemented only by a backend with an initialized
// runtime envelope broker. The file Store deliberately does not implement it,
// preserving the explicit Beta static-binding path.
type CredentialBackend interface {
	PutCredential(principal string, scope Scope, id string, value []byte) (CredentialDescriptor, error)
	ListCredentials(scope Scope) ([]CredentialDescriptor, error)
	RevokeCredential(principal string, scope Scope, id string) (CredentialDescriptor, error)
	RedeemCredentialCapability(nodeID, generation, taskID, leaseToken string, capability CredentialCapability) (CredentialBundle, error)
}

// NodeIdentityBackend is enabled by the distributed PostgreSQL authority when
// Control is configured to issue short-lived Node certificates.
type NodeIdentityBackend interface {
	ProvisionNodeEnrollmentTokens(provisions []nodeidentity.EnrollmentProvision) error
	EnrollNodeCertificate(nodeID string, token []byte, record nodeidentity.CertificateRecord) error
	RenewNodeCertificate(nodeID, currentSerial string, record nodeidentity.CertificateRecord) error
	AuthorizeNodeCertificate(nodeID, serialHex string) error
	RevokeNodeCertificate(principal, nodeID, serialHex string) error
}

type LeaseProof struct {
	TaskID     string `json:"task_id"`
	LeaseToken string `json:"lease_token"`
}

type Completion struct {
	Succeeded    bool
	ResultSHA256 string
	FailureCode  string
}

type TaskEvent struct {
	Cursor       uint64 `json:"cursor"`
	Attempt      uint8  `json:"attempt"`
	SourceCursor uint64 `json:"source_cursor"`
	Timestamp    string `json:"timestamp"`
	TaskID       string `json:"task_id"`
	Type         string `json:"type"`
	CommandID    string `json:"command_id,omitempty"`
	Stream       string `json:"stream,omitempty"`
	Data         []byte `json:"data,omitempty"`
	PID          int    `json:"pid,omitempty"`
	OK           *bool  `json:"ok,omitempty"`
	Error        string `json:"error,omitempty"`
}

func cloneTaskEvent(event TaskEvent) TaskEvent {
	event.Data = append([]byte(nil), event.Data...)
	if event.OK != nil {
		value := *event.OK
		event.OK = &value
	}
	return event
}

func (completion Completion) validate() error {
	if completion.ResultSHA256 != "" && !validHex(completion.ResultSHA256, 64) {
		return errors.New("completion result digest is invalid")
	}
	if completion.Succeeded {
		if completion.FailureCode != "" {
			return errors.New("successful completion cannot contain a failure code")
		}
		return nil
	}
	if !validFailureCode(completion.FailureCode) {
		return errors.New("failed completion requires a canonical failure code")
	}
	return nil
}

func validName(value string, maximum int) bool {
	if value == "" || len(value) > maximum || !utf8.ValidString(value) || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for _, char := range value[1:] {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '.' && char != '-' && char != '_' {
			return false
		}
	}
	return value != "." && value != ".."
}

func validRuntimeVersion(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') &&
			(char < '0' || char > '9') && char != '.' && char != '-' && char != '_' && char != '+' {
			return false
		}
	}
	return true
}

func validGeneration(value string) bool {
	return computer.ValidID(value) && len(value) >= 16
}

func validFailureCode(value string) bool {
	return validName(value, 64) && !strings.Contains(value, ".")
}

func validHex(value string, length int) bool {
	if len(value) != length || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func parseTimestamp(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, errors.New("timestamp is invalid")
	}
	return parsed, nil
}

func cloneTask(task Task) Task {
	task.Payload = append(json.RawMessage(nil), task.Payload...)
	task.CredentialIDs = append([]string(nil), task.CredentialIDs...)
	return task
}

func cloneNode(node Node) Node {
	node.Scopes = append([]Scope(nil), node.Scopes...)
	return node
}
