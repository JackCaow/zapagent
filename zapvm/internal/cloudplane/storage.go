package cloudplane

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const maxStateSize = 64 << 20

type AuditRecord struct {
	SchemaVersion   int    `json:"schema_version"`
	Sequence        uint64 `json:"sequence"`
	Timestamp       string `json:"timestamp"`
	Action          string `json:"action"`
	TenantID        string `json:"tenant_id,omitempty"`
	ProjectID       string `json:"project_id,omitempty"`
	NodeID          string `json:"node_id,omitempty"`
	TaskID          string `json:"task_id,omitempty"`
	OperationID     string `json:"operation_id,omitempty"`
	ArtifactID      string `json:"artifact_id,omitempty"`
	PrincipalSHA256 string `json:"principal_sha256,omitempty"`
	Outcome         string `json:"outcome"`
	PreviousSHA256  string `json:"previous_sha256,omitempty"`
	SHA256          string `json:"sha256"`
}

type diskState struct {
	SchemaVersion       int                           `json:"schema_version"`
	Sequence            uint64                        `json:"sequence"`
	DispatchSequence    uint64                        `json:"dispatch_sequence"`
	Nodes               map[string]Node               `json:"nodes"`
	Tasks               map[string]Task               `json:"tasks"`
	Events              map[string][]TaskEvent        `json:"events"`
	WorkspaceOperations map[string]WorkspaceOperation `json:"workspace_operations"`
	Artifacts           map[string]Artifact           `json:"artifacts"`
	ScopeDispatch       map[string]uint64             `json:"scope_dispatch"`
	Audit               []AuditRecord                 `json:"audit"`
}

func emptyState() diskState {
	return diskState{
		SchemaVersion: stateSchemaVersion, Nodes: make(map[string]Node), Tasks: make(map[string]Task),
		Events:              make(map[string][]TaskEvent),
		WorkspaceOperations: make(map[string]WorkspaceOperation),
		Artifacts:           make(map[string]Artifact),
		ScopeDispatch:       make(map[string]uint64), Audit: make([]AuditRecord, 0),
	}
}

func migrateState(state *diskState) (bool, error) {
	switch state.SchemaVersion {
	case stateSchemaVersion:
		return false, nil
	case 9:
		return finalizeStateMigration(state)
	case 8:
		return finalizeStateMigration(state)
	case 7:
		return finalizeStateMigration(state)
	case 6:
		state.Artifacts = make(map[string]Artifact)
		return finalizeStateMigration(state)
	case 5:
		state.Artifacts = make(map[string]Artifact)
		return finalizeStateMigration(state)
	case 4:
		state.Artifacts = make(map[string]Artifact)
		for id, node := range state.Nodes {
			node.DaemonState = DaemonUnknown
			state.Nodes[id] = node
		}
		return finalizeStateMigration(state)
	case 3:
		state.Artifacts = make(map[string]Artifact)
		for id, node := range state.Nodes {
			node.DaemonState = DaemonUnknown
			state.Nodes[id] = node
		}
		return finalizeStateMigration(state)
	case 2:
		state.Artifacts = make(map[string]Artifact)
		state.WorkspaceOperations = make(map[string]WorkspaceOperation)
		for id, node := range state.Nodes {
			node.DaemonState = DaemonUnknown
			state.Nodes[id] = node
		}
		return finalizeStateMigration(state)
	case 1:
		state.Artifacts = make(map[string]Artifact)
		for id, task := range state.Tasks {
			normalizedPayload, err := normalizeTaskPayload(task.Payload)
			if err != nil {
				return false, fmt.Errorf("migrate cloud control-plane Task %q: %w", id, err)
			}
			request := SubmitRequest{
				ID: task.ID, Scope: task.Scope(), ComputerID: task.ComputerID,
				Payload: normalizedPayload, CredentialIDs: task.CredentialIDs,
			}
			digest, err := request.validate()
			if err != nil {
				return false, fmt.Errorf("migrate cloud control-plane Task %q: %w", id, err)
			}
			task.Payload = normalizedPayload
			task.PayloadSHA256 = digest
			state.Tasks[id] = task
		}
		state.WorkspaceOperations = make(map[string]WorkspaceOperation)
		for id, node := range state.Nodes {
			node.DaemonState = DaemonUnknown
			state.Nodes[id] = node
		}
		return finalizeStateMigration(state)
	default:
		return false, errors.New("cloud control-plane state schema is unsupported")
	}
}

