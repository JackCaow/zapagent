package cloudplane

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"path"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"zapvm/internal/computer"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/workspacefs"
)

const (
	ArtifactPending   = "pending"
	ArtifactAvailable = "available"
	ArtifactFailed    = "failed"
	ArtifactExpired   = "expired"

	maxArtifacts             = 10000
	maxArtifactsPerTask      = 100
	maxArtifactsPerScope     = 1000
	maxArtifactSize          = uint64(5 << 30)
	defaultArtifactRetention = 7 * 24 * time.Hour
	minArtifactRetention     = time.Hour
	maxArtifactRetention     = 30 * 24 * time.Hour
)

// Artifact is the authoritative metadata record for an output produced by a
// leased Computer Task. Object-store location and download authority are
// intentionally absent: those belong to the collector/storage layer.
type Artifact struct {
	ID                       string `json:"id"`
	TenantID                 string `json:"tenant_id"`
	ProjectID                string `json:"project_id"`
	ComputerID               string `json:"computer_id"`
	SessionID                string `json:"session_id"`
	TaskID                   string `json:"task_id"`
	Path                     string `json:"path"`
	Name                     string `json:"name"`
	ContentType              string `json:"content_type"`
	Size                     uint64 `json:"size"`
	SHA256                   string `json:"sha256"`
	State                    string `json:"state"`
	RetentionSeconds         uint64 `json:"retention_seconds"`
	CreatedAt                string `json:"created_at"`
	UpdatedAt                string `json:"updated_at"`
	ExpiresAt                string `json:"expires_at"`
	FailureCode              string `json:"failure_code,omitempty"`
	ObjectKey                string `json:"object_key,omitempty"`
	AvailableAt              string `json:"available_at,omitempty"`
	CreatedSequence          uint64 `json:"created_sequence"`
	RegisteredNodeID         string `json:"registered_node_id"`
	RegisteredNodeGeneration string `json:"registered_node_generation"`
}

type ArtifactObjectStore interface {
	Put(context.Context, string, string, uint64, string, io.Reader) error
	SignedGetURL(context.Context, string, string, string, time.Duration) (string, error)
	Delete(context.Context, string) error
}

func (artifact Artifact) Scope() Scope {
	return Scope{TenantID: artifact.TenantID, ProjectID: artifact.ProjectID}
}

// ArtifactRegistrationRequest contains only immutable file metadata. Scope,
// Computer, session, Task, and Node ownership are always derived server-side.
type ArtifactRegistrationRequest struct {
	ID               string `json:"id"`
	Path             string `json:"path"`
	ContentType      string `json:"content_type"`
	Size             uint64 `json:"size"`
	SHA256           string `json:"sha256"`
	RetentionSeconds uint64 `json:"retention_seconds,omitempty"`
}

func (request ArtifactRegistrationRequest) normalized() (ArtifactRegistrationRequest, string, error) {
	if !computer.ValidID(request.ID) || workspacefs.ValidatePath(request.Path, false) != nil {
		return ArtifactRegistrationRequest{}, "", errors.New("Artifact identity or path is invalid")
	}
	name := path.Base(request.Path)
	if name == "." || name == "/" || len(name) > 255 || !utf8.ValidString(name) {
		return ArtifactRegistrationRequest{}, "", errors.New("Artifact name is invalid")
	}
	mediaType, parameters, err := mime.ParseMediaType(request.ContentType)
	if err != nil || mediaType == "" || len(request.ContentType) > 255 {
		return ArtifactRegistrationRequest{}, "", errors.New("Artifact content type is invalid")
	}
	request.ContentType = mime.FormatMediaType(strings.ToLower(mediaType), parameters)
	if request.ContentType == "" || len(request.ContentType) > 255 {
		return ArtifactRegistrationRequest{}, "", errors.New("Artifact content type is invalid")
	}
	request.SHA256 = strings.ToLower(request.SHA256)
	if request.Size == 0 || request.Size > maxArtifactSize || !validHex(request.SHA256, 64) {
		return ArtifactRegistrationRequest{}, "", errors.New("Artifact size or digest is invalid")
	}
	if request.RetentionSeconds == 0 {
		request.RetentionSeconds = uint64(defaultArtifactRetention / time.Second)
	}
	if request.RetentionSeconds < uint64(minArtifactRetention/time.Second) || request.RetentionSeconds > uint64(maxArtifactRetention/time.Second) {
		return ArtifactRegistrationRequest{}, "", errors.New("Artifact retention is invalid")
	}
	return request, name, nil
}

