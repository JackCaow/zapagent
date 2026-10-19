package daemonconfig

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"zapvm/internal/credential"
	"zapvm/internal/remoteauth"
)

const (
	SchemaVersion = 1
	maxConfigSize = 64 << 10
)

type CredentialBinding struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

// Config is the owner-only, non-secret daemon service authority. Credential
// values remain in separate owner-only files and are loaded by the daemon's
// broker; this document contains only their stable IDs and paths.
type Config struct {
	SchemaVersion        int                 `json:"schema_version"`
	Endpoint             string              `json:"endpoint,omitempty"`
	ImageRoot            string              `json:"image_root"`
	ImagePublicKey       string              `json:"image_public_key"`
	AgentRoot            string              `json:"agent_root,omitempty"`
	AgentPublicKey       string              `json:"agent_public_key,omitempty"`
	StateRoot            string              `json:"state_root"`
	MaxWorkers           int                 `json:"max_workers,omitempty"`
	MaxPerWorkspace      int                 `json:"max_per_workspace,omitempty"`
	IdleTimeoutMillis    uint64              `json:"idle_timeout_ms,omitempty"`
	StopTimeoutMillis    uint64              `json:"stop_timeout_ms,omitempty"`
	TaskRetentionMillis  uint64              `json:"task_retention_ms,omitempty"`
	TaskGCIntervalMillis uint64              `json:"task_gc_interval_ms,omitempty"`
	CPUCount             uint                `json:"cpus,omitempty"`
	MemoryMiB            uint64              `json:"memory_mib,omitempty"`
	Credentials          []CredentialBinding `json:"credentials,omitempty"`
}

