package cloudplane

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	"zapvm/internal/computer"
	"zapvm/internal/credential"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/workspacefs"
)

const (
	WorkspaceOperationPending   = "pending"
	WorkspaceOperationLeased    = "leased"
	WorkspaceOperationSucceeded = "succeeded"
	WorkspaceOperationFailed    = "failed"

	WorkspaceOperationList    = "list"
	WorkspaceOperationRead    = "read"
	WorkspaceOperationDiff    = "diff"
	WorkspaceOperationGitPush = "git_push"

	maxWorkspaceOperations         = 64
	maxWorkspaceOperationsPerScope = 8
	workspaceOperationTTL          = 15 * time.Minute
	workspaceOperationRetention    = 10 * time.Minute
)

type WorkspaceOperation struct {
	ID              string          `json:"id"`
	TenantID        string          `json:"tenant_id"`
	ProjectID       string          `json:"project_id"`
	ComputerID      string          `json:"computer_id"`
	Kind            string          `json:"kind"`
	Path            string          `json:"path,omitempty"`
	TaskID          string          `json:"task_id,omitempty"`
	ProviderID      string          `json:"provider_id,omitempty"`
	Branch          string          `json:"branch,omitempty"`
	State           string          `json:"state"`
	NodeID          string          `json:"node_id,omitempty"`
	NodeGeneration  string          `json:"node_generation,omitempty"`
	Attempt         uint8           `json:"attempt"`
	LeaseTokenHash  string          `json:"lease_token_hash,omitempty"`
	LeaseExpiresAt  string          `json:"lease_expires_at,omitempty"`
	CreatedAt       string          `json:"created_at"`
	UpdatedAt       string          `json:"updated_at"`
	ExpiresAt       string          `json:"expires_at"`
	Result          json.RawMessage `json:"result,omitempty"`
	ResultSHA256    string          `json:"result_sha256,omitempty"`
	FailureCode     string          `json:"failure_code,omitempty"`
	CreatedSequence uint64          `json:"created_sequence"`
}

func (operation WorkspaceOperation) Scope() Scope {
	return Scope{TenantID: operation.TenantID, ProjectID: operation.ProjectID}
}

type WorkspaceOperationRequest struct {
	ID         string
	Scope      Scope
	ComputerID string
	Kind       string
	Path       string
	TaskID     string
	ProviderID string
}

type WorkspaceOperationLease struct {
	Operation  WorkspaceOperation  `json:"operation"`
	LeaseToken string              `json:"lease_token"`
	Git        *GitLeaseCapability `json:"git,omitempty"`
}

type GitLeaseCapability struct {
	Owner         string `json:"owner"`
	Repository    string `json:"repository"`
	BaseBranch    string `json:"base_branch"`
	HTTPSCloneURL string `json:"https_clone_url"`
	Token         []byte `json:"token"`
}

func (capability *GitLeaseCapability) Destroy() {
	if capability == nil {
		return
	}
	credential.ZeroBytes(capability.Token)
	capability.Token = nil
}

type WorkspaceOperationCompletion struct {
	Succeeded   bool
	Result      json.RawMessage
	FailureCode string
}

func (request WorkspaceOperationRequest) validate() error {
	if !computer.ValidID(request.ID) || !computer.ValidID(request.ComputerID) || request.Scope.Validate() != nil {
		return errors.New("workspace operation identity is invalid")
	}
	if request.Kind != WorkspaceOperationList && request.Kind != WorkspaceOperationRead && request.Kind != WorkspaceOperationDiff && request.Kind != WorkspaceOperationGitPush {
		return errors.New("workspace operation kind is invalid")
	}
	if request.Kind == WorkspaceOperationGitPush {
		if request.Path != "" || !computer.ValidID(request.TaskID) || !computer.ValidID(request.ProviderID) {
			return errors.New("Git operation authority is invalid")
		}
		return nil
	}
	if request.TaskID != "" || request.ProviderID != "" {
		return errors.New("read-only workspace operation contains Git authority")
	}
	allowRoot := request.Kind != WorkspaceOperationRead
	if err := workspacefs.ValidatePath(request.Path, allowRoot); err != nil {
		return errors.New("workspace operation path is invalid")
	}
	return nil
}

// ValidateWorkspaceOperationRequest applies the canonical workspace authority
// and path checks used by every durable control-plane backend.
func ValidateWorkspaceOperationRequest(request WorkspaceOperationRequest) error {
	return request.validate()
}

