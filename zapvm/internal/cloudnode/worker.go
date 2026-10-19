package cloudnode

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"zapvm/internal/cloudplane"
	"zapvm/internal/credential"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/localipc"
	"zapvm/internal/platform"
	"zapvm/internal/remoteauth"
	localtask "zapvm/internal/task"
)

type activeLease struct {
	lease      cloudplane.Lease
	cancelSent bool
}

type activeWorkspaceLease struct {
	lease cloudplane.WorkspaceOperationLease
}

type activeComputerOperationLease struct {
	lease cloudplane.ComputerOperationLease
}

const nodeHeartbeatInterval = 5 * time.Second

type Worker struct {
	config          Config
	identity        *managedIdentity
	clientMu        sync.RWMutex
	client          *http.Client
	uploadClient    *http.Client
	relayTLS        *tls.Config
	generation      string
	nodeVersion     string
	log             io.Writer
	mu              sync.Mutex
	active          map[string]activeLease
	activeWorkspace map[string]activeWorkspaceLease
	activeComputer  map[string]activeComputerOperationLease
	wait            sync.WaitGroup
	requestSequence atomic.Uint64
}

func New(config Config, log io.Writer) (*Worker, error) {
	return NewWithVersion(config, log, "")
}

func NewWithVersion(config Config, log io.Writer, nodeVersion string) (*Worker, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	var tlsConfig *tls.Config
	var identity *managedIdentity
	var err error
	if config.ManagedIdentity() {
		identity, err = newManagedIdentity(config)
	} else {
		tlsConfig, err = remoteauth.LoadMutualTLSClient(
			config.ServerCA, config.Certificate, config.PrivateKey, config.NodeURI(), config.ControlURI(),
		)
	}
	if err != nil {
		return nil, err
	}
	generationBytes := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, generationBytes); err != nil {
		return nil, err
	}
	if log == nil {
		log = io.Discard
	}
	worker := &Worker{
		config: config, identity: identity,
		generation: hex.EncodeToString(generationBytes), nodeVersion: nodeVersion,
		log: log, active: make(map[string]activeLease),
		activeWorkspace: make(map[string]activeWorkspaceLease),
		activeComputer:  make(map[string]activeComputerOperationLease),
	}
	if tlsConfig != nil {
		worker.installClients(tlsConfig)
	}
	return worker, nil
}

func (worker *Worker) Run(ctx context.Context) error {
	if worker.identity != nil {
		if _, err := worker.identity.ensure(ctx); err != nil {
			return err
		}
		tlsConfig, err := worker.identity.tlsConfig()
		if err != nil {
			return err
		}
		worker.installClients(tlsConfig)
	}
	node, err := worker.register(ctx)
	if err != nil {
		return err
	}
	claimTicker := time.NewTicker(time.Duration(worker.config.PollMillis) * time.Millisecond)
	heartbeatTicker := time.NewTicker(nodeHeartbeatInterval)
	defer claimTicker.Stop()
	defer heartbeatTicker.Stop()
	defer func() {
		worker.closeIdleConnections()
		worker.wait.Wait()
	}()
	worker.dispatch(ctx, node)
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-claimTicker.C:
			worker.dispatch(ctx, node)
		case <-heartbeatTicker.C:
			node = worker.refreshNode(ctx, node)
			worker.dispatch(ctx, node)
		}
	}
}

func (worker *Worker) refreshNode(ctx context.Context, current cloudplane.Node) cloudplane.Node {
	if worker.identity != nil {
		changed, renewErr := worker.identity.ensure(ctx)
		if renewErr != nil {
			code := "identity_renew_failed"
			if errors.Is(renewErr, ErrIdentityReenrollmentRequired) {
				code = "identity_reenrollment_required"
			}
			worker.logEvent("identity_renew", "", "", "failed", code)
		} else if changed {
			tlsConfig, loadErr := worker.identity.tlsConfig()
			if loadErr != nil {
				worker.logEvent("identity_reload", "", "", "failed", "identity_reload_failed")
				return current
			}
			worker.installClients(tlsConfig)
			worker.logEvent("identity_renew", "", "", "succeeded", "")
		}
	}
	node, err := worker.heartbeat(ctx)
	if err != nil {
		worker.logEvent("heartbeat", "", "", "failed", "control_request_failed")
		node, err = worker.register(ctx)
		if err != nil {
			worker.logEvent("register", "", "", "failed", "control_request_failed")
			return current
		}
	}
	return node
}

func (worker *Worker) dispatch(ctx context.Context, node cloudplane.Node) {
	if node.DaemonState == cloudplane.DaemonHealthy || node.DaemonState == cloudplane.DaemonUnknown {
		available := int(worker.config.MaxConcurrent) - worker.activeCount()
		if available > 0 {
			computerLeases, err := worker.claimComputerOperations(ctx, available)
			if err != nil {
				worker.logEvent("computer_claim", "", "", "failed", "control_request_failed")
			} else {
				for _, lease := range computerLeases {
					worker.startComputerOperation(ctx, lease)
				}
				available -= len(computerLeases)
			}
		}
		if available > 0 {
			leases, err := worker.claim(ctx, available)
			if err != nil {
				worker.logEvent("claim", "", "", "failed", "control_request_failed")
			} else {
				for _, lease := range leases {
					worker.startLease(ctx, lease)
				}
				available -= len(leases)
			}
		}
		if available > 0 {
			workspaceLeases, err := worker.claimWorkspace(ctx, available)
			if err != nil {
				worker.logEvent("workspace_claim", "", "", "failed", "control_request_failed")
			} else {
				for _, lease := range workspaceLeases {
					worker.startWorkspaceLease(ctx, lease)
				}
			}
		}
	}
	cancellations, err := worker.cancellations(ctx)
	if err != nil {
		worker.logEvent("cancellations", "", "", "failed", "control_request_failed")
	} else {
		for _, taskID := range cancellations {
			worker.startCancellation(ctx, taskID)
		}
	}
}