// NormalizeArtifactRegistrationRequest applies the canonical Artifact metadata
// checks used by every durable control-plane backend.
func NormalizeArtifactRegistrationRequest(request ArtifactRegistrationRequest) (ArtifactRegistrationRequest, string, error) {
	return request.normalized()
}

func (store *Store) RegisterArtifact(nodeID, generation, taskID, leaseToken string, request ArtifactRegistrationRequest) (Artifact, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return Artifact{}, false, err
	}
	normalized, name, err := request.normalized()
	if err != nil {
		return Artifact{}, false, err
	}
	now := store.now().UTC()
	if err := store.sweepPersistLocked(now); err != nil {
		return Artifact{}, false, err
	}
	if _, err := store.requireNodeLocked(nodeID, generation); err != nil {
		return Artifact{}, false, err
	}
	task, err := store.requireLeaseLocked(nodeID, generation, taskID, leaseToken)
	if err != nil {
		return Artifact{}, false, err
	}
	if task.State != TaskRunning && task.State != TaskCanceling {
		return Artifact{}, false, ErrConflict
	}
	command, err := daemonrpc.DecodeComputerTaskSubmit(task.Payload)
	if err != nil || command.ComputerID != task.ComputerID || command.Command.SessionID == "" ||
		len(command.Command.Argv) == 0 || command.Command.Argv[0] != residentAgentBinary {
		return Artifact{}, false, ErrConflict
	}
	if existing, exists := store.state.Artifacts[normalized.ID]; exists {
		if artifactMatchesRegistration(existing, task, command.Command.SessionID, normalized, name) {
			return existing, false, nil
		}
		return Artifact{}, false, ErrConflict
	}
	if len(store.state.Artifacts) >= maxArtifacts {
		return Artifact{}, false, errors.New("Artifact limit reached")
	}
	perTask, perScope := 0, 0
	var taskBytes, scopeBytes uint64
	for _, artifact := range store.state.Artifacts {
		if artifact.State == ArtifactExpired {
			continue
		}
		if artifact.TaskID == task.ID {
			perTask++
			if taskBytes > store.artifactBytesPerTask-artifact.Size {
				return Artifact{}, false, ErrQuotaReached
			}
			taskBytes += artifact.Size
		}
		if artifact.Scope() == task.Scope() {
			perScope++
			if scopeBytes > store.artifactBytesPerScope-artifact.Size {
				return Artifact{}, false, ErrQuotaReached
			}
			scopeBytes += artifact.Size
		}
	}
	if perTask >= maxArtifactsPerTask || perScope >= maxArtifactsPerScope {
		return Artifact{}, false, ErrQuotaReached
	}
	if normalized.Size > store.artifactBytesPerTask-taskBytes || normalized.Size > store.artifactBytesPerScope-scopeBytes {
		return Artifact{}, false, ErrQuotaReached
	}
	retention := time.Duration(normalized.RetentionSeconds) * time.Second
	artifact := Artifact{
		ID: normalized.ID, TenantID: task.TenantID, ProjectID: task.ProjectID,
		ComputerID: task.ComputerID, SessionID: command.Command.SessionID, TaskID: task.ID,
		Path: normalized.Path, Name: name, ContentType: normalized.ContentType,
		Size: normalized.Size, SHA256: normalized.SHA256, State: ArtifactPending,
		RetentionSeconds: normalized.RetentionSeconds, CreatedAt: timestamp(now), UpdatedAt: timestamp(now),
		ExpiresAt: timestamp(now.Add(retention)), CreatedSequence: store.state.Sequence + 1,
		RegisteredNodeID: nodeID, RegisteredNodeGeneration: generation,
	}
	store.state.Artifacts[artifact.ID] = artifact
	if err := store.appendArtifactAuditLocked("artifact_register", artifact.Scope(), nodeID, task.ID, artifact.ID, ArtifactPending); err != nil {
		store.degraded = err
		return Artifact{}, false, err
	}
	if err := store.persistLocked(); err != nil {
		return Artifact{}, false, err
	}
	return artifact, true, nil
}

