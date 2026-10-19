package artifactcollector

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"zapvm/internal/computer"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/workspacefs"
)

const (
	SchemaVersion       = 1
	defaultTTL          = 15 * time.Minute
	defaultMaxFiles     = 100
	defaultMaxFileSize  = uint64(5 << 30)
	defaultMaxTotalSize = uint64(20 << 30)
	maxManifestSize     = 256 << 10
)

var (
	ErrNotFound = errors.New("Artifact capability does not exist")
	ErrExpired  = errors.New("Artifact capability expired")
)

type Options struct {
	TTL          time.Duration
	MaxFiles     int
	MaxFileSize  uint64
	MaxTotalSize uint64
	Now          func() time.Time
	Random       io.Reader
}

type Collector struct {
	mu           sync.Mutex
	root         string
	ttl          time.Duration
	maxFiles     int
	maxFileSize  uint64
	maxTotalSize uint64
	now          func() time.Time
	random       io.Reader
}

type Artifact struct {
	ID          string `json:"id"`
	Path        string `json:"path"`
	ContentType string `json:"content_type"`
	Size        uint64 `json:"size"`
	SHA256      string `json:"sha256"`
}

type Collection struct {
	Capability string     `json:"capability"`
	ExpiresAt  string     `json:"expires_at"`
	Artifacts  []Artifact `json:"artifacts"`
}

type manifest struct {
	SchemaVersion int        `json:"schema_version"`
	TaskID        string     `json:"task_id"`
	ExpiresAt     string     `json:"expires_at"`
	Artifacts     []Artifact `json:"artifacts"`
}

