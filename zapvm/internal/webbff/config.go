package webbff

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"zapvm/internal/remoteauth"
)

const (
	ConfigSchemaVersion = 1
	maxConfigSize       = 256 << 10
	maxSigningKeySize   = 1024
)

type Config struct {
	SchemaVersion   int             `json:"schema_version"`
	Listen          string          `json:"listen"`
	PublicOrigin    string          `json:"public_origin"`
	DevelopmentHTTP bool            `json:"development_http,omitempty"`
	CookieName      string          `json:"cookie_name,omitempty"`
	SigningKey      string          `json:"signing_key_file"`
	SessionSeconds  uint32          `json:"session_seconds,omitempty"`
	OIDC            *OIDCConfig     `json:"oidc,omitempty"`
	Projects        []ProjectConfig `json:"projects"`
}

// OIDCConfig binds one enterprise identity provider to one Workspace. Email
// domain allowlisting is mandatory so a valid identity at a shared provider
// cannot silently acquire tenant membership.
type OIDCConfig struct {
	Issuer              string   `json:"issuer"`
	ClientID            string   `json:"client_id"`
	ClientSecretFile    string   `json:"client_secret_file"`
	ProjectID           string   `json:"project_id"`
	DisplayName         string   `json:"display_name,omitempty"`
	AllowedEmailDomains []string `json:"allowed_email_domains"`
}

type ProjectConfig struct {
	ID              string         `json:"id"`
	UserID          string         `json:"user_id"`
	DisplayName     string         `json:"display_name,omitempty"`
	AccessTokenHash string         `json:"access_token_sha256"`
	ControlURL      string         `json:"control_url"`
	ServerCA        string         `json:"server_ca"`
	Certificate     string         `json:"certificate"`
	PrivateKey      string         `json:"private_key"`
	ClientURI       string         `json:"client_uri"`
	ControlURI      string         `json:"control_uri"`
	RuntimeProfile  RuntimeProfile `json:"runtime_profile,omitempty"`
}

type RuntimeProfile struct {
	ID                 string `json:"id"`
	DisplayName        string `json:"display_name,omitempty"`
	ProviderBaseURL    string `json:"provider_base_url"`
	Model              string `json:"model"`
	ModelCredentialID  string `json:"model_credential_id"`
	SearchCredentialID string `json:"search_credential_id,omitempty"`
	MaxTurns           uint16 `json:"max_turns,omitempty"`
	TimeoutSeconds     uint32 `json:"timeout_seconds,omitempty"`
}

type ProjectRuntime struct {
	ID             string
	UserID         string
	DisplayName    string
	RuntimeProfile RuntimeProfile
	TokenHash      [sha256.Size]byte
	ControlURL     *url.URL
	Transport      http.RoundTripper
}

