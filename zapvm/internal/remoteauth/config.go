package remoteauth

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	GatewayConfigSchemaVersion = 1
	maxGatewayConfigSize       = 64 << 10
	GatewayModeServe           = "serve"
	GatewayModeTunnel          = "tunnel"
)

type GatewayConfig struct {
	SchemaVersion int                  `json:"schema_version"`
	Mode          string               `json:"mode"`
	Serve         *GatewayServeConfig  `json:"serve,omitempty"`
	Tunnel        *GatewayTunnelConfig `json:"tunnel,omitempty"`
}

type GatewayServeConfig struct {
	Listen         string `json:"listen"`
	DaemonEndpoint string `json:"daemon_endpoint,omitempty"`
	ClientCA       string `json:"client_ca"`
	Certificate    string `json:"certificate"`
	PrivateKey     string `json:"private_key"`
	Policy         string `json:"policy"`
	AuditLog       string `json:"audit_log"`
}

type GatewayTunnelConfig struct {
	Endpoint    string `json:"endpoint,omitempty"`
	Remote      string `json:"remote"`
	ServerCA    string `json:"server_ca"`
	Certificate string `json:"certificate"`
	PrivateKey  string `json:"private_key"`
	NodeURI     string `json:"node_uri"`
}

func LoadGatewayConfig(path string) (GatewayConfig, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return GatewayConfig{}, err
	}
	data, err := readSecureRegularFile(absolute, maxGatewayConfigSize, true)
	if err != nil {
		return GatewayConfig{}, fmt.Errorf("load gateway config: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var config GatewayConfig
	if err := decoder.Decode(&config); err != nil {
		return GatewayConfig{}, fmt.Errorf("decode gateway config: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return GatewayConfig{}, errors.New("gateway config contains trailing JSON")
	}
	if err := config.Validate(); err != nil {
		return GatewayConfig{}, err
	}
	return config, nil
}

func (config GatewayConfig) Validate() error {
	if config.SchemaVersion != GatewayConfigSchemaVersion {
		return fmt.Errorf("unsupported gateway config schema %d", config.SchemaVersion)
	}
	switch config.Mode {
	case GatewayModeServe:
		if config.Serve == nil || config.Tunnel != nil {
			return errors.New("serve gateway config requires only the serve object")
		}
		return config.Serve.Validate()
	case GatewayModeTunnel:
		if config.Tunnel == nil || config.Serve != nil {
			return errors.New("tunnel gateway config requires only the tunnel object")
		}
		return config.Tunnel.Validate()
	default:
		return errors.New("gateway config mode must be serve or tunnel")
	}
}

func (config GatewayServeConfig) Validate() error {
	if err := validateTCPAddress(config.Listen, "gateway listen", false); err != nil {
		return err
	}
	paths := []struct{ label, path string }{
		{"client_ca", config.ClientCA}, {"certificate", config.Certificate}, {"private_key", config.PrivateKey},
		{"policy", config.Policy}, {"audit_log", config.AuditLog},
	}
	for _, item := range paths {
		if err := validateAbsoluteConfigPath(item.path, item.label); err != nil {
			return err
		}
	}
	return validateOptionalEndpoint(config.DaemonEndpoint, "daemon_endpoint")
}

func (config GatewayTunnelConfig) Validate() error {
	if err := validateTCPAddress(config.Remote, "gateway remote", true); err != nil {
		return err
	}
	paths := []struct{ label, path string }{
		{"server_ca", config.ServerCA}, {"certificate", config.Certificate}, {"private_key", config.PrivateKey},
	}
	for _, item := range paths {
		if err := validateAbsoluteConfigPath(item.path, item.label); err != nil {
			return err
		}
	}
	if _, _, err := ParseNodeIdentity(config.NodeURI); err != nil {
		return fmt.Errorf("gateway node_uri: %w", err)
	}
	return validateOptionalEndpoint(config.Endpoint, "endpoint")
}

func validateTCPAddress(address, label string, requireHost bool) error {
	if address == "" || len(address) > 512 || strings.IndexByte(address, 0) >= 0 {
		return fmt.Errorf("%s must be a bounded host:port address", label)
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("%s must be a host:port address: %w", label, err)
	}
	if requireHost && strings.TrimSpace(host) == "" {
		return fmt.Errorf("%s host must not be empty", label)
	}
	parsedPort, err := strconv.ParseUint(port, 10, 16)
	if err != nil || parsedPort == 0 {
		return fmt.Errorf("%s port must be between 1 and 65535", label)
	}
	return nil
}

func validateAbsoluteConfigPath(path, label string) error {
	if !filepath.IsAbs(path) || len(path) > 32767 || strings.IndexByte(path, 0) >= 0 {
		return fmt.Errorf("gateway %s must be an absolute non-NUL path", label)
	}
	return nil
}

func validateOptionalEndpoint(endpoint, label string) error {
	if endpoint == "" {
		return nil
	}
	if len(endpoint) > 32767 || strings.IndexByte(endpoint, 0) >= 0 {
		return fmt.Errorf("gateway %s must be bounded and non-NUL", label)
	}
	if filepath.IsAbs(endpoint) || strings.HasPrefix(strings.ToLower(endpoint), `\\.\pipe\zapvm-`) {
		return nil
	}
	return fmt.Errorf("gateway %s must be an absolute path or zapvm Windows named pipe", label)
}