func (worker *Worker) startComputerOperation(ctx context.Context, lease cloudplane.ComputerOperationLease) {
	worker.mu.Lock()
	if _, exists := worker.activeComputer[lease.Operation.ID]; exists {
		worker.mu.Unlock()
		return
	}
	worker.activeComputer[lease.Operation.ID] = activeComputerOperationLease{lease: lease}
	worker.wait.Add(1)
	worker.mu.Unlock()
	go func() {
		defer worker.wait.Done()
		defer func() {
			worker.mu.Lock()
			delete(worker.activeComputer, lease.Operation.ID)
			worker.mu.Unlock()
		}()
		event := "computer_" + lease.Operation.Kind
		worker.logEvent(event, "operation_id", lease.Operation.ID, "started", "")
		if err := worker.executeComputerOperation(ctx, lease); err != nil {
			worker.logEvent(event, "operation_id", lease.Operation.ID, "failed", event+"_failed")
		} else {
			worker.logEvent(event, "operation_id", lease.Operation.ID, "succeeded", "")
		}
	}()
}

func (worker *Worker) executeComputerOperation(ctx context.Context, lease cloudplane.ComputerOperationLease) error {
	deadline, err := time.Parse(time.RFC3339Nano, lease.Operation.DeadlineAt)
	if err != nil {
		return worker.failComputerOperation(ctx, lease, "invalid_operation", err)
	}
	operationKind := lease.Operation.Kind
	// Control versions before lifecycle management omitted kind because start
	// was the only possible operation. Keep rolling upgrades compatible.
	if operationKind == "" {
		operationKind = cloudplane.ComputerOperationStart
	}
	requestType, responseType, expectedState, failureCode := daemonrpc.TypeComputerStart, daemonrpc.TypeComputer, "running", "daemon_start_failed"
	if operationKind == cloudplane.ComputerOperationStop {
		requestType, responseType, expectedState, failureCode = daemonrpc.TypeComputerStop, daemonrpc.TypeComputerStopped, "stopped", "daemon_stop_failed"
	} else if operationKind != cloudplane.ComputerOperationStart {
		return worker.failComputerOperation(ctx, lease, "invalid_operation", errors.New("unsupported Computer lifecycle operation"))
	}
	operationContext, cancel := context.WithDeadline(ctx, deadline)
	if operationKind == cloudplane.ComputerOperationStart && lease.Provision != nil {
		if err := worker.provisionComputer(operationContext, lease); err != nil {
			cancel()
			return worker.failComputerOperation(ctx, lease, "daemon_provision_failed", err)
		}
	}
	response, requestErr := worker.daemonRequest(operationContext, requestType, daemonrpc.ComputerReference{ID: lease.Operation.ComputerID})
	cancel()
	if requestErr != nil {
		return worker.failComputerOperation(ctx, lease, failureCode, requestErr)
	}
	if response.Type != responseType {
		return worker.failComputerOperation(ctx, lease, "daemon_protocol_error", errors.New("unexpected Computer lifecycle response"))
	}
	current, err := daemonrpc.DecodePayload[daemonrpc.ComputerSpec](response.Payload)
	if err != nil || current.ID != lease.Operation.ComputerID || current.RuntimeState != expectedState {
		if err == nil {
			err = errors.New("daemon returned an unexpected Computer runtime state")
		}
		return worker.failComputerOperation(ctx, lease, "daemon_protocol_error", err)
	}
	body := map[string]any{
		"generation": worker.generation, "lease_token": lease.LeaseToken, "succeeded": true,
	}
	return worker.postRetry(ctx, "/v1/node/computers/operations/"+lease.Operation.ID+"/complete", body, nil)
}

func (worker *Worker) provisionComputer(ctx context.Context, lease cloudplane.ComputerOperationLease) error {
	if lease.Provision == nil {
		return nil
	}
	if worker.config.WorkspaceRoot == "" {
		return errors.New("cloud node workspace_root is not configured")
	}
	workspace := filepath.Join(worker.config.WorkspaceRoot, lease.Operation.TenantID, lease.Operation.ProjectID, lease.Operation.ComputerID)
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		return fmt.Errorf("create Computer workspace: %w", err)
	}
	response, err := worker.daemonRequest(ctx, daemonrpc.TypeComputerInspect, daemonrpc.ComputerReference{ID: lease.Operation.ComputerID})
	if err == nil {
		current, decodeErr := daemonrpc.DecodePayload[daemonrpc.ComputerSpec](response.Payload)
		if decodeErr != nil || current.ID != lease.Operation.ComputerID {
			return errors.New("daemon returned an invalid existing Computer")
		}
		return nil
	}
	request := daemonrpc.ComputerCreateRequest{Computer: daemonrpc.ComputerSpec{
		ID: lease.Operation.ComputerID, Agent: lease.Provision.Agent, Workspace: workspace,
		Network: platform.NetworkUnrestricted, CPUCount: lease.Provision.CPUCount, MemoryMiB: lease.Provision.MemoryMiB,
	}}
	created, err := worker.daemonRequest(ctx, daemonrpc.TypeComputerCreate, request)
	if err != nil {
		return err
	}
	current, err := daemonrpc.DecodePayload[daemonrpc.ComputerSpec](created.Payload)
	if err != nil || current.ID != lease.Operation.ComputerID {
		return errors.New("daemon returned an invalid provisioned Computer")
	}
	return nil
}