func Open(root string, options Options) (*Collector, error) {
	if root == "" || !filepath.IsAbs(root) || len(root) > 32767 || strings.IndexByte(root, 0) >= 0 {
		return nil, errors.New("Artifact collector root must be an absolute non-NUL path")
	}
	if options.TTL == 0 {
		options.TTL = defaultTTL
	}
	if options.MaxFiles == 0 {
		options.MaxFiles = defaultMaxFiles
	}
	if options.MaxFileSize == 0 {
		options.MaxFileSize = defaultMaxFileSize
	}
	if options.MaxTotalSize == 0 {
		options.MaxTotalSize = defaultMaxTotalSize
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Random == nil {
		options.Random = rand.Reader
	}
	if options.TTL < time.Minute || options.TTL > time.Hour || options.MaxFiles < 1 || options.MaxFiles > 100 ||
		options.MaxFileSize < 1 || options.MaxFileSize > defaultMaxFileSize || options.MaxTotalSize < options.MaxFileSize || options.MaxTotalSize > defaultMaxTotalSize {
		return nil, errors.New("Artifact collector limits are invalid")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(root, 0o700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o700) {
		return nil, errors.New("Artifact collector root must be a real owner-only directory")
	}
	collector := &Collector{
		root: root, ttl: options.TTL, maxFiles: options.MaxFiles, maxFileSize: options.MaxFileSize,
		maxTotalSize: options.MaxTotalSize, now: options.Now, random: options.Random,
	}
	if err := collector.CleanupExpired(); err != nil {
		return nil, err
	}
	return collector, nil
}

func (collector *Collector) Collect(workspace, taskID string) (Collection, error) {
	collector.mu.Lock()
	defer collector.mu.Unlock()
	if !computer.ValidID(taskID) {
		return Collection{}, errors.New("Artifact collection Task ID is invalid")
	}
	outputPath, err := daemonrpc.ArtifactOutputPath(taskID)
	if err != nil {
		return Collection{}, err
	}
	if err := collector.cleanupExpired(); err != nil {
		return Collection{}, err
	}
	explorer, err := workspacefs.New(workspace)
	if err != nil {
		return Collection{}, err
	}
	staging, err := os.MkdirTemp(collector.root, ".collect-*.tmp")
	if err != nil {
		return Collection{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(staging)
		}
	}()
	if err := os.Chmod(staging, 0o700); err != nil {
		return Collection{}, err
	}
	dataRoot := filepath.Join(staging, "data")
	if err := os.Mkdir(dataRoot, 0o700); err != nil {
		return Collection{}, err
	}
	snapshots, err := explorer.Snapshot(outputPath, dataRoot, collector.maxFiles, collector.maxFileSize, collector.maxTotalSize)
	if err != nil {
		return Collection{}, err
	}
	if len(snapshots) == 0 {
		return Collection{Artifacts: []Artifact{}}, nil
	}
	artifacts := make([]Artifact, 0, len(snapshots))
	for _, snapshot := range snapshots {
		digest := sha256.Sum256([]byte("zapvm-artifact-v1\x00" + taskID + "\x00" + snapshot.Path))
		artifacts = append(artifacts, Artifact{
			ID: "artifact-" + hex.EncodeToString(digest[:16]), Path: snapshot.Path, ContentType: snapshot.ContentType,
			Size: snapshot.Size, SHA256: snapshot.SHA256,
		})
	}
	capabilityBytes := make([]byte, 32)
	if _, err := io.ReadFull(collector.random, capabilityBytes); err != nil {
		return Collection{}, err
	}
	capability := base64.RawURLEncoding.EncodeToString(capabilityBytes)
	capabilityDigest := sha256.Sum256([]byte(capability))
	finalPath := filepath.Join(collector.root, hex.EncodeToString(capabilityDigest[:]))
	if _, err := os.Lstat(finalPath); err == nil {
		return Collection{}, errors.New("Artifact capability collision")
	} else if !errors.Is(err, os.ErrNotExist) {
		return Collection{}, err
	}
	expiresAt := collector.now().UTC().Add(collector.ttl).Format(time.RFC3339Nano)
	metadata := manifest{SchemaVersion: SchemaVersion, TaskID: taskID, ExpiresAt: expiresAt, Artifacts: artifacts}
	encoded, err := json.Marshal(metadata)
	if err != nil || len(encoded) > maxManifestSize {
		return Collection{}, errors.New("encode Artifact collection manifest")
	}
	encoded = append(encoded, '\n')
	manifestPath := filepath.Join(staging, "manifest.json")
	file, err := os.OpenFile(manifestPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Collection{}, err
	}
	if _, err := file.Write(encoded); err != nil {
		_ = file.Close()
		return Collection{}, errors.New("persist Artifact collection manifest")
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return Collection{}, errors.New("persist Artifact collection manifest")
	}
	if err := file.Close(); err != nil {
		return Collection{}, errors.New("persist Artifact collection manifest")
	}
	if err := os.Rename(staging, finalPath); err != nil {
		return Collection{}, err
	}
	committed = true
	return Collection{Capability: capability, ExpiresAt: expiresAt, Artifacts: artifacts}, nil
}

// OpenArtifact redeems one local short-lived capability. The caller owns the
// returned file handle and must still verify size and digest while uploading.
func (collector *Collector) OpenArtifact(capability, artifactID string) (*os.File, Artifact, error) {
	collector.mu.Lock()
	defer collector.mu.Unlock()
	root, metadata, err := collector.load(capability)
	if err != nil {
		return nil, Artifact{}, err
	}
	for _, artifact := range metadata.Artifacts {
		if artifact.ID != artifactID {
			continue
		}
		explorer, err := workspacefs.New(filepath.Join(root, "data"))
		if err != nil {
			return nil, Artifact{}, err
		}
		file, err := explorer.OpenRegular(artifact.Path)
		if err != nil {
			return nil, Artifact{}, err
		}
		return file, artifact, nil
	}
	return nil, Artifact{}, ErrNotFound
}

func (collector *Collector) Release(capability string) error {
	collector.mu.Lock()
	defer collector.mu.Unlock()
	root, _, err := collector.load(capability)
	if err != nil && !errors.Is(err, ErrExpired) {
		return err
	}
	if root == "" {
		root = collector.capabilityPath(capability)
	}
	return os.RemoveAll(root)
}

func (collector *Collector) CleanupExpired() error {
	collector.mu.Lock()
	defer collector.mu.Unlock()
	return collector.cleanupExpired()
}

func (collector *Collector) cleanupExpired() error {
	entries, err := os.ReadDir(collector.root)
	if err != nil {
		return err
	}
	now := collector.now().UTC()
	for _, entry := range entries {
		name := entry.Name()
		path := filepath.Join(collector.root, name)
		if strings.HasPrefix(name, ".collect-") && strings.HasSuffix(name, ".tmp") {
			if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
				return errors.New("Artifact collector staging entry is invalid")
			}
			if err := os.RemoveAll(path); err != nil {
				return err
			}
			continue
		}
		if len(name) != 64 || !validHex(name) || entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
			return errors.New("Artifact collector contains an invalid entry")
		}
		metadata, err := readManifest(path)
		if err != nil {
			return err
		}
		expires, err := time.Parse(time.RFC3339Nano, metadata.ExpiresAt)
		if err != nil {
			return errors.New("Artifact collection expiry is invalid")
		}
		if !expires.After(now) {
			if err := os.RemoveAll(path); err != nil {
				return err
			}
		}
	}
	return nil
}

