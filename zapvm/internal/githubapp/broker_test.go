package githubapp

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestBrokerMintsScopedInstallationCapability(t *testing.T) {
	now := time.Date(2026, 8, 8, 3, 0, 0, 0, time.UTC)
	key, path := testPrivateKey(t, 2048)
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		if request.Method != http.MethodPost || request.URL.Path != "/app/installations/42/access_tokens" ||
			request.Header.Get("X-GitHub-Api-Version") != apiVersion || request.Header.Get("Accept") != "application/vnd.github+json" {
			t.Errorf("unexpected request: %s %s headers=%v", request.Method, request.URL.Path, request.Header)
		}
		verifyJWT(t, strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer "), key, now, "1234")
		var body struct {
			Repositories []string          `json:"repositories"`
			Permissions  map[string]string `json:"permissions"`
		}
		decoder := json.NewDecoder(request.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body.Repositories) != 1 || body.Repositories[0] != "zapVM" || body.Permissions["contents"] != "write" ||
			body.Permissions["pull_requests"] != "write" || body.Permissions["metadata"] != "read" || len(body.Permissions) != 3 {
			t.Fatalf("unscoped request body: %#v", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"token":        "ghs_1234_abcdefghijklmnopqrstuvwxyz_VARIABLE_LENGTH_2026",
			"expires_at":   now.Add(time.Hour).Format(time.RFC3339),
			"permissions":  map[string]string{"contents": "write"},
			"repositories": []map[string]any{{"id": 1, "name": "zapVM"}},
		})
	}))
	defer server.Close()

	broker, err := Open([]Config{{
		ID: "github", TenantID: "acme", ProjectID: "weather", APIBaseURL: server.URL, WebBaseURL: server.URL,
		AppID: 1234, InstallationID: 42, PrivateKeyFile: path, Owner: "JackCaow", Repository: "zapVM", DefaultBaseBranch: "main",
	}}, server.Client(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	providers := broker.List("acme", "weather")
	if len(providers) != 1 || providers[0].ID != "github" || len(broker.List("other", "weather")) != 0 {
		t.Fatalf("providers=%#v", providers)
	}
	capability, err := broker.Mint(context.Background(), "acme", "weather", "github")
	if err != nil {
		t.Fatal(err)
	}
	if capability.HTTPSCloneURL != server.URL+"/JackCaow/zapVM.git" || capability.ExpiresAt != now.Add(time.Hour) ||
		!strings.HasPrefix(string(capability.Token), "ghs_") {
		t.Fatalf("capability=%#v", capability)
	}
	underlying := capability.Token
	capability.Destroy()
	if capability.Token != nil {
		t.Fatal("Destroy retained token")
	}
	for _, value := range underlying {
		if value != 0 {
			t.Fatal("Destroy did not zero token backing memory")
		}
	}
	if _, err := broker.Mint(context.Background(), "other", "weather", "github"); err == nil || calls.Load() != 1 {
		t.Fatal("cross-scope mint reached GitHub")
	}
}

func TestConfigAndPrivateKeyBoundary(t *testing.T) {
	_, path := testPrivateKey(t, 2048)
	base := Config{ID: "github", TenantID: "acme", ProjectID: "weather", AppID: 1, InstallationID: 2,
		PrivateKeyFile: path, Owner: "owner", Repository: "repo", DefaultBaseBranch: "main"}
	if err := base.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*Config){
		"http origin":   func(config *Config) { config.APIBaseURL = "http://github.example" },
		"relative key":  func(config *Config) { config.PrivateKeyFile = "app.pem" },
		"unsafe branch": func(config *Config) { config.DefaultBaseBranch = "refs/../main" },
		"git suffix":    func(config *Config) { config.Repository = "repo.git" },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := base
			mutate(&candidate)
			if err := candidate.Validate(); err == nil {
				t.Fatal("unsafe config accepted")
			}
		})
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := Open([]Config{base}, nil, nil); err == nil {
			t.Fatal("broad private-key permissions accepted")
		}
	}
}

func verifyJWT(t *testing.T, token string, key *rsa.PrivateKey, now time.Time, appID string) {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("invalid JWT %q", token)
	}
	var header map[string]any
	var claims map[string]any
	decode := func(value string, destination any) {
		data, err := base64.RawURLEncoding.DecodeString(value)
		if err != nil || json.Unmarshal(data, destination) != nil {
			t.Fatal("invalid JWT JSON")
		}
	}
	decode(parts[0], &header)
	decode(parts[1], &claims)
	if header["alg"] != "RS256" || claims["iss"] != appID || int64(claims["iat"].(float64)) != now.Add(-time.Minute).Unix() ||
		int64(claims["exp"].(float64)) != now.Add(9*time.Minute).Unix() {
		t.Fatalf("unexpected JWT header=%v claims=%v", header, claims)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], signature); err != nil {
		t.Fatal(err)
	}
}

func testPrivateKey(t *testing.T, bits int) (*rsa.PrivateKey, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, bits)
	if err != nil {
		t.Fatal(err)
	}
	data := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	path := filepath.Join(t.TempDir(), "github-app.pem")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return key, path
}