func (worker *Worker) failComputerOperation(ctx context.Context, lease cloudplane.ComputerOperationLease, code string, cause error) error {
	body := map[string]any{
		"generation": worker.generation, "lease_token": lease.LeaseToken,
		"succeeded": false, "failure_code": code,
	}
	completeErr := worker.postRetry(ctx, "/v1/node/computers/operations/"+lease.Operation.ID+"/complete", body, nil)
	return errors.Join(cause, completeErr)
}

func (worker *Worker) installClients(tlsConfig *tls.Config) {
	transport := &http.Transport{
		Proxy: nil, TLSClientConfig: tlsConfig, ForceAttemptHTTP2: true,
		DisableCompression: true, MaxIdleConns: 16, IdleConnTimeout: 90 * time.Second,
	}
	worker.clientMu.Lock()
	oldClient := worker.client
	worker.client = &http.Client{Transport: transport, Timeout: 30 * time.Second}
	worker.uploadClient = &http.Client{Transport: transport}
	worker.relayTLS = tlsConfig.Clone()
	worker.clientMu.Unlock()
	if oldClient != nil {
		oldClient.CloseIdleConnections()
	}
}

func (worker *Worker) closeIdleConnections() {
	worker.clientMu.RLock()
	client := worker.client
	uploadClient := worker.uploadClient
	worker.clientMu.RUnlock()
	if client != nil {
		client.CloseIdleConnections()
	}
	if uploadClient != nil && uploadClient != client {
		uploadClient.CloseIdleConnections()
	}
}

func (worker *Worker) startWorkspaceLease(ctx context.Context, lease cloudplane.WorkspaceOperationLease) {
	worker.mu.Lock()
	if _, exists := worker.activeWorkspace[lease.Operation.ID]; exists {
		worker.mu.Unlock()
		return
	}
	worker.activeWorkspace[lease.Operation.ID] = activeWorkspaceLease{lease: lease}
	worker.wait.Add(1)
	worker.mu.Unlock()
	go func() {
		defer worker.wait.Done()
		defer func() {
			worker.mu.Lock()
			delete(worker.activeWorkspace, lease.Operation.ID)
			worker.mu.Unlock()
		}()
		worker.logEvent("workspace_execute", "operation_id", lease.Operation.ID, "started", "")
		if err := worker.executeWorkspaceLease(ctx, lease); err != nil {
			worker.logEvent("workspace_execute", "operation_id", lease.Operation.ID, "failed", "workspace_execution_failed")
		} else {
			worker.logEvent("workspace_execute", "operation_id", lease.Operation.ID, "succeeded", "")
		}
	}()
}

func (worker *Worker) executeWorkspaceLease(ctx context.Context, lease cloudplane.WorkspaceOperationLease) error {
	if lease.Operation.Kind == cloudplane.WorkspaceOperationGitPush {
		if lease.Git == nil {
			return worker.failWorkspaceLease(ctx, lease, "invalid_git_capability", errors.New("missing Git capability"))
		}
		defer lease.Git.Destroy()
		request := daemonrpc.ComputerGitPushRequest{
			OperationID: lease.Operation.ID, ComputerID: lease.Operation.ComputerID,
			Owner: lease.Git.Owner, Repository: lease.Git.Repository, BaseBranch: lease.Git.BaseBranch,
			Branch: lease.Operation.Branch, HTTPSCloneURL: lease.Git.HTTPSCloneURL, Token: append([]byte(nil), lease.Git.Token...),
		}
		defer func() {
			for index := range request.Token {
				request.Token[index] = 0
			}
		}()
		operationContext, cancel := context.WithTimeout(ctx, 5*time.Minute)
		response, err := worker.daemonRequest(operationContext, daemonrpc.TypeComputerGitPush, request)
		cancel()
		if err != nil {
			return worker.failWorkspaceLease(ctx, lease, daemonGitFailureCode(err), err)
		}
		if response.Type != daemonrpc.TypeGitPushResult {
			return worker.failWorkspaceLease(ctx, lease, "daemon_protocol_error", errors.New("unexpected Git response"))
		}
		body := map[string]any{
			"generation": worker.generation, "lease_token": lease.LeaseToken,
			"succeeded": true, "result": json.RawMessage(response.Payload),
		}
		return worker.postRetry(ctx, "/v1/node/workspace/operations/"+lease.Operation.ID+"/complete", body, nil)
	}
	request := daemonrpc.ComputerWorkspaceRequest{ComputerID: lease.Operation.ComputerID, Path: lease.Operation.Path}
	messageType := ""
	expectedType := ""
	switch lease.Operation.Kind {
	case cloudplane.WorkspaceOperationList:
		messageType, expectedType = daemonrpc.TypeComputerWorkspaceList, daemonrpc.TypeWorkspaceListing
	case cloudplane.WorkspaceOperationRead:
		messageType, expectedType = daemonrpc.TypeComputerWorkspaceRead, daemonrpc.TypeWorkspaceFile
	case cloudplane.WorkspaceOperationDiff:
		messageType, expectedType = daemonrpc.TypeComputerWorkspaceDiff, daemonrpc.TypeWorkspaceDiff
	default:
		return worker.failWorkspaceLease(ctx, lease, "invalid_operation", errors.New("unknown workspace operation"))
	}
	response, err := worker.daemonRequest(ctx, messageType, request)
	if err != nil {
		return worker.failWorkspaceLease(ctx, lease, "daemon_request_failed", err)
	}
	if response.Type != expectedType {
		return worker.failWorkspaceLease(ctx, lease, "daemon_protocol_error", errors.New("unexpected workspace response"))
	}
	body := map[string]any{
		"generation": worker.generation, "lease_token": lease.LeaseToken,
		"succeeded": true, "result": json.RawMessage(response.Payload),
	}
	return worker.postRetry(ctx, "/v1/node/workspace/operations/"+lease.Operation.ID+"/complete", body, nil)
}

