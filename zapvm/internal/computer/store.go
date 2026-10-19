package computer

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"zapvm/internal/platform"
)

const (
	CurrentSchema = 1
	MaxRecordSize = 64 << 10
)

var (
	ErrExists   = errors.New("Computer already exists")
	ErrNotFound = errors.New("Computer does not exist")
)

// Record is the durable, owner-only definition of one Agent Computer. Runtime
// state is deliberately not persisted here: it is derived from the VM pool so
// a daemon crash cannot leave a false "running" status behind.
type Record struct {
	SchemaVersion     int                  `json:"schema_version"`
	ID                string               `json:"id"`
	Agent             string               `json:"agent,omitempty"`
	Workspace         string               `json:"workspace"`
	WorkspaceReadOnly bool                 `json:"workspace_read_only,omitempty"`
	Network           platform.NetworkMode `json:"network"`
	AllowedDomains    []string             `json:"allowed_domains,omitempty"`
	AllowedPorts      []uint16             `json:"allowed_ports,omitempty"`
	CPUCount          uint                 `json:"cpus"`
	MemoryMiB         uint64               `json:"memory_mib"`
	CreatedAt         string               `json:"created_at"`
}

func (record Record) Validate() error {
	if record.SchemaVersion != CurrentSchema {
		return errors.New("unsupported Computer record schema")
	}
	if !ValidID(record.ID) {
		return errors.New("Computer ID must contain 1-128 ASCII token characters")
	}
	if record.Agent != "" {
		id, version, ok := strings.Cut(record.Agent, "@")
		if !ok || strings.Contains(version, "@") || !ValidID(id) {
			return errors.New("Computer Agent must be a valid id@version reference")
		}
		if err := validateVersion(version); err != nil {
			return fmt.Errorf("Computer Agent version: %w", err)
		}
	}
	if record.Workspace == "" || !filepath.IsAbs(record.Workspace) || len(record.Workspace) > 32767 || !utf8.ValidString(record.Workspace) || strings.IndexByte(record.Workspace, 0) >= 0 {
		return errors.New("Computer workspace must be a bounded absolute path")
	}
	if record.CPUCount < 1 || record.CPUCount > 256 || record.MemoryMiB < 256 || record.MemoryMiB > 1024*1024 {
		return errors.New("Computer resources are outside supported limits")
	}
	switch record.Network {
	case platform.NetworkOff, platform.NetworkUnrestricted:
		if len(record.AllowedDomains) != 0 || len(record.AllowedPorts) != 0 {
			return errors.New("Computer network allow rules require restricted mode")
		}
	case platform.NetworkRestricted:
		if len(record.AllowedDomains) == 0 {
			return errors.New("restricted Computer requires allowed domains")
		}
	default:
		return errors.New("Computer contains an invalid network mode")
	}
	if len(record.AllowedDomains) > 128 || len(record.AllowedPorts) > 64 {
		return errors.New("Computer contains too many network allow rules")
	}
	for _, domain := range record.AllowedDomains {
		if domain == "" || len(domain) > 253 || !utf8.ValidString(domain) || strings.IndexByte(domain, 0) >= 0 {
			return errors.New("Computer contains an invalid allowed domain")
		}
	}
	for _, port := range record.AllowedPorts {
		if port == 0 {
			return errors.New("Computer contains an invalid allowed port")
		}
	}
	if record.CreatedAt == "" {
		return errors.New("Computer creation timestamp is required")
	}
	return nil
}

func ValidID(value string) bool {
	if value == "" || len(value) > 128 || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

func validateVersion(value string) error {
	if value == "" || value == "." || value == ".." || len(value) > 128 || !utf8.ValidString(value) || strings.IndexByte(value, 0) >= 0 {
		return errors.New("invalid version")
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || strings.ContainsRune("._+-", character) {
			continue
		}
		return errors.New("invalid version")
	}
	return nil
}

type Store struct {
	mu   sync.Mutex
	root string
	now  func() time.Time
}

func Open(root string) (*Store, error) {
	if root == "" || !filepath.IsAbs(root) {
		return nil, errors.New("Computer store root must be absolute")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	if err := protectStoreRoot(root); err != nil {
		return nil, err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("Computer store root must be a real directory")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		return nil, errors.New("Computer store root must have mode 0700")
	}
	return &Store{root: root, now: time.Now}, nil
}

func (store *Store) Create(record Record) (Record, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if record.SchemaVersion == 0 {
		record.SchemaVersion = CurrentSchema
	}
	if record.CreatedAt == "" {
		record.CreatedAt = store.now().UTC().Format(time.RFC3339Nano)
	}
	if err := record.Validate(); err != nil {
		return Record{}, err
	}
	path := store.path(record.ID)
	if _, err := os.Lstat(path); err == nil {
		return Record{}, ErrExists
	} else if !errors.Is(err, os.ErrNotExist) {
		return Record{}, err
	}
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return Record{}, err
	}
	data = append(data, '\n')
	if len(data) > MaxRecordSize {
		return Record{}, errors.New("Computer record is too large")
	}
	temporary, err := os.CreateTemp(store.root, ".computer-*.tmp")
	if err != nil {
		return Record{}, err
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
		return Record{}, err
	}
	if _, err := temporary.Write(data); err != nil {
		return Record{}, err
	}
	if err := temporary.Sync(); err != nil {
		return Record{}, err
	}
	if err := temporary.Close(); err != nil {
		return Record{}, err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return Record{}, err
	}
	committed = true
	return cloneRecord(record), nil
}

func (store *Store) Get(id string) (Record, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if !ValidID(id) {
		return Record{}, errors.New("invalid Computer ID")
	}
	return store.read(store.path(id))
}

func (store *Store) List() ([]Record, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	entries, err := os.ReadDir(store.root)
	if err != nil {
		return nil, err
	}
	records := make([]Record, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".computer-") && strings.HasSuffix(name, ".tmp") {
			continue
		}
		if entry.IsDir() || filepath.Ext(name) != ".json" {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		if !ValidID(id) {
			return nil, fmt.Errorf("Computer store contains invalid entry %q", name)
		}
		record, err := store.read(filepath.Join(store.root, name))
		if err != nil {
			return nil, fmt.Errorf("read Computer %q: %w", id, err)
		}
		if record.ID != id {
			return nil, fmt.Errorf("Computer file %q contains mismatched ID", name)
		}
		records = append(records, record)
	}
	sort.Slice(records, func(left, right int) bool { return records[left].ID < records[right].ID })
	return records, nil
}

func (store *Store) path(id string) string { return filepath.Join(store.root, id+".json") }

func (store *Store) read(path string) (Record, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return Record{}, ErrNotFound
	}
	if err != nil {
		return Record{}, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > MaxRecordSize {
		return Record{}, errors.New("Computer record must be a bounded regular file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		return Record{}, errors.New("Computer record must have mode 0600")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Record{}, err
	}
	var record Record
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&record); err != nil {
		return Record{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Record{}, errors.New("Computer record contains trailing JSON")
	}
	if err := record.Validate(); err != nil {
		return Record{}, err
	}
	return cloneRecord(record), nil
}

func cloneRecord(record Record) Record {
	record.AllowedDomains = append([]string(nil), record.AllowedDomains...)
	record.AllowedPorts = append([]uint16(nil), record.AllowedPorts...)
	return record
}