func (store *Store) InspectAgentArtifact(scope Scope, id string) (Artifact, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if scope.Validate() != nil || !computer.ValidID(id) {
		return Artifact{}, ErrNotFound
	}
	if err := store.sweepPersistLocked(store.now().UTC()); err != nil {
		return Artifact{}, err
	}
	artifact, exists := store.state.Artifacts[id]
	if !exists || artifact.Scope() != scope {
		return Artifact{}, ErrNotFound
	}
	return artifact, nil
}

func (store *Store) PrepareArtifactUpload(nodeID, generation, taskID, leaseToken, artifactID string) (Artifact, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return Artifact{}, false, err
	}
	if !computer.ValidID(artifactID) {
		return Artifact{}, false, ErrNotFound
	}
	if err := store.sweepPersistLocked(store.now().UTC()); err != nil {
		return Artifact{}, false, err
	}
	if _, err := store.requireNodeLocked(nodeID, generation); err != nil {
		return Artifact{}, false, err
	}
	task, err := store.requireLeaseLocked(nodeID, generation, taskID, leaseToken)
	if err != nil {
		return Artifact{}, false, err
	}
	artifact, exists := store.state.Artifacts[artifactID]
	if !exists || artifact.TaskID != task.ID || artifact.Scope() != task.Scope() {
		return Artifact{}, false, ErrNotFound
	}
	if artifact.ObjectKey == "" && (artifact.State == ArtifactPending || artifact.State == ArtifactFailed) {
		artifact.ObjectKey = artifactObjectKey(artifact)
		store.state.Artifacts[artifact.ID] = artifact
		if err := store.persistLocked(); err != nil {
			return Artifact{}, false, err
		}
	}
	switch artifact.State {
	case ArtifactAvailable:
		return artifact, false, nil
	case ArtifactPending, ArtifactFailed:
		return artifact, true, nil
	default:
		return Artifact{}, false, ErrConflict
	}
}

func (store *Store) CompleteArtifactUpload(nodeID, generation, taskID, leaseToken, artifactID, objectKey string) (Artifact, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.readyLocked(); err != nil {
		return Artifact{}, err
	}
	if !validArtifactObjectKey(objectKey) {
		return Artifact{}, errors.New("Artifact object key is invalid")
	}
	if _, err := store.requireNodeLocked(nodeID, generation); err != nil {
		return Artifact{}, err
	}
	task, err := store.requireLeaseLocked(nodeID, generation, taskID, leaseToken)
	if err != nil {
		return Artifact{}, err
	}
	artifact, exists := store.state.Artifacts[artifactID]
	if !exists || artifact.TaskID != task.ID || artifact.Scope() != task.Scope() {
		return Artifact{}, ErrNotFound
	}
	if artifact.State == ArtifactAvailable {
		if artifact.ObjectKey == objectKey {
			return artifact, nil
		}
		return Artifact{}, ErrConflict
	}
	if artifact.State != ArtifactPending && artifact.State != ArtifactFailed {
		return Artifact{}, ErrConflict
	}
	if artifact.ObjectKey != "" && artifact.ObjectKey != objectKey {
		return Artifact{}, ErrConflict
	}
	now := store.now().UTC()
	artifact.State = ArtifactAvailable
	artifact.ObjectKey = objectKey
	artifact.AvailableAt = timestamp(now)
	artifact.UpdatedAt = timestamp(now)
	artifact.FailureCode = ""
	store.state.Artifacts[artifact.ID] = artifact
	if err := store.appendArtifactAuditLocked("artifact_upload", artifact.Scope(), nodeID, task.ID, artifact.ID, ArtifactAvailable); err != nil {
		store.degraded = err
		return Artifact{}, err
	}
	if err := store.persistLocked(); err != nil {
		return Artifact{}, err
	}
	return artifact, nil
}