func daemonGitFailureCode(err error) string {
	if err == nil {
		return "git_operation_failed"
	}
	switch err.Error() {
	case "git_unavailable", "invalid_worktree", "git_output_exceeded", "unsafe_git_config", "git_branch_conflict",
		"dirty_git_index", "git_remote_unavailable", "git_remote_invalid", "git_base_mismatch", "git_stage_failed",
		"protected_path_staged", "unsafe_git_metadata", "git_no_changes", "git_commit_failed", "git_operation_failed", "git_remote_branch_conflict", "git_push_failed":
		return err.Error()
	default:
		return "daemon_request_failed"
	}
}

func (worker *Worker) failWorkspaceLease(ctx context.Context, lease cloudplane.WorkspaceOperationLease, code string, cause error) error {
	body := map[string]any{
		"generation": worker.generation, "lease_token": lease.LeaseToken,
		"succeeded": false, "failure_code": code,
	}
	completeErr := worker.postRetry(ctx, "/v1/node/workspace/operations/"+lease.Operation.ID+"/complete", body, nil)
	return errors.Join(cause, completeErr)
}

func (worker *Worker) startLease(ctx context.Context, lease cloudplane.Lease) {
	worker.mu.Lock()
	if _, exists := worker.active[lease.Task.ID]; exists {
		worker.mu.Unlock()
		return
	}
	worker.active[lease.Task.ID] = activeLease{lease: lease}
	worker.wait.Add(1)
	worker.mu.Unlock()
	go func() {
		defer worker.wait.Done()
		defer func() {
			worker.mu.Lock()
			delete(worker.active, lease.Task.ID)
			worker.mu.Unlock()
		}()
		worker.logEvent("task_execute", "task_id", lease.Task.ID, "started", "")
		if err := worker.executeLease(ctx, lease); err != nil {
			worker.logEvent("task_execute", "task_id", lease.Task.ID, "failed", "task_execution_failed")
		} else {
			worker.logEvent("task_execute", "task_id", lease.Task.ID, "completed", "")
		}
	}()
}

func (worker *Worker) executeLease(ctx context.Context, lease cloudplane.Lease) error {
	if lease.CredentialCapability != nil {
		defer lease.CredentialCapability.Destroy()
	}
	ack := map[string]any{"generation": worker.generation, "lease_token": lease.LeaseToken}
	var acknowledged cloudplane.Task
	if err := worker.post(ctx, "/v1/node/tasks/"+lease.Task.ID+"/ack", ack, &acknowledged); err != nil {
		return err
	}
	if acknowledged.ID != lease.Task.ID {
		return errors.New("cloud control-plane acknowledged a different Task")
	}
	if acknowledged.State == cloudplane.TaskCanceling {
		return worker.confirmCanceled(ctx, lease)
	}
	if acknowledged.State != cloudplane.TaskRunning {
		return fmt.Errorf("cloud control-plane acknowledged Task in state %q", acknowledged.State)
	}
	request, err := daemonrpc.DecodeComputerTaskSubmit(lease.Task.Payload)
	if err != nil {
		return worker.failLease(ctx, lease, "invalid_payload", err)
	}
	request.ID = lease.Task.ID
	if lease.Agent != "" {
		if err := worker.ensureComputerAgent(ctx, request.ComputerID, lease.Agent); err != nil {
			return worker.failLease(ctx, lease, "computer_agent_mismatch", err)
		}
	}
	messageType := daemonrpc.TypeComputerTaskSubmit
	payload := any(request)
	var bundle cloudplane.CredentialBundle
	if lease.CredentialCapability != nil {
		bundle, err = worker.redeemCredentials(ctx, lease)
		if err != nil {
			return worker.failLease(ctx, lease, "credential_unavailable", err)
		}
		defer bundle.Destroy()
		if err := daemonrpc.ValidateCredentialValues(request.Command.CredentialIDs, bundle.Values); err != nil {
			return worker.failLease(ctx, lease, "credential_invalid", err)
		}
		messageType = daemonrpc.TypeComputerTaskSubmitCredentialed
		payload = daemonrpc.ComputerTaskCredentialSubmitRequest{Task: request, Values: bundle.Values}
	}
	response, err := worker.daemonRequest(ctx, messageType, payload)
	if err != nil {
		return worker.failLease(ctx, lease, "daemon_submit_failed", err)
	}
	if response.Type != daemonrpc.TypeComputerTask {
		return worker.failLease(ctx, lease, "daemon_protocol_error", errors.New("unexpected Task submit response"))
	}
	if _, err := daemonrpc.DecodePayload[daemonrpc.ComputerTask](response.Payload); err != nil {
		return worker.failLease(ctx, lease, "daemon_protocol_error", err)
	}
	final, err := worker.attach(ctx, lease)
	if err != nil {
		return worker.failLease(ctx, lease, "daemon_attach_failed", err)
	}
	encoded, err := json.Marshal(final)
	if err != nil {
		return worker.failLease(ctx, lease, "result_encode_failed", err)
	}
	digest := sha256.Sum256(encoded)
	if final.State == localtask.StateCanceled {
		return worker.confirmCanceled(ctx, lease)
	}
	succeeded := final.State == localtask.StateSucceeded
	failureCode := ""
	if !succeeded {
		failureCode = "execution_failed"
	}
	if succeeded {
		artifactCount, collectErr := worker.collectArtifacts(ctx, lease)
		if collectErr != nil {
			worker.logArtifactCollection(lease.Task.ID, "failed", "artifact_collection_failed", artifactCount)
			worker.reportArtifactCollectionFailure(ctx, lease, final.LastCursor+1)
		} else {
			worker.logArtifactCollection(lease.Task.ID, "succeeded", "", artifactCount)
			worker.reportArtifactCollectionSuccess(ctx, lease, final.LastCursor+1, artifactCount)
		}
	}
	completion := map[string]any{
		"generation": worker.generation, "lease_token": lease.LeaseToken, "succeeded": succeeded,
		"result_sha256": hex.EncodeToString(digest[:]), "failure_code": failureCode,
	}
	return worker.postRetry(ctx, "/v1/node/tasks/"+lease.Task.ID+"/complete", completion, nil)
}