func (collector *Collector) load(capability string) (string, manifest, error) {
	root := collector.capabilityPath(capability)
	if root == "" {
		return "", manifest{}, ErrNotFound
	}
	metadata, err := readManifest(root)
	if errors.Is(err, os.ErrNotExist) {
		return "", manifest{}, ErrNotFound
	}
	if err != nil {
		return "", manifest{}, err
	}
	expires, err := time.Parse(time.RFC3339Nano, metadata.ExpiresAt)
	if err != nil {
		return "", manifest{}, errors.New("Artifact collection expiry is invalid")
	}
	if !expires.After(collector.now().UTC()) {
		_ = os.RemoveAll(root)
		return root, manifest{}, ErrExpired
	}
	return root, metadata, nil
}

func (collector *Collector) capabilityPath(capability string) string {
	decoded, err := base64.RawURLEncoding.DecodeString(capability)
	if err != nil || len(decoded) != 32 {
		return ""
	}
	digest := sha256.Sum256([]byte(capability))
	return filepath.Join(collector.root, hex.EncodeToString(digest[:]))
}

func readManifest(root string) (manifest, error) {
	path := filepath.Join(root, "manifest.json")
	info, err := os.Lstat(path)
	if err != nil {
		return manifest{}, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 2 || info.Size() > maxManifestSize || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		return manifest{}, errors.New("Artifact collection manifest is invalid")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return manifest{}, err
	}
	var metadata manifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&metadata); err != nil {
		return manifest{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return manifest{}, errors.New("Artifact collection manifest contains trailing JSON")
	}
	if metadata.SchemaVersion != SchemaVersion || !computer.ValidID(metadata.TaskID) || len(metadata.Artifacts) < 1 || len(metadata.Artifacts) > defaultMaxFiles {
		return manifest{}, errors.New("Artifact collection manifest fields are invalid")
	}
	seenIDs := make(map[string]struct{}, len(metadata.Artifacts))
	seenPaths := make(map[string]struct{}, len(metadata.Artifacts))
	var total uint64
	for _, artifact := range metadata.Artifacts {
		if !computer.ValidID(artifact.ID) || workspacefs.ValidatePath(artifact.Path, false) != nil || artifact.Size == 0 || artifact.Size > defaultMaxFileSize ||
			len(artifact.ContentType) == 0 || len(artifact.ContentType) > 255 || len(artifact.SHA256) != 64 || !validHex(artifact.SHA256) {
			return manifest{}, errors.New("Artifact collection manifest Artifact is invalid")
		}
		if _, exists := seenIDs[artifact.ID]; exists {
			return manifest{}, errors.New("Artifact collection manifest contains a duplicate Artifact ID")
		}
		if _, exists := seenPaths[artifact.Path]; exists || total > defaultMaxTotalSize-artifact.Size {
			return manifest{}, errors.New("Artifact collection manifest contains duplicate paths or exceeds total size")
		}
		seenIDs[artifact.ID] = struct{}{}
		seenPaths[artifact.Path] = struct{}{}
		total += artifact.Size
	}
	return metadata, nil
}

func validHex(value string) bool {
	_, err := hex.DecodeString(value)
	return err == nil && strings.ToLower(value) == value
}
