package state

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	legacyMetadataSchema  = 1
	CurrentMetadataSchema = 2
	MinimumStateSchema    = 1
	CurrentStateSchema    = 3
	DefaultComputerBytes  = int64(16 << 30)
)

type Metadata struct {
	SchemaVersion int    `json:"schema_version"`
	StateSchema   int    `json:"state_schema"`
	DiskFormat    string `json:"disk_format"`
	CleanShutdown bool   `json:"clean_shutdown"`
	Generation    uint64 `json:"generation"`
	LastVMID      string `json:"last_vm_id,omitempty"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

type Handle struct {
	diskPath      string
	metadataPath  string
	lockFile      *os.File
	original      Metadata
	metadata      Metadata
	previousDirty bool
	mu            sync.Mutex
	closed        bool
}

func MetadataPath(diskPath string) string { return diskPath + ".zapvm-state.json" }

func Inspect(diskPath string) (Metadata, error) {
	info, err := os.Lstat(diskPath)
	if err != nil {
		return Metadata{}, err
	}
	if !info.Mode().IsRegular() {
		return Metadata{}, errors.New("state disk must be a regular file")
	}
	metadata, err := readMetadata(MetadataPath(diskPath))
	if err != nil {
		return Metadata{}, err
	}
	if err := verifyFormatPath(diskPath, metadata.DiskFormat); err != nil {
		return Metadata{}, err
	}
	return metadata, nil
}

func CreateFromTemplate(templatePath, outputPath, format string) error {
	return CreateFromTemplateSchema(templatePath, outputPath, format, CurrentStateSchema)
}

func CreateFromTemplateSchema(templatePath, outputPath, format string, stateSchema int) error {
	return CreateFromTemplateSchemaCapacity(templatePath, outputPath, format, stateSchema, 0)
}

func CreateFromTemplateSchemaCapacity(templatePath, outputPath, format string, stateSchema int, capacityBytes int64) error {
	format = strings.ToLower(strings.TrimSpace(format))
	if format != "raw" && format != "vhdx" {
		return fmt.Errorf("unsupported state disk format %q", format)
	}
	if templatePath == "" || outputPath == "" {
		return errors.New("state template and output paths are required")
	}
	if stateSchema < MinimumStateSchema || stateSchema > CurrentStateSchema {
		return fmt.Errorf("unsupported state template schema %d", stateSchema)
	}
	if !filepath.IsAbs(outputPath) {
		return errors.New("state output path must be absolute")
	}
	if err := verifyFormatPath(outputPath, format); err != nil {
		return err
	}
	info, err := os.Lstat(templatePath)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("state template must be a regular file")
	}
	if _, err := os.Lstat(outputPath); err == nil {
		return errors.New("state output already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	metadataPath := MetadataPath(outputPath)
	if _, err := os.Lstat(metadataPath); err == nil {
		return errors.New("state metadata already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o700); err != nil {
		return err
	}
	if err := copyStateFile(templatePath, outputPath); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(outputPath)
			_ = os.Remove(metadataPath)
		}
	}()
	if capacityBytes != 0 {
		if format != "raw" {
			return errors.New("state capacity expansion is supported only for raw disks")
		}
		if capacityBytes < info.Size() {
			return errors.New("state capacity cannot be smaller than its template")
		}
		if err := resizeRawStateFile(outputPath, capacityBytes); err != nil {
			return err
		}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	metadata := Metadata{
		SchemaVersion: CurrentMetadataSchema,
		StateSchema:   stateSchema,
		DiskFormat:    format,
		CleanShutdown: true,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := writeMetadataExclusive(metadataPath, metadata); err != nil {
		return err
	}
	committed = true
	return nil
}

func resizeRawStateFile(path string, size int64) error {
	file, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := file.Truncate(size); err != nil {
		return err
	}
	return file.Sync()
}

func copyStateFallback(sourcePath, destinationPath string) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()
	destination, err := os.OpenFile(destinationPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	failed := true
	defer func() {
		_ = destination.Close()
		if failed {
			_ = os.Remove(destinationPath)
		}
	}()
	if _, err := io.Copy(destination, source); err != nil {
		return err
	}
	if err := destination.Sync(); err != nil {
		return err
	}
	if err := destination.Close(); err != nil {
		return err
	}
	failed = false
	return nil
}

func OpenForVM(diskPath, vmID string) (*Handle, error) {
	if diskPath == "" || vmID == "" {
		return nil, errors.New("state disk path and VM ID are required")
	}
	info, err := os.Lstat(diskPath)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("state disk must be a regular file")
	}
	lockFile, err := os.OpenFile(diskPath+".zapvm.lock", os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockExclusive(lockFile); err != nil {
		_ = lockFile.Close()
		return nil, fmt.Errorf("state disk is already attached: %w", err)
	}
	metadataPath := MetadataPath(diskPath)
	metadata, err := readMetadata(metadataPath)
	if err != nil {
		_ = unlock(lockFile)
		_ = lockFile.Close()
		return nil, err
	}
	if err := verifyFormatPath(diskPath, metadata.DiskFormat); err != nil {
		_ = unlock(lockFile)
		_ = lockFile.Close()
		return nil, err
	}
	// Normalize legacy companion metadata before it is written again. This
	// upgrades only the Host-side document; StateSchema still describes the
	// actual guest filesystem until a verified clean stop commits migration.
	metadata.SchemaVersion = CurrentMetadataSchema
	handle := &Handle{
		diskPath: diskPath, metadataPath: metadataPath, lockFile: lockFile,
		original: metadata, metadata: metadata, previousDirty: !metadata.CleanShutdown,
	}
	handle.metadata.CleanShutdown = false
	handle.metadata.Generation++
	handle.metadata.LastVMID = vmID
	handle.metadata.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := writeMetadata(metadataPath, handle.metadata); err != nil {
		_ = unlock(lockFile)
		_ = lockFile.Close()
		return nil, err
	}
	return handle, nil
}

func (h *Handle) PreviousDirty() bool { return h.previousDirty }

func (h *Handle) Metadata() Metadata {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.metadata
}

func (h *Handle) MarkClean(stateSchema int) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return errors.New("state handle is closed")
	}
	if stateSchema < h.metadata.StateSchema || stateSchema > CurrentStateSchema {
		return fmt.Errorf("invalid clean state schema transition %d -> %d", h.metadata.StateSchema, stateSchema)
	}
	h.metadata.CleanShutdown = true
	h.metadata.SchemaVersion = CurrentMetadataSchema
	h.metadata.StateSchema = stateSchema
	h.metadata.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := writeMetadata(h.metadataPath, h.metadata); err != nil {
		return err
	}
	return h.closeLocked()
}

func (h *Handle) Restore() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil
	}
	if err := writeMetadata(h.metadataPath, h.original); err != nil {
		return err
	}
	h.metadata = h.original
	return h.closeLocked()
}

func (h *Handle) CloseDirty() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil
	}
	return h.closeLocked()
}

func (h *Handle) closeLocked() error {
	h.closed = true
	unlockErr := unlock(h.lockFile)
	closeErr := h.lockFile.Close()
	return errors.Join(unlockErr, closeErr)
}

func readMetadata(path string) (Metadata, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Metadata{}, fmt.Errorf("read state metadata: %w", err)
	}
	var metadata Metadata
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&metadata); err != nil {
		return Metadata{}, fmt.Errorf("decode state metadata: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Metadata{}, errors.New("state metadata contains trailing data")
	}
	switch metadata.SchemaVersion {
	case legacyMetadataSchema:
		if metadata.StateSchema != 0 {
			return Metadata{}, errors.New("legacy state metadata must not declare state_schema")
		}
		metadata.StateSchema = 1
		metadata.SchemaVersion = CurrentMetadataSchema
	case CurrentMetadataSchema:
		if metadata.StateSchema < MinimumStateSchema || metadata.StateSchema > CurrentStateSchema {
			return Metadata{}, fmt.Errorf("unsupported guest state schema %d", metadata.StateSchema)
		}
	default:
		return Metadata{}, fmt.Errorf("unsupported state metadata schema %d", metadata.SchemaVersion)
	}
	if metadata.CreatedAt == "" || metadata.UpdatedAt == "" {
		return Metadata{}, errors.New("state metadata timestamps are required")
	}
	if _, err := time.Parse(time.RFC3339Nano, metadata.CreatedAt); err != nil {
		return Metadata{}, fmt.Errorf("invalid state creation time: %w", err)
	}
	if _, err := time.Parse(time.RFC3339Nano, metadata.UpdatedAt); err != nil {
		return Metadata{}, fmt.Errorf("invalid state update time: %w", err)
	}
	return metadata, nil
}

func verifyFormatPath(path, format string) error {
	extension := strings.ToLower(filepath.Ext(path))
	switch format {
	case "raw":
		if extension != ".raw" {
			return errors.New("raw state disk path must end in .raw")
		}
	case "vhdx":
		if extension != ".vhdx" {
			return errors.New("VHDX state disk path must end in .vhdx")
		}
	default:
		return fmt.Errorf("unsupported state disk format %q", format)
	}
	return nil
}

func writeMetadataExclusive(path string, metadata Metadata) error {
	data, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	return file.Close()
}

func writeMetadata(path string, metadata Metadata) error {
	data, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temporary, err := os.CreateTemp(filepath.Dir(path), ".zapvm-state-metadata-")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return replaceFile(temporaryPath, path)
}