func (worker *Worker) ensureComputerAgent(ctx context.Context, computerID, expectedAgent string) error {
	response, err := worker.daemonRequest(ctx, daemonrpc.TypeComputerInspect, daemonrpc.ComputerReference{ID: computerID})
	if err != nil {
		return err
	}
	if response.Type != daemonrpc.TypeComputer {
		return errors.New("unexpected Computer inspect response")
	}
	current, err := daemonrpc.DecodePayload[daemonrpc.ComputerSpec](response.Payload)
	if err != nil {
		return err
	}
	if current.Agent != expectedAgent {
		return fmt.Errorf("Computer %s Agent %q differs from provisioned Agent %q", computerID, current.Agent, expectedAgent)
	}
	return nil
}

func (worker *Worker) redeemCredentials(ctx context.Context, lease cloudplane.Lease) (cloudplane.CredentialBundle, error) {
	if lease.CredentialCapability == nil || len(lease.CredentialCapability.Secret) == 0 {
		return cloudplane.CredentialBundle{}, errors.New("missing Credential capability")
	}
	body := map[string]any{
		"generation": worker.generation, "lease_token": lease.LeaseToken,
		"capability": lease.CredentialCapability,
	}
	var bundle cloudplane.CredentialBundle
	if err := worker.post(ctx, "/v1/node/tasks/"+lease.Task.ID+"/credentials", body, &bundle); err != nil {
		return cloudplane.CredentialBundle{}, err
	}
	if err := daemonrpc.ValidateCredentialValues(lease.Task.CredentialIDs, bundle.Values); err != nil {
		bundle.Destroy()
		return cloudplane.CredentialBundle{}, errors.New("Control returned an invalid Credential bundle")
	}
	return bundle, nil
}

func (worker *Worker) collectArtifacts(ctx context.Context, lease cloudplane.Lease) (int, error) {
	request, err := daemonrpc.DecodeComputerTaskSubmit(lease.Task.Payload)
	if err != nil {
		return 0, err
	}
	response, err := worker.daemonRequest(ctx, daemonrpc.TypeComputerArtifactCollect, daemonrpc.ComputerArtifactCollectRequest{
		TaskID: lease.Task.ID, ComputerID: request.ComputerID,
	})
	if err != nil {
		return 0, err
	}
	if response.Type != daemonrpc.TypeArtifactCollection {
		return 0, errors.New("unexpected Artifact collection response")
	}
	collection, err := daemonrpc.DecodeArtifactCollection(response.Payload)
	if err != nil {
		return 0, err
	}
	for index, artifact := range collection.Artifacts {
		body := map[string]any{
			"generation": worker.generation, "lease_token": lease.LeaseToken,
			"artifact": map[string]any{
				"id": artifact.ID, "path": artifact.Path, "content_type": artifact.ContentType,
				"size": artifact.Size, "sha256": artifact.SHA256,
			},
		}
		if err := worker.postRetry(ctx, "/v1/node/tasks/"+lease.Task.ID+"/artifacts", body, nil); err != nil {
			return index, err
		}
		if err := worker.uploadArtifact(ctx, lease, collection.Capability, artifact); err != nil {
			return index, err
		}
	}
	return len(collection.Artifacts), nil
}

func (worker *Worker) reportArtifactCollectionFailure(ctx context.Context, lease cloudplane.Lease, cursor uint64) {
	event := daemonrpc.ComputerTaskEvent{
		Cursor: cursor, Timestamp: time.Now().UTC().Format(time.RFC3339Nano), TaskID: lease.Task.ID,
		Type: "artifact.collect_failed", Error: "artifact_collection_failed",
	}
	body := map[string]any{"generation": worker.generation, "lease_token": lease.LeaseToken, "event": event}
	_ = worker.postRetry(ctx, "/v1/node/tasks/"+lease.Task.ID+"/events", body, nil)
}

func (worker *Worker) reportArtifactCollectionSuccess(ctx context.Context, lease cloudplane.Lease, cursor uint64, count int) {
	data, err := json.Marshal(map[string]int{"count": count})
	if err != nil {
		return
	}
	event := daemonrpc.ComputerTaskEvent{
		Cursor: cursor, Timestamp: time.Now().UTC().Format(time.RFC3339Nano), TaskID: lease.Task.ID,
		Type: "artifact.collect_completed", Data: data,
	}
	body := map[string]any{"generation": worker.generation, "lease_token": lease.LeaseToken, "event": event}
	_ = worker.postRetry(ctx, "/v1/node/tasks/"+lease.Task.ID+"/events", body, nil)
}

func (worker *Worker) confirmCanceled(ctx context.Context, lease cloudplane.Lease) error {
	body := map[string]any{"generation": worker.generation, "lease_token": lease.LeaseToken}
	return worker.postRetry(ctx, "/v1/node/tasks/"+lease.Task.ID+"/canceled", body, nil)
}

