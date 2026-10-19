package controlpostgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"zapvm/internal/cloudplane"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/nodeidentity"
)

type BackendOptions struct {
	OperationTimeout time.Duration
	Queue            QueueOptions
	Provisions       []cloudplane.NodeProvision
}

// Backend adapts the context-aware PostgreSQL authority to the synchronous
// cloudplane.Backend contract consumed by the HTTP API.
type Backend struct {
	queue   *Queue
	timeout time.Duration
}

var _ cloudplane.Backend = (*Backend)(nil)
var _ cloudplane.TaskEventBatchAppender = (*Backend)(nil)
var _ cloudplane.CredentialBackend = (*Backend)(nil)
var _ cloudplane.NodeIdentityBackend = (*Backend)(nil)
var _ cloudplane.ComputerOperationBackend = (*Backend)(nil)
var _ cloudplane.PlatformAdminBackend = (*Backend)(nil)

func NewBackend(ctx context.Context, migrator *Migrator, options BackendOptions) (*Backend, error) {
	if ctx == nil {
		return nil, errors.New("PostgreSQL Backend context is required")
	}
	if options.OperationTimeout == 0 {
		options.OperationTimeout = 30 * time.Second
	}
	if options.OperationTimeout < time.Second || options.OperationTimeout > 10*time.Minute {
		return nil, errors.New("PostgreSQL Backend operation timeout must be between 1 second and 10 minutes")
	}
	status, err := migrator.Status(ctx)
	if err != nil || status.Pending != 0 || status.Current == 0 {
		return nil, errors.New("PostgreSQL Backend schema is not current")
	}
	queue, err := NewQueue(migrator, options.Queue)
	if err != nil {
		return nil, err
	}
	if err := queue.ReconcileProvisions(ctx, options.Provisions); err != nil {
		return nil, err
	}
	return &Backend{queue: queue, timeout: options.OperationTimeout}, nil
}

func (backend *Backend) context() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), backend.timeout)
}

func (backend *Backend) Ready() error {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.Ready(ctx)
}

func (backend *Backend) Now() time.Time { return backend.queue.now().UTC() }

func (backend *Backend) OperationalSnapshot() cloudplane.OperationalSnapshot {
	ctx, cancel := backend.context()
	defer cancel()
	snapshot, err := backend.queue.OperationalSnapshot(ctx)
	if err != nil {
		return cloudplane.OperationalSnapshot{SchemaVersion: 1, CollectedAt: backend.Now().Format(time.RFC3339Nano), Ready: false}
	}
	return snapshot
}

func (backend *Backend) RegisterNodeWithReport(nodeID, generation string, report cloudplane.NodeReport) (cloudplane.Node, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.RegisterNodeWithReport(ctx, nodeID, generation, report)
}

func (backend *Backend) HeartbeatWithReport(nodeID, generation string, proofs []cloudplane.LeaseProof, report cloudplane.NodeReport) (cloudplane.Node, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.HeartbeatWithReport(ctx, nodeID, generation, proofs, report)
}

func (backend *Backend) Cancellations(nodeID, generation string, proofs []cloudplane.LeaseProof) ([]string, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.Cancellations(ctx, nodeID, generation, proofs)
}

func (backend *Backend) SetNodeDraining(nodeID, generation string, draining bool) (cloudplane.Node, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.SetNodeDraining(ctx, nodeID, generation, draining)
}

func (backend *Backend) ProvisionNodeEnrollmentTokens(provisions []nodeidentity.EnrollmentProvision) error {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ProvisionNodeEnrollmentTokens(ctx, provisions)
}

func (backend *Backend) EnrollNodeCertificate(nodeID string, token []byte, record nodeidentity.CertificateRecord) error {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.EnrollNodeCertificate(ctx, nodeID, token, record)
}

func (backend *Backend) RenewNodeCertificate(nodeID, currentSerial string, record nodeidentity.CertificateRecord) error {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.RenewNodeCertificate(ctx, nodeID, currentSerial, record)
}

func (backend *Backend) AuthorizeNodeCertificate(nodeID, serialHex string) error {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.AuthorizeNodeCertificate(ctx, nodeID, serialHex)
}

func (backend *Backend) RevokeNodeCertificate(principal, nodeID, serialHex string) error {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.RevokeNodeCertificate(ctx, principal, nodeID, serialHex)
}

func (backend *Backend) ListNodes() []cloudplane.Node {
	ctx, cancel := backend.context()
	defer cancel()
	nodes, err := backend.queue.ListNodes(ctx)
	if err != nil {
		return []cloudplane.Node{}
	}
	return nodes
}

