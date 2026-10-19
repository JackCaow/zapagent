package cloudplane

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"zapvm/internal/artifactstore"
	"zapvm/internal/githubapp"
	"zapvm/internal/remoteauth"
)

const maxConfigSize = 256 << 10

type Config struct {
	SchemaVersion          int                      `json:"schema_version"`
	Listen                 string                   `json:"listen"`
	StateRoot              string                   `json:"state_root"`
	TrustDomain            string                   `json:"trust_domain"`
	ControlID              string                   `json:"control_id"`
	ClientCA               string                   `json:"client_ca"`
	Certificate            string                   `json:"certificate"`
	PrivateKey             string                   `json:"private_key"`
	HeartbeatTTLSeconds    uint32                   `json:"heartbeat_ttl_seconds,omitempty"`
	LeaseTTLSeconds        uint32                   `json:"lease_ttl_seconds,omitempty"`
	DispatchTimeoutSeconds uint32                   `json:"task_dispatch_timeout_seconds,omitempty"`
	ArtifactBytesPerTask   uint64                   `json:"artifact_bytes_per_task,omitempty"`
	ArtifactBytesPerScope  uint64                   `json:"artifact_bytes_per_scope,omitempty"`
	TaskRetentionSeconds   uint64                   `json:"task_retention_seconds,omitempty"`
	Administrators         []string                 `json:"administrators"`
	Nodes                  []NodeProvision          `json:"nodes"`
	ArtifactStore          *artifactstore.Config    `json:"artifact_store,omitempty"`
	GitHubApps             []githubapp.Config       `json:"github_apps,omitempty"`
	PostgreSQLMirror       *PostgreSQLMirrorConfig  `json:"postgresql_mirror,omitempty"`
	PostgreSQLPrimary      *PostgreSQLPrimaryConfig `json:"postgresql_primary,omitempty"`
	CredentialBroker       *CredentialBrokerConfig  `json:"credential_broker,omitempty"`
	NodeIdentity           *NodeIdentityConfig      `json:"node_identity,omitempty"`
}

type PostgreSQLMirrorConfig struct {
	DSNFile                      string `json:"dsn_file"`
	RetryIntervalSeconds         uint32 `json:"retry_interval_seconds,omitempty"`
	FlushTimeoutSeconds          uint32 `json:"flush_timeout_seconds,omitempty"`
	DevelopmentInsecureLocalhost bool   `json:"development_insecure_localhost,omitempty"`
}

type PostgreSQLPrimaryConfig struct {
	DSNFile                      string `json:"dsn_file"`
	Mode                         string `json:"mode,omitempty"`
	PlacementMode                string `json:"placement_mode,omitempty"`
	ComputerStartTimeoutSeconds  uint32 `json:"computer_start_timeout_seconds,omitempty"`
	OperationTimeoutSeconds      uint32 `json:"operation_timeout_seconds,omitempty"`
	DevelopmentInsecureLocalhost bool   `json:"development_insecure_localhost,omitempty"`
}

type CredentialBrokerConfig struct {
	DevelopmentStaticKeyFile string `json:"development_static_key_file"`
	CapabilityTTLSeconds     uint32 `json:"capability_ttl_seconds,omitempty"`
}

type NodeIdentityConfig struct {
	SigningCertificateFile string                    `json:"signing_certificate_file"`
	SigningPrivateKeyFile  string                    `json:"signing_private_key_file"`
	CertificateTTLSeconds  uint32                    `json:"certificate_ttl_seconds,omitempty"`
	RenewBeforeSeconds     uint32                    `json:"renew_before_seconds,omitempty"`
	EnrollmentTokens       []NodeEnrollmentProvision `json:"enrollment_tokens,omitempty"`
}

type NodeEnrollmentProvision struct {
	NodeID      string `json:"node_id"`
	TokenSHA256 string `json:"token_sha256"`
	ExpiresAt   string `json:"expires_at"`
}

