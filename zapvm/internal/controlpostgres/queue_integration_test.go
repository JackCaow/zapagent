package controlpostgres

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"zapvm/internal/cloudplane"
	"zapvm/internal/daemonrpc"
)

func TestPostgreSQLDistributedQueueIntegration(t *testing.T) {
	dsn := os.Getenv("ZAPVM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAPVM_TEST_POSTGRES_DSN is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	migrator, err := Open(ctx, dsn, OpenOptions{AllowInsecureLocalhost: true})
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	if _, err := migrator.Apply(ctx); err != nil {
		t.Fatal(err)
	}
	if err := resetQueueIntegrationState(ctx, migrator); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := resetQueueIntegrationState(context.Background(), migrator); err != nil {
			t.Errorf("reset PostgreSQL queue integration state: %v", err)
		}
	}()

	now := time.Date(2026, 8, 8, 8, 0, 0, 0, time.UTC)
	queue, err := NewQueue(migrator, QueueOptions{HeartbeatTTL: 10 * time.Minute, LeaseTTL: 30 * time.Second, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	const nodeID = "node-queue"
	const generation = "generation-queue-0001"
	const principal = "spiffe://example.test/tenant/acme/project/queue/client/integration"
	transaction, err := migrator.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `SELECT set_config('zapvm.bypass_rls','on',true)`); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO zapvm.nodes (id,generation,state,capacity,last_heartbeat,daemon_state,updated_at) VALUES ('node-queue','provisioned-offline','offline',4,$1,'unknown',$1)`,
		`INSERT INTO zapvm.node_scopes (node_id,tenant_id,project_id) VALUES ('node-queue','acme','queue')`,
		`INSERT INTO zapvm.computers (tenant_id,project_id,computer_id,created_at) VALUES ('acme','queue','computer-queue',$1)`,
		`INSERT INTO zapvm.computer_nodes (tenant_id,project_id,computer_id,node_id) VALUES ('acme','queue','computer-queue','node-queue')`,
	} {
		arguments := []any(nil)
		if strings.Contains(statement, "$1") {
			arguments = []any{now}
		}
		if _, err := transaction.Exec(ctx, statement, arguments...); err != nil {
			_ = transaction.Rollback(ctx)
			t.Fatalf("queue fixture statement failed: %v", err)
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	registered, err := queue.RegisterNodeWithReport(ctx, nodeID, generation, cloudplane.NodeReport{DaemonState: cloudplane.DaemonHealthy, StartAttempts: 1, StartDurationMillisTotal: 10, StartDurationMillisMax: 10})
	if err != nil || registered.State != cloudplane.NodeOnline || registered.Generation != generation || len(registered.Scopes) != 1 {
		t.Fatalf("register PostgreSQL Node=%#v err=%v", registered, err)
	}
	initialPayload := queueTaskPayload(t, "task-queue", "command-queue", []string{"echo", "task-queue"})
	type submitResult struct {
		task    cloudplane.Task
		created bool
		err     error
	}
	submits := make(chan submitResult, 8)
	var submitters sync.WaitGroup
	for index := 0; index < 8; index++ {
		submitters.Add(1)
		go func() {
			defer submitters.Done()
			task, created, err := queue.Submit(ctx, principal, cloudplane.SubmitRequest{
				ID: "task-queue", Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, ComputerID: "computer-queue", Payload: initialPayload,
			})
			submits <- submitResult{task: task, created: created, err: err}
		}()
	}
	submitters.Wait()
	close(submits)
	createdSubmits := 0
	for result := range submits {
		if result.err != nil || result.task.ID != "task-queue" {
			t.Fatalf("concurrent Task submit=%#v err=%v", result.task, result.err)
		}
		if result.created {
			createdSubmits++
		}
	}
	if createdSubmits != 1 {
		t.Fatalf("concurrent Task created count=%d", createdSubmits)
	}

	type claimResult struct {
		leases []cloudplane.Lease
		err    error
	}
	results := make(chan claimResult, 8)
	var workers sync.WaitGroup
	for index := 0; index < 8; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			leases, err := queue.Claim(ctx, nodeID, generation, 1)
			results <- claimResult{leases: leases, err: err}
		}()
	}
	workers.Wait()
	close(results)
	var lease cloudplane.Lease
	claimed := 0
	for result := range results {
		if result.err != nil {
			t.Fatalf("concurrent queue claim: %v", result.err)
		}
		claimed += len(result.leases)
		if len(result.leases) == 1 {
			lease = result.leases[0]
		}
	}
	if claimed != 1 || lease.Task.ID != "task-queue" || lease.Task.Attempt != 1 || string(lease.Task.Payload) == "" {
		t.Fatalf("concurrent queue claims=%d lease=%#v", claimed, lease)
	}

	running, err := queue.Acknowledge(ctx, nodeID, generation, lease.Task.ID, lease.LeaseToken)
	if err != nil || running.State != cloudplane.TaskRunning {
		t.Fatalf("acknowledge Task=%#v err=%v", running, err)
	}
	duplicateAck, err := queue.Acknowledge(ctx, nodeID, generation, lease.Task.ID, lease.LeaseToken)
	if err != nil || duplicateAck.State != cloudplane.TaskRunning {
		t.Fatalf("duplicate acknowledge Task=%#v err=%v", duplicateAck, err)
	}
	eventSource := daemonrpc.ComputerTaskEvent{
		Cursor: 1, Timestamp: now.Add(123456789 * time.Nanosecond).Format(time.RFC3339Nano), TaskID: lease.Task.ID,
		Type: "command.stdout", CommandID: "command-queue", Stream: "stdout", Data: []byte("ready\n"),
	}
	event, created, err := queue.AppendEvent(ctx, nodeID, generation, lease.Task.ID, lease.LeaseToken, eventSource)
	if err != nil || !created || event.Cursor != 1 || event.SourceCursor != 1 {
		t.Fatalf("append Event=%#v created=%t err=%v", event, created, err)
	}
	duplicateEvent, created, err := queue.AppendEvent(ctx, nodeID, generation, lease.Task.ID, lease.LeaseToken, eventSource)
	if err != nil || created || duplicateEvent.Cursor != event.Cursor || duplicateEvent.Timestamp != event.Timestamp {
		t.Fatalf("duplicate Event=%#v created=%t err=%v", duplicateEvent, created, err)
	}
	completed, err := queue.Complete(ctx, nodeID, generation, lease.Task.ID, lease.LeaseToken, cloudplane.Completion{Succeeded: true, ResultSHA256: strings.Repeat("ab", 32)})
	if err != nil || completed.State != cloudplane.TaskSucceeded || completed.NodeID != "" {
		t.Fatalf("complete Task=%#v err=%v", completed, err)
	}
	duplicateCompletion, err := queue.Complete(ctx, nodeID, generation, lease.Task.ID, lease.LeaseToken, cloudplane.Completion{Succeeded: true, ResultSHA256: strings.Repeat("ab", 32)})
	if err != nil || duplicateCompletion.State != cloudplane.TaskSucceeded {
		t.Fatalf("duplicate completion Task=%#v err=%v", duplicateCompletion, err)
	}

	workspaceRequest := cloudplane.WorkspaceOperationRequest{
		ID: "workspace-diff", Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "queue"},
		ComputerID: "computer-queue", Kind: cloudplane.WorkspaceOperationDiff, Path: "",
	}
	type workspaceSubmitResult struct {
		operation cloudplane.WorkspaceOperation
		created   bool
		err       error
	}
	workspaceSubmits := make(chan workspaceSubmitResult, 8)
	var workspaceSubmitters sync.WaitGroup
	for index := 0; index < 8; index++ {
		workspaceSubmitters.Add(1)
		go func() {
			defer workspaceSubmitters.Done()
			operation, created, err := queue.SubmitWorkspaceOperation(ctx, principal, workspaceRequest)
			workspaceSubmits <- workspaceSubmitResult{operation: operation, created: created, err: err}
		}()
	}
	workspaceSubmitters.Wait()
	close(workspaceSubmits)
	workspaceCreates := 0
	for result := range workspaceSubmits {
		if result.err != nil || result.operation.ID != workspaceRequest.ID {
			t.Fatalf("concurrent workspace submit=%#v err=%v", result.operation, result.err)
		}
		if result.created {
			workspaceCreates++
		}
	}
	if workspaceCreates != 1 {
		t.Fatalf("concurrent workspace created count=%d", workspaceCreates)
	}
	workspaceClaims := make(chan []cloudplane.WorkspaceOperationLease, 8)
	workspaceClaimErrors := make(chan error, 8)
	var workspaceWorkers sync.WaitGroup
	for index := 0; index < 8; index++ {
		workspaceWorkers.Add(1)
		go func() {
			defer workspaceWorkers.Done()
			leases, err := queue.ClaimWorkspaceOperations(ctx, nodeID, generation, 1)
			workspaceClaims <- leases
			workspaceClaimErrors <- err
		}()
	}
	workspaceWorkers.Wait()
	close(workspaceClaims)
	close(workspaceClaimErrors)
	for err := range workspaceClaimErrors {
		if err != nil {
			t.Fatal(err)
		}
	}
	var workspaceLease cloudplane.WorkspaceOperationLease
	workspaceClaimed := 0
	for leases := range workspaceClaims {
		workspaceClaimed += len(leases)
		if len(leases) == 1 {
			workspaceLease = leases[0]
		}
	}
	if workspaceClaimed != 1 || workspaceLease.Operation.ID != workspaceRequest.ID {
		t.Fatalf("concurrent workspace claims=%d lease=%#v", workspaceClaimed, workspaceLease)
	}
	if inspected, err := queue.InspectWorkspaceOperationLease(ctx, nodeID, generation, workspaceLease.Operation.ID, workspaceLease.LeaseToken); err != nil || inspected.State != cloudplane.WorkspaceOperationLeased {
		t.Fatalf("inspect workspace lease=%#v err=%v", inspected, err)
	}
	workspaceResult := queueWorkspaceDiffResult(t, "", []byte("diff --git a/a b/a\n"))
	workspaceCompleted, err := queue.CompleteWorkspaceOperation(ctx, nodeID, generation, workspaceLease.Operation.ID, workspaceLease.LeaseToken, cloudplane.WorkspaceOperationCompletion{Succeeded: true, Result: workspaceResult})
	if err != nil || workspaceCompleted.State != cloudplane.WorkspaceOperationSucceeded || workspaceCompleted.ResultSHA256 == "" {
		t.Fatalf("complete workspace operation=%#v err=%v", workspaceCompleted, err)
	}
	if _, err := queue.InspectWorkspaceOperation(ctx, cloudplane.Scope{TenantID: "other", ProjectID: "queue"}, workspaceCompleted.ID); !errors.Is(err, cloudplane.ErrNotFound) {
		t.Fatalf("cross-scope workspace inspection error=%v", err)
	}
	deletedWorkspace, err := queue.DeleteWorkspaceOperation(ctx, principal, workspaceCompleted.Scope(), workspaceCompleted.ID)
	if err != nil || deletedWorkspace.State != cloudplane.WorkspaceOperationSucceeded {
		t.Fatalf("delete workspace operation=%#v err=%v", deletedWorkspace, err)
	}

	gitOperation, created, err := queue.SubmitWorkspaceOperation(ctx, principal, cloudplane.WorkspaceOperationRequest{
		ID: "workspace-git", Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, ComputerID: "computer-queue",
		Kind: cloudplane.WorkspaceOperationGitPush, TaskID: completed.ID, ProviderID: "github-main",
	})
	if err != nil || !created || gitOperation.Branch != "zapvm/workspace-git" {
		t.Fatalf("submit Git operation=%#v created=%t err=%v", gitOperation, created, err)
	}
	gitLeases, err := queue.ClaimWorkspaceOperations(ctx, nodeID, generation, 1)
	if err != nil || len(gitLeases) != 1 || gitLeases[0].Operation.ID != gitOperation.ID || gitLeases[0].Git != nil {
		t.Fatalf("claim Git operation=%#v err=%v", gitLeases, err)
	}
	gitResult, err := json.Marshal(daemonrpc.GitPushResult{
		OperationID: gitOperation.ID, Branch: gitOperation.Branch, CommitSHA: strings.Repeat("12", 20),
		PullRequestNumber: 52, PullRequestURL: "https://github.example/acme/repository/pull/52", PullRequestState: "open",
	})
	if err != nil {
		t.Fatal(err)
	}
	gitCompleted, err := queue.CompleteWorkspaceOperation(ctx, nodeID, generation, gitOperation.ID, gitLeases[0].LeaseToken, cloudplane.WorkspaceOperationCompletion{Succeeded: true, Result: gitResult})
	if err != nil || gitCompleted.State != cloudplane.WorkspaceOperationSucceeded {
		t.Fatalf("complete Git operation=%#v err=%v", gitCompleted, err)
	}
	if _, err := queue.DeleteWorkspaceOperation(ctx, principal, gitCompleted.Scope(), gitCompleted.ID); err != nil {
		t.Fatal(err)
	}
	expiringWorkspace, created, err := queue.SubmitWorkspaceOperation(ctx, principal, cloudplane.WorkspaceOperationRequest{
		ID: "workspace-expire", Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, ComputerID: "computer-queue",
		Kind: cloudplane.WorkspaceOperationDiff, Path: "",
	})
	if err != nil || !created {
		t.Fatalf("submit expiring workspace operation=%#v created=%t err=%v", expiringWorkspace, created, err)
	}
	expiringWorkspaceLease, err := queue.ClaimWorkspaceOperations(ctx, nodeID, generation, 1)
	if err != nil || len(expiringWorkspaceLease) != 1 || expiringWorkspaceLease[0].Operation.ID != expiringWorkspace.ID {
		t.Fatalf("claim expiring workspace operation=%#v err=%v", expiringWorkspaceLease, err)
	}
	staleWorkspaceLease := expiringWorkspaceLease[0]
	now = now.Add(31 * time.Second)
	reclaimedWorkspaceLease, err := queue.ClaimWorkspaceOperations(ctx, nodeID, generation, 1)
	if err != nil || len(reclaimedWorkspaceLease) != 1 || reclaimedWorkspaceLease[0].Operation.ID != expiringWorkspace.ID || reclaimedWorkspaceLease[0].Operation.Attempt != 2 || reclaimedWorkspaceLease[0].LeaseToken == staleWorkspaceLease.LeaseToken {
		t.Fatalf("reclaim expired workspace operation=%#v err=%v", reclaimedWorkspaceLease, err)
	}
	if _, err := queue.CompleteWorkspaceOperation(ctx, nodeID, generation, staleWorkspaceLease.Operation.ID, staleWorkspaceLease.LeaseToken, cloudplane.WorkspaceOperationCompletion{Succeeded: false, FailureCode: "stale_worker"}); !errors.Is(err, cloudplane.ErrFenced) {
		t.Fatalf("stale workspace completion error=%v", err)
	}
	failedWorkspace, err := queue.CompleteWorkspaceOperation(ctx, nodeID, generation, reclaimedWorkspaceLease[0].Operation.ID, reclaimedWorkspaceLease[0].LeaseToken, cloudplane.WorkspaceOperationCompletion{Succeeded: false, FailureCode: "guest_failed"})
	if err != nil || failedWorkspace.State != cloudplane.WorkspaceOperationFailed {
		t.Fatalf("fail reclaimed workspace operation=%#v err=%v", failedWorkspace, err)
	}
	if _, err := queue.DeleteWorkspaceOperation(ctx, principal, failedWorkspace.Scope(), failedWorkspace.ID); err != nil {
		t.Fatal(err)
	}

	outbox, err := queue.ClaimOutbox(ctx, "replica-a", 100, 30*time.Second)
	if err != nil || len(outbox) != 4 {
		t.Fatalf("claim outbox=%#v err=%v", outbox, err)
	}
	if second, err := queue.ClaimOutbox(ctx, "replica-b", 100, 30*time.Second); err != nil || len(second) != 0 {
		t.Fatalf("duplicate outbox claim=%#v err=%v", second, err)
	}
	ids := make([]int64, 0, len(outbox))
	for _, record := range outbox {
		ids = append(ids, record.ID)
	}
	if err := queue.AckOutbox(ctx, "replica-b", ids); !errors.Is(err, cloudplane.ErrFenced) {
		t.Fatalf("wrong replica outbox acknowledgment error=%v", err)
	}
	if err := queue.AckOutbox(ctx, "replica-a", ids); err != nil {
		t.Fatal(err)
	}

	submitQueueTask(t, ctx, queue, principal, "task-expire", "command-expire", []string{"echo", "task-expire"})
	expiring, err := queue.Claim(ctx, nodeID, generation, 1)
	if err != nil || len(expiring) != 1 || expiring[0].Task.Attempt != 1 {
		t.Fatalf("claim expiring Task=%#v err=%v", expiring, err)
	}
	oldLease := expiring[0]
	now = now.Add(31 * time.Second)
	reclaimed, err := queue.Claim(ctx, nodeID, generation, 1)
	if err != nil || len(reclaimed) != 1 || reclaimed[0].Task.ID != oldLease.Task.ID || reclaimed[0].Task.Attempt != 2 || reclaimed[0].LeaseToken == oldLease.LeaseToken {
		t.Fatalf("reclaim expired Task=%#v err=%v", reclaimed, err)
	}
	if _, err := queue.Acknowledge(ctx, nodeID, generation, oldLease.Task.ID, oldLease.LeaseToken); !errors.Is(err, cloudplane.ErrFenced) {
		t.Fatalf("stale lease acknowledgment error=%v", err)
	}
	current := reclaimed[0]
	validExpiry := current.Task.LeaseExpiresAt
	invalidToken := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	if err := queue.Renew(ctx, nodeID, generation, []cloudplane.LeaseProof{{TaskID: current.Task.ID, LeaseToken: current.LeaseToken}, {TaskID: "missing-task", LeaseToken: invalidToken}}); !errors.Is(err, cloudplane.ErrFenced) {
		t.Fatalf("partially invalid renewal error=%v", err)
	}
	var persistedExpiry time.Time
	if err := migrator.pool.QueryRow(ctx, `SELECT lease_expires_at FROM zapvm.tasks WHERE id=$1`, current.Task.ID).Scan(&persistedExpiry); err != nil || persistedExpiry.UTC().Format(time.RFC3339Nano) != validExpiry {
		t.Fatalf("renewal was not atomic expiry=%s expected=%s err=%v", persistedExpiry, validExpiry, err)
	}
	now = now.Add(time.Second)
	heartbeatNode, err := queue.HeartbeatWithReport(ctx, nodeID, generation, []cloudplane.LeaseProof{{TaskID: current.Task.ID, LeaseToken: current.LeaseToken}}, cloudplane.NodeReport{
		DaemonState: cloudplane.DaemonHealthy, StartAttempts: 2, StartDurationMillisTotal: 20, StartDurationMillisMax: 10,
	})
	if err != nil || heartbeatNode.StartAttempts != 2 || heartbeatNode.InFlight != 1 {
		t.Fatalf("PostgreSQL Node heartbeat=%#v err=%v", heartbeatNode, err)
	}
	if _, err := queue.Acknowledge(ctx, nodeID, generation, current.Task.ID, current.LeaseToken); err != nil {
		t.Fatal(err)
	}
	failedCompletion := cloudplane.Completion{Succeeded: false, FailureCode: "guest_failed"}
	failed, err := queue.Complete(ctx, nodeID, generation, current.Task.ID, current.LeaseToken, failedCompletion)
	if err != nil || failed.State != cloudplane.TaskFailed || failed.FailureCode != failedCompletion.FailureCode {
		t.Fatalf("failed completion Task=%#v err=%v", failed, err)
	}
	if repeated, err := queue.Complete(ctx, nodeID, generation, current.Task.ID, current.LeaseToken, failedCompletion); err != nil || repeated.FailureCode != failedCompletion.FailureCode {
		t.Fatalf("duplicate failed completion Task=%#v err=%v", repeated, err)
	}
	if _, err := queue.Complete(ctx, nodeID, generation, current.Task.ID, current.LeaseToken, cloudplane.Completion{Succeeded: false, FailureCode: "different_failure"}); !errors.Is(err, cloudplane.ErrConflict) {
		t.Fatalf("conflicting duplicate completion error=%v", err)
	}

	submitQueueTask(t, ctx, queue, principal, "task-cancel-active", "command-cancel-active", []string{"echo", "task-cancel-active"})
	activeCancelLease, err := queue.Claim(ctx, nodeID, generation, 1)
	if err != nil || len(activeCancelLease) != 1 {
		t.Fatalf("claim active cancellation Task=%#v err=%v", activeCancelLease, err)
	}
	if _, err := queue.Acknowledge(ctx, nodeID, generation, activeCancelLease[0].Task.ID, activeCancelLease[0].LeaseToken); err != nil {
		t.Fatal(err)
	}
	canceling, err := queue.Cancel(ctx, principal, cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, activeCancelLease[0].Task.ID)
	if err != nil || canceling.State != cloudplane.TaskCanceling {
		t.Fatalf("request active cancellation Task=%#v err=%v", canceling, err)
	}
	cancellations, err := queue.Cancellations(ctx, nodeID, generation, []cloudplane.LeaseProof{{TaskID: canceling.ID, LeaseToken: activeCancelLease[0].LeaseToken}})
	if err != nil || len(cancellations) != 1 || cancellations[0] != canceling.ID {
		t.Fatalf("cancellation intents=%#v err=%v", cancellations, err)
	}
	canceled, err := queue.ConfirmCanceled(ctx, nodeID, generation, canceling.ID, activeCancelLease[0].LeaseToken)
	if err != nil || canceled.State != cloudplane.TaskCanceled {
		t.Fatalf("confirm canceled Task=%#v err=%v", canceled, err)
	}
	if repeated, err := queue.ConfirmCanceled(ctx, nodeID, generation, canceling.ID, activeCancelLease[0].LeaseToken); err != nil || repeated.State != cloudplane.TaskCanceled {
		t.Fatalf("duplicate cancel confirmation Task=%#v err=%v", repeated, err)
	}

	submitQueueTask(t, ctx, queue, principal, "task-cancel-pending", "command-cancel-pending", []string{"echo", "task-cancel-pending"})
	pendingCanceled, err := queue.Cancel(ctx, principal, cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, "task-cancel-pending")
	if err != nil || pendingCanceled.State != cloudplane.TaskCanceled || pendingCanceled.Attempt != 0 {
		t.Fatalf("cancel pending Task=%#v err=%v", pendingCanceled, err)
	}
	if repeated, err := queue.Cancel(ctx, principal, cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, "task-cancel-pending"); err != nil || repeated.State != cloudplane.TaskCanceled {
		t.Fatalf("duplicate pending cancellation Task=%#v err=%v", repeated, err)
	}

	agentPayload := queueTaskPayload(t, "task-agent-first", "command-agent-first", []string{residentAgentCommand, "run"})
	agentTask, created, err := queue.SubmitAgentSession(ctx, principal, cloudplane.SubmitRequest{
		ID: "task-agent-first", Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, ComputerID: "computer-queue", Payload: agentPayload,
	}, "session-agent", false)
	if err != nil || !created || agentTask.State != cloudplane.TaskPending {
		t.Fatalf("submit PostgreSQL Agent Session Task=%#v created=%t err=%v", agentTask, created, err)
	}
	if _, _, err := queue.SubmitAgentSession(ctx, principal, cloudplane.SubmitRequest{
		ID: "task-agent-conflict", Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, ComputerID: "computer-queue",
		Payload: queueTaskPayload(t, "task-agent-conflict", "command-agent-conflict", []string{residentAgentCommand, "run"}),
	}, "session-agent", false); !errors.Is(err, cloudplane.ErrConflict) {
		t.Fatalf("concurrent first Agent Session error=%v", err)
	}
	agentLease, err := queue.Claim(ctx, nodeID, generation, 1)
	if err != nil || len(agentLease) != 1 || agentLease[0].Task.ID != agentTask.ID {
		t.Fatalf("claim Agent Session Task=%#v err=%v", agentLease, err)
	}
	if _, err := queue.Acknowledge(ctx, nodeID, generation, agentTask.ID, agentLease[0].LeaseToken); err != nil {
		t.Fatal(err)
	}
	artifactRequest := cloudplane.ArtifactRegistrationRequest{
		ID: "artifact-agent-output", Path: "outputs/result.txt", ContentType: "text/plain; charset=utf-8",
		Size: 12, SHA256: strings.Repeat("cd", 32), RetentionSeconds: 3600,
	}
	type artifactRegistrationResult struct {
		artifact cloudplane.Artifact
		created  bool
		err      error
	}
	artifactRegistrations := make(chan artifactRegistrationResult, 8)
	var artifactWriters sync.WaitGroup
	for index := 0; index < 8; index++ {
		artifactWriters.Add(1)
		go func() {
			defer artifactWriters.Done()
			artifact, created, err := queue.RegisterArtifact(ctx, nodeID, generation, agentTask.ID, agentLease[0].LeaseToken, artifactRequest)
			artifactRegistrations <- artifactRegistrationResult{artifact: artifact, created: created, err: err}
		}()
	}
	artifactWriters.Wait()
	close(artifactRegistrations)
	artifactCreates := 0
	var artifact cloudplane.Artifact
	for result := range artifactRegistrations {
		if result.err != nil || result.artifact.ID != artifactRequest.ID || result.artifact.SessionID != "session-agent" {
			t.Fatalf("concurrent Artifact registration=%#v err=%v", result.artifact, result.err)
		}
		if result.created {
			artifactCreates++
		}
		artifact = result.artifact
	}
	if artifactCreates != 1 {
		t.Fatalf("concurrent Artifact created count=%d", artifactCreates)
	}
	preparedArtifact, upload, err := queue.PrepareArtifactUpload(ctx, nodeID, generation, agentTask.ID, agentLease[0].LeaseToken, artifact.ID)
	if err != nil || !upload || preparedArtifact.ObjectKey != cloudplane.ArtifactObjectKeyFor(artifact) {
		t.Fatalf("prepare Artifact upload=%#v upload=%t err=%v", preparedArtifact, upload, err)
	}
	availableArtifact, err := queue.CompleteArtifactUpload(ctx, nodeID, generation, agentTask.ID, agentLease[0].LeaseToken, artifact.ID, preparedArtifact.ObjectKey)
	if err != nil || availableArtifact.State != cloudplane.ArtifactAvailable || availableArtifact.AvailableAt == "" {
		t.Fatalf("complete Artifact upload=%#v err=%v", availableArtifact, err)
	}
	if repeated, err := queue.CompleteArtifactUpload(ctx, nodeID, generation, agentTask.ID, agentLease[0].LeaseToken, artifact.ID, preparedArtifact.ObjectKey); err != nil || repeated.State != cloudplane.ArtifactAvailable {
		t.Fatalf("duplicate Artifact upload=%#v err=%v", repeated, err)
	}
	retryArtifact, created, err := queue.RegisterArtifact(ctx, nodeID, generation, agentTask.ID, agentLease[0].LeaseToken, cloudplane.ArtifactRegistrationRequest{
		ID: "artifact-agent-retry", Path: "outputs/retry.log", ContentType: "text/plain", Size: 8,
		SHA256: strings.Repeat("ef", 32), RetentionSeconds: 3600,
	})
	if err != nil || !created {
		t.Fatalf("register retry Artifact=%#v created=%t err=%v", retryArtifact, created, err)
	}
	preparedRetry, upload, err := queue.PrepareArtifactUpload(ctx, nodeID, generation, agentTask.ID, agentLease[0].LeaseToken, retryArtifact.ID)
	if err != nil || !upload || preparedRetry.ObjectKey == "" {
		t.Fatalf("prepare retry Artifact=%#v upload=%t err=%v", preparedRetry, upload, err)
	}
	failedArtifact, err := queue.FailArtifactUpload(ctx, nodeID, generation, agentTask.ID, agentLease[0].LeaseToken, retryArtifact.ID, "object_store_timeout")
	if err != nil || failedArtifact.State != cloudplane.ArtifactFailed || failedArtifact.ObjectKey != preparedRetry.ObjectKey {
		t.Fatalf("fail Artifact upload=%#v err=%v", failedArtifact, err)
	}
	if repeated, err := queue.FailArtifactUpload(ctx, nodeID, generation, agentTask.ID, agentLease[0].LeaseToken, retryArtifact.ID, "object_store_timeout"); err != nil || repeated.State != cloudplane.ArtifactFailed {
		t.Fatalf("duplicate Artifact failure=%#v err=%v", repeated, err)
	}
	preparedRetry, upload, err = queue.PrepareArtifactUpload(ctx, nodeID, generation, agentTask.ID, agentLease[0].LeaseToken, retryArtifact.ID)
	if err != nil || !upload || preparedRetry.ObjectKey != failedArtifact.ObjectKey {
		t.Fatalf("reprepare failed Artifact=%#v upload=%t err=%v", preparedRetry, upload, err)
	}
	if _, err := queue.CompleteArtifactUpload(ctx, nodeID, generation, agentTask.ID, agentLease[0].LeaseToken, retryArtifact.ID, preparedRetry.ObjectKey); err != nil {
		t.Fatal(err)
	}
	listedArtifacts, artifactCursor, err := queue.ListAgentSessionArtifacts(ctx, cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, agentTask.ID, 0, 10)
	if err != nil || len(listedArtifacts) != 2 || artifactCursor != retryArtifact.CreatedSequence {
		t.Fatalf("list Agent Session Artifacts=%#v cursor=%d err=%v", listedArtifacts, artifactCursor, err)
	}
	if _, err := queue.InspectAgentArtifact(ctx, cloudplane.Scope{TenantID: "other", ProjectID: "queue"}, artifact.ID); !errors.Is(err, cloudplane.ErrNotFound) {
		t.Fatalf("cross-scope Artifact inspection error=%v", err)
	}
	if _, err := queue.Complete(ctx, nodeID, generation, agentTask.ID, agentLease[0].LeaseToken, cloudplane.Completion{Succeeded: true}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Hour + time.Second)
	expiredArtifacts, err := queue.ExpiredArtifactObjects(ctx, 10)
	if err != nil || len(expiredArtifacts) != 2 || expiredArtifacts[0].State != cloudplane.ArtifactExpired || expiredArtifacts[1].State != cloudplane.ArtifactExpired {
		t.Fatalf("expired Artifact objects=%#v err=%v", expiredArtifacts, err)
	}
	for _, expiredArtifact := range expiredArtifacts {
		if err := queue.ConfirmArtifactObjectDeleted(ctx, expiredArtifact.ID, expiredArtifact.ObjectKey); err != nil {
			t.Fatal(err)
		}
	}
	deletedArtifact, err := queue.InspectAgentArtifact(ctx, cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, artifact.ID)
	if err != nil || deletedArtifact.State != cloudplane.ArtifactExpired || deletedArtifact.ObjectKey != "" || deletedArtifact.AvailableAt != "" {
		t.Fatalf("deleted Artifact metadata=%#v err=%v", deletedArtifact, err)
	}
	if _, err := queue.HeartbeatWithReport(ctx, nodeID, generation, nil, cloudplane.NodeReport{DaemonState: cloudplane.DaemonHealthy}); err != nil {
		t.Fatal(err)
	}
	continuationPayload := queueTaskPayload(t, "task-agent-next", "command-agent-next", []string{residentAgentCommand, "continue"})
	continuation, created, err := queue.SubmitAgentSession(ctx, principal, cloudplane.SubmitRequest{
		ID: "task-agent-next", Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, ComputerID: "computer-queue", Payload: continuationPayload,
	}, "session-agent", true)
	if err != nil || !created || continuation.State != cloudplane.TaskPending {
		t.Fatalf("submit Agent continuation Task=%#v created=%t err=%v", continuation, created, err)
	}
	listed, _, err := queue.ListAgentSessions(ctx, cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, 0, 10)
	if err != nil || len(listed) != 2 {
		t.Fatalf("list PostgreSQL Agent Sessions=%#v err=%v", listed, err)
	}

	generationLease, err := queue.Claim(ctx, nodeID, generation, 1)
	if err != nil || len(generationLease) != 1 || generationLease[0].Task.ID != continuation.ID {
		t.Fatalf("claim generation fence Task=%#v err=%v", generationLease, err)
	}
	generationWorkspace, created, err := queue.SubmitWorkspaceOperation(ctx, principal, cloudplane.WorkspaceOperationRequest{
		ID: "workspace-generation", Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, ComputerID: "computer-queue",
		Kind: cloudplane.WorkspaceOperationDiff, Path: "",
	})
	if err != nil || !created {
		t.Fatalf("submit generation workspace operation=%#v created=%t err=%v", generationWorkspace, created, err)
	}
	generationWorkspaceLease, err := queue.ClaimWorkspaceOperations(ctx, nodeID, generation, 1)
	if err != nil || len(generationWorkspaceLease) != 1 || generationWorkspaceLease[0].Operation.ID != generationWorkspace.ID {
		t.Fatalf("claim generation workspace operation=%#v err=%v", generationWorkspaceLease, err)
	}
	const nextGeneration = "generation-queue-0002"
	if _, err := queue.RegisterNodeWithReport(ctx, nodeID, nextGeneration, cloudplane.NodeReport{DaemonState: cloudplane.DaemonHealthy}); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Acknowledge(ctx, nodeID, generation, continuation.ID, generationLease[0].LeaseToken); !errors.Is(err, cloudplane.ErrFenced) {
		t.Fatalf("old generation lease error=%v", err)
	}
	requeued, err := queue.InspectTask(ctx, cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, continuation.ID)
	if err != nil || requeued.State != cloudplane.TaskPending {
		t.Fatalf("generation-fenced Task=%#v err=%v", requeued, err)
	}
	if _, err := queue.CompleteWorkspaceOperation(ctx, nodeID, generation, generationWorkspace.ID, generationWorkspaceLease[0].LeaseToken, cloudplane.WorkspaceOperationCompletion{Succeeded: false, FailureCode: "old_generation"}); !errors.Is(err, cloudplane.ErrFenced) {
		t.Fatalf("old generation workspace lease error=%v", err)
	}
	requeuedWorkspace, err := queue.InspectWorkspaceOperation(ctx, generationWorkspace.Scope(), generationWorkspace.ID)
	if err != nil || requeuedWorkspace.State != cloudplane.WorkspaceOperationPending {
		t.Fatalf("generation-fenced workspace operation=%#v err=%v", requeuedWorkspace, err)
	}
	records, err := queue.Audit(ctx, cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, 0, 1000)
	if err != nil || len(records) == 0 {
		t.Fatalf("PostgreSQL audit records=%#v err=%v", records, err)
	}
	for _, record := range records {
		digest, err := cloudplane.HashAuditRecord(record)
		if err != nil || digest != record.SHA256 {
			t.Fatalf("PostgreSQL audit digest=%s stored=%s err=%v", digest, record.SHA256, err)
		}
	}
	rows, err := migrator.pool.Query(ctx, `SELECT COALESCE(encode(previous_sha256,'hex'),''),encode(sha256,'hex') FROM zapvm.audit_records ORDER BY sequence`)
	if err != nil {
		t.Fatal(err)
	}
	previous := ""
	for rows.Next() {
		var linked, digest string
		if err := rows.Scan(&linked, &digest); err != nil {
			t.Fatal(err)
		}
		if linked != previous {
			t.Fatalf("PostgreSQL audit chain linked=%s expected=%s", linked, previous)
		}
		previous = digest
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgreSQLQueueCapacityTimeoutAndComputerRuntimeIntegration(t *testing.T) {
	dsn := os.Getenv("ZAPVM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAPVM_TEST_POSTGRES_DSN is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	migrator, err := Open(ctx, dsn, OpenOptions{AllowInsecureLocalhost: true})
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	if _, err := migrator.Apply(ctx); err != nil {
		t.Fatal(err)
	}
	if err := resetQueueIntegrationState(ctx, migrator); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := resetQueueIntegrationState(context.Background(), migrator); err != nil {
			t.Errorf("reset PostgreSQL capacity integration state: %v", err)
		}
	}()

	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	queue, err := NewQueue(migrator, QueueOptions{
		HeartbeatTTL:    10 * time.Minute,
		LeaseTTL:        10 * time.Minute,
		DispatchTimeout: 2 * time.Second,
		Now:             func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	transaction, err := migrator.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `SELECT set_config('zapvm.bypass_rls','on',true)`); err != nil {
		_ = transaction.Rollback(ctx)
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO zapvm.nodes (id,generation,state,capacity,last_heartbeat,daemon_state,updated_at) VALUES ('node-capacity','provisioned-offline','offline',1,$1,'unknown',$1)`,
		`INSERT INTO zapvm.node_scopes (node_id,tenant_id,project_id) VALUES ('node-capacity','acme','queue')`,
		`INSERT INTO zapvm.computers (tenant_id,project_id,computer_id,created_at) VALUES ('acme','queue','computer-queue',$1)`,
		`INSERT INTO zapvm.computer_nodes (tenant_id,project_id,computer_id,node_id) VALUES ('acme','queue','computer-queue','node-capacity')`,
	} {
		arguments := []any(nil)
		if strings.Contains(statement, "$1") {
			arguments = []any{now}
		}
		if _, err := transaction.Exec(ctx, statement, arguments...); err != nil {
			_ = transaction.Rollback(ctx)
			t.Fatalf("capacity fixture statement failed: %v", err)
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	const generation = "generation-capacity-0001"
	if _, err := queue.RegisterNodeWithReport(ctx, "node-capacity", generation, cloudplane.NodeReport{DaemonState: cloudplane.DaemonHealthy}); err != nil {
		t.Fatal(err)
	}
	const principal = "spiffe://example.test/tenant/acme/project/queue/client/capacity"
	holder := submitQueueTask(t, ctx, queue, principal, "task-capacity-holder", "command-capacity-holder", []string{"echo", "holder"})
	leases, err := queue.Claim(ctx, "node-capacity", generation, 1)
	if err != nil || len(leases) != 1 || leases[0].Task.ID != holder.ID {
		t.Fatalf("claim PostgreSQL capacity holder=%#v err=%v", leases, err)
	}
	waiter := submitQueueTask(t, ctx, queue, principal, "task-capacity-waiter", "command-capacity-waiter", []string{"echo", "waiter"})
	if waiter.QueueReason != cloudplane.QueueReasonCapacityWait || waiter.QueueDeadline == "" {
		t.Fatalf("PostgreSQL capacity waiter=%#v", waiter)
	}
	computers, err := queue.ListAgentComputers(ctx, waiter.Scope())
	if err != nil || len(computers) != 1 || computers[0].ObservedState != cloudplane.ComputerObservedBusy || computers[0].AssignedNodeID != "node-capacity" || computers[0].LastActivityAt == "" {
		t.Fatalf("PostgreSQL Computer runtime=%#v err=%v", computers, err)
	}
	now = now.Add(3 * time.Second)
	if err := queue.Renew(ctx, "node-capacity", generation, nil); err != nil {
		t.Fatal(err)
	}
	if err := queue.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	waiter, err = queue.InspectTask(ctx, waiter.Scope(), waiter.ID)
	if err != nil || waiter.State != cloudplane.TaskFailed || waiter.FailureCode != "capacity_timeout" || waiter.QueueReason != cloudplane.QueueReasonCapacityWait {
		t.Fatalf("expired PostgreSQL capacity waiter=%#v err=%v", waiter, err)
	}
}

func TestPostgreSQLDynamicPlacementCompetitionAndGenerationFenceIntegration(t *testing.T) {
	dsn := os.Getenv("ZAPVM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAPVM_TEST_POSTGRES_DSN is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	migrator, err := Open(ctx, dsn, OpenOptions{AllowInsecureLocalhost: true})
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	if _, err := migrator.Apply(ctx); err != nil {
		t.Fatal(err)
	}
	if err := resetQueueIntegrationState(ctx, migrator); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := resetQueueIntegrationState(context.Background(), migrator); err != nil {
			t.Errorf("reset PostgreSQL dynamic placement state: %v", err)
		}
	}()

	now := time.Date(2026, 8, 14, 6, 0, 0, 0, time.UTC)
	queue, err := NewQueue(migrator, QueueOptions{
		HeartbeatTTL: 10 * time.Minute, LeaseTTL: 10 * time.Minute,
		DispatchTimeout: 30 * time.Second, PlacementMode: cloudplane.PlacementModeDynamic, ComputerStartTimeout: 30 * time.Second,
		Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	scope := cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}
	computer := cloudplane.ComputerProvision{ID: "computer-queue", TenantID: scope.TenantID, ProjectID: scope.ProjectID}
	if err := queue.ReconcileProvisions(ctx, []cloudplane.NodeProvision{
		{ID: "node-placement-a", Capacity: 2, Scopes: []cloudplane.Scope{scope}, Computers: []cloudplane.ComputerProvision{computer}},
		{ID: "node-placement-b", Capacity: 2, Scopes: []cloudplane.Scope{scope}, Computers: []cloudplane.ComputerProvision{computer}},
	}); err != nil {
		t.Fatal(err)
	}
	var resourceRows int
	if err := migrator.pool.QueryRow(ctx, `SELECT count(*) FROM zapvm.node_resources WHERE node_id IN ('node-placement-a','node-placement-b') AND vm_slots=2 AND allocatable_vcpu=2`).Scan(&resourceRows); err != nil || resourceRows != 2 {
		t.Fatalf("dynamic placement Node resources=%d err=%v", resourceRows, err)
	}
	if _, err := migrator.pool.Exec(ctx, `UPDATE zapvm.node_resources SET starting_count=1,running_count=2 WHERE node_id='node-placement-a'`); err == nil {
		t.Fatal("dynamic placement Node resources accepted more active Computers than VM slots")
	}
	generations := map[string]string{
		"node-placement-a": "generation-placement-a-0001",
		"node-placement-b": "generation-placement-b-0001",
	}
	for nodeID, generation := range generations {
		if _, err := queue.RegisterNodeWithReport(ctx, nodeID, generation, cloudplane.NodeReport{DaemonState: cloudplane.DaemonHealthy}); err != nil {
			t.Fatalf("register dynamic placement Node %s: %v", nodeID, err)
		}
	}
	available, err := queue.ListAgentComputers(ctx, scope)
	if err != nil || len(available) != 1 || available[0].State != cloudplane.NodeOnline ||
		available[0].ObservedState != cloudplane.ComputerObservedUnavailable || available[0].FailureCode != "" {
		t.Fatalf("unplaced on-demand Computer availability=%#v err=%v", available, err)
	}

	const principal = "spiffe://example.test/tenant/acme/project/queue/client/placement"
	type submitResult struct {
		task cloudplane.Task
		err  error
	}
	results := make(chan submitResult, 2)
	payloads := make(map[string]json.RawMessage, 2)
	for _, taskID := range []string{"task-placement-a", "task-placement-b"} {
		payloads[taskID] = queueTaskPayload(t, taskID, "command-"+taskID, []string{"echo", taskID})
	}
	for _, taskID := range []string{"task-placement-a", "task-placement-b"} {
		taskID := taskID
		payload := payloads[taskID]
		go func() {
			task, _, err := queue.Submit(ctx, principal, cloudplane.SubmitRequest{
				ID: taskID, Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, ComputerID: "computer-queue", Payload: payload,
			})
			results <- submitResult{task: task, err: err}
		}()
	}
	tasks := make([]cloudplane.Task, 0, 2)
	for range 2 {
		result := <-results
		if result.err != nil || result.task.PlacementEpoch == 0 {
			t.Fatalf("dynamic placement submit=%#v err=%v", result.task, result.err)
		}
		tasks = append(tasks, result.task)
	}
	if tasks[0].PlacementEpoch != tasks[1].PlacementEpoch {
		t.Fatalf("competing submissions used different epochs: %#v", tasks)
	}
	for _, task := range tasks {
		if task.QueueReason != cloudplane.QueueReasonComputerStarting {
			t.Fatalf("dynamic placement Task was dispatchable before VM start: %#v", task)
		}
	}

	var assignedNode, assignedGeneration string
	var activePlacements int
	if err := migrator.pool.QueryRow(ctx, `
SELECT count(*),min(node_id),min(node_generation)
FROM zapvm.computer_placements WHERE tenant_id='acme' AND project_id='queue'
  AND computer_id='computer-queue' AND state='ready'`).Scan(&activePlacements, &assignedNode, &assignedGeneration); err != nil {
		t.Fatal(err)
	}
	if activePlacements != 1 || assignedNode == "" || assignedGeneration != generations[assignedNode] {
		t.Fatalf("active dynamic placements=%d node=%q generation=%q", activePlacements, assignedNode, assignedGeneration)
	}
	otherNode := "node-placement-a"
	if otherNode == assignedNode {
		otherNode = "node-placement-b"
	}
	wrongOperations, err := queue.ClaimComputerOperations(ctx, otherNode, generations[otherNode], 2)
	if err != nil || len(wrongOperations) != 0 {
		t.Fatalf("unassigned Node claimed Computer starts=%#v err=%v", wrongOperations, err)
	}
	wrongLeases, err := queue.Claim(ctx, otherNode, generations[otherNode], 2)
	if err != nil || len(wrongLeases) != 0 {
		t.Fatalf("unassigned Node claimed dynamic tasks=%#v err=%v", wrongLeases, err)
	}
	blockedLeases, err := queue.Claim(ctx, assignedNode, assignedGeneration, 2)
	if err != nil || len(blockedLeases) != 0 {
		t.Fatalf("assigned Node claimed Tasks before Computer start=%#v err=%v", blockedLeases, err)
	}
	operations, err := queue.ClaimComputerOperations(ctx, assignedNode, assignedGeneration, 2)
	if err != nil || len(operations) != 1 || operations[0].Operation.ComputerID != "computer-queue" {
		t.Fatalf("assigned Node Computer start claims=%#v err=%v", operations, err)
	}
	var startingCount, runningCount int
	if err := migrator.pool.QueryRow(ctx, `SELECT starting_count,running_count FROM zapvm.node_resources WHERE node_id=$1`, assignedNode).Scan(&startingCount, &runningCount); err != nil || startingCount != 1 || runningCount != 0 {
		t.Fatalf("starting resource counters=(%d,%d) err=%v", startingCount, runningCount, err)
	}
	completedOperation, err := queue.CompleteComputerOperation(ctx, assignedNode, assignedGeneration, operations[0].Operation.ID, operations[0].LeaseToken, cloudplane.ComputerOperationCompletion{Succeeded: true})
	if err != nil || completedOperation.State != cloudplane.ComputerOperationSucceeded {
		t.Fatalf("complete Computer start=%#v err=%v", completedOperation, err)
	}
	replayedOperation, err := queue.CompleteComputerOperation(ctx, assignedNode, assignedGeneration, operations[0].Operation.ID, operations[0].LeaseToken, cloudplane.ComputerOperationCompletion{Succeeded: true})
	if err != nil || replayedOperation.State != cloudplane.ComputerOperationSucceeded || replayedOperation.CompletedAt != completedOperation.CompletedAt {
		t.Fatalf("replay successful Computer start=%#v original=%#v err=%v", replayedOperation, completedOperation, err)
	}
	if _, err := queue.CompleteComputerOperation(ctx, assignedNode, assignedGeneration, operations[0].Operation.ID, operations[0].LeaseToken, cloudplane.ComputerOperationCompletion{FailureCode: "daemon_start_failed"}); !errors.Is(err, cloudplane.ErrFenced) {
		t.Fatalf("conflicting Computer start replay error=%v", err)
	}
	if err := migrator.pool.QueryRow(ctx, `SELECT starting_count,running_count FROM zapvm.node_resources WHERE node_id=$1`, assignedNode).Scan(&startingCount, &runningCount); err != nil || startingCount != 0 || runningCount != 1 {
		t.Fatalf("running resource counters=(%d,%d) err=%v", startingCount, runningCount, err)
	}
	leases, err := queue.Claim(ctx, assignedNode, assignedGeneration, 2)
	if err != nil || len(leases) != 2 {
		t.Fatalf("assigned Node post-start dynamic claims=%#v err=%v", leases, err)
	}

	conflict, err := migrator.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conflict.Exec(ctx, `SELECT set_config('zapvm.bypass_rls','on',true)`); err != nil {
		_ = conflict.Rollback(ctx)
		t.Fatal(err)
	}
	_, conflictErr := conflict.Exec(ctx, `
INSERT INTO zapvm.computer_placements
    (tenant_id,project_id,computer_id,epoch,node_id,node_generation,state,created_at,ready_at)
VALUES ('acme','queue','computer-queue',$1,$2,$3,'ready',$4,$4)`, int64(tasks[0].PlacementEpoch+1), otherNode, generations[otherNode], now)
	_ = conflict.Rollback(ctx)
	if conflictErr == nil {
		t.Fatal("unique active dynamic placement constraint accepted a second ready placement")
	}

	nextGeneration := "generation-placement-next-0002"
	if _, err := queue.RegisterNodeWithReport(ctx, assignedNode, nextGeneration, cloudplane.NodeReport{DaemonState: cloudplane.DaemonHealthy}); err != nil {
		t.Fatalf("fence dynamic placement generation: %v", err)
	}
	generations[assignedNode] = nextGeneration
	if _, err := queue.Claim(ctx, assignedNode, assignedGeneration, 1); !errors.Is(err, cloudplane.ErrFenced) {
		t.Fatalf("stale dynamic placement generation claim error=%v", err)
	}
	if _, err := queue.ClaimComputerOperations(ctx, assignedNode, assignedGeneration, 1); !errors.Is(err, cloudplane.ErrFenced) {
		t.Fatalf("stale dynamic Computer start generation claim error=%v", err)
	}
	if err := queue.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	for _, source := range tasks {
		updated, err := queue.InspectTask(ctx, source.Scope(), source.ID)
		if err != nil || updated.State != cloudplane.TaskPending || updated.PlacementEpoch <= source.PlacementEpoch {
			t.Fatalf("replaced dynamic Task=%#v previous=%#v err=%v", updated, source, err)
		}
	}
	computers, err := queue.ListAgentComputers(ctx, cloudplane.Scope{TenantID: "acme", ProjectID: "queue"})
	if err != nil || len(computers) != 1 || computers[0].PlacementEpoch <= tasks[0].PlacementEpoch || computers[0].AssignedNodeID == "" {
		t.Fatalf("replaced dynamic Computer=%#v err=%v", computers, err)
	}
	beforeDrainEpoch := computers[0].PlacementEpoch
	drainingNode := computers[0].AssignedNodeID
	if _, err := queue.SetNodeDraining(ctx, drainingNode, generations[drainingNode], true); err != nil {
		t.Fatalf("drain dynamic placement Node: %v", err)
	}
	if err := queue.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	computers, err = queue.ListAgentComputers(ctx, cloudplane.Scope{TenantID: "acme", ProjectID: "queue"})
	if err != nil || len(computers) != 1 || computers[0].PlacementEpoch <= beforeDrainEpoch || computers[0].AssignedNodeID == drainingNode {
		t.Fatalf("drain replacement dynamic Computer=%#v err=%v", computers, err)
	}
	failedStartEpoch := computers[0].PlacementEpoch
	failedStartNode := computers[0].AssignedNodeID
	failedStartLeases, err := queue.ClaimComputerOperations(ctx, failedStartNode, generations[failedStartNode], 1)
	if err != nil || len(failedStartLeases) != 1 {
		t.Fatalf("claim failing Computer start=%#v err=%v", failedStartLeases, err)
	}
	failedOperation, err := queue.CompleteComputerOperation(ctx, failedStartNode, generations[failedStartNode], failedStartLeases[0].Operation.ID, failedStartLeases[0].LeaseToken, cloudplane.ComputerOperationCompletion{FailureCode: "daemon_start_failed"})
	if err != nil || failedOperation.State != cloudplane.ComputerOperationFailed || failedOperation.FailureCode != "daemon_start_failed" {
		t.Fatalf("failed Computer start=%#v err=%v", failedOperation, err)
	}
	replayedFailure, err := queue.CompleteComputerOperation(ctx, failedStartNode, generations[failedStartNode], failedStartLeases[0].Operation.ID, failedStartLeases[0].LeaseToken, cloudplane.ComputerOperationCompletion{FailureCode: "daemon_start_failed"})
	if err != nil || replayedFailure.State != cloudplane.ComputerOperationFailed || replayedFailure.CompletedAt != failedOperation.CompletedAt {
		t.Fatalf("replay failed Computer start=%#v original=%#v err=%v", replayedFailure, failedOperation, err)
	}
	var failedPlacementState string
	if err := migrator.pool.QueryRow(ctx, `
SELECT state FROM zapvm.computer_placements
WHERE tenant_id='acme' AND project_id='queue' AND computer_id='computer-queue' AND epoch=$1`, int64(failedStartEpoch)).Scan(&failedPlacementState); err != nil || failedPlacementState != cloudplane.PlacementReleased {
		t.Fatalf("failed Computer placement state=%q err=%v", failedPlacementState, err)
	}
	if err := queue.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	computers, err = queue.ListAgentComputers(ctx, cloudplane.Scope{TenantID: "acme", ProjectID: "queue"})
	if err != nil || len(computers) != 1 || computers[0].PlacementEpoch <= failedStartEpoch || computers[0].AssignedNodeID == "" {
		t.Fatalf("failed start replacement Computer=%#v err=%v", computers, err)
	}
	var pendingOperationID string
	if err := migrator.pool.QueryRow(ctx, `
SELECT id FROM zapvm.computer_operations
WHERE tenant_id='acme' AND project_id='queue' AND computer_id='computer-queue'
  AND placement_epoch=$1 AND state='pending'`, int64(computers[0].PlacementEpoch)).Scan(&pendingOperationID); err != nil {
		t.Fatalf("inspect replacement Computer start: %v", err)
	}
	now = now.Add(31 * time.Second)
	if err := queue.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	var operationState, operationFailure string
	if err := migrator.pool.QueryRow(ctx, `SELECT state,failure_code FROM zapvm.computer_operations WHERE id=$1`, pendingOperationID).Scan(&operationState, &operationFailure); err != nil || operationState != cloudplane.ComputerOperationFailed || operationFailure != "computer_start_timeout" {
		t.Fatalf("timed out Computer start state=%q failure=%q err=%v", operationState, operationFailure, err)
	}
	var activePlacementsAfterTimeout, activeOperationsAfterTimeout int
	if err := migrator.pool.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM zapvm.computer_placements WHERE tenant_id='acme' AND project_id='queue' AND computer_id='computer-queue' AND state='ready'),
  (SELECT count(*) FROM zapvm.computer_operations WHERE tenant_id='acme' AND project_id='queue' AND computer_id='computer-queue' AND state IN ('pending','leased'))`).Scan(&activePlacementsAfterTimeout, &activeOperationsAfterTimeout); err != nil || activePlacementsAfterTimeout != 0 || activeOperationsAfterTimeout != 0 {
		t.Fatalf("timed out Computer leaked placement=%d operation=%d err=%v", activePlacementsAfterTimeout, activeOperationsAfterTimeout, err)
	}
	for _, source := range tasks {
		updated, err := queue.InspectTask(ctx, source.Scope(), source.ID)
		if err != nil || updated.State != cloudplane.TaskFailed || updated.FailureCode != "computer_unavailable" {
			t.Fatalf("Computer start timeout Task=%#v err=%v", updated, err)
		}
	}
}

func TestPostgreSQLIdleStoppedComputerReleasesPlacementIntegration(t *testing.T) {
	dsn := os.Getenv("ZAPVM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAPVM_TEST_POSTGRES_DSN is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	migrator, err := Open(ctx, dsn, OpenOptions{AllowInsecureLocalhost: true})
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	if _, err := migrator.Apply(ctx); err != nil {
		t.Fatal(err)
	}
	if err := resetQueueIntegrationState(ctx, migrator); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := resetQueueIntegrationState(context.Background(), migrator); err != nil {
			t.Errorf("reset PostgreSQL idle Computer state: %v", err)
		}
	}()

	now := time.Date(2026, 8, 14, 8, 0, 0, 0, time.UTC)
	queue, err := NewQueue(migrator, QueueOptions{
		HeartbeatTTL: 10 * time.Minute, LeaseTTL: 10 * time.Minute,
		DispatchTimeout: 2 * time.Minute, PlacementMode: cloudplane.PlacementModeDynamic,
		ComputerStartTimeout: 30 * time.Second, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	scope := cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}
	computer := cloudplane.ComputerProvision{ID: "computer-queue", TenantID: scope.TenantID, ProjectID: scope.ProjectID}
	if err := queue.ReconcileProvisions(ctx, []cloudplane.NodeProvision{{
		ID: "node-idle", Capacity: 2, Scopes: []cloudplane.Scope{scope}, Computers: []cloudplane.ComputerProvision{computer},
	}}); err != nil {
		t.Fatal(err)
	}
	const nodeID = "node-idle"
	const generation = "generation-idle-0001"
	const principal = "spiffe://example.test/tenant/acme/project/queue/client/idle"
	if _, err := queue.RegisterNodeWithReport(ctx, nodeID, generation, cloudplane.NodeReport{DaemonState: cloudplane.DaemonHealthy}); err != nil {
		t.Fatal(err)
	}

	first := submitQueueTask(t, ctx, queue, principal, "task-idle-first", "command-idle-first", []string{"echo", "first"})
	starts, err := queue.ClaimComputerOperations(ctx, nodeID, generation, 1)
	if err != nil || len(starts) != 1 {
		t.Fatalf("claim first Computer start=%#v err=%v", starts, err)
	}
	if _, err := queue.CompleteComputerOperation(ctx, nodeID, generation, starts[0].Operation.ID, starts[0].LeaseToken, cloudplane.ComputerOperationCompletion{Succeeded: true}); err != nil {
		t.Fatal(err)
	}
	leases, err := queue.Claim(ctx, nodeID, generation, 1)
	if err != nil || len(leases) != 1 || leases[0].Task.ID != first.ID {
		t.Fatalf("claim first idle lifecycle Task=%#v err=%v", leases, err)
	}
	if _, err := queue.Acknowledge(ctx, nodeID, generation, first.ID, leases[0].LeaseToken); err != nil {
		t.Fatal(err)
	}
	stoppedReport := cloudplane.NodeReport{
		DaemonState:      cloudplane.DaemonHealthy,
		ComputerRuntimes: []cloudplane.ComputerRuntimeReport{{ID: "computer-queue", State: "stopped"}},
	}
	if _, err := queue.HeartbeatWithReport(ctx, nodeID, generation, []cloudplane.LeaseProof{{TaskID: first.ID, LeaseToken: leases[0].LeaseToken}}, stoppedReport); err != nil {
		t.Fatal(err)
	}
	var placementState string
	if err := migrator.pool.QueryRow(ctx, `SELECT state FROM zapvm.computer_placements WHERE tenant_id='acme' AND project_id='queue' AND computer_id='computer-queue' AND epoch=$1`, int64(first.PlacementEpoch)).Scan(&placementState); err != nil || placementState != cloudplane.PlacementReady {
		t.Fatalf("active Computer placement state=%q err=%v", placementState, err)
	}
	if _, err := queue.Complete(ctx, nodeID, generation, first.ID, leases[0].LeaseToken, cloudplane.Completion{Succeeded: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.HeartbeatWithReport(ctx, nodeID, generation, nil, stoppedReport); err != nil {
		t.Fatal(err)
	}
	var runningCount int
	var assignedNode, failureCode string
	if err := migrator.pool.QueryRow(ctx, `SELECT state FROM zapvm.computer_placements WHERE tenant_id='acme' AND project_id='queue' AND computer_id='computer-queue' AND epoch=$1`, int64(first.PlacementEpoch)).Scan(&placementState); err != nil || placementState != cloudplane.PlacementReleased {
		t.Fatalf("idle Computer placement state=%q err=%v", placementState, err)
	}
	if err := migrator.pool.QueryRow(ctx, `SELECT running_count FROM zapvm.node_resources WHERE node_id=$1`, nodeID).Scan(&runningCount); err != nil || runningCount != 0 {
		t.Fatalf("idle Computer running count=%d err=%v", runningCount, err)
	}
	if err := migrator.pool.QueryRow(ctx, `SELECT COALESCE(assigned_node_id,''),COALESCE(failure_code,'') FROM zapvm.computer_runtime WHERE tenant_id='acme' AND project_id='queue' AND computer_id='computer-queue'`).Scan(&assignedNode, &failureCode); err != nil || assignedNode != "" || failureCode != "computer_idle_stopped" {
		t.Fatalf("idle Computer runtime node=%q failure=%q err=%v", assignedNode, failureCode, err)
	}
	available, err := queue.ListAgentComputers(ctx, scope)
	if err != nil || len(available) != 1 || available[0].State != cloudplane.NodeOnline ||
		available[0].ObservedState != cloudplane.ComputerObservedUnavailable || available[0].FailureCode != "" {
		t.Fatalf("idle on-demand Computer availability=%#v err=%v", available, err)
	}

	second := submitQueueTask(t, ctx, queue, principal, "task-idle-second", "command-idle-second", []string{"echo", "second"})
	if second.PlacementEpoch <= first.PlacementEpoch || second.QueueReason != cloudplane.QueueReasonComputerStarting {
		t.Fatalf("replacement idle Computer Task=%#v first_epoch=%d", second, first.PlacementEpoch)
	}
	if leases, err := queue.Claim(ctx, nodeID, generation, 1); err != nil || len(leases) != 0 {
		t.Fatalf("replacement Task bypassed Computer start=%#v err=%v", leases, err)
	}
	starts, err = queue.ClaimComputerOperations(ctx, nodeID, generation, 1)
	if err != nil || len(starts) != 1 || starts[0].Operation.PlacementEpoch != second.PlacementEpoch {
		t.Fatalf("replacement Computer start=%#v err=%v", starts, err)
	}
}

func TestPostgreSQLSweepPrioritizesExpiredPendingTasks(t *testing.T) {
	dsn := os.Getenv("ZAPVM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAPVM_TEST_POSTGRES_DSN is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	migrator, err := Open(ctx, dsn, OpenOptions{AllowInsecureLocalhost: true})
	if err != nil {
		t.Fatal(err)
	}
	defer migrator.Close()
	if _, err := migrator.Apply(ctx); err != nil {
		t.Fatal(err)
	}
	if err := resetQueueIntegrationState(ctx, migrator); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := resetQueueIntegrationState(context.Background(), migrator); err != nil {
			t.Errorf("reset PostgreSQL deadline integration state: %v", err)
		}
	}()

	now := time.Date(2026, 8, 8, 13, 0, 0, 0, time.UTC)
	queue, err := NewQueue(migrator, QueueOptions{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	transaction, err := migrator.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if _, err := transaction.Exec(ctx, `SELECT set_config('zapvm.bypass_rls','on',true)`); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `INSERT INTO zapvm.computers (tenant_id,project_id,computer_id,created_at) VALUES ('acme','queue','computer-queue',$1)`, now); err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{"schema_version":1}`)
	digest := sha256.Sum256(payload)
	if _, err := transaction.Exec(ctx, `
INSERT INTO zapvm.tasks
    (id,tenant_id,project_id,computer_id,payload,payload_raw,payload_sha256,state,created_at,created_sequence,updated_at,queue_reason,queue_deadline)
SELECT 'deadline-' || lpad(sequence::text,4,'0'),'acme','queue','computer-queue',$1::jsonb,$2,$3,'pending',$4,sequence,$4,'node_offline',
       CASE WHEN sequence <= 1024 THEN $4::timestamptz + interval '1 hour' ELSE $4::timestamptz - interval '1 second' END
FROM generate_series(1,1025) AS sequence`, string(payload), payload, digest[:], now); err != nil {
		t.Fatal(err)
	}
	if err := transaction.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := queue.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	var expiredState, futureState string
	if err := migrator.pool.QueryRow(ctx, `SELECT state FROM zapvm.tasks WHERE id='deadline-1025'`).Scan(&expiredState); err != nil {
		t.Fatal(err)
	}
	if err := migrator.pool.QueryRow(ctx, `SELECT state FROM zapvm.tasks WHERE id='deadline-0001'`).Scan(&futureState); err != nil {
		t.Fatal(err)
	}
	if expiredState != cloudplane.TaskFailed || futureState != cloudplane.TaskPending {
		t.Fatalf("deadline sweep expired=%s future=%s", expiredState, futureState)
	}
}

func submitQueueTask(t *testing.T, ctx context.Context, queue *Queue, principal, taskID, commandID string, argv []string) cloudplane.Task {
	t.Helper()
	payload := queueTaskPayload(t, taskID, commandID, argv)
	task, created, err := queue.Submit(ctx, principal, cloudplane.SubmitRequest{
		ID: taskID, Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, ComputerID: "computer-queue", Payload: payload,
	})
	if err != nil || !created {
		t.Fatalf("submit PostgreSQL Task=%#v created=%t err=%v", task, created, err)
	}
	repeated, created, err := queue.Submit(ctx, principal, cloudplane.SubmitRequest{
		ID: taskID, Scope: cloudplane.Scope{TenantID: "acme", ProjectID: "queue"}, ComputerID: "computer-queue", Payload: payload,
	})
	if err != nil || created || repeated.ID != task.ID {
		t.Fatalf("duplicate PostgreSQL Task=%#v created=%t err=%v", repeated, created, err)
	}
	return task
}

func queueTaskPayload(t *testing.T, taskID, commandID string, argv []string) json.RawMessage {
	t.Helper()
	sessionID := "session-" + taskID
	if len(argv) != 0 && argv[0] == residentAgentCommand {
		sessionID = "session-agent"
	}
	payload, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
		ID: taskID, ComputerID: "computer-queue",
		Command: daemonrpc.Command{ID: commandID, SessionID: sessionID, Argv: argv, TimeoutMillis: 60000},
	})
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func queueWorkspaceDiffResult(t *testing.T, path string, data []byte) json.RawMessage {
	t.Helper()
	digest := sha256.Sum256(data)
	result, err := json.Marshal(daemonrpc.WorkspaceDiff{Path: path, Size: int64(len(data)), SHA256: hex.EncodeToString(digest[:]), Data: data})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func resetQueueIntegrationState(ctx context.Context, migrator *Migrator) error {
	transaction, err := migrator.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if _, err := transaction.Exec(ctx, `SELECT set_config('zapvm.bypass_rls','on',true)`); err != nil {
		return err
	}
	for _, table := range []string{"workspace_quotas", "computer_profiles", "agent_profiles", "model_profiles", "host_pool_nodes", "host_pools", "workspace_members", "node_identity_audit", "node_certificates", "node_enrollment_tokens", "credential_access_audit", "credential_capability_items", "credential_capabilities", "credential_envelopes", "task_outbox", "task_transition_receipts", "task_events", "artifacts", "workspace_operations", "tasks", "computer_operations", "computer_placements", "computer_runtime", "agent_sessions", "computer_nodes", "node_resources", "computers", "scope_dispatch", "node_scopes", "nodes", "audit_records", "file_mirror_state", "primary_state"} {
		if _, err := transaction.Exec(ctx, `DELETE FROM zapvm.`+table); err != nil {
			return err
		}
	}
	if _, err := transaction.Exec(ctx, `UPDATE zapvm.control_state SET audit_sequence=0,credential_audit_sequence=0,node_identity_audit_sequence=0,dispatch_sequence=0,updated_at=clock_timestamp() WHERE singleton`); err != nil {
		return err
	}
	return transaction.Commit(ctx)
}
