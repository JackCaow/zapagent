package cloudnode

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"zapvm/internal/remoteauth"
)

const maxConfigSize = 64 << 10

type Config struct {
	SchemaVersion       int    `json:"schema_version"`
	ControlURL          string `json:"control_url"`
	TrustDomain         string `json:"trust_domain"`
	ControlID           string `json:"control_id"`
	NodeID              string `json:"node_id"`
	ServerCA            string `json:"server_ca"`
	Certificate         string `json:"certificate"`
	PrivateKey          string `json:"private_key"`
	EnrollmentTokenFile string `json:"enrollment_token_file,omitempty"`
	IdentityDirectory   string `json:"identity_directory,omitempty"`
	RenewBeforeSeconds  uint32 `json:"renew_before_seconds,omitempty"`
	DaemonEndpoint      string `json:"daemon_endpoint,omitempty"`
	WorkspaceRoot       string `json:"workspace_root,omitempty"`
	PollMillis          uint32 `json:"poll_ms,omitempty"`
	MaxConcurrent       uint16 `json:"max_concurrent,omitempty"`
	RelayMode           string `json:"relay_mode,omitempty"`
}

func LoadConfig(path string) (Config, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return Config{}, err
	}
	data, err := remoteauth.ReadOwnerOnlyFile(absolute, maxConfigSize)
	if err != nil {
		return Config{}, fmt.Errorf("load cloud node config: %w", err)
	}
	var config Config
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return Config{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Config{}, errors.New("cloud node config contains trailing JSON")
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func (config *Config) Validate() error {
	if config.SchemaVersion != 1 {
		return errors.New("unsupported cloud node config schema")
	}
	parsed, err := url.Parse(config.ControlURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return errors.New("cloud node control_url must be an HTTPS origin")
	}
	config.ControlURL = strings.TrimSuffix(config.ControlURL, "/")
	nodeURI := "spiffe://" + config.TrustDomain + "/node/" + config.NodeID
	trust, node, err := remoteauth.ParseNodeIdentity(nodeURI)
	if err != nil || trust != config.TrustDomain || node != config.NodeID {
		return errors.New("cloud node identity is invalid")
	}
	controlURI, err := url.Parse(config.ControlURI())
	if err != nil || controlURI.Scheme != "spiffe" || controlURI.Host != config.TrustDomain ||
		controlURI.Path != "/control/"+config.ControlID || !validControlID(config.ControlID) {
		return errors.New("cloud node control identity is invalid")
	}
	for label, path := range map[string]string{"server_ca": config.ServerCA} {
		if !filepath.IsAbs(path) || len(path) > 32767 || strings.IndexByte(path, 0) >= 0 {
			return fmt.Errorf("cloud node %s must be an absolute non-NUL path", label)
		}
	}
	managedIdentity := config.EnrollmentTokenFile != "" || config.IdentityDirectory != ""
	if managedIdentity {
		if config.EnrollmentTokenFile == "" || config.IdentityDirectory == "" || config.Certificate != "" || config.PrivateKey != "" {
			return errors.New("cloud node managed identity requires enrollment_token_file and identity_directory without static certificate paths")
		}
		for label, path := range map[string]string{"enrollment_token_file": config.EnrollmentTokenFile, "identity_directory": config.IdentityDirectory} {
			if !filepath.IsAbs(path) || len(path) > 32767 || strings.IndexByte(path, 0) >= 0 {
				return fmt.Errorf("cloud node %s must be an absolute non-NUL path", label)
			}
		}
		if config.RenewBeforeSeconds == 0 {
			config.RenewBeforeSeconds = 1800
		}
		if config.RenewBeforeSeconds < 60 || config.RenewBeforeSeconds > 21600 {
			return errors.New("cloud node renew_before_seconds must be between 60 and 21600")
		}
	} else {
		for label, path := range map[string]string{"certificate": config.Certificate, "private_key": config.PrivateKey} {
			if !filepath.IsAbs(path) || len(path) > 32767 || strings.IndexByte(path, 0) >= 0 {
				return fmt.Errorf("cloud node %s must be an absolute non-NUL path", label)
			}
		}
		if config.RenewBeforeSeconds != 0 {
			return errors.New("cloud node renew_before_seconds requires managed identity")
		}
	}
	if config.DaemonEndpoint != "" && !filepath.IsAbs(config.DaemonEndpoint) &&
		!strings.HasPrefix(strings.ToLower(config.DaemonEndpoint), `\\.\pipe\zapvm-`) {
		return errors.New("cloud node daemon_endpoint must be absolute or a zapvm Windows named pipe")
	}
	if config.WorkspaceRoot != "" && (!filepath.IsAbs(config.WorkspaceRoot) || len(config.WorkspaceRoot) > 32767 || strings.IndexByte(config.WorkspaceRoot, 0) >= 0) {
		return errors.New("cloud node workspace_root must be an absolute non-NUL path")
	}
	config.WorkspaceRoot = filepath.Clean(config.WorkspaceRoot)
	if config.PollMillis == 0 {
		config.PollMillis = 250
	}
	if time.Duration(config.PollMillis)*time.Millisecond < 250*time.Millisecond || config.PollMillis > 60000 {
		return errors.New("cloud node poll_ms must be between 250 and 60000")
	}
	if config.MaxConcurrent == 0 {
		config.MaxConcurrent = 4
	}
	if config.MaxConcurrent > 64 {
		return errors.New("cloud node max_concurrent must be between 1 and 64")
	}
	if config.RelayMode == "" {
		config.RelayMode = "auto"
	}
	if config.RelayMode != "auto" && config.RelayMode != "required" && config.RelayMode != "off" {
		return errors.New("cloud node relay_mode must be auto, required, or off")
	}
	return nil
}

func (config Config) ManagedIdentity() bool { return config.EnrollmentTokenFile != "" }

func validControlID(value string) bool {
	if value == "" || len(value) > 128 || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for _, character := range value[1:] {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') &&
			character != '-' && character != '_' && character != '.' {
			return false
		}
	}
	return true
}

func (config Config) NodeURI() string {
	return "spiffe://" + config.TrustDomain + "/node/" + config.NodeID
}

func (config Config) ControlURI() string {
	return "spiffe://" + config.TrustDomain + "/control/" + config.ControlID
}