func (worker *Worker) failLease(ctx context.Context, lease cloudplane.Lease, code string, cause error) error {
	completion := map[string]any{
		"generation": worker.generation, "lease_token": lease.LeaseToken,
		"succeeded": false, "failure_code": code,
	}
	completeErr := worker.postRetry(ctx, "/v1/node/tasks/"+lease.Task.ID+"/complete", completion, nil)
	return errors.Join(cause, completeErr)
}

func (worker *Worker) attach(ctx context.Context, lease cloudplane.Lease) (daemonrpc.ComputerTask, error) {
	connection, err := worker.dialDaemon(ctx)
	if err != nil {
		return daemonrpc.ComputerTask{}, err
	}
	defer connection.Close()
	closed := make(chan struct{})
	defer close(closed)
	go func() {
		select {
		case <-ctx.Done():
			_ = connection.Close()
		case <-closed:
		}
	}()
	codec := daemonrpc.NewCodec(connection, connection)
	requestID := rpcID("attach", lease.Task.ID)
	envelope, err := daemonrpc.NewEnvelope(requestID, daemonrpc.TypeComputerTaskAttach, daemonrpc.ComputerTaskAttachRequest{ID: lease.Task.ID, Follow: true})
	if err != nil {
		return daemonrpc.ComputerTask{}, err
	}
	if err := codec.Write(envelope); err != nil {
		return daemonrpc.ComputerTask{}, err
	}
	type attachRead struct {
		response daemonrpc.Envelope
		err      error
	}
	reads := make(chan attachRead, 256)
	go func() {
		for {
			response, readErr := codec.Read()
			select {
			case reads <- attachRead{response: response, err: readErr}:
			case <-closed:
				return
			}
			if readErr != nil {
				return
			}
		}
	}()
	uploader := newTaskEventUploader(worker, lease)
	defer uploader.Close()
	batch := make([]daemonrpc.ComputerTaskEvent, 0, taskRelayBatchEvents)
	batchBytes := 0
	var flushTimer *time.Timer
	var flushTimerChannel <-chan time.Time
	stopFlushTimer := func() {
		if flushTimer != nil && !flushTimer.Stop() {
			select {
			case <-flushTimer.C:
			default:
			}
		}
		flushTimer = nil
		flushTimerChannel = nil
	}
	flush := func() error {
		stopFlushTimer()
		if len(batch) == 0 {
			return nil
		}
		if err := uploader.Upload(ctx, batch); err != nil {
			return err
		}
		batch = batch[:0]
		batchBytes = 0
		return nil
	}
	defer stopFlushTimer()
	for {
		var response daemonrpc.Envelope
		select {
		case <-ctx.Done():
			return daemonrpc.ComputerTask{}, ctx.Err()
		case <-flushTimerChannel:
			if err := flush(); err != nil {
				return daemonrpc.ComputerTask{}, err
			}
			continue
		case read := <-reads:
			if read.err != nil {
				return daemonrpc.ComputerTask{}, read.err
			}
			response = read.response
		}
		if response.ID != requestID {
			return daemonrpc.ComputerTask{}, errors.New("daemon response request ID mismatch")
		}
		switch response.Type {
		case daemonrpc.TypeAccepted:
			if err := daemonrpc.DecodeEmpty(response.Payload); err != nil {
				return daemonrpc.ComputerTask{}, err
			}
		case daemonrpc.TypeComputerTaskEvent:
			event, err := daemonrpc.DecodePayload[daemonrpc.ComputerTaskEvent](response.Payload)
			if err != nil {
				return daemonrpc.ComputerTask{}, err
			}
			batch = append(batch, event)
			batchBytes += len(event.Data) + len(event.Error) + len(event.Type) + len(event.CommandID) + len(event.Stream) + 256
			if flushTimer == nil {
				flushTimer = time.NewTimer(taskRelayBatchDelay)
				flushTimerChannel = flushTimer.C
			}
			if len(batch) >= taskRelayBatchEvents || batchBytes >= taskRelayBatchSize {
				if err := flush(); err != nil {
					return daemonrpc.ComputerTask{}, err
				}
			}
		case daemonrpc.TypeComputerTaskEnd:
			if err := flush(); err != nil {
				return daemonrpc.ComputerTask{}, err
			}
			return daemonrpc.DecodePayload[daemonrpc.ComputerTask](response.Payload)
		case daemonrpc.TypeError:
			if err := flush(); err != nil {
				return daemonrpc.ComputerTask{}, err
			}
			message, decodeErr := daemonrpc.DecodePayload[daemonrpc.Error](response.Payload)
			if decodeErr != nil {
				return daemonrpc.ComputerTask{}, decodeErr
			}
			return daemonrpc.ComputerTask{}, errors.New(message.Message)
		default:
			return daemonrpc.ComputerTask{}, fmt.Errorf("unexpected daemon attach response %q", response.Type)
		}
	}
}