func (store *Store) SubmitWorkspaceOperation(principal string, request WorkspaceOperationRequest) (WorkspaceOperation, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return WorkspaceOperation{}, false, err
	}
	if !validPrincipal(principal) {
		return WorkspaceOperation{}, false, ErrUnauthorized
	}
	if err := request.validate(); err != nil {
		return WorkspaceOperation{}, false, err
	}
	now := store.now().UTC()
	if err := store.sweepPersistLocked(now); err != nil {
		return WorkspaceOperation{}, false, err
	}
	if existing, ok := store.state.WorkspaceOperations[request.ID]; ok {
		if existing.Scope() == request.Scope && existing.ComputerID == request.ComputerID && existing.Kind == request.Kind && existing.Path == request.Path &&
			existing.TaskID == request.TaskID && existing.ProviderID == request.ProviderID {
			return cloneWorkspaceOperation(existing), false, nil
		}
		return WorkspaceOperation{}, false, ErrConflict
	}
	if !store.computerExplicitlyProvisionedLocked(request.Scope, request.ComputerID) {
		return WorkspaceOperation{}, false, ErrUnavailable
	}
	branch := ""
	if request.Kind == WorkspaceOperationGitPush {
		task, exists := store.state.Tasks[request.TaskID]
		if !exists || task.Scope() != request.Scope || task.ComputerID != request.ComputerID {
			return WorkspaceOperation{}, false, ErrNotFound
		}
		if task.State != TaskSucceeded {
			return WorkspaceOperation{}, false, ErrConflict
		}
		branch = "zapvm/" + request.ID
	}
	if len(store.state.WorkspaceOperations) >= maxWorkspaceOperations {
		return WorkspaceOperation{}, false, errors.New("workspace operation limit reached")
	}
	count := 0
	for _, operation := range store.state.WorkspaceOperations {
		if operation.Scope() == request.Scope {
			count++
		}
	}
	if count >= maxWorkspaceOperationsPerScope {
		return WorkspaceOperation{}, false, errors.New("workspace operation scope limit reached")
	}
	operation := WorkspaceOperation{
		ID: request.ID, TenantID: request.Scope.TenantID, ProjectID: request.Scope.ProjectID,
		ComputerID: request.ComputerID, Kind: request.Kind, Path: request.Path,
		TaskID: request.TaskID, ProviderID: request.ProviderID, Branch: branch,
		State: WorkspaceOperationPending, CreatedAt: timestamp(now), UpdatedAt: timestamp(now),
		ExpiresAt: timestamp(now.Add(workspaceOperationTTL)), CreatedSequence: store.state.Sequence + 1,
	}
	store.state.WorkspaceOperations[operation.ID] = operation
	if err := store.commitOperationPrincipalLocked("submit", operation, "", "accepted", principal); err != nil {
		return WorkspaceOperation{}, false, err
	}
	return cloneWorkspaceOperation(operation), true, nil
}

func (store *Store) InspectWorkspaceOperation(scope Scope, id string) (WorkspaceOperation, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if scope.Validate() != nil || !computer.ValidID(id) {
		return WorkspaceOperation{}, ErrNotFound
	}
	if err := store.sweepPersistLocked(store.now().UTC()); err != nil {
		return WorkspaceOperation{}, err
	}
	operation, ok := store.state.WorkspaceOperations[id]
	if !ok || operation.Scope() != scope {
		return WorkspaceOperation{}, ErrNotFound
	}
	return cloneWorkspaceOperation(operation), nil
}

func (store *Store) DeleteWorkspaceOperation(principal string, scope Scope, id string) (WorkspaceOperation, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if !validPrincipal(principal) {
		return WorkspaceOperation{}, ErrUnauthorized
	}
	if scope.Validate() != nil || !computer.ValidID(id) {
		return WorkspaceOperation{}, ErrNotFound
	}
	if err := store.sweepPersistLocked(store.now().UTC()); err != nil {
		return WorkspaceOperation{}, err
	}
	operation, ok := store.state.WorkspaceOperations[id]
	if !ok || operation.Scope() != scope {
		return WorkspaceOperation{}, ErrNotFound
	}
	if operation.State != WorkspaceOperationSucceeded && operation.State != WorkspaceOperationFailed {
		return WorkspaceOperation{}, ErrConflict
	}
	delete(store.state.WorkspaceOperations, id)
	if err := store.commitOperationPrincipalLocked("delete", operation, "", "success", principal); err != nil {
		return WorkspaceOperation{}, err
	}
	return cloneWorkspaceOperation(operation), nil
}