func (store *Store) FailArtifactUpload(nodeID, generation, taskID, leaseToken, artifactID, failureCode string) (Artifact, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if !validFailureCode(failureCode) {
		return Artifact{}, errors.New("Artifact upload failure code is invalid")
	}
	if _, err := store.requireNodeLocked(nodeID, generation); err != nil {
		return Artifact{}, err
	}
	task, err := store.requireLeaseLocked(nodeID, generation, taskID, leaseToken)
	if err != nil {
		return Artifact{}, err
	}
	artifact, exists := store.state.Artifacts[artifactID]
	if !exists || artifact.TaskID != task.ID || artifact.Scope() != task.Scope() {
		return Artifact{}, ErrNotFound
	}
	if artifact.State == ArtifactAvailable {
		return artifact, nil
	}
	if artifact.State != ArtifactPending && artifact.State != ArtifactFailed {
		return Artifact{}, ErrConflict
	}
	artifact.State = ArtifactFailed
	artifact.FailureCode = failureCode
	artifact.AvailableAt = ""
	artifact.UpdatedAt = timestamp(store.now().UTC())
	store.state.Artifacts[artifact.ID] = artifact
	if err := store.appendArtifactAuditLocked("artifact_upload_failed", artifact.Scope(), nodeID, task.ID, artifact.ID, failureCode); err != nil {
		store.degraded = err
		return Artifact{}, err
	}
	if err := store.persistLocked(); err != nil {
		return Artifact{}, err
	}
	return artifact, nil
}

func artifactObjectKey(artifact Artifact) string {
	scopeDigest := sha256.Sum256([]byte(artifact.TenantID + "\x00" + artifact.ProjectID))
	return "v1/" + hex.EncodeToString(scopeDigest[:16]) + "/" + artifact.ID + "/" + artifact.SHA256
}

// ArtifactObjectKeyFor returns the deterministic object-store key for an
// Artifact whose ownership and digest have already been validated.
func ArtifactObjectKeyFor(artifact Artifact) string {
	return artifactObjectKey(artifact)
}

func validArtifactObjectKey(value string) bool {
	if value == "" || len(value) > 512 || strings.HasPrefix(value, "/") || strings.Contains(value, "..") {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '/' || character == '-' || character == '_' {
			continue
		}
		return false
	}
	return true
}

// ValidArtifactObjectKey reports whether value is a canonical Artifact object
// key accepted by the collector and durable metadata store.
func ValidArtifactObjectKey(value string) bool {
	return validArtifactObjectKey(value)
}

// ExpiredArtifactObjects returns a bounded snapshot for storage GC. It never
// returns pending or available records, and does not retain the Store lock
// while the caller performs object-store I/O.
func (store *Store) ExpiredArtifactObjects(limit int) ([]Artifact, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if limit < 1 || limit > 1000 {
		return nil, errors.New("Artifact GC limit must be between 1 and 1000")
	}
	if err := store.sweepPersistLocked(store.now().UTC()); err != nil {
		return nil, err
	}
	result := make([]Artifact, 0, limit)
	for _, artifact := range store.state.Artifacts {
		if artifact.State == ArtifactExpired && artifact.ObjectKey != "" {
			result = append(result, artifact)
		}
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].UpdatedAt != result[right].UpdatedAt {
			return result[left].UpdatedAt < result[right].UpdatedAt
		}
		return result[left].ID < result[right].ID
	})
	if len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

func (store *Store) ConfirmArtifactObjectDeleted(id, objectKey string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	artifact, exists := store.state.Artifacts[id]
	if !exists || artifact.State != ArtifactExpired || artifact.ObjectKey != objectKey || !validArtifactObjectKey(objectKey) {
		return ErrConflict
	}
	artifact.ObjectKey = ""
	artifact.AvailableAt = ""
	artifact.UpdatedAt = timestamp(store.now().UTC())
	store.state.Artifacts[id] = artifact
	if err := store.appendArtifactAuditLocked("artifact_delete", artifact.Scope(), "", artifact.TaskID, artifact.ID, "deleted"); err != nil {
		store.degraded = err
		return err
	}
	return store.persistLocked()
}

func (store *Store) ListAgentSessionArtifacts(scope Scope, taskID string, after uint64, limit int) ([]Artifact, uint64, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if scope.Validate() != nil || !computer.ValidID(taskID) || limit < 1 || limit > 1000 {
		return nil, 0, ErrNotFound
	}
	if err := store.sweepPersistLocked(store.now().UTC()); err != nil {
		return nil, 0, err
	}
	task, exists := store.state.Tasks[taskID]
	if !exists || task.Scope() != scope {
		return nil, 0, ErrNotFound
	}
	if _, err := publicAgentSession(task); err != nil {
		return nil, 0, ErrNotFound
	}
	result := make([]Artifact, 0, limit)
	for _, artifact := range store.state.Artifacts {
		if artifact.TaskID == taskID && artifact.CreatedSequence > after {
			result = append(result, artifact)
		}
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].CreatedSequence != result[right].CreatedSequence {
			return result[left].CreatedSequence < result[right].CreatedSequence
		}
		return result[left].ID < result[right].ID
	})
	if len(result) > limit {
		result = result[:limit]
	}
	next := after
	if len(result) > 0 {
		next = result[len(result)-1].CreatedSequence
	}
	return result, next, nil
}