func (backend *Backend) Submit(principal string, request cloudplane.SubmitRequest) (cloudplane.Task, bool, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.Submit(ctx, principal, request)
}

func (backend *Backend) SubmitAgentSession(principal string, request cloudplane.SubmitRequest, sessionID string, continuation bool) (cloudplane.Task, bool, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.SubmitAgentSession(ctx, principal, request, sessionID, continuation)
}

func (backend *Backend) RetryAgentSession(principal string, scope cloudplane.Scope, sourceID, newID string) (cloudplane.Task, bool, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.RetryAgentSession(ctx, principal, scope, sourceID, newID)
}

func (backend *Backend) ListAgentSessions(scope cloudplane.Scope, after uint64, limit int) ([]cloudplane.Task, uint64, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ListAgentSessions(ctx, scope, after, limit)
}

func (backend *Backend) InspectTask(scope cloudplane.Scope, taskID string) (cloudplane.Task, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.InspectTask(ctx, scope, taskID)
}

func (backend *Backend) TaskEvents(scope cloudplane.Scope, taskID string, after uint64, limit int) ([]cloudplane.TaskEvent, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.TaskEvents(ctx, scope, taskID, after, limit)
}

func (backend *Backend) WaitTaskEvents(ctx context.Context, scope cloudplane.Scope, taskID string, after uint64, limit int) (cloudplane.Task, []cloudplane.TaskEvent, error) {
	if ctx == nil {
		return cloudplane.Task{}, nil, errors.New("PostgreSQL Task Event wait context is required")
	}
	return backend.queue.WaitTaskEvents(ctx, scope, taskID, after, limit)
}

func (backend *Backend) Cancel(principal string, scope cloudplane.Scope, taskID string) (cloudplane.Task, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.Cancel(ctx, principal, scope, taskID)
}

func (backend *Backend) Claim(nodeID, generation string, maximum int) ([]cloudplane.Lease, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.Claim(ctx, nodeID, generation, maximum)
}

func (backend *Backend) ClaimComputerOperations(nodeID, generation string, maximum int) ([]cloudplane.ComputerOperationLease, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ClaimComputerOperations(ctx, nodeID, generation, maximum)
}

func (backend *Backend) CompleteComputerOperation(nodeID, generation, operationID, leaseToken string, completion cloudplane.ComputerOperationCompletion) (cloudplane.ComputerOperation, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.CompleteComputerOperation(ctx, nodeID, generation, operationID, leaseToken, completion)
}

func (backend *Backend) Acknowledge(nodeID, generation, taskID, leaseToken string) (cloudplane.Task, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.Acknowledge(ctx, nodeID, generation, taskID, leaseToken)
}

func (backend *Backend) Complete(nodeID, generation, taskID, leaseToken string, completion cloudplane.Completion) (cloudplane.Task, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.Complete(ctx, nodeID, generation, taskID, leaseToken, completion)
}

func (backend *Backend) ConfirmCanceled(nodeID, generation, taskID, leaseToken string) (cloudplane.Task, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ConfirmCanceled(ctx, nodeID, generation, taskID, leaseToken)
}

func (backend *Backend) AppendTaskEvent(nodeID, generation, taskID, leaseToken string, source daemonrpc.ComputerTaskEvent) (cloudplane.TaskEvent, bool, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.AppendEvent(ctx, nodeID, generation, taskID, leaseToken, source)
}

func (backend *Backend) AppendTaskEvents(nodeID, generation, taskID, leaseToken string, sources []daemonrpc.ComputerTaskEvent) ([]cloudplane.TaskEvent, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.AppendEvents(ctx, nodeID, generation, taskID, leaseToken, sources)
}

func (backend *Backend) RegisterArtifact(nodeID, generation, taskID, leaseToken string, request cloudplane.ArtifactRegistrationRequest) (cloudplane.Artifact, bool, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.RegisterArtifact(ctx, nodeID, generation, taskID, leaseToken, request)
}

func (backend *Backend) PrepareArtifactUpload(nodeID, generation, taskID, leaseToken, artifactID string) (cloudplane.Artifact, bool, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.PrepareArtifactUpload(ctx, nodeID, generation, taskID, leaseToken, artifactID)
}

func (backend *Backend) CompleteArtifactUpload(nodeID, generation, taskID, leaseToken, artifactID, objectKey string) (cloudplane.Artifact, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.CompleteArtifactUpload(ctx, nodeID, generation, taskID, leaseToken, artifactID, objectKey)
}

func (backend *Backend) FailArtifactUpload(nodeID, generation, taskID, leaseToken, artifactID, failureCode string) (cloudplane.Artifact, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.FailArtifactUpload(ctx, nodeID, generation, taskID, leaseToken, artifactID, failureCode)
}