func LoadConfig(path string) (Config, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return Config{}, err
	}
	data, err := remoteauth.ReadOwnerOnlyFile(absolute, maxConfigSize)
	if err != nil {
		return Config{}, fmt.Errorf("load Web BFF config: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var config Config
	if err := decoder.Decode(&config); err != nil {
		return Config{}, fmt.Errorf("decode Web BFF config: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Config{}, errors.New("Web BFF config contains trailing JSON")
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func (config *Config) Validate() error {
	if config.SchemaVersion != ConfigSchemaVersion {
		return errors.New("unsupported Web BFF config schema")
	}
	if err := validateListen(config.Listen); err != nil {
		return err
	}
	origin, err := url.Parse(config.PublicOrigin)
	if err != nil || origin.Host == "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || (origin.Path != "" && origin.Path != "/") {
		return errors.New("Web BFF public_origin must be an origin")
	}
	if origin.Scheme != "https" {
		host := origin.Hostname()
		if !config.DevelopmentHTTP || origin.Scheme != "http" || (host != "127.0.0.1" && host != "localhost" && host != "::1") {
			return errors.New("Web BFF public_origin must use HTTPS outside loopback development")
		}
	}
	config.PublicOrigin = strings.TrimSuffix(config.PublicOrigin, "/")
	if config.CookieName == "" {
		config.CookieName = "__Host-zapvm_session"
		if origin.Scheme == "http" {
			config.CookieName = "zapvm_session"
		}
	}
	if !validCookieName(config.CookieName) || (!config.DevelopmentHTTP && !strings.HasPrefix(config.CookieName, "__Host-")) {
		return errors.New("Web BFF cookie_name is invalid")
	}
	if origin.Scheme == "http" && strings.HasPrefix(config.CookieName, "__Host-") {
		return errors.New("loopback HTTP cannot use a Secure __Host- cookie name")
	}
	if !filepath.IsAbs(config.SigningKey) {
		return errors.New("Web BFF signing_key_file must be absolute")
	}
	if config.SessionSeconds == 0 {
		config.SessionSeconds = uint32((12 * time.Hour) / time.Second)
	}
	if config.SessionSeconds < 300 || config.SessionSeconds > uint32((7*24*time.Hour)/time.Second) {
		return errors.New("Web BFF session_seconds must be between 300 and 604800")
	}
	if len(config.Projects) == 0 || len(config.Projects) > 1000 {
		return errors.New("Web BFF requires between 1 and 1000 projects")
	}
	seenIDs := make(map[string]struct{}, len(config.Projects))
	seenHashes := make(map[string]struct{}, len(config.Projects))
	for index := range config.Projects {
		project := &config.Projects[index]
		if err := project.Validate(); err != nil {
			return fmt.Errorf("Web BFF project %q: %w", project.ID, err)
		}
		if _, exists := seenIDs[project.ID]; exists {
			return errors.New("Web BFF project IDs must be unique")
		}
		if _, exists := seenHashes[project.AccessTokenHash]; exists {
			return errors.New("Web BFF access token hashes must be unique")
		}
		seenIDs[project.ID] = struct{}{}
		seenHashes[project.AccessTokenHash] = struct{}{}
	}
	if config.OIDC != nil {
		if err := config.OIDC.Validate(); err != nil {
			return fmt.Errorf("Web BFF OIDC: %w", err)
		}
		if _, exists := seenIDs[config.OIDC.ProjectID]; !exists {
			return errors.New("Web BFF OIDC project_id does not match a configured project")
		}
	}
	return nil
}

func (config *OIDCConfig) Validate() error {
	issuer, err := url.Parse(config.Issuer)
	if err != nil || issuer.Scheme != "https" || issuer.Host == "" || issuer.User != nil || issuer.RawQuery != "" || issuer.Fragment != "" {
		return errors.New("issuer must be an HTTPS URL without credentials, query, or fragment")
	}
	config.Issuer = strings.TrimSuffix(config.Issuer, "/")
	if config.ClientID == "" || len(config.ClientID) > 512 || strings.IndexByte(config.ClientID, 0) >= 0 || !filepath.IsAbs(config.ClientSecretFile) || len(config.ClientSecretFile) > 32767 || strings.IndexByte(config.ClientSecretFile, 0) >= 0 {
		return errors.New("client_id or client_secret_file is invalid")
	}
	if !canonicalName(config.ProjectID) || len(config.DisplayName) > 128 || strings.IndexByte(config.DisplayName, 0) >= 0 {
		return errors.New("project_id or display_name is invalid")
	}
	if config.DisplayName == "" {
		config.DisplayName = "企业账号"
	}
	if len(config.AllowedEmailDomains) == 0 || len(config.AllowedEmailDomains) > 100 {
		return errors.New("allowed_email_domains must contain 1-100 domains")
	}
	seen := make(map[string]struct{}, len(config.AllowedEmailDomains))
	for index, domain := range config.AllowedEmailDomains {
		domain = strings.ToLower(strings.TrimSpace(domain))
		if !validEmailDomain(domain) {
			return errors.New("allowed_email_domains contains an invalid domain")
		}
		if _, exists := seen[domain]; exists {
			return errors.New("allowed_email_domains contains a duplicate")
		}
		seen[domain] = struct{}{}
		config.AllowedEmailDomains[index] = domain
	}
	return nil
}

func validEmailDomain(domain string) bool {
	if domain == "" || len(domain) > 253 || strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") || net.ParseIP(domain) != nil {
		return false
	}
	for _, label := range strings.Split(domain, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
				return false
			}
		}
	}
	return true
}

func (project *ProjectConfig) Validate() error {
	if !canonicalName(project.ID) || !canonicalName(project.UserID) || len(project.DisplayName) > 256 || strings.IndexByte(project.DisplayName, 0) >= 0 {
		return errors.New("identity fields are invalid")
	}
	hash, err := hex.DecodeString(project.AccessTokenHash)
	if err != nil || len(hash) != sha256.Size || project.AccessTokenHash != strings.ToLower(project.AccessTokenHash) {
		return errors.New("access_token_sha256 must be 64 lowercase hexadecimal characters")
	}
	parsed, err := url.Parse(project.ControlURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return errors.New("control_url must be an HTTPS origin")
	}
	project.ControlURL = strings.TrimSuffix(project.ControlURL, "/")
	for label, path := range map[string]string{"server_ca": project.ServerCA, "certificate": project.Certificate, "private_key": project.PrivateKey} {
		if !filepath.IsAbs(path) || len(path) > 32767 || strings.IndexByte(path, 0) >= 0 {
			return fmt.Errorf("%s must be an absolute non-NUL path", label)
		}
	}
	if project.ClientURI == "" || project.ControlURI == "" {
		return errors.New("client_uri and control_uri are required")
	}
	if project.RuntimeProfile.configured() {
		if err := project.RuntimeProfile.Validate(); err != nil {
			return fmt.Errorf("runtime_profile: %w", err)
		}
	}
	return nil
}