func Load(path string) (Config, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return Config{}, err
	}
	data, err := remoteauth.ReadOwnerOnlyFile(absolute, maxConfigSize)
	if err != nil {
		return Config{}, fmt.Errorf("load daemon config: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var config Config
	if err := decoder.Decode(&config); err != nil {
		return Config{}, fmt.Errorf("decode daemon config: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Config{}, errors.New("daemon config contains trailing JSON")
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func (config *Config) Validate() error {
	if config.SchemaVersion != SchemaVersion {
		return errors.New("unsupported daemon config schema")
	}
	for label, path := range map[string]string{
		"image_root": config.ImageRoot, "image_public_key": config.ImagePublicKey, "state_root": config.StateRoot,
	} {
		if !validAbsolutePath(path) {
			return fmt.Errorf("daemon %s must be an absolute non-NUL path", label)
		}
	}
	if (config.AgentRoot == "") != (config.AgentPublicKey == "") {
		return errors.New("daemon agent_root and agent_public_key must be configured together")
	}
	if config.AgentRoot != "" && (!validAbsolutePath(config.AgentRoot) || !validAbsolutePath(config.AgentPublicKey)) {
		return errors.New("daemon Agent registry paths must be absolute non-NUL paths")
	}
	if config.Endpoint != "" && !validAbsolutePath(config.Endpoint) &&
		!strings.HasPrefix(strings.ToLower(config.Endpoint), `\\.\pipe\zapvm-`) {
		return errors.New("daemon endpoint must be absolute or a zapvm Windows named pipe")
	}
	if config.MaxWorkers == 0 {
		config.MaxWorkers = 4
	}
	if config.MaxPerWorkspace == 0 {
		config.MaxPerWorkspace = 2
	}
	if config.MaxWorkers < 1 || config.MaxWorkers > 64 || config.MaxPerWorkspace < 1 || config.MaxPerWorkspace > config.MaxWorkers {
		return errors.New("daemon worker limits are invalid")
	}
	if config.IdleTimeoutMillis == 0 {
		config.IdleTimeoutMillis = uint64(time.Hour / time.Millisecond)
	}
	if config.StopTimeoutMillis == 0 {
		config.StopTimeoutMillis = uint64((15 * time.Second) / time.Millisecond)
	}
	idle, ok := durationMillis(config.IdleTimeoutMillis)
	if !ok || idle < time.Second || idle > 24*time.Hour {
		return errors.New("daemon idle_timeout_ms must be between 1000 and 86400000")
	}
	stop, ok := durationMillis(config.StopTimeoutMillis)
	if !ok || stop < time.Second || stop > time.Minute {
		return errors.New("daemon stop_timeout_ms must be between 1000 and 60000")
	}
	if config.TaskRetentionMillis > 0 {
		retention, valid := durationMillis(config.TaskRetentionMillis)
		if !valid || retention < time.Minute || retention > 10*365*24*time.Hour {
			return errors.New("daemon task_retention_ms must be 0 or between 60000 and ten years")
		}
		if config.TaskGCIntervalMillis == 0 {
			config.TaskGCIntervalMillis = uint64(time.Hour / time.Millisecond)
		}
		gcInterval, valid := durationMillis(config.TaskGCIntervalMillis)
		if !valid || gcInterval < time.Minute || gcInterval > 24*time.Hour {
			return errors.New("daemon task_gc_interval_ms must be between 60000 and 86400000 when retention is enabled")
		}
	} else if config.TaskGCIntervalMillis != 0 {
		return errors.New("daemon task_gc_interval_ms requires task_retention_ms")
	}
	if config.CPUCount == 0 {
		config.CPUCount = 2
	}
	if config.MemoryMiB == 0 {
		config.MemoryMiB = 2048
	}
	if config.CPUCount > 256 || config.MemoryMiB < 256 || config.MemoryMiB > 1024*1024 {
		return errors.New("daemon CPU or memory limit is invalid")
	}
	if len(config.Credentials) > credential.MaxCredentials {
		return fmt.Errorf("daemon config contains more than %d credential bindings", credential.MaxCredentials)
	}
	seen := make(map[string]struct{}, len(config.Credentials))
	for _, binding := range config.Credentials {
		if !credential.ValidID(binding.ID) || !validAbsolutePath(binding.Path) {
			return errors.New("daemon credential binding must contain a valid ID and absolute path")
		}
		if _, duplicate := seen[binding.ID]; duplicate {
			return errors.New("daemon config contains a duplicate credential ID")
		}
		seen[binding.ID] = struct{}{}
	}
	return nil
}

func (config Config) ServeArguments() []string {
	arguments := make([]string, 0, 24+len(config.Credentials))
	if config.Endpoint != "" {
		arguments = append(arguments, "--endpoint", config.Endpoint)
	}
	arguments = append(arguments,
		"--image-root", config.ImageRoot,
		"--image-public-key", config.ImagePublicKey,
		"--state-root", config.StateRoot,
		"--max-workers", strconv.Itoa(config.MaxWorkers),
		"--max-per-workspace", strconv.Itoa(config.MaxPerWorkspace),
		"--idle-timeout", (time.Duration(config.IdleTimeoutMillis) * time.Millisecond).String(),
		"--stop-timeout", (time.Duration(config.StopTimeoutMillis) * time.Millisecond).String(),
		"--cpus", strconv.FormatUint(uint64(config.CPUCount), 10),
		"--memory-mib", strconv.FormatUint(config.MemoryMiB, 10),
	)
	if config.AgentRoot != "" {
		arguments = append(arguments, "--agent-root", config.AgentRoot, "--agent-public-key", config.AgentPublicKey)
	}
	if config.TaskRetentionMillis > 0 {
		arguments = append(arguments,
			"--task-retention", (time.Duration(config.TaskRetentionMillis) * time.Millisecond).String(),
			"--task-gc-interval", (time.Duration(config.TaskGCIntervalMillis) * time.Millisecond).String(),
		)
	}
	for _, binding := range config.Credentials {
		arguments = append(arguments, "--credential", binding.ID+"="+binding.Path)
	}
	return arguments
}

func validAbsolutePath(path string) bool {
	return filepath.IsAbs(path) && len(path) <= 32767 && strings.IndexByte(path, 0) < 0
}

func durationMillis(value uint64) (time.Duration, bool) {
	maximum := uint64((time.Duration(1<<63 - 1)) / time.Millisecond)
	if value > maximum {
		return 0, false
	}
	return time.Duration(value) * time.Millisecond, true
}