func (backend *Backend) InspectAgentArtifact(scope cloudplane.Scope, id string) (cloudplane.Artifact, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.InspectAgentArtifact(ctx, scope, id)
}

func (backend *Backend) ListAgentSessionArtifacts(scope cloudplane.Scope, taskID string, after uint64, limit int) ([]cloudplane.Artifact, uint64, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ListAgentSessionArtifacts(ctx, scope, taskID, after, limit)
}

func (backend *Backend) SubmitWorkspaceOperation(principal string, request cloudplane.WorkspaceOperationRequest) (cloudplane.WorkspaceOperation, bool, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.SubmitWorkspaceOperation(ctx, principal, request)
}

func (backend *Backend) ClaimWorkspaceOperations(nodeID, generation string, maximum int) ([]cloudplane.WorkspaceOperationLease, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ClaimWorkspaceOperations(ctx, nodeID, generation, maximum)
}

func (backend *Backend) InspectWorkspaceOperation(scope cloudplane.Scope, id string) (cloudplane.WorkspaceOperation, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.InspectWorkspaceOperation(ctx, scope, id)
}

func (backend *Backend) InspectWorkspaceOperationLease(nodeID, generation, operationID, leaseToken string) (cloudplane.WorkspaceOperation, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.InspectWorkspaceOperationLease(ctx, nodeID, generation, operationID, leaseToken)
}

func (backend *Backend) CompleteWorkspaceOperation(nodeID, generation, operationID, leaseToken string, completion cloudplane.WorkspaceOperationCompletion) (cloudplane.WorkspaceOperation, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.CompleteWorkspaceOperation(ctx, nodeID, generation, operationID, leaseToken, completion)
}

func (backend *Backend) DeleteWorkspaceOperation(principal string, scope cloudplane.Scope, id string) (cloudplane.WorkspaceOperation, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.DeleteWorkspaceOperation(ctx, principal, scope, id)
}

func (backend *Backend) ListAgentComputers(scope cloudplane.Scope) ([]cloudplane.AgentComputer, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ListAgentComputers(ctx, scope)
}

func (backend *Backend) RequestAgentComputerLifecycle(principal string, scope cloudplane.Scope, computerID, action string) (cloudplane.AgentComputerLifecycle, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.RequestAgentComputerLifecycle(ctx, principal, scope, computerID, action)
}

func (backend *Backend) Audit(scope cloudplane.Scope, after uint64, limit int) ([]cloudplane.AuditRecord, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.Audit(ctx, scope, after, limit)
}

func (backend *Backend) PutCredential(principal string, scope cloudplane.Scope, id string, value []byte) (cloudplane.CredentialDescriptor, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.PutCredential(ctx, principal, scope, id, value)
}

func (backend *Backend) ListCredentials(scope cloudplane.Scope) ([]cloudplane.CredentialDescriptor, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ListCredentials(ctx, scope)
}

func (backend *Backend) RevokeCredential(principal string, scope cloudplane.Scope, id string) (cloudplane.CredentialDescriptor, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.RevokeCredential(ctx, principal, scope, id)
}

func (backend *Backend) RedeemCredentialCapability(nodeID, generation, taskID, leaseToken string, capability cloudplane.CredentialCapability) (cloudplane.CredentialBundle, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.RedeemCredentialCapability(ctx, nodeID, generation, taskID, leaseToken, capability)
}