func (profile RuntimeProfile) configured() bool {
	return profile.ID != "" || profile.DisplayName != "" || profile.ProviderBaseURL != "" || profile.Model != "" || profile.ModelCredentialID != "" ||
		profile.SearchCredentialID != "" || profile.MaxTurns != 0 || profile.TimeoutSeconds != 0
}

func (profile *RuntimeProfile) Validate() error {
	if !canonicalName(profile.ID) || len(profile.DisplayName) > 128 || strings.IndexByte(profile.DisplayName, 0) >= 0 {
		return errors.New("identity fields are invalid")
	}
	provider, err := url.Parse(profile.ProviderBaseURL)
	if err != nil || provider.Scheme != "https" || provider.Host == "" || provider.User != nil || provider.RawQuery != "" || provider.Fragment != "" {
		return errors.New("provider_base_url must be an HTTPS URL without credentials, query, or fragment")
	}
	profile.ProviderBaseURL = strings.TrimSuffix(profile.ProviderBaseURL, "/")
	if profile.Model == "" || len(profile.Model) > 256 || strings.IndexByte(profile.Model, 0) >= 0 || !canonicalName(profile.ModelCredentialID) {
		return errors.New("model or model_credential_id is invalid")
	}
	if profile.SearchCredentialID != "" && (!canonicalName(profile.SearchCredentialID) || profile.SearchCredentialID == profile.ModelCredentialID) {
		return errors.New("search_credential_id is invalid")
	}
	if profile.MaxTurns == 0 {
		profile.MaxTurns = 80
	}
	if profile.MaxTurns > 200 {
		return errors.New("max_turns must not exceed 200")
	}
	if profile.TimeoutSeconds == 0 {
		profile.TimeoutSeconds = 7200
	}
	if profile.TimeoutSeconds < 60 || profile.TimeoutSeconds > 24*60*60 {
		return errors.New("timeout_seconds must be between 60 and 86400")
	}
	return nil
}

func (config Config) Build() ([]byte, []ProjectRuntime, error) {
	keyData, err := remoteauth.ReadOwnerOnlyFile(config.SigningKey, maxSigningKeySize)
	if err != nil {
		return nil, nil, fmt.Errorf("load Web BFF signing key: %w", err)
	}
	keyData = bytes.TrimSpace(keyData)
	key, err := hex.DecodeString(string(keyData))
	if err != nil || len(key) != 32 {
		return nil, nil, errors.New("Web BFF signing key must contain exactly 64 hexadecimal characters")
	}
	projects := make([]ProjectRuntime, 0, len(config.Projects))
	for _, project := range config.Projects {
		tlsConfig, err := remoteauth.LoadMutualTLSClient(project.ServerCA, project.Certificate, project.PrivateKey, project.ClientURI, project.ControlURI)
		if err != nil {
			return nil, nil, fmt.Errorf("build Web BFF project %q transport: %w", project.ID, err)
		}
		controlURL, _ := url.Parse(project.ControlURL)
		tokenHash, _ := hex.DecodeString(project.AccessTokenHash)
		var digest [sha256.Size]byte
		copy(digest[:], tokenHash)
		projects = append(projects, ProjectRuntime{
			ID: project.ID, UserID: project.UserID, DisplayName: project.DisplayName, RuntimeProfile: project.RuntimeProfile,
			TokenHash: digest, ControlURL: controlURL,
			Transport: &http.Transport{
				Proxy: http.ProxyFromEnvironment, ForceAttemptHTTP2: true, TLSClientConfig: tlsConfig,
				MaxIdleConns: 100, MaxIdleConnsPerHost: 20, IdleConnTimeout: 90 * time.Second, TLSHandshakeTimeout: 10 * time.Second,
			},
		})
	}
	return key, projects, nil
}

func canonicalName(value string) bool {
	if value == "" || len(value) > 128 || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for _, character := range value[1:] {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' && character != '_' && character != '.' {
			return false
		}
	}
	return true
}

func validCookieName(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') && character != '-' && character != '_' {
			return false
		}
	}
	return true
}

func validateListen(value string) error {
	if value == "" || len(value) > 512 || strings.IndexByte(value, 0) >= 0 {
		return errors.New("Web BFF listen must be a bounded host:port")
	}
	_, port, err := net.SplitHostPort(value)
	if err != nil {
		return errors.New("Web BFF listen must be a host:port")
	}
	parsedPort, err := strconv.ParseUint(port, 10, 16)
	if err != nil || parsedPort == 0 {
		return errors.New("Web BFF listen port must be between 1 and 65535")
	}
	return nil
}