func LoadConfig(path string) (Config, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return Config{}, err
	}
	data, err := remoteauth.ReadOwnerOnlyFile(absolute, maxConfigSize)
	if err != nil {
		return Config{}, fmt.Errorf("load cloud control-plane config: %w", err)
	}
	var config Config
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return Config{}, fmt.Errorf("decode cloud control-plane config: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Config{}, errors.New("cloud control-plane config contains trailing JSON")
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func (config *Config) Validate() error {
	if config.SchemaVersion != SchemaVersion {
		return errors.New("unsupported cloud control-plane config schema")
	}
	if err := validateListen(config.Listen); err != nil {
		return err
	}
	for label, path := range map[string]string{
		"state_root": config.StateRoot, "client_ca": config.ClientCA, "certificate": config.Certificate, "private_key": config.PrivateKey,
	} {
		if !filepath.IsAbs(path) || len(path) > 32767 || strings.IndexByte(path, 0) >= 0 {
			return fmt.Errorf("cloud control-plane %s must be an absolute non-NUL path", label)
		}
	}
	if !validTrustDomain(config.TrustDomain) || !validName(config.ControlID, 128) {
		return errors.New("cloud control-plane trust domain or control ID is invalid")
	}
	if config.HeartbeatTTLSeconds == 0 {
		config.HeartbeatTTLSeconds = uint32(defaultHeartbeatTTL / time.Second)
	}
	if config.LeaseTTLSeconds == 0 {
		config.LeaseTTLSeconds = uint32(defaultLeaseTTL / time.Second)
	}
	if config.DispatchTimeoutSeconds == 0 {
		config.DispatchTimeoutSeconds = uint32(defaultDispatchTimeout / time.Second)
	}
	if config.ArtifactBytesPerTask == 0 {
		config.ArtifactBytesPerTask = defaultArtifactBytesPerTask
	}
	if config.ArtifactBytesPerScope == 0 {
		config.ArtifactBytesPerScope = defaultArtifactBytesPerScope
	}
	heartbeat := time.Duration(config.HeartbeatTTLSeconds) * time.Second
	lease := time.Duration(config.LeaseTTLSeconds) * time.Second
	dispatchTimeout := time.Duration(config.DispatchTimeoutSeconds) * time.Second
	if heartbeat < 5*time.Second || heartbeat > 10*time.Minute || lease < 10*time.Second || lease > time.Hour {
		return errors.New("cloud control-plane heartbeat or lease TTL is outside limits")
	}
	if dispatchTimeout < 30*time.Second || dispatchTimeout > time.Hour {
		return errors.New("cloud control-plane Task dispatch timeout must be between 30 seconds and 1 hour")
	}
	if config.ArtifactBytesPerTask < maxArtifactSize || config.ArtifactBytesPerTask > uint64(100<<30) ||
		config.ArtifactBytesPerScope < config.ArtifactBytesPerTask || config.ArtifactBytesPerScope > uint64(10<<40) {
		return errors.New("cloud control-plane Artifact byte quotas are invalid")
	}
	if config.TaskRetentionSeconds != 0 && (config.TaskRetentionSeconds < uint64(time.Hour/time.Second) ||
		config.TaskRetentionSeconds > uint64((365*24*time.Hour)/time.Second)) {
		return errors.New("cloud control-plane Task retention must be zero or between 1 hour and 365 days")
	}
	if len(config.Administrators) < 1 || len(config.Administrators) > 64 {
		return errors.New("cloud control-plane requires 1-64 administrators")
	}
	seenAdministrators := make(map[string]struct{}, len(config.Administrators))
	for _, principal := range config.Administrators {
		identity, err := remoteauth.ParseClientIdentity(principal, config.TrustDomain)
		if err != nil || identity.URI != principal {
			return errors.New("cloud control-plane administrator must be a canonical client SPIFFE URI")
		}
		if _, duplicate := seenAdministrators[principal]; duplicate {
			return errors.New("cloud control-plane contains duplicate administrators")
		}
		seenAdministrators[principal] = struct{}{}
	}
	seenNodes := make(map[string]struct{}, len(config.Nodes))
	if len(config.Nodes) < 1 || len(config.Nodes) > 4096 {
		return errors.New("cloud control-plane requires 1-4096 provisioned nodes")
	}
	for _, provision := range config.Nodes {
		if err := provision.Validate(); err != nil {
			return fmt.Errorf("cloud control-plane node %q: %w", provision.ID, err)
		}
		if _, duplicate := seenNodes[provision.ID]; duplicate {
			return errors.New("cloud control-plane contains duplicate nodes")
		}
		seenNodes[provision.ID] = struct{}{}
	}
	if err := ValidateComputerAgentPlacements(config.Nodes); err != nil {
		return fmt.Errorf("cloud control-plane: %w", err)
	}
	if len(config.GitHubApps) > 64 {
		return errors.New("cloud control-plane supports at most 64 GitHub App provisions")
	}
	seenGitHubApps := make(map[string]struct{}, len(config.GitHubApps))
	for index := range config.GitHubApps {
		provision := &config.GitHubApps[index]
		if err := provision.Validate(); err != nil {
			return fmt.Errorf("cloud control-plane GitHub App %q: %w", provision.ID, err)
		}
		key := provision.TenantID + "\x00" + provision.ProjectID + "\x00" + provision.ID
		if _, duplicate := seenGitHubApps[key]; duplicate {
			return errors.New("cloud control-plane contains duplicate GitHub App provisions")
		}
		seenGitHubApps[key] = struct{}{}
		if !config.hasNodeScope(provision.TenantID, provision.ProjectID) {
			return fmt.Errorf("cloud control-plane GitHub App %q has no authorized Node scope", provision.ID)
		}
	}
	if config.ArtifactStore != nil {
		if err := config.ArtifactStore.Validate(); err != nil {
			return fmt.Errorf("cloud control-plane Artifact store: %w", err)
		}
	}
	if config.PostgreSQLMirror != nil {
		mirror := config.PostgreSQLMirror
		if !filepath.IsAbs(mirror.DSNFile) || len(mirror.DSNFile) > 32767 || strings.IndexByte(mirror.DSNFile, 0) >= 0 {
			return errors.New("cloud control-plane PostgreSQL mirror DSN file must be an absolute non-NUL path")
		}
		if mirror.RetryIntervalSeconds == 0 {
			mirror.RetryIntervalSeconds = 5
		}
		if mirror.FlushTimeoutSeconds == 0 {
			mirror.FlushTimeoutSeconds = 120
		}
		if mirror.RetryIntervalSeconds < 1 || mirror.RetryIntervalSeconds > 300 || mirror.FlushTimeoutSeconds < 5 || mirror.FlushTimeoutSeconds > 600 {
			return errors.New("cloud control-plane PostgreSQL mirror retry or flush timeout is outside limits")
		}
	}
	if config.PostgreSQLPrimary != nil {
		if config.PostgreSQLMirror != nil {
			return errors.New("cloud control-plane PostgreSQL mirror and primary are mutually exclusive")
		}
		primary := config.PostgreSQLPrimary
		if primary.Mode == "" {
			primary.Mode = "snapshot"
		}
		if primary.Mode != "snapshot" && primary.Mode != "distributed" {
			return errors.New("cloud control-plane PostgreSQL primary mode must be snapshot or distributed")
		}
		if primary.PlacementMode == "" {
			primary.PlacementMode = PlacementModeStatic
		}
		if primary.PlacementMode != PlacementModeStatic && primary.PlacementMode != PlacementModeDynamic {
			return errors.New("cloud control-plane PostgreSQL placement mode must be static or dynamic")
		}
		if primary.Mode != "distributed" && primary.PlacementMode != PlacementModeStatic {
			return errors.New("cloud control-plane dynamic placement requires distributed PostgreSQL")
		}
		if primary.ComputerStartTimeoutSeconds == 0 {
			primary.ComputerStartTimeoutSeconds = 300
			if primary.PlacementMode == PlacementModeDynamic && config.DispatchTimeoutSeconds < primary.ComputerStartTimeoutSeconds {
				primary.ComputerStartTimeoutSeconds = config.DispatchTimeoutSeconds
			}
		}
		if primary.ComputerStartTimeoutSeconds < 30 || primary.ComputerStartTimeoutSeconds > 1800 {
			return errors.New("cloud control-plane Computer start timeout must be between 30 seconds and 30 minutes")
		}
		if primary.PlacementMode == PlacementModeDynamic && primary.ComputerStartTimeoutSeconds > config.DispatchTimeoutSeconds {
			return errors.New("cloud control-plane Computer start timeout cannot exceed Task dispatch timeout")
		}
		if !filepath.IsAbs(primary.DSNFile) || len(primary.DSNFile) > 32767 || strings.IndexByte(primary.DSNFile, 0) >= 0 {
			return errors.New("cloud control-plane PostgreSQL primary DSN file must be an absolute non-NUL path")
		}
		if primary.OperationTimeoutSeconds == 0 {
			primary.OperationTimeoutSeconds = 120
		}
		if primary.OperationTimeoutSeconds < 5 || primary.OperationTimeoutSeconds > 600 {
			return errors.New("cloud control-plane PostgreSQL primary operation timeout is outside limits")
		}
	}
	if config.CredentialBroker != nil {
		broker := config.CredentialBroker
		if config.PostgreSQLPrimary == nil || config.PostgreSQLPrimary.Mode != "distributed" {
			return errors.New("cloud control-plane Credential broker requires distributed PostgreSQL")
		}
		if !filepath.IsAbs(broker.DevelopmentStaticKeyFile) || len(broker.DevelopmentStaticKeyFile) > 32767 || strings.IndexByte(broker.DevelopmentStaticKeyFile, 0) >= 0 {
			return errors.New("cloud control-plane development Credential wrapper key must be an absolute non-NUL path")
		}
		if broker.CapabilityTTLSeconds == 0 {
			broker.CapabilityTTLSeconds = 300
		}
		if broker.CapabilityTTLSeconds < 10 || broker.CapabilityTTLSeconds > 900 {
			return errors.New("cloud control-plane Credential capability TTL must be between 10 and 900 seconds")
		}
	}
	if config.NodeIdentity != nil {
		identity := config.NodeIdentity
		if config.PostgreSQLPrimary == nil || config.PostgreSQLPrimary.Mode != "distributed" {
			return errors.New("cloud control-plane Node identity issuer requires distributed PostgreSQL")
		}
		for label, path := range map[string]string{"signing_certificate_file": identity.SigningCertificateFile, "signing_private_key_file": identity.SigningPrivateKeyFile} {
			if !filepath.IsAbs(path) || len(path) > 32767 || strings.IndexByte(path, 0) >= 0 {
				return fmt.Errorf("cloud control-plane Node identity %s must be an absolute non-NUL path", label)
			}
		}
		if identity.CertificateTTLSeconds == 0 {
			identity.CertificateTTLSeconds = uint32((6 * time.Hour) / time.Second)
		}
		if identity.RenewBeforeSeconds == 0 {
			identity.RenewBeforeSeconds = uint32((30 * time.Minute) / time.Second)
		}
		if identity.CertificateTTLSeconds < 300 || identity.CertificateTTLSeconds > 86400 || identity.RenewBeforeSeconds < 60 || identity.RenewBeforeSeconds*2 >= identity.CertificateTTLSeconds {
			return errors.New("cloud control-plane Node identity certificate or renewal TTL is outside limits")
		}
		knownNodes := make(map[string]struct{}, len(config.Nodes))
		for _, node := range config.Nodes {
			knownNodes[node.ID] = struct{}{}
		}
		seenTokens := make(map[string]struct{}, len(identity.EnrollmentTokens))
		for _, token := range identity.EnrollmentTokens {
			if _, ok := knownNodes[token.NodeID]; !ok || !validSHA256Hex(token.TokenSHA256) {
				return errors.New("cloud control-plane Node enrollment provision is invalid")
			}
			if _, duplicate := seenTokens[token.NodeID]; duplicate {
				return errors.New("cloud control-plane contains duplicate Node enrollment provisions")
			}
			seenTokens[token.NodeID] = struct{}{}
			expiresAt, err := time.Parse(time.RFC3339, token.ExpiresAt)
			if err != nil || token.ExpiresAt != expiresAt.UTC().Format(time.RFC3339) {
				return errors.New("cloud control-plane Node enrollment expiry must be canonical UTC RFC3339")
			}
		}
	}
	return nil
}

func validSHA256Hex(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func (config Config) hasNodeScope(tenantID, projectID string) bool {
	for _, node := range config.Nodes {
		for _, scope := range node.Scopes {
			if scope.TenantID == tenantID && scope.ProjectID == projectID {
				return true
			}
		}
	}
	return false
}

func (config Config) ControlURI() string {
	return "spiffe://" + config.TrustDomain + "/control/" + config.ControlID
}

func (config Config) StoreOptions() Options {
	return Options{
		HeartbeatTTL:          time.Duration(config.HeartbeatTTLSeconds) * time.Second,
		LeaseTTL:              time.Duration(config.LeaseTTLSeconds) * time.Second,
		DispatchTimeout:       time.Duration(config.DispatchTimeoutSeconds) * time.Second,
		ArtifactBytesPerTask:  config.ArtifactBytesPerTask,
		ArtifactBytesPerScope: config.ArtifactBytesPerScope,
		TaskRetention:         time.Duration(config.TaskRetentionSeconds) * time.Second,
	}
}

func validateListen(address string) error {
	if address == "" || len(address) > 512 || strings.IndexByte(address, 0) >= 0 {
		return errors.New("cloud control-plane listen address is invalid")
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("cloud control-plane listen must be host:port: %w", err)
	}
	parsed, err := strconv.ParseUint(port, 10, 16)
	if err != nil || parsed == 0 {
		return errors.New("cloud control-plane listen port must be between 1 and 65535")
	}
	return nil
}

func validTrustDomain(value string) bool {
	parsed, err := url.Parse("spiffe://" + value + "/node/check")
	return err == nil && parsed.Host == value && parsed.Scheme == "spiffe" && !strings.ContainsAny(value, "/?#@")
}