func (store *Store) ClaimWorkspaceOperations(nodeID, generation string, maximum int) ([]WorkspaceOperationLease, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return nil, err
	}
	if maximum < 1 || maximum > 8 {
		return nil, errors.New("workspace claim maximum must be between 1 and 8")
	}
	now := store.now().UTC()
	if err := store.sweepPersistLocked(now); err != nil {
		return nil, err
	}
	node, err := store.requireNodeLocked(nodeID, generation)
	if err != nil {
		return nil, err
	}
	if node.State != NodeOnline {
		return nil, ErrUnavailable
	}
	available := int(node.Capacity) - int(store.inFlightLocked(nodeID, generation))
	if available <= 0 {
		return nil, ErrCapacityReached
	}
	if maximum > available {
		maximum = available
	}
	provision := store.provisions[nodeID]
	candidates := make([]WorkspaceOperation, 0)
	for _, operation := range store.state.WorkspaceOperations {
		if operation.State == WorkspaceOperationPending && operation.Attempt < MaxAttempts &&
			computerExplicitlyAllowedOnProvision(provision, operation.Scope(), operation.ComputerID) {
			candidates = append(candidates, operation)
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].CreatedSequence != candidates[j].CreatedSequence {
			return candidates[i].CreatedSequence < candidates[j].CreatedSequence
		}
		return candidates[i].ID < candidates[j].ID
	})
	if len(candidates) > maximum {
		candidates = candidates[:maximum]
	}
	leases := make([]WorkspaceOperationLease, 0, len(candidates))
	for _, operation := range candidates {
		tokenBytes := make([]byte, 32)
		if _, err := io.ReadFull(store.random, tokenBytes); err != nil {
			store.degraded = fmt.Errorf("generate workspace lease token: %w", err)
			return nil, store.degraded
		}
		token := base64.RawURLEncoding.EncodeToString(tokenBytes)
		digest := sha256.Sum256([]byte(token))
		operation.State = WorkspaceOperationLeased
		operation.NodeID = nodeID
		operation.NodeGeneration = generation
		operation.Attempt++
		operation.LeaseTokenHash = hex.EncodeToString(digest[:])
		operation.LeaseExpiresAt = timestamp(now.Add(store.leaseTTL))
		operation.UpdatedAt = timestamp(now)
		store.state.WorkspaceOperations[operation.ID] = operation
		leases = append(leases, WorkspaceOperationLease{Operation: cloneWorkspaceOperation(operation), LeaseToken: token})
		if err := store.appendOperationAuditLocked("lease", operation, nodeID, "success"); err != nil {
			store.degraded = err
			return nil, err
		}
	}
	if len(leases) != 0 {
		if err := store.persistLocked(); err != nil {
			return nil, err
		}
	}
	return leases, nil
}

func (store *Store) computerExplicitlyProvisionedLocked(scope Scope, computerID string) bool {
	for _, provision := range store.provisions {
		if computerExplicitlyAllowedOnProvision(provision, scope, computerID) {
			return true
		}
	}
	return false
}

func computerExplicitlyAllowedOnProvision(provision NodeProvision, scope Scope, computerID string) bool {
	for _, candidate := range provision.Computers {
		if candidate.ID == computerID && candidate.Scope() == scope {
			return true
		}
	}
	return false
}

func (store *Store) CompleteWorkspaceOperation(nodeID, generation, operationID, leaseToken string, completion WorkspaceOperationCompletion) (WorkspaceOperation, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return WorkspaceOperation{}, err
	}
	now := store.now().UTC()
	if err := store.sweepPersistLocked(now); err != nil {
		return WorkspaceOperation{}, err
	}
	if _, err := store.requireNodeLocked(nodeID, generation); err != nil {
		return WorkspaceOperation{}, err
	}
	operation, ok := store.state.WorkspaceOperations[operationID]
	if !ok {
		return WorkspaceOperation{}, ErrNotFound
	}
	if operation.State != WorkspaceOperationLeased || operation.NodeID != nodeID || operation.NodeGeneration != generation || !tokenMatches(operation.LeaseTokenHash, leaseToken) {
		return WorkspaceOperation{}, ErrFenced
	}
	expires, err := parseTimestamp(operation.LeaseExpiresAt)
	if err != nil || !expires.After(now) {
		return WorkspaceOperation{}, ErrFenced
	}
	if completion.Succeeded {
		if completion.FailureCode != "" {
			return WorkspaceOperation{}, errors.New("workspace operation completion is invalid")
		}
		result, digest, err := validateWorkspaceResult(operation, completion.Result)
		if err != nil {
			operation.State = WorkspaceOperationFailed
			operation.FailureCode = "invalid_result"
		} else {
			operation.State = WorkspaceOperationSucceeded
			operation.Result = result
			operation.ResultSHA256 = digest
		}
	} else {
		if !validFailureCode(completion.FailureCode) || len(completion.Result) != 0 {
			return WorkspaceOperation{}, errors.New("workspace operation failure is invalid")
		}
		operation.State = WorkspaceOperationFailed
		operation.FailureCode = completion.FailureCode
	}
	operation.UpdatedAt = timestamp(now)
	clearWorkspaceOperationLease(&operation)
	store.state.WorkspaceOperations[operation.ID] = operation
	if err := store.commitOperationLocked("complete", operation, nodeID, operation.State); err != nil {
		return WorkspaceOperation{}, err
	}
	return cloneWorkspaceOperation(operation), nil
}