func (backend *Backend) EnsureWorkspaceOwner(principal string, scope cloudplane.Scope, userID, displayName, email string) (cloudplane.WorkspaceMember, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.EnsureWorkspaceOwner(ctx, principal, scope, userID, displayName, email)
}
func (backend *Backend) ResolveWorkspaceMember(scope cloudplane.Scope, userID string) (cloudplane.WorkspaceMember, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ResolveWorkspaceMember(ctx, scope, userID)
}
func (backend *Backend) ListWorkspaceMembers(scope cloudplane.Scope) ([]cloudplane.WorkspaceMember, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ListWorkspaceMembers(ctx, scope)
}
func (backend *Backend) PutWorkspaceMember(principal string, scope cloudplane.Scope, member cloudplane.WorkspaceMember) (cloudplane.WorkspaceMember, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.PutWorkspaceMember(ctx, principal, scope, member)
}
func (backend *Backend) DeleteWorkspaceMember(principal string, scope cloudplane.Scope, userID string) error {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.DeleteWorkspaceMember(ctx, principal, scope, userID)
}
func (backend *Backend) ListHostPools(scope cloudplane.Scope) ([]cloudplane.HostPool, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ListHostPools(ctx, scope)
}
func (backend *Backend) PutHostPool(principal string, scope cloudplane.Scope, pool cloudplane.HostPool) (cloudplane.HostPool, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.PutHostPool(ctx, principal, scope, pool)
}
func (backend *Backend) DeleteHostPool(principal string, scope cloudplane.Scope, id string) error {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.DeleteHostPool(ctx, principal, scope, id)
}
func (backend *Backend) ListModelProfiles(scope cloudplane.Scope) ([]cloudplane.ModelProfile, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ListModelProfiles(ctx, scope)
}
func (backend *Backend) PutModelProfile(principal string, scope cloudplane.Scope, profile cloudplane.ModelProfile) (cloudplane.ModelProfile, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.PutModelProfile(ctx, principal, scope, profile)
}
func (backend *Backend) DeleteModelProfile(principal string, scope cloudplane.Scope, id string) error {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.DeleteModelProfile(ctx, principal, scope, id)
}
func (backend *Backend) ListAgentProfiles(scope cloudplane.Scope) ([]cloudplane.AgentProfile, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ListAgentProfiles(ctx, scope)
}
func (backend *Backend) PutAgentProfile(principal string, scope cloudplane.Scope, profile cloudplane.AgentProfile) (cloudplane.AgentProfile, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.PutAgentProfile(ctx, principal, scope, profile)
}
func (backend *Backend) DeleteAgentProfile(principal string, scope cloudplane.Scope, id string) error {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.DeleteAgentProfile(ctx, principal, scope, id)
}
func (backend *Backend) ListComputerProfiles(scope cloudplane.Scope) ([]cloudplane.ComputerProfile, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ListComputerProfiles(ctx, scope)
}
func (backend *Backend) CreateComputerProfile(principal string, scope cloudplane.Scope, profile cloudplane.ComputerProfile) (cloudplane.ComputerProfile, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.CreateComputerProfile(ctx, principal, scope, profile)
}
func (backend *Backend) DeleteComputerProfile(principal string, scope cloudplane.Scope, id string) error {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.DeleteComputerProfile(ctx, principal, scope, id)
}
func (backend *Backend) GetWorkspaceQuota(scope cloudplane.Scope) (cloudplane.WorkspaceQuota, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.GetWorkspaceQuota(ctx, scope)
}
func (backend *Backend) PutWorkspaceQuota(principal string, scope cloudplane.Scope, quota cloudplane.WorkspaceQuota) (cloudplane.WorkspaceQuota, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.PutWorkspaceQuota(ctx, principal, scope, quota)
}
func (backend *Backend) GetWorkspaceUsage(scope cloudplane.Scope) (cloudplane.WorkspaceUsage, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.GetWorkspaceUsage(ctx, scope)
}

func (backend *Backend) ResolveComputerRuntime(scope cloudplane.Scope, computerID string) (cloudplane.ComputerRuntimeSelection, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ResolveComputerRuntime(ctx, scope, computerID)
}

func (backend *Backend) Sweep() error {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.Sweep(ctx)
}

func (backend *Backend) ExpiredArtifactObjects(limit int) ([]cloudplane.Artifact, error) {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ExpiredArtifactObjects(ctx, limit)
}

func (backend *Backend) ConfirmArtifactObjectDeleted(id, objectKey string) error {
	ctx, cancel := backend.context()
	defer cancel()
	return backend.queue.ConfirmArtifactObjectDeleted(ctx, id, objectKey)
}

func (queue *Queue) Ready(ctx context.Context) error {
	if err := queue.validateCall(ctx); err != nil {
		return err
	}
	status, err := queue.migrator.Status(ctx)
	if err != nil || status.Current == 0 || status.Pending != 0 {
		return cloudplane.ErrUnavailable
	}
	return nil
}