func (worker *Worker) daemonRequest(ctx context.Context, messageType string, payload any) (daemonrpc.Envelope, error) {
	connection, err := worker.dialDaemon(ctx)
	if err != nil {
		return daemonrpc.Envelope{}, err
	}
	defer connection.Close()
	if deadline, ok := ctx.Deadline(); ok {
		if err := connection.SetDeadline(deadline); err != nil {
			return daemonrpc.Envelope{}, err
		}
	}
	codec := daemonrpc.NewCodec(connection, connection)
	payloadData, err := json.Marshal(payload)
	if err != nil {
		return daemonrpc.Envelope{}, err
	}
	payloadDigest := sha256.Sum256(payloadData)
	credential.ZeroBytes(payloadData)
	requestID := rpcID(messageType, hex.EncodeToString(payloadDigest[:]))
	envelope, err := daemonrpc.NewEnvelope(requestID, messageType, payload)
	if err != nil {
		return daemonrpc.Envelope{}, err
	}
	defer credential.ZeroBytes(envelope.Payload)
	if err := codec.Write(envelope); err != nil {
		return daemonrpc.Envelope{}, err
	}
	response, err := codec.Read()
	if err != nil {
		return daemonrpc.Envelope{}, err
	}
	if response.ID != requestID {
		return daemonrpc.Envelope{}, errors.New("daemon response request ID mismatch")
	}
	if response.Type == daemonrpc.TypeError {
		message, decodeErr := daemonrpc.DecodePayload[daemonrpc.Error](response.Payload)
		if decodeErr != nil {
			return daemonrpc.Envelope{}, decodeErr
		}
		return daemonrpc.Envelope{}, errors.New(message.Message)
	}
	return response, nil
}

func (worker *Worker) dialDaemon(ctx context.Context) (net.Conn, error) {
	endpoint := worker.config.DaemonEndpoint
	if endpoint == "" {
		var err error
		endpoint, err = localipc.DefaultEndpoint()
		if err != nil {
			return nil, err
		}
	}
	dialContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return localipc.Dial(dialContext, endpoint)
}

func (worker *Worker) register(ctx context.Context) (cloudplane.Node, error) {
	body := worker.operationalBody(ctx)
	body["generation"] = worker.generation
	var node cloudplane.Node
	err := worker.postRetry(ctx, "/v1/node/register", body, &node)
	return node, err
}

func (worker *Worker) heartbeat(ctx context.Context) (cloudplane.Node, error) {
	proofs := worker.leaseProofs()
	body := worker.operationalBody(ctx)
	body["generation"] = worker.generation
	body["leases"] = proofs
	var node cloudplane.Node
	err := worker.post(ctx, "/v1/node/heartbeat", body, &node)
	return node, err
}

func (worker *Worker) operationalBody(ctx context.Context) map[string]any {
	body := map[string]any{"daemon_state": cloudplane.DaemonUnreachable, "failure_code": "daemon_unreachable"}
	if worker.nodeVersion != "" {
		body["node_version"] = worker.nodeVersion
	}
	probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	response, err := worker.daemonRequest(probeCtx, daemonrpc.TypeStatus, daemonrpc.Empty{})
	if err != nil {
		return body
	}
	if response.Type != daemonrpc.TypeStatus {
		body["daemon_state"] = cloudplane.DaemonDegraded
		body["failure_code"] = "daemon_protocol_error"
		return body
	}
	status, err := daemonrpc.DecodePayload[daemonrpc.Status](response.Payload)
	if err != nil {
		body["daemon_state"] = cloudplane.DaemonDegraded
		body["failure_code"] = "daemon_protocol_error"
		return body
	}
	delete(body, "failure_code")
	if status.Version != "" {
		body["daemon_version"] = status.Version
	}
	if status.ImageDigest != "" {
		body["image_digest"] = status.ImageDigest
	}
	body["start_attempts"] = status.StartAttempts
	body["start_failures"] = status.StartFailures
	body["start_duration_ms_total"] = status.StartDurationMillisTotal
	body["start_duration_ms_max"] = status.StartDurationMillisMax
	if len(status.ComputerRuntimes) != 0 {
		body["computer_runtimes"] = status.ComputerRuntimes
	}
	switch {
	case status.Degraded:
		body["daemon_state"] = cloudplane.DaemonDegraded
		body["failure_code"] = "daemon_degraded"
	case status.Paused:
		body["daemon_state"] = cloudplane.DaemonPaused
	default:
		body["daemon_state"] = cloudplane.DaemonHealthy
	}
	return body
}

func (worker *Worker) cancellations(ctx context.Context) ([]string, error) {
	body := map[string]any{"generation": worker.generation, "leases": worker.leaseProofs()}
	var response struct {
		TaskIDs []string `json:"task_ids"`
	}
	if err := worker.post(ctx, "/v1/node/cancellations", body, &response); err != nil {
		return nil, err
	}
	return response.TaskIDs, nil
}

func (worker *Worker) leaseProofs() []cloudplane.LeaseProof {
	worker.mu.Lock()
	defer worker.mu.Unlock()
	proofs := make([]cloudplane.LeaseProof, 0, len(worker.active))
	for _, active := range worker.active {
		proofs = append(proofs, cloudplane.LeaseProof{TaskID: active.lease.Task.ID, LeaseToken: active.lease.LeaseToken})
	}
	return proofs
}

func (worker *Worker) startCancellation(ctx context.Context, taskID string) {
	worker.mu.Lock()
	active, exists := worker.active[taskID]
	if !exists || active.cancelSent {
		worker.mu.Unlock()
		return
	}
	active.cancelSent = true
	worker.active[taskID] = active
	worker.wait.Add(1)
	worker.mu.Unlock()
	go func(lease cloudplane.Lease) {
		defer worker.wait.Done()
		if err := worker.cancelLease(ctx, lease); err != nil {
			worker.logEvent("task_cancel", "task_id", lease.Task.ID, "failed", "task_cancel_failed")
			worker.mu.Lock()
			if current, ok := worker.active[lease.Task.ID]; ok && current.lease.LeaseToken == lease.LeaseToken {
				current.cancelSent = false
				worker.active[lease.Task.ID] = current
			}
			worker.mu.Unlock()
		} else {
			worker.logEvent("task_cancel", "task_id", lease.Task.ID, "succeeded", "")
		}
	}(active.lease)
}