func validateWorkspaceResult(operation WorkspaceOperation, raw json.RawMessage) (json.RawMessage, string, error) {
	normalized, err := normalizeTaskPayload(raw)
	if err != nil {
		return nil, "", err
	}
	decode := func(target any) error {
		decoder := json.NewDecoder(bytes.NewReader(normalized))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(target); err != nil {
			return err
		}
		var trailing any
		if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			return errors.New("workspace result contains trailing JSON")
		}
		return nil
	}
	switch operation.Kind {
	case WorkspaceOperationList:
		var result daemonrpc.WorkspaceListing
		if err := decode(&result); err != nil || result.Path != operation.Path || len(result.Entries) > workspacefs.MaxEntries {
			return nil, "", errors.New("workspace listing result is invalid")
		}
		seen := make(map[string]struct{}, len(result.Entries))
		for _, entry := range result.Entries {
			if workspacefs.ValidatePath(entry.Path, false) != nil || entry.Name == "" || path.Base(entry.Path) != entry.Name ||
				(operation.Path == "" && strings.Contains(entry.Path, "/")) ||
				(operation.Path != "" && path.Dir(entry.Path) != operation.Path) ||
				(entry.Type != "file" && entry.Type != "directory" && entry.Type != "symlink" && entry.Type != "other") {
				return nil, "", errors.New("workspace listing entry is invalid")
			}
			if _, duplicate := seen[entry.Path]; duplicate {
				return nil, "", errors.New("workspace listing contains duplicate entries")
			}
			seen[entry.Path] = struct{}{}
			if _, err := parseTimestamp(entry.ModifiedAt); err != nil {
				return nil, "", errors.New("workspace listing timestamp is invalid")
			}
			if entry.Type != "file" && entry.Size != 0 || entry.Size < 0 {
				return nil, "", errors.New("workspace listing size is invalid")
			}
		}
	case WorkspaceOperationRead:
		var result daemonrpc.WorkspaceFile
		if err := decode(&result); err != nil || result.Path != operation.Path || len(result.Data) > workspacefs.MaxContent || int64(len(result.Data)) != result.Size ||
			len(result.ContentType) == 0 || len(result.ContentType) > 256 || !digestMatches(result.Data, result.SHA256) {
			return nil, "", errors.New("workspace file result is invalid")
		}
	case WorkspaceOperationDiff:
		var result daemonrpc.WorkspaceDiff
		if err := decode(&result); err != nil || result.Path != operation.Path || len(result.Data) > workspacefs.MaxContent || int64(len(result.Data)) != result.Size || !digestMatches(result.Data, result.SHA256) {
			return nil, "", errors.New("workspace diff result is invalid")
		}
	case WorkspaceOperationGitPush:
		var result daemonrpc.GitPushResult
		if err := decode(&result); err != nil || result.OperationID != operation.ID || result.Branch != operation.Branch || !validGitObjectID(result.CommitSHA) {
			return nil, "", errors.New("Git push result is invalid")
		}
		hasPullRequest := result.PullRequestNumber != 0 || result.PullRequestURL != "" || result.PullRequestState != ""
		if hasPullRequest && (result.PullRequestNumber == 0 || !validPullRequestURL(result.PullRequestURL) ||
			(result.PullRequestState != "open" && result.PullRequestState != "closed" && result.PullRequestState != "merged")) {
			return nil, "", errors.New("Git pull request result is invalid")
		}
	default:
		return nil, "", errors.New("workspace operation kind is invalid")
	}
	digest := sha256.Sum256(normalized)
	return normalized, hex.EncodeToString(digest[:]), nil
}

// ValidateWorkspaceOperationResult canonicalizes and validates a Node result
// against the leased operation contract.
func ValidateWorkspaceOperationResult(operation WorkspaceOperation, raw json.RawMessage) (json.RawMessage, string, error) {
	return validateWorkspaceResult(operation, raw)
}