func finalizeStateMigration(state *diskState) (bool, error) {
	for id, task := range state.Tasks {
		if task.State != TaskPending {
			continue
		}
		updated, err := parseTimestamp(task.UpdatedAt)
		if err != nil {
			return false, fmt.Errorf("migrate cloud control-plane Task %q queue deadline: %w", id, err)
		}
		task.QueueReason = QueueReasonDispatchWait
		task.QueueDeadline = timestamp(updated.Add(defaultDispatchTimeout))
		state.Tasks[id] = task
	}
	state.SchemaVersion = stateSchemaVersion
	return true, nil
}

func openState(root string) (diskState, error) {
	if root == "" || !filepath.IsAbs(root) || len(root) > 32767 || strings.IndexByte(root, 0) >= 0 {
		return diskState{}, errors.New("cloud control-plane root must be an absolute non-NUL path")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return diskState{}, err
	}
	if err := protectRoot(root); err != nil {
		return diskState{}, err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return diskState{}, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return diskState{}, errors.New("cloud control-plane root must be a real directory")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		return diskState{}, errors.New("cloud control-plane root must have mode 0700")
	}
	path := filepath.Join(root, "state.json")
	pathInfo, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return emptyState(), nil
	}
	if err != nil {
		return diskState{}, err
	}
	if !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 || pathInfo.Size() < 2 || pathInfo.Size() > maxStateSize {
		return diskState{}, errors.New("cloud control-plane state must be a bounded regular file")
	}
	if runtime.GOOS != "windows" && pathInfo.Mode().Perm() != 0o600 {
		return diskState{}, errors.New("cloud control-plane state must have mode 0600")
	}
	file, err := os.Open(path)
	if err != nil {
		return diskState{}, err
	}
	defer file.Close()
	fileInfo, err := file.Stat()
	if err != nil {
		return diskState{}, err
	}
	currentInfo, err := os.Lstat(path)
	if err != nil {
		return diskState{}, err
	}
	if !os.SameFile(fileInfo, currentInfo) || currentInfo.Mode()&os.ModeSymlink != 0 {
		return diskState{}, errors.New("cloud control-plane state changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxStateSize+1))
	if err != nil {
		return diskState{}, err
	}
	if len(data) > maxStateSize || int64(len(data)) != fileInfo.Size() {
		return diskState{}, errors.New("cloud control-plane state changed while reading")
	}
	var state diskState
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return diskState{}, fmt.Errorf("decode cloud control-plane state: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return diskState{}, errors.New("cloud control-plane state contains trailing JSON")
	}
	return state, nil
}

// RepairTaskPayloadDigests is an explicit offline recovery operation for the
// pre-schema-2 state bug that could persist the digest of non-canonical JSON.
// It never accepts a payload on digest alone: every Task must first pass the
// current strict Computer Task authority validation. The normal Open path
// remains fail-closed and never invokes this repair automatically.
func RepairTaskPayloadDigests(root string) (int, error) {
	if root == "" || !filepath.IsAbs(root) {
		return 0, errors.New("cloud control-plane repair requires an absolute state root")
	}
	lock, err := openStoreLock(root)
	if err != nil {
		return 0, err
	}
	defer closeStoreLock(lock)
	state, err := openState(root)
	if err != nil {
		return 0, err
	}
	if state.SchemaVersion != stateSchemaVersion {
		return 0, errors.New("cloud control-plane repair requires the current state schema")
	}
	repaired := 0
	for id, task := range state.Tasks {
		if id != task.ID {
			return 0, errors.New("cloud control-plane Task map contains a mismatched ID")
		}
		normalizedPayload, err := normalizeTaskPayload(task.Payload)
		if err != nil {
			return 0, fmt.Errorf("repair cloud control-plane Task %q: %w", id, err)
		}
		request := SubmitRequest{
			ID: task.ID, Scope: task.Scope(), ComputerID: task.ComputerID,
			Payload: normalizedPayload, CredentialIDs: task.CredentialIDs, RetryOf: task.RetryOf,
		}
		digest, err := request.validate()
		if err != nil {
			return 0, fmt.Errorf("repair cloud control-plane Task %q: %w", id, err)
		}
		if !bytes.Equal(task.Payload, normalizedPayload) || task.PayloadSHA256 != digest {
			task.Payload = normalizedPayload
			task.PayloadSHA256 = digest
			state.Tasks[id] = task
			repaired++
		}
	}
	if repaired == 0 {
		return 0, nil
	}
	if err := writeState(root, state); err != nil {
		return 0, fmt.Errorf("persist cloud control-plane Task digest repair: %w", err)
	}
	return repaired, nil
}

func writeState(root string, state diskState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if len(data) > maxStateSize {
		return errors.New("cloud control-plane state reached its 64 MiB limit")
	}
	temporary, err := os.CreateTemp(root, ".state-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	path := filepath.Join(root, "state.json")
	if err := replaceStateFile(temporaryPath, path); err != nil {
		return err
	}
	committed = true
	return syncStateDirectory(root)
}

func (store *Store) appendAuditLocked(action string, scope Scope, nodeID, taskID, outcome string, principal ...string) error {
	return store.appendAuditRecordLocked(action, scope, nodeID, taskID, "", "", outcome, principal...)
}

func (store *Store) appendWorkspaceOperationAuditLocked(action string, scope Scope, nodeID, operationID, outcome string, principal ...string) error {
	return store.appendAuditRecordLocked(action, scope, nodeID, "", operationID, "", outcome, principal...)
}

func (store *Store) appendOperationAuditLocked(suffix string, operation WorkspaceOperation, nodeID, outcome string, principal ...string) error {
	action := "workspace_operation_" + suffix
	taskID := ""
	if operation.Kind == WorkspaceOperationGitPush {
		action = "git_operation_" + suffix
		taskID = operation.TaskID
	}
	return store.appendAuditRecordLocked(action, operation.Scope(), nodeID, taskID, operation.ID, "", outcome, principal...)
}

func (store *Store) appendArtifactAuditLocked(action string, scope Scope, nodeID, taskID, artifactID, outcome string) error {
	return store.appendAuditRecordLocked(action, scope, nodeID, taskID, "", artifactID, outcome)
}

func (store *Store) appendAuditRecordLocked(action string, scope Scope, nodeID, taskID, operationID, artifactID, outcome string, principal ...string) error {
	if len(store.state.Audit) >= maxAuditRecords {
		return errors.New("cloud control-plane audit reached its record limit")
	}
	if !validName(action, 64) || !validName(outcome, 128) {
		return errors.New("cloud control-plane audit action or outcome is invalid")
	}
	if scope != (Scope{}) {
		if err := scope.Validate(); err != nil {
			return err
		}
	}
	if nodeID != "" && !computerID(nodeID) {
		return errors.New("cloud control-plane audit node ID is invalid")
	}
	if taskID != "" && !computerID(taskID) {
		return errors.New("cloud control-plane audit Task ID is invalid")
	}
	if operationID != "" && !computerID(operationID) {
		return errors.New("cloud control-plane audit workspace operation ID is invalid")
	}
	if artifactID != "" && !computerID(artifactID) {
		return errors.New("cloud control-plane audit Artifact ID is invalid")
	}
	previous := ""
	if len(store.state.Audit) > 0 {
		previous = store.state.Audit[len(store.state.Audit)-1].SHA256
	}
	record := AuditRecord{
		SchemaVersion: SchemaVersion, Sequence: store.state.Sequence + 1, Timestamp: timestamp(store.now().UTC()),
		Action: action, TenantID: scope.TenantID, ProjectID: scope.ProjectID, NodeID: nodeID,
		TaskID: taskID, OperationID: operationID, ArtifactID: artifactID, Outcome: outcome, PreviousSHA256: previous,
	}
	if len(principal) > 1 {
		return errors.New("cloud control-plane audit accepts at most one principal")
	}
	if len(principal) == 1 {
		if !validPrincipal(principal[0]) {
			return errors.New("cloud control-plane audit principal is invalid")
		}
		digest := sha256.Sum256([]byte(principal[0]))
		record.PrincipalSHA256 = hex.EncodeToString(digest[:])
	}
	digest, err := hashAudit(record)
	if err != nil {
		return err
	}
	record.SHA256 = digest
	store.state.Sequence = record.Sequence
	store.state.Audit = append(store.state.Audit, record)
	return nil
}

func (store *Store) Audit(scope Scope, after uint64, limit int) ([]AuditRecord, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := scope.Validate(); err != nil {
		return nil, ErrUnauthorized
	}
	if limit < 1 || limit > 1000 {
		return nil, errors.New("audit limit must be between 1 and 1000")
	}
	result := make([]AuditRecord, 0, limit)
	for _, record := range store.state.Audit {
		if record.Sequence <= after || record.TenantID != scope.TenantID || record.ProjectID != scope.ProjectID {
			continue
		}
		result = append(result, record)
		if len(result) == limit {
			break
		}
	}
	return result, nil
}

func (store *Store) validateLoadedState() error {
	if store.state.SchemaVersion != stateSchemaVersion || store.state.Nodes == nil || store.state.Tasks == nil || store.state.WorkspaceOperations == nil || store.state.Artifacts == nil ||
		store.state.Events == nil || store.state.ScopeDispatch == nil || store.state.Audit == nil {
		return errors.New("cloud control-plane state schema or collections are invalid")
	}
	if len(store.state.Tasks) > maxTasks || len(store.state.WorkspaceOperations) > maxWorkspaceOperations || len(store.state.Artifacts) > maxArtifacts || len(store.state.Audit) > maxAuditRecords {
		return errors.New("cloud control-plane state exceeds object limits")
	}
	previous := ""
	for index, record := range store.state.Audit {
		if record.SchemaVersion != SchemaVersion || record.Sequence != uint64(index+1) || record.PreviousSHA256 != previous {
			return fmt.Errorf("cloud control-plane audit record %d breaks sequence or hash chain", index+1)
		}
		expected, err := hashAudit(record)
		if err != nil || expected != record.SHA256 {
			return fmt.Errorf("cloud control-plane audit record %d has an invalid hash", index+1)
		}
		if _, err := parseTimestamp(record.Timestamp); err != nil {
			return err
		}
		if !validName(record.Action, 64) || !validName(record.Outcome, 128) ||
			(record.NodeID != "" && !computerID(record.NodeID)) || (record.TaskID != "" && !computerID(record.TaskID)) ||
			(record.OperationID != "" && !computerID(record.OperationID)) ||
			(record.ArtifactID != "" && !computerID(record.ArtifactID)) ||
			(record.PrincipalSHA256 != "" && !validHex(record.PrincipalSHA256, 64)) {
			return fmt.Errorf("cloud control-plane audit record %d has invalid fields", index+1)
		}
		if (record.TenantID == "") != (record.ProjectID == "") {
			return fmt.Errorf("cloud control-plane audit record %d has a partial scope", index+1)
		}
		if record.TenantID != "" {
			if err := (Scope{TenantID: record.TenantID, ProjectID: record.ProjectID}).Validate(); err != nil {
				return err
			}
		}
		previous = record.SHA256
	}
	if store.state.Sequence != uint64(len(store.state.Audit)) {
		return errors.New("cloud control-plane state sequence does not match audit")
	}
	for id, task := range store.state.Tasks {
		if id != task.ID {
			return errors.New("cloud control-plane Task map contains a mismatched ID")
		}
		if err := validateStoredTask(task); err != nil {
			return fmt.Errorf("cloud control-plane Task %q: %w", id, err)
		}
		if _, exists := store.state.Events[id]; !exists {
			return errors.New("cloud control-plane Task is missing its event journal")
		}
	}
	for _, task := range store.state.Tasks {
		if task.RetryOf == "" {
			continue
		}
		source, exists := store.state.Tasks[task.RetryOf]
		if !exists || source.Scope() != task.Scope() || source.ComputerID != task.ComputerID || !terminalTask(source.State) {
			return errors.New("cloud control-plane Task retry lineage is invalid")
		}
	}
	for id, operation := range store.state.WorkspaceOperations {
		if id != operation.ID || validateStoredWorkspaceOperation(operation) != nil {
			return errors.New("cloud control-plane workspace operation is invalid")
		}
		if operation.Kind == WorkspaceOperationGitPush {
			task, exists := store.state.Tasks[operation.TaskID]
			if !exists || task.Scope() != operation.Scope() || task.ComputerID != operation.ComputerID || task.State != TaskSucceeded {
				return errors.New("cloud control-plane Git operation Task authority is invalid")
			}
		}
	}
	for id, artifact := range store.state.Artifacts {
		if id != artifact.ID {
			return errors.New("cloud control-plane Artifact map contains a mismatched ID")
		}
		task, exists := store.state.Tasks[artifact.TaskID]
		if !exists || validateStoredArtifact(artifact, task) != nil {
			return errors.New("cloud control-plane Artifact is invalid")
		}
	}
	for taskID, events := range store.state.Events {
		if _, exists := store.state.Tasks[taskID]; !exists || len(events) > MaxEventsPerTask {
			return errors.New("cloud control-plane event journal references an invalid Task")
		}
		lastByAttempt := make(map[uint8]uint64)
		for index, event := range events {
			if event.Cursor != uint64(index+1) || event.TaskID != taskID || event.Attempt == 0 ||
				event.SourceCursor != lastByAttempt[event.Attempt]+1 || validateTaskEvent(event) != nil {
				return errors.New("cloud control-plane Task event journal is invalid")
			}
			lastByAttempt[event.Attempt] = event.SourceCursor
		}
	}
	for id, node := range store.state.Nodes {
		if id != node.ID || !computerID(id) || !validGeneration(node.Generation) {
			return errors.New("cloud control-plane node map contains an invalid identity")
		}
		if _, err := parseTimestamp(node.LastHeartbeat); err != nil {
			return err
		}
		if node.State != NodeOnline && node.State != NodeOffline && node.State != NodeDraining {
			return errors.New("cloud control-plane node contains an invalid state")
		}
		report, err := reportFromNode(node).normalized()
		if err != nil {
			return fmt.Errorf("cloud control-plane node %q report: %w", id, err)
		}
		applyNodeReport(&node, report)
		if provision, ok := store.provisions[id]; ok {
			node.Capacity = provision.Capacity
			node.Scopes = append([]Scope(nil), provision.Scopes...)
		} else {
			node.State = NodeOffline
			node.Scopes = nil
		}
		node.InFlight = store.inFlightLocked(id, node.Generation)
		store.state.Nodes[id] = node
	}
	return nil
}

func validateStoredTask(task Task) error {
	request := SubmitRequest{
		ID: task.ID, Scope: task.Scope(), ComputerID: task.ComputerID, Payload: task.Payload, CredentialIDs: task.CredentialIDs, RetryOf: task.RetryOf,
	}
	digest, err := request.validate()
	if err != nil || digest != task.PayloadSHA256 {
		return errors.New("Task request or payload digest is invalid")
	}
	if task.Attempt > MaxAttempts {
		return errors.New("Task attempt exceeds limit")
	}
	if task.CreatedSequence == 0 {
		return errors.New("Task creation sequence is invalid")
	}
	if _, err := parseTimestamp(task.CreatedAt); err != nil {
		return err
	}
	if _, err := parseTimestamp(task.UpdatedAt); err != nil {
		return err
	}
	switch task.State {
	case TaskPending:
		if task.NodeID != "" || task.LeaseTokenHash != "" || task.LeaseExpiresAt != "" {
			return errors.New("pending Task retains lease authority")
		}
		if !ValidQueueReason(task.QueueReason) {
			return errors.New("pending Task queue reason is invalid")
		}
		if _, err := parseTimestamp(task.QueueDeadline); err != nil {
			return errors.New("pending Task queue deadline is invalid")
		}
	case TaskLeased, TaskRunning, TaskCanceling:
		if !computerID(task.NodeID) || !validGeneration(task.NodeGeneration) || !validHex(task.LeaseTokenHash, 64) {
			return errors.New("active Task lease authority is invalid")
		}
		if _, err := parseTimestamp(task.LeaseExpiresAt); err != nil {
			return err
		}
	case TaskSucceeded, TaskFailed, TaskCanceled:
		if task.NodeID != "" || task.LeaseTokenHash != "" || task.LeaseExpiresAt != "" {
			return errors.New("terminal Task retains lease authority")
		}
	default:
		return errors.New("Task state is invalid")
	}
	if task.ResultSHA256 != "" && !validHex(task.ResultSHA256, 64) {
		return errors.New("Task result digest is invalid")
	}
	if task.State == TaskFailed && !validFailureCode(task.FailureCode) {
		return errors.New("failed Task failure code is invalid")
	}
	if task.State != TaskFailed && task.FailureCode != "" {
		return errors.New("non-failed Task contains a failure code")
	}
	return nil
}

func hashAudit(record AuditRecord) (string, error) {
	record.SHA256 = ""
	data, err := json.Marshal(record)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}

// HashAuditRecord returns the canonical chain digest used by every durable
// backend. Callers must set PreviousSHA256 and leave SHA256 empty.
func HashAuditRecord(record AuditRecord) (string, error) { return hashAudit(record) }

func computerID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

func syncStateDirectory(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