func (worker *Worker) cancelLease(ctx context.Context, lease cloudplane.Lease) error {
	response, err := worker.daemonRequest(ctx, daemonrpc.TypeComputerTaskCancel, daemonrpc.ComputerTaskReference{ID: lease.Task.ID})
	if err != nil {
		return err
	}
	if response.Type != daemonrpc.TypeComputerTask {
		return errors.New("unexpected Task cancel response")
	}
	current, err := daemonrpc.DecodePayload[daemonrpc.ComputerTask](response.Payload)
	if err != nil {
		return err
	}
	if current.ID != lease.Task.ID {
		return errors.New("daemon canceled a different Task")
	}
	return nil
}

func (worker *Worker) claim(ctx context.Context, maximum int) ([]cloudplane.Lease, error) {
	body := map[string]any{"generation": worker.generation, "maximum": maximum}
	var response struct {
		Leases []cloudplane.Lease `json:"leases"`
	}
	if err := worker.post(ctx, "/v1/node/claim", body, &response); err != nil {
		return nil, err
	}
	return response.Leases, nil
}

func (worker *Worker) claimComputerOperations(ctx context.Context, maximum int) ([]cloudplane.ComputerOperationLease, error) {
	if maximum > 16 {
		maximum = 16
	}
	body := map[string]any{"generation": worker.generation, "maximum": maximum}
	var response struct {
		Leases []cloudplane.ComputerOperationLease `json:"leases"`
	}
	if err := worker.post(ctx, "/v1/node/computers/claim", body, &response); err != nil {
		return nil, err
	}
	return response.Leases, nil
}

func (worker *Worker) claimWorkspace(ctx context.Context, maximum int) ([]cloudplane.WorkspaceOperationLease, error) {
	if maximum > 8 {
		maximum = 8
	}
	body := map[string]any{"generation": worker.generation, "maximum": maximum}
	var response struct {
		Leases []cloudplane.WorkspaceOperationLease `json:"leases"`
	}
	if err := worker.post(ctx, "/v1/node/workspace/claim", body, &response); err != nil {
		return nil, err
	}
	return response.Leases, nil
}

func (worker *Worker) postRetry(ctx context.Context, path string, body, response any) error {
	requestID := worker.nextRequestID(path)
	var last error
	for attempt := 0; attempt < 5; attempt++ {
		if err := worker.postWithRequestID(ctx, path, body, response, requestID); err == nil {
			return nil
		} else {
			last = err
		}
		select {
		case <-ctx.Done():
			return errors.Join(ctx.Err(), last)
		case <-time.After(time.Duration(attempt+1) * 250 * time.Millisecond):
		}
	}
	return last
}

func (worker *Worker) post(ctx context.Context, path string, body, response any) error {
	return worker.postWithRequestID(ctx, path, body, response, worker.nextRequestID(path))
}

func (worker *Worker) postWithRequestID(ctx context.Context, path string, body, response any, requestID string) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	defer credential.ZeroBytes(data)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, worker.config.ControlURL+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(cloudplane.RequestIDHeader, requestID)
	worker.clientMu.RLock()
	client := worker.client
	worker.clientMu.RUnlock()
	if client == nil {
		return errors.New("cloud Node identity is not initialized")
	}
	httpResponse, err := client.Do(request)
	if err != nil {
		return err
	}
	defer httpResponse.Body.Close()
	limited := io.LimitReader(httpResponse.Body, cloudplane.MaxPayloadSize+1)
	responseData, err := io.ReadAll(limited)
	if err != nil {
		return err
	}
	defer credential.ZeroBytes(responseData)
	if len(responseData) > cloudplane.MaxPayloadSize {
		return errors.New("cloud control-plane response is oversized")
	}
	if httpResponse.StatusCode < 200 || httpResponse.StatusCode >= 300 {
		return fmt.Errorf("cloud control-plane returned HTTP %d", httpResponse.StatusCode)
	}
	if response != nil {
		decoder := json.NewDecoder(bytes.NewReader(responseData))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(response); err != nil {
			return err
		}
	}
	return nil
}

func (worker *Worker) nextRequestID(path string) string {
	sequence := worker.requestSequence.Add(1)
	digest := sha256.Sum256([]byte(worker.generation + "\x00" + path + "\x00" + fmt.Sprint(sequence)))
	return "node-" + hex.EncodeToString(digest[:16])
}

func (worker *Worker) logEvent(operation, identityKey, identityValue, result, code string) {
	if worker.log == nil {
		return
	}
	if identityKey == "" {
		identityKey = "object_id"
		identityValue = "none"
	}
	if code == "" {
		code = "none"
	}
	_, _ = fmt.Fprintf(worker.log, "component=node operation=%s %s=%s result=%s code=%s\n", operation, identityKey, identityValue, result, code)
}

func (worker *Worker) logArtifactCollection(taskID, result, code string, count int) {
	if worker.log == nil {
		return
	}
	if code == "" {
		code = "none"
	}
	_, _ = fmt.Fprintf(worker.log, "component=node operation=artifact_collect task_id=%s result=%s code=%s artifact_count=%d\n", taskID, result, code, count)
}

func (worker *Worker) activeCount() int {
	worker.mu.Lock()
	defer worker.mu.Unlock()
	return len(worker.active) + len(worker.activeWorkspace) + len(worker.activeComputer)
}

func rpcID(action, value string) string {
	digest := sha256.Sum256([]byte(action + "\x00" + value))
	return "cloud-" + hex.EncodeToString(digest[:16])
}