func validGitObjectID(value string) bool {
	return validHex(value, 40) || validHex(value, 64)
}

func validPullRequestURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == ""
}

func (store *Store) InspectWorkspaceOperationLease(nodeID, generation, operationID, leaseToken string) (WorkspaceOperation, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return WorkspaceOperation{}, err
	}
	now := store.now().UTC()
	if err := store.sweepPersistLocked(now); err != nil {
		return WorkspaceOperation{}, err
	}
	if _, err := store.requireNodeLocked(nodeID, generation); err != nil {
		return WorkspaceOperation{}, err
	}
	operation, ok := store.state.WorkspaceOperations[operationID]
	if !ok {
		return WorkspaceOperation{}, ErrNotFound
	}
	if operation.State != WorkspaceOperationLeased || operation.NodeID != nodeID || operation.NodeGeneration != generation || !tokenMatches(operation.LeaseTokenHash, leaseToken) {
		return WorkspaceOperation{}, ErrFenced
	}
	expires, err := parseTimestamp(operation.LeaseExpiresAt)
	if err != nil || !expires.After(now) {
		return WorkspaceOperation{}, ErrFenced
	}
	return cloneWorkspaceOperation(operation), nil
}

func digestMatches(data []byte, expected string) bool {
	digest := sha256.Sum256(data)
	return subtleStringEqual(hex.EncodeToString(digest[:]), expected)
}

func cloneWorkspaceOperation(operation WorkspaceOperation) WorkspaceOperation {
	operation.Result = append(json.RawMessage(nil), operation.Result...)
	return operation
}

func clearWorkspaceOperationLease(operation *WorkspaceOperation) {
	operation.NodeID = ""
	operation.NodeGeneration = ""
	operation.LeaseTokenHash = ""
	operation.LeaseExpiresAt = ""
}

func validateStoredWorkspaceOperation(operation WorkspaceOperation) error {
	request := WorkspaceOperationRequest{
		ID: operation.ID, Scope: operation.Scope(), ComputerID: operation.ComputerID, Kind: operation.Kind, Path: operation.Path,
		TaskID: operation.TaskID, ProviderID: operation.ProviderID,
	}
	if request.validate() != nil || operation.CreatedSequence == 0 || operation.Attempt > MaxAttempts {
		return errors.New("workspace operation request is invalid")
	}
	if operation.Kind == WorkspaceOperationGitPush {
		if operation.Branch != "zapvm/"+operation.ID {
			return errors.New("Git operation branch is invalid")
		}
	} else if operation.Branch != "" {
		return errors.New("read-only workspace operation contains a Git branch")
	}
	created, createdErr := parseTimestamp(operation.CreatedAt)
	updated, updatedErr := parseTimestamp(operation.UpdatedAt)
	expires, expiresErr := parseTimestamp(operation.ExpiresAt)
	if createdErr != nil || updatedErr != nil || expiresErr != nil || !expires.After(created) || updated.Before(created) {
		return errors.New("workspace operation timestamps are invalid")
	}
	switch operation.State {
	case WorkspaceOperationPending:
		if operation.NodeID != "" || operation.NodeGeneration != "" || operation.LeaseTokenHash != "" || operation.LeaseExpiresAt != "" ||
			operation.Result != nil || operation.ResultSHA256 != "" || operation.FailureCode != "" {
			return errors.New("pending workspace operation contains authority or result")
		}
	case WorkspaceOperationLeased:
		if !computer.ValidID(operation.NodeID) || !validGeneration(operation.NodeGeneration) || !validHex(operation.LeaseTokenHash, 64) || operation.Result != nil || operation.FailureCode != "" {
			return errors.New("leased workspace operation is invalid")
		}
		if _, err := parseTimestamp(operation.LeaseExpiresAt); err != nil {
			return err
		}
	case WorkspaceOperationSucceeded:
		_, digest, err := validateWorkspaceResult(operation, operation.Result)
		if err != nil || digest != operation.ResultSHA256 || operation.NodeID != "" || operation.NodeGeneration != "" || operation.LeaseTokenHash != "" || operation.LeaseExpiresAt != "" || operation.FailureCode != "" {
			return errors.New("successful workspace operation result is invalid")
		}
	case WorkspaceOperationFailed:
		if !validFailureCode(operation.FailureCode) || operation.NodeID != "" || operation.NodeGeneration != "" || operation.LeaseTokenHash != "" || operation.LeaseExpiresAt != "" || operation.Result != nil || operation.ResultSHA256 != "" {
			return errors.New("failed workspace operation is invalid")
		}
	default:
		return errors.New("workspace operation state is invalid")
	}
	return nil
}
