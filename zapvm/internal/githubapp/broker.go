package githubapp

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"zapvm/internal/gitprovider"
	"zapvm/internal/remoteauth"
)

const (
	maxPrivateKeySize = 128 << 10
	apiVersion        = "2026-03-10"
)

type Config struct {
	ID                string `json:"id"`
	TenantID          string `json:"tenant_id"`
	ProjectID         string `json:"project_id"`
	APIBaseURL        string `json:"api_base_url,omitempty"`
	WebBaseURL        string `json:"web_base_url,omitempty"`
	AppID             uint64 `json:"app_id"`
	InstallationID    uint64 `json:"installation_id"`
	PrivateKeyFile    string `json:"private_key_file"`
	Owner             string `json:"owner"`
	Repository        string `json:"repository"`
	DefaultBaseBranch string `json:"default_base_branch"`
}

func (config *Config) Validate() error {
	if config.APIBaseURL == "" {
		config.APIBaseURL = "https://api.github.com"
	}
	if config.WebBaseURL == "" {
		config.WebBaseURL = "https://github.com"
	}
	if !validCanonical(config.ID, 128, false) || !validCanonical(config.TenantID, 128, true) || !validCanonical(config.ProjectID, 128, true) {
		return errors.New("GitHub App provision identity is invalid")
	}
	if config.AppID == 0 || config.InstallationID == 0 || !validRepositoryPart(config.Owner) || !validRepositoryPart(config.Repository) || !validBranch(config.DefaultBaseBranch) {
		return errors.New("GitHub App installation or repository is invalid")
	}
	if err := validateHTTPSOrigin(config.APIBaseURL); err != nil {
		return fmt.Errorf("GitHub App API base URL: %w", err)
	}
	if err := validateHTTPSOrigin(config.WebBaseURL); err != nil {
		return fmt.Errorf("GitHub App web base URL: %w", err)
	}
	if !filepath.IsAbs(config.PrivateKeyFile) || len(config.PrivateKeyFile) > 32767 || strings.ContainsRune(config.PrivateKeyFile, 0) {
		return errors.New("GitHub App private key file must be an absolute non-NUL path")
	}
	return nil
}

type Broker struct {
	installations map[string]installation
	client        *http.Client
	now           func() time.Time
}

type installation struct {
	config Config
	key    *rsa.PrivateKey
}

func Open(configs []Config, client *http.Client, now func() time.Time) (*Broker, error) {
	if len(configs) > 64 {
		return nil, errors.New("GitHub App broker supports at most 64 provisions")
	}
	if client == nil {
		client = &http.Client{Transport: &http.Transport{Proxy: nil, ForceAttemptHTTP2: true}, Timeout: 15 * time.Second}
	}
	clientCopy := *client
	clientCopy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	client = &clientCopy
	if now == nil {
		now = time.Now
	}
	broker := &Broker{installations: make(map[string]installation, len(configs)), client: client, now: now}
	for _, candidate := range configs {
		config := candidate
		if err := config.Validate(); err != nil {
			return nil, err
		}
		key := provisionKey(config.TenantID, config.ProjectID, config.ID)
		if _, duplicate := broker.installations[key]; duplicate {
			return nil, errors.New("duplicate GitHub App provision")
		}
		privateKey, err := loadPrivateKey(config.PrivateKeyFile)
		if err != nil {
			return nil, fmt.Errorf("load GitHub App %q private key: %w", config.ID, err)
		}
		broker.installations[key] = installation{config: config, key: privateKey}
	}
	return broker, nil
}

func (broker *Broker) Configured(tenantID, projectID, providerID string) bool {
	if broker == nil {
		return false
	}
	_, exists := broker.installations[provisionKey(tenantID, projectID, providerID)]
	return exists
}

func (broker *Broker) List(tenantID, projectID string) []gitprovider.Descriptor {
	if broker == nil {
		return []gitprovider.Descriptor{}
	}
	providers := make([]gitprovider.Descriptor, 0)
	for _, provision := range broker.installations {
		if provision.config.TenantID != tenantID || provision.config.ProjectID != projectID {
			continue
		}
		providers = append(providers, gitprovider.Descriptor{
			ID: provision.config.ID, Owner: provision.config.Owner, Repository: provision.config.Repository,
			DefaultBaseBranch: provision.config.DefaultBaseBranch,
		})
	}
	gitprovider.SortDescriptors(providers)
	return providers
}