func artifactMatchesRegistration(artifact Artifact, task Task, sessionID string, request ArtifactRegistrationRequest, name string) bool {
	return artifact.Scope() == task.Scope() && artifact.ComputerID == task.ComputerID && artifact.SessionID == sessionID && artifact.TaskID == task.ID &&
		artifact.Path == request.Path && artifact.Name == name && artifact.ContentType == request.ContentType && artifact.Size == request.Size &&
		artifact.SHA256 == request.SHA256 && artifact.RetentionSeconds == request.RetentionSeconds
}

func validateStoredArtifact(artifact Artifact, task Task) error {
	request, name, err := (ArtifactRegistrationRequest{
		ID: artifact.ID, Path: artifact.Path, ContentType: artifact.ContentType, Size: artifact.Size,
		SHA256: artifact.SHA256, RetentionSeconds: artifact.RetentionSeconds,
	}).normalized()
	if err != nil || artifact.Name != name || artifact.ContentType != request.ContentType || artifact.SHA256 != request.SHA256 ||
		artifact.Scope() != task.Scope() || artifact.ComputerID != task.ComputerID || artifact.TaskID != task.ID || artifact.CreatedSequence == 0 ||
		!computer.ValidID(artifact.SessionID) || !computer.ValidID(artifact.RegisteredNodeID) || !validGeneration(artifact.RegisteredNodeGeneration) {
		return errors.New("Artifact identity or metadata is invalid")
	}
	command, err := daemonrpc.DecodeComputerTaskSubmit(task.Payload)
	if err != nil || command.ComputerID != artifact.ComputerID || command.Command.SessionID != artifact.SessionID ||
		len(command.Command.Argv) == 0 || command.Command.Argv[0] != residentAgentBinary {
		return errors.New("Artifact session ownership is invalid")
	}
	created, err := parseTimestamp(artifact.CreatedAt)
	if err != nil {
		return err
	}
	updated, err := parseTimestamp(artifact.UpdatedAt)
	if err != nil || updated.Before(created) {
		return errors.New("Artifact update timestamp is invalid")
	}
	expires, err := parseTimestamp(artifact.ExpiresAt)
	if err != nil || !expires.Equal(created.Add(time.Duration(artifact.RetentionSeconds)*time.Second)) {
		return errors.New("Artifact expiry timestamp is invalid")
	}
	switch artifact.State {
	case ArtifactPending, ArtifactAvailable, ArtifactExpired:
		if artifact.FailureCode != "" {
			return errors.New("non-failed Artifact contains a failure code")
		}
	case ArtifactFailed:
		if !validFailureCode(artifact.FailureCode) {
			return errors.New("failed Artifact failure code is invalid")
		}
	default:
		return errors.New("Artifact state is invalid")
	}
	if artifact.State == ArtifactAvailable {
		if !validArtifactObjectKey(artifact.ObjectKey) {
			return errors.New("available Artifact object key is invalid")
		}
		available, err := parseTimestamp(artifact.AvailableAt)
		if err != nil || available.Before(created) || available.After(updated) {
			return errors.New("available Artifact timestamp is invalid")
		}
	} else {
		if artifact.ObjectKey != "" && !validArtifactObjectKey(artifact.ObjectKey) {
			return errors.New("unavailable Artifact object key is invalid")
		}
		if artifact.State != ArtifactExpired && artifact.AvailableAt != "" {
			return errors.New("unavailable Artifact contains an availability timestamp")
		}
		if artifact.AvailableAt != "" {
			available, err := parseTimestamp(artifact.AvailableAt)
			if err != nil || available.Before(created) || available.After(updated) || artifact.ObjectKey == "" {
				return errors.New("expired Artifact availability timestamp is invalid")
			}
		}
	}
	return nil
}