func (queue *Queue) Sweep(ctx context.Context) error {
	if err := queue.validateCall(ctx); err != nil {
		return err
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	rows, err := transaction.Query(ctx, `SELECT id FROM zapvm.nodes WHERE state<>'offline' AND last_heartbeat<$1 ORDER BY id FOR UPDATE`, now.Add(-queue.heartbeatTTL))
	if err != nil {
		return databaseFailure("lock stale PostgreSQL Nodes", err)
	}
	staleNodes := make([]string, 0)
	for rows.Next() {
		var nodeID string
		if err := rows.Scan(&nodeID); err != nil {
			rows.Close()
			return errors.New("decode stale PostgreSQL Node")
		}
		staleNodes = append(staleNodes, nodeID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("read stale PostgreSQL Nodes")
	}
	for _, nodeID := range staleNodes {
		if _, err := transaction.Exec(ctx, `UPDATE zapvm.nodes SET state='offline',updated_at=$1 WHERE id=$2`, now, nodeID); err != nil {
			return databaseFailure("mark stale PostgreSQL Node offline", err)
		}
		if _, err := appendAudit(ctx, transaction, now, auditInput{action: "node_offline", nodeID: nodeID, outcome: "timeout"}); err != nil {
			return err
		}
	}
	if err := queue.sweepComputerOperations(ctx, transaction, now); err != nil {
		return err
	}
	if err := queue.expirePending(ctx, transaction, now); err != nil {
		return err
	}
	if err := queue.reapExpired(ctx, transaction, now, "", ""); err != nil {
		return err
	}
	if err := queue.expireCredentialCapabilities(ctx, transaction, now); err != nil {
		return err
	}
	if err := queue.expireNodeIdentity(ctx, transaction, now); err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return databaseFailure("commit PostgreSQL Task and Node sweep", err)
	}
	if err := queue.sweepWorkspaceNow(ctx); err != nil {
		return err
	}
	_, err = queue.ExpiredArtifactObjects(ctx, 1)
	return err
}

func (queue *Queue) ReconcileProvisions(ctx context.Context, provisions []cloudplane.NodeProvision) error {
	if err := queue.validateCall(ctx); err != nil {
		return err
	}
	if len(provisions) < 1 || len(provisions) > 4096 {
		return errors.New("PostgreSQL Backend requires provisioned Nodes")
	}
	if err := cloudplane.ValidateComputerAgentPlacements(provisions); err != nil {
		return err
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC().Truncate(time.Microsecond)
	desiredNodes := make(map[string]cloudplane.NodeProvision, len(provisions))
	desiredScopes := make(map[string]struct{})
	desiredComputers := make(map[string]struct{})
	desiredComputerRows := make(map[string]struct{})
	legacyScopeNodes := make(map[string]map[string]struct{})
	explicitComputerScopes := make(map[string]struct{})
	for _, provision := range provisions {
		if err := provision.Validate(); err != nil {
			return err
		}
		if _, duplicate := desiredNodes[provision.ID]; duplicate {
			return errors.New("PostgreSQL Backend contains duplicate Node provisions")
		}
		desiredNodes[provision.ID] = provision
		command, err := transaction.Exec(ctx, `
INSERT INTO zapvm.nodes (id,generation,state,capacity,in_flight,last_heartbeat,daemon_state,updated_at)
VALUES ($1,'provisioned-offline','offline',$2,0,$3,'unknown',$3)
ON CONFLICT (id) DO UPDATE SET capacity=EXCLUDED.capacity,updated_at=EXCLUDED.updated_at
WHERE zapvm.nodes.in_flight<=EXCLUDED.capacity`, provision.ID, int32(provision.Capacity), now)
		if err != nil {
			return databaseFailure("reconcile PostgreSQL Node provision", err)
		}
		if command.RowsAffected() != 1 {
			return cloudplane.ErrCapacityReached
		}
		resourceCommand, err := transaction.Exec(ctx, `
INSERT INTO zapvm.node_resources
    (node_id,total_vcpu,allocatable_vcpu,vm_slots,updated_at)
VALUES ($1,$2,$2,$2,$3)
ON CONFLICT (node_id) DO UPDATE SET
    total_vcpu=EXCLUDED.total_vcpu,
    allocatable_vcpu=EXCLUDED.allocatable_vcpu,
    vm_slots=EXCLUDED.vm_slots,
    updated_at=EXCLUDED.updated_at
WHERE zapvm.node_resources.running_count + zapvm.node_resources.starting_count <= EXCLUDED.vm_slots`, provision.ID, int32(provision.Capacity), now)
		if err != nil {
			return databaseFailure("reconcile PostgreSQL Node resources", err)
		}
		if resourceCommand.RowsAffected() != 1 {
			return cloudplane.ErrCapacityReached
		}
		for _, scope := range provision.Scopes {
			desiredScopes[provision.ID+"\x00"+scope.TenantID+"\x00"+scope.ProjectID] = struct{}{}
			if len(provision.Computers) == 0 {
				key := scope.TenantID + "\x00" + scope.ProjectID
				if legacyScopeNodes[key] == nil {
					legacyScopeNodes[key] = make(map[string]struct{})
				}
				legacyScopeNodes[key][provision.ID] = struct{}{}
			}
			if _, err := transaction.Exec(ctx, `INSERT INTO zapvm.node_scopes (node_id,tenant_id,project_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, provision.ID, scope.TenantID, scope.ProjectID); err != nil {
				return databaseFailure("reconcile PostgreSQL Node scope", err)
			}
		}
		for _, computer := range provision.Computers {
			scopeKey := computer.TenantID + "\x00" + computer.ProjectID
			explicitComputerScopes[scopeKey] = struct{}{}
			desiredComputerRows[scopeKey+"\x00"+computer.ID+"\x00"+computer.Agent] = struct{}{}
			desiredComputers[provision.ID+"\x00"+computer.TenantID+"\x00"+computer.ProjectID+"\x00"+computer.ID] = struct{}{}
			if _, err := transaction.Exec(ctx, `INSERT INTO zapvm.computers (tenant_id,project_id,computer_id,agent,created_at,provisioning_source) VALUES ($1,$2,$3,$4,$5,'config') ON CONFLICT (tenant_id,project_id,computer_id) DO UPDATE SET agent=EXCLUDED.agent WHERE zapvm.computers.provisioning_source='config'`, computer.TenantID, computer.ProjectID, computer.ID, computer.Agent, now); err != nil {
				return databaseFailure("reconcile PostgreSQL Computer", err)
			}
			if _, err := transaction.Exec(ctx, `INSERT INTO zapvm.computer_nodes (tenant_id,project_id,computer_id,node_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, computer.TenantID, computer.ProjectID, computer.ID, provision.ID); err != nil {
				return databaseFailure("reconcile PostgreSQL Computer placement", err)
			}
		}
	}
	// A file-backend provision with Scopes and no Computers is the legacy
	// dynamic-Computer form. Snapshot import projects only Computers that are
	// backed by durable work. Preserve exactly those rows during cutover while
	// still rejecting unreferenced or out-of-scope database authority.
	rows, err := transaction.Query(ctx, `
SELECT tenant_id,project_id,computer_id FROM (
    SELECT tenant_id,project_id,computer_id FROM zapvm.tasks
    UNION
    SELECT tenant_id,project_id,computer_id FROM zapvm.workspace_operations
    UNION
    SELECT tenant_id,project_id,computer_id FROM zapvm.artifacts
) AS tracked ORDER BY tenant_id,project_id,computer_id`)
	if err != nil {
		return databaseFailure("list PostgreSQL tracked legacy Computers", err)
	}
	type legacyComputer struct{ tenantID, projectID, computerID string }
	trackedLegacyComputers := make([]legacyComputer, 0)
	for rows.Next() {
		var tenantID, projectID, computerID string
		if err := rows.Scan(&tenantID, &projectID, &computerID); err != nil {
			rows.Close()
			return errors.New("decode PostgreSQL tracked legacy Computer")
		}
		scopeKey := tenantID + "\x00" + projectID
		if _, explicit := explicitComputerScopes[scopeKey]; explicit {
			continue
		}
		nodes := legacyScopeNodes[scopeKey]
		if len(nodes) == 0 {
			continue
		}
		trackedLegacyComputers = append(trackedLegacyComputers, legacyComputer{tenantID: tenantID, projectID: projectID, computerID: computerID})
		desiredComputerRows[scopeKey+"\x00"+computerID+"\x00"] = struct{}{}
		for nodeID := range nodes {
			desiredComputers[nodeID+"\x00"+scopeKey+"\x00"+computerID] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return errors.New("read PostgreSQL tracked legacy Computers")
	}
	rows.Close()
	for _, computer := range trackedLegacyComputers {
		scopeKey := computer.tenantID + "\x00" + computer.projectID
		for nodeID := range legacyScopeNodes[scopeKey] {
			if _, err := transaction.Exec(ctx, `INSERT INTO zapvm.computer_nodes (tenant_id,project_id,computer_id,node_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, computer.tenantID, computer.projectID, computer.computerID, nodeID); err != nil {
				return databaseFailure("reconcile PostgreSQL tracked legacy Computer placement", err)
			}
		}
	}
	var existingNodes []string
	rows, err = transaction.Query(ctx, `SELECT id FROM zapvm.nodes ORDER BY id`)
	if err != nil {
		return databaseFailure("list PostgreSQL provisioned Nodes", err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return errors.New("decode PostgreSQL provisioned Node")
		}
		existingNodes = append(existingNodes, id)
	}
	rows.Close()
	if len(existingNodes) != len(desiredNodes) {
		return errors.New("PostgreSQL Node provisions differ from configuration")
	}
	for _, id := range existingNodes {
		if _, exists := desiredNodes[id]; !exists {
			return errors.New("PostgreSQL Node provisions differ from configuration")
		}
	}
	if err := compareProvisionRows(ctx, transaction, `SELECT node_id,tenant_id,project_id FROM zapvm.node_scopes ORDER BY node_id,tenant_id,project_id`, desiredScopes, 3); err != nil {
		return err
	}
	if err := compareProvisionRows(ctx, transaction, `SELECT tenant_id,project_id,computer_id,agent FROM zapvm.computers WHERE provisioning_source='config' ORDER BY tenant_id,project_id,computer_id`, desiredComputerRows, 4); err != nil {
		return err
	}
	if err := compareProvisionRows(ctx, transaction, `SELECT cn.node_id,cn.tenant_id,cn.project_id,cn.computer_id FROM zapvm.computer_nodes cn JOIN zapvm.computers c USING (tenant_id,project_id,computer_id) WHERE c.provisioning_source='config' ORDER BY cn.node_id,cn.tenant_id,cn.project_id,cn.computer_id`, desiredComputers, 4); err != nil {
		return err
	}
	return transaction.Commit(ctx)
}

func compareProvisionRows(ctx context.Context, transaction pgx.Tx, query string, desired map[string]struct{}, columns int) error {
	rows, err := transaction.Query(ctx, query)
	if err != nil {
		return databaseFailure("list PostgreSQL provision authority", err)
	}
	defer rows.Close()
	found := make(map[string]struct{})
	for rows.Next() {
		values := make([]string, columns)
		targets := make([]any, columns)
		for index := range values {
			targets[index] = &values[index]
		}
		if err := rows.Scan(targets...); err != nil {
			return errors.New("decode PostgreSQL provision authority")
		}
		key := values[0]
		for _, value := range values[1:] {
			key += "\x00" + value
		}
		found[key] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return errors.New("read PostgreSQL provision authority")
	}
	if len(found) != len(desired) {
		return errors.New("PostgreSQL provision authority differs from configuration")
	}
	for key := range found {
		if _, exists := desired[key]; !exists {
			return errors.New("PostgreSQL provision authority differs from configuration")
		}
	}
	return nil
}

func (queue *Queue) ListAgentComputers(ctx context.Context, scope cloudplane.Scope) ([]cloudplane.AgentComputer, error) {
	if err := queue.validateCall(ctx); err != nil {
		return nil, err
	}
	if scope.Validate() != nil {
		return nil, cloudplane.ErrUnauthorized
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollbackBounded(transaction)
	now := queue.now().UTC()
	if err := queue.reconcileComputerRuntimes(ctx, transaction, now); err != nil {
		return nil, err
	}
	rows, err := transaction.Query(ctx, `
SELECT computer_id,
       CASE WHEN observed_state IN ('ready','busy') THEN 'online'
            WHEN observed_state='degraded' THEN 'draining'
            ELSE 'offline' END,
       desired_state,observed_state,COALESCE(assigned_node_id,''),placement_epoch,
       last_activity_at,COALESCE(failure_code,''),COALESCE(reachable.available,false)
FROM zapvm.computer_runtime AS runtime
LEFT JOIN LATERAL (
  SELECT true AS available
  FROM zapvm.nodes AS node
  JOIN zapvm.node_scopes AS node_scope
    ON node_scope.node_id=node.id
   AND node_scope.tenant_id=runtime.tenant_id
   AND node_scope.project_id=runtime.project_id
  WHERE $4 AND node.state='online' AND node.last_heartbeat>$3
    AND node.daemon_state IN ('unknown','healthy')
    AND (
      EXISTS (
        SELECT 1 FROM zapvm.computer_nodes AS allowed
        WHERE allowed.node_id=node.id
          AND allowed.tenant_id=runtime.tenant_id
          AND allowed.project_id=runtime.project_id
          AND allowed.computer_id=runtime.computer_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM zapvm.computer_nodes AS configured
        WHERE configured.tenant_id=runtime.tenant_id
          AND configured.project_id=runtime.project_id
      )
    )
  LIMIT 1
) AS reachable ON true
WHERE runtime.tenant_id=$1 AND runtime.project_id=$2
ORDER BY computer_id`, scope.TenantID, scope.ProjectID, now.Add(-queue.heartbeatTTL), queue.placementMode == cloudplane.PlacementModeDynamic)
	if err != nil {
		return nil, databaseFailure("list PostgreSQL Agent Computers", err)
	}
	defer rows.Close()
	computers := make([]cloudplane.AgentComputer, 0)
	for rows.Next() {
		var computer cloudplane.AgentComputer
		var lastActivity *time.Time
		var placementEpoch int64
		var nodeReachable bool
		if err := rows.Scan(&computer.ID, &computer.State, &computer.DesiredState, &computer.ObservedState,
			&computer.AssignedNodeID, &placementEpoch, &lastActivity, &computer.FailureCode, &nodeReachable); err != nil || placementEpoch < 0 {
			return nil, errors.New("decode PostgreSQL Agent Computer")
		}
		computer.PlacementEpoch = uint64(placementEpoch)
		if lastActivity != nil {
			computer.LastActivityAt = lastActivity.UTC().Format(time.RFC3339Nano)
		}
		applyAgentComputerAvailability(&computer, nodeReachable)
		computers = append(computers, computer)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("read PostgreSQL Agent Computers")
	}
	if err := transaction.Commit(ctx); err != nil {
		return nil, databaseFailure("commit PostgreSQL Agent Computer list", err)
	}
	return computers, nil
}

// applyAgentComputerAvailability separates logical availability from the
// lifecycle of an on-demand VM. Dynamic placement deliberately releases idle
// VMs, so an unavailable observed runtime is not an outage while a compatible
// healthy Node can start it again. Preserve real start/degraded failures.
func applyAgentComputerAvailability(computer *cloudplane.AgentComputer, nodeReachable bool) {
	// Older rows/tests predate desired_state and therefore decode it as an
	// empty string. Treat that legacy value as running; only an explicit stop
	// request makes the Computer unavailable by intent.
	if !nodeReachable || computer.DesiredState == cloudplane.ComputerDesiredStopped || computer.ObservedState != cloudplane.ComputerObservedUnavailable {
		return
	}
	switch computer.FailureCode {
	case "", cloudplane.QueueReasonNodeOffline, "computer_idle_stopped":
		computer.State = cloudplane.NodeOnline
		computer.FailureCode = ""
	}
}

func (queue *Queue) OperationalSnapshot(ctx context.Context) (cloudplane.OperationalSnapshot, error) {
	if err := queue.validateCall(ctx); err != nil {
		return cloudplane.OperationalSnapshot{}, err
	}
	now := queue.now().UTC()
	snapshot := cloudplane.OperationalSnapshot{
		SchemaVersion: 1, CollectedAt: now.Format(time.RFC3339Nano), Ready: true,
		NodesByState: map[string]uint64{}, NodesByDaemonState: map[string]uint64{}, TasksByState: map[string]uint64{},
		WorkspaceOperationsByState: map[string]uint64{}, GitOperationsByState: map[string]uint64{}, Alerts: []cloudplane.OperationalAlert{},
	}
	transaction, err := queue.begin(ctx)
	if err != nil {
		return cloudplane.OperationalSnapshot{}, err
	}
	defer rollbackBounded(transaction)
	if err := loadStateCounts(ctx, transaction, `SELECT state,count(*) FROM zapvm.nodes GROUP BY state`, snapshot.NodesByState); err != nil {
		return cloudplane.OperationalSnapshot{}, err
	}
	if err := loadStateCounts(ctx, transaction, `SELECT daemon_state,count(*) FROM zapvm.nodes GROUP BY daemon_state`, snapshot.NodesByDaemonState); err != nil {
		return cloudplane.OperationalSnapshot{}, err
	}
	if err := loadStateCounts(ctx, transaction, `SELECT state,count(*) FROM zapvm.tasks GROUP BY state`, snapshot.TasksByState); err != nil {
		return cloudplane.OperationalSnapshot{}, err
	}
	if err := loadStateCounts(ctx, transaction, `SELECT state,count(*) FROM zapvm.workspace_operations WHERE kind<>'git_push' GROUP BY state`, snapshot.WorkspaceOperationsByState); err != nil {
		return cloudplane.OperationalSnapshot{}, err
	}
	if err := loadStateCounts(ctx, transaction, `SELECT state,count(*) FROM zapvm.workspace_operations WHERE kind='git_push' GROUP BY state`, snapshot.GitOperationsByState); err != nil {
		return cloudplane.OperationalSnapshot{}, err
	}
	snapshot.StatePrimaryEnabled = true
	if err := transaction.Commit(ctx); err != nil {
		return cloudplane.OperationalSnapshot{}, databaseFailure("commit PostgreSQL operational snapshot", err)
	}
	return snapshot, nil
}

func loadStateCounts(ctx context.Context, transaction pgx.Tx, query string, target map[string]uint64) error {
	rows, err := transaction.Query(ctx, query)
	if err != nil {
		return databaseFailure("query PostgreSQL operational counts", err)
	}
	defer rows.Close()
	for rows.Next() {
		var state string
		var count int64
		if err := rows.Scan(&state, &count); err != nil || count < 0 {
			return errors.New("decode PostgreSQL operational count")
		}
		target[state] = uint64(count)
	}
	return rows.Err()
}