func (broker *Broker) Mint(ctx context.Context, tenantID, projectID, providerID string) (gitprovider.Capability, error) {
	if broker == nil || ctx == nil {
		return gitprovider.Capability{}, errors.New("GitHub App broker is unavailable")
	}
	provision, exists := broker.installations[provisionKey(tenantID, projectID, providerID)]
	if !exists {
		return gitprovider.Capability{}, errors.New("GitHub App provision does not exist")
	}
	now := broker.now().UTC()
	jwt, err := signJWT(provision.key, provision.config.AppID, now)
	if err != nil {
		return gitprovider.Capability{}, err
	}
	body, err := json.Marshal(map[string]any{
		"repositories": []string{provision.config.Repository},
		"permissions":  map[string]string{"contents": "write", "pull_requests": "write", "metadata": "read"},
	})
	if err != nil {
		return gitprovider.Capability{}, err
	}
	endpoint := strings.TrimSuffix(provision.config.APIBaseURL, "/") + "/app/installations/" + strconv.FormatUint(provision.config.InstallationID, 10) + "/access_tokens"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return gitprovider.Capability{}, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+jwt)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-GitHub-Api-Version", apiVersion)
	response, err := broker.client.Do(request)
	if err != nil {
		return gitprovider.Capability{}, fmt.Errorf("mint GitHub App installation token: %w", err)
	}
	defer response.Body.Close()
	data, readErr := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
	if readErr != nil || len(data) > 64<<10 {
		return gitprovider.Capability{}, errors.New("GitHub App installation token response is too large")
	}
	if response.StatusCode != http.StatusCreated {
		return gitprovider.Capability{}, fmt.Errorf("mint GitHub App installation token: HTTP %d", response.StatusCode)
	}
	var result struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expires_at"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return gitprovider.Capability{}, errors.New("decode GitHub App installation token")
	}
	expiresAt, err := time.Parse(time.RFC3339, result.ExpiresAt)
	if err != nil || expiresAt.Before(now.Add(time.Minute)) || expiresAt.After(now.Add(2*time.Hour)) ||
		len(result.Token) < 16 || len(result.Token) > 4096 || strings.ContainsAny(result.Token, " \t\r\n\x00") {
		return gitprovider.Capability{}, errors.New("GitHub App installation token response is invalid")
	}
	cloneURL := strings.TrimSuffix(provision.config.WebBaseURL, "/") + "/" + provision.config.Owner + "/" + provision.config.Repository + ".git"
	return gitprovider.Capability{
		ProviderID: provision.config.ID, Owner: provision.config.Owner, Repository: provision.config.Repository,
		BaseBranch: provision.config.DefaultBaseBranch, HTTPSCloneURL: cloneURL,
		Token: []byte(result.Token), ExpiresAt: expiresAt.UTC(),
	}, nil
}

func loadPrivateKey(path string) (*rsa.PrivateKey, error) {
	data, err := remoteauth.ReadOwnerOnlyFile(path, maxPrivateKeySize)
	if err != nil {
		return nil, err
	}
	block, rest := pem.Decode(data)
	if block == nil || len(bytes.TrimSpace(rest)) != 0 || !strings.Contains(block.Type, "PRIVATE KEY") {
		return nil, errors.New("GitHub App private key is not one PEM block")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		if key.N.BitLen() < 2048 {
			return nil, errors.New("GitHub App private key must be RSA-2048 or stronger")
		}
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, errors.New("GitHub App private key is not RSA PKCS#1 or PKCS#8")
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok || key.N.BitLen() < 2048 {
		return nil, errors.New("GitHub App private key must be RSA-2048 or stronger")
	}
	return key, nil
}

func signJWT(key *rsa.PrivateKey, appID uint64, now time.Time) (string, error) {
	if key == nil || key.N.BitLen() < 2048 || appID == 0 {
		return "", errors.New("GitHub App JWT inputs are invalid")
	}
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{
		"iat": now.Add(-60 * time.Second).Unix(), "exp": now.Add(9 * time.Minute).Unix(), "iss": strconv.FormatUint(appID, 10),
	})
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func validateHTTPSOrigin(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("must be an HTTPS origin without credentials, path, query, or fragment")
	}
	return nil
}

func provisionKey(tenantID, projectID, providerID string) string {
	return tenantID + "\x00" + projectID + "\x00" + providerID
}

func validCanonical(value string, maximum int, lowercase bool) bool {
	if value == "" || len(value) > maximum || (lowercase && value != strings.ToLower(value)) {
		return false
	}
	for _, character := range value {
		if !((character >= 'a' && character <= 'z') || (!lowercase && character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '-' || character == '_' || character == '.') {
			return false
		}
	}
	return true
}

func validRepositoryPart(value string) bool {
	return validCanonical(value, 100, false) && value != "." && value != ".." && !strings.HasSuffix(strings.ToLower(value), ".git")
}

func validBranch(value string) bool {
	return value != "" && len(value) <= 255 && !strings.HasPrefix(value, "/") && !strings.HasSuffix(value, "/") &&
		!strings.HasSuffix(value, ".") && !strings.HasSuffix(value, ".lock") && !strings.Contains(value, "..") &&
		!strings.Contains(value, "@{") && !strings.ContainsAny(value, " ~^:?*[\\\x00")
}
