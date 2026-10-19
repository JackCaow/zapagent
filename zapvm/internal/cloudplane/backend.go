package cloudplane

import (
	"context"
	"time"

	"zapvm/internal/daemonrpc"
)

// Backend is the complete durable authority consumed by the Control HTTP API.
// Store implements it for the single-active file backend. PostgreSQL multi-
// replica implementations must satisfy the same contract without sharing a
// local state root.
type Backend interface {
	Ready() error
	Now() time.Time
	OperationalSnapshot() OperationalSnapshot

	RegisterNodeWithReport(nodeID, generation string, report NodeReport) (Node, error)
	HeartbeatWithReport(nodeID, generation string, proofs []LeaseProof, report NodeReport) (Node, error)
	Cancellations(nodeID, generation string, proofs []LeaseProof) ([]string, error)
	SetNodeDraining(nodeID, generation string, draining bool) (Node, error)
	ListNodes() []Node

	Submit(principal string, request SubmitRequest) (Task, bool, error)
	SubmitAgentSession(principal string, request SubmitRequest, sessionID string, continuation bool) (Task, bool, error)
	RetryAgentSession(principal string, scope Scope, sourceID, newID string) (Task, bool, error)
	ListAgentSessions(scope Scope, after uint64, limit int) ([]Task, uint64, error)
	InspectTask(scope Scope, taskID string) (Task, error)
	TaskEvents(scope Scope, taskID string, after uint64, limit int) ([]TaskEvent, error)
	WaitTaskEvents(ctx context.Context, scope Scope, taskID string, after uint64, limit int) (Task, []TaskEvent, error)
	Cancel(principal string, scope Scope, taskID string) (Task, error)

	Claim(nodeID, generation string, maximum int) ([]Lease, error)
	Acknowledge(nodeID, generation, taskID, leaseToken string) (Task, error)
	Complete(nodeID, generation, taskID, leaseToken string, completion Completion) (Task, error)
	ConfirmCanceled(nodeID, generation, taskID, leaseToken string) (Task, error)
	AppendTaskEvent(nodeID, generation, taskID, leaseToken string, source daemonrpc.ComputerTaskEvent) (TaskEvent, bool, error)

	RegisterArtifact(nodeID, generation, taskID, leaseToken string, request ArtifactRegistrationRequest) (Artifact, bool, error)
	PrepareArtifactUpload(nodeID, generation, taskID, leaseToken, artifactID string) (Artifact, bool, error)
	CompleteArtifactUpload(nodeID, generation, taskID, leaseToken, artifactID, objectKey string) (Artifact, error)
	FailArtifactUpload(nodeID, generation, taskID, leaseToken, artifactID, failureCode string) (Artifact, error)
	InspectAgentArtifact(scope Scope, id string) (Artifact, error)
	ListAgentSessionArtifacts(scope Scope, taskID string, after uint64, limit int) ([]Artifact, uint64, error)

	SubmitWorkspaceOperation(principal string, request WorkspaceOperationRequest) (WorkspaceOperation, bool, error)
	ClaimWorkspaceOperations(nodeID, generation string, maximum int) ([]WorkspaceOperationLease, error)
	InspectWorkspaceOperation(scope Scope, id string) (WorkspaceOperation, error)
	InspectWorkspaceOperationLease(nodeID, generation, operationID, leaseToken string) (WorkspaceOperation, error)
	CompleteWorkspaceOperation(nodeID, generation, operationID, leaseToken string, completion WorkspaceOperationCompletion) (WorkspaceOperation, error)
	DeleteWorkspaceOperation(principal string, scope Scope, id string) (WorkspaceOperation, error)

	ListAgentComputers(scope Scope) ([]AgentComputer, error)
	Audit(scope Scope, after uint64, limit int) ([]AuditRecord, error)
}

// TaskEventBatchAppender is an optional backend acceleration used by the
// persistent Node Relay. Implementations must commit the whole batch
// atomically and preserve AppendTaskEvent's source-cursor idempotence.
type TaskEventBatchAppender interface {
	AppendTaskEvents(nodeID, generation, taskID, leaseToken string, sources []daemonrpc.ComputerTaskEvent) ([]TaskEvent, error)
}

// ComputerOperationBackend is the optional dynamic-placement authority used
// by Nodes to start a Computer before its first Task is dispatchable. Static
// and single-active backends intentionally do not need to implement it.
type ComputerOperationBackend interface {
	ClaimComputerOperations(nodeID, generation string, maximum int) ([]ComputerOperationLease, error)
	CompleteComputerOperation(nodeID, generation, operationID, leaseToken string, completion ComputerOperationCompletion) (ComputerOperation, error)
}

// AgentComputerLifecycleBackend is implemented by dynamic placement stores
// that can explicitly wake and release tenant Computers. The ordinary Agent
// API remains read-only unless the BFF authenticates a Workspace administrator
// and invokes this optional capability.
type AgentComputerLifecycleBackend interface {
	RequestAgentComputerLifecycle(principal string, scope Scope, computerID, action string) (AgentComputerLifecycle, error)
}

var _ Backend = (*Store)(nil)

// Now returns the backend clock used for signed URL expiration and observable
// timestamps. It intentionally exposes a value rather than the clock function.
func (store *Store) Now() time.Time { return store.now().UTC() }
