package cloudplane

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"zapvm/internal/githubapp"
)

func validConfig(t *testing.T) Config {
	t.Helper()
	root := t.TempDir()
	return Config{
		SchemaVersion: SchemaVersion, Listen: "127.0.0.1:9444", StateRoot: filepath.Join(root, "state"),
		TrustDomain: "example.test", ControlID: "primary", ClientCA: filepath.Join(root, "ca.pem"),
		Certificate: filepath.Join(root, "control.pem"), PrivateKey: filepath.Join(root, "control.key"),
		Administrators: []string{testPrincipalA}, Nodes: testProvisions(),
	}
}

func TestConfigRejectsInvalidComputerAgent(t *testing.T) {
	config := validConfig(t)
	config.Nodes[0].Computers = []ComputerProvision{{ID: "computer-a", TenantID: "acme", ProjectID: "weather", Agent: "not-a-reference"}}
	if err := config.Validate(); err == nil {
		t.Fatal("invalid Computer Agent provision was accepted")
	}
}

func TestConfigRejectsConflictingComputerAgentPlacements(t *testing.T) {
	config := validConfig(t)
	config.Nodes[0].Computers = []ComputerProvision{{ID: "computer-a", TenantID: "acme", ProjectID: "weather", Agent: "zapcode@1.12.0"}}
	config.Nodes[2].Computers = []ComputerProvision{{ID: "computer-a", TenantID: "acme", ProjectID: "weather"}}
	if err := config.Validate(); err == nil {
		t.Fatal("conflicting Computer Agent placements were accepted")
	}
}

func TestConfigStrictDefaultsAndOwnerOnly(t *testing.T) {
	config := validConfig(t)
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "control.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ControlURI() != "spiffe://example.test/control/primary" || loaded.HeartbeatTTLSeconds == 0 || loaded.LeaseTTLSeconds == 0 {
		t.Fatalf("loaded config = %#v", loaded)
	}
	unknown := append(data[:len(data)-1], []byte(`,"unknown":true}`)...)
	if err := os.WriteFile(path, unknown, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("config accepted an unknown field")
	}
	if runtime.GOOS != "windows" {
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadConfig(path); err == nil {
			t.Fatal("config accepted broad permissions")
		}
	}
}

func TestConfigRejectsUnsafeAuthority(t *testing.T) {
	config := validConfig(t)
	config.PrivateKey = "control.key"
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted a relative private key")
	}
	config = validConfig(t)
	config.Administrators = []string{"spiffe://other.test/tenant/acme/project/weather/client/codex"}
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted an administrator from another trust domain")
	}
	config = validConfig(t)
	config.Nodes[0].Computers = []ComputerProvision{{ID: "computer-a", TenantID: "other", ProjectID: "project"}}
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted a Computer outside the Node's authorized scopes")
	}
	config = validConfig(t)
	config.Nodes[0].Computers = []ComputerProvision{
		{ID: "computer-a", TenantID: "acme", ProjectID: "weather"},
		{ID: "computer-a", TenantID: "acme", ProjectID: "weather"},
	}
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted a duplicate Computer provision")
	}
}

func TestConfigValidatesTaskRetention(t *testing.T) {
	config := validConfig(t)
	config.TaskRetentionSeconds = uint64(time.Hour/time.Second) - 1
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted a sub-hour Task retention")
	}
	config = validConfig(t)
	config.TaskRetentionSeconds = uint64(time.Hour / time.Second)
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	if config.StoreOptions().TaskRetention != time.Hour {
		t.Fatalf("Task retention option=%s", config.StoreOptions().TaskRetention)
	}
}

func TestConfigValidatesPostgreSQLMirror(t *testing.T) {
	config := validConfig(t)
	config.PostgreSQLMirror = &PostgreSQLMirrorConfig{DSNFile: filepath.Join(t.TempDir(), "postgres-dsn")}
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	if config.PostgreSQLMirror.RetryIntervalSeconds != 5 || config.PostgreSQLMirror.FlushTimeoutSeconds != 120 {
		t.Fatalf("PostgreSQL mirror defaults=%#v", config.PostgreSQLMirror)
	}
	config = validConfig(t)
	config.PostgreSQLMirror = &PostgreSQLMirrorConfig{DSNFile: "postgres-dsn"}
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted a relative PostgreSQL DSN file")
	}
	config = validConfig(t)
	config.PostgreSQLMirror = &PostgreSQLMirrorConfig{DSNFile: filepath.Join(t.TempDir(), "postgres-dsn"), RetryIntervalSeconds: 301}
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted an excessive PostgreSQL mirror retry interval")
	}
}

func TestConfigValidatesPostgreSQLPrimary(t *testing.T) {
	config := validConfig(t)
	config.PostgreSQLPrimary = &PostgreSQLPrimaryConfig{DSNFile: filepath.Join(t.TempDir(), "postgres-dsn")}
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	if config.PostgreSQLPrimary.OperationTimeoutSeconds != 120 || config.PostgreSQLPrimary.ComputerStartTimeoutSeconds != 300 || config.PostgreSQLPrimary.Mode != "snapshot" || config.PostgreSQLPrimary.PlacementMode != PlacementModeStatic {
		t.Fatalf("PostgreSQL primary defaults=%#v", config.PostgreSQLPrimary)
	}
	config = validConfig(t)
	config.PostgreSQLPrimary = &PostgreSQLPrimaryConfig{DSNFile: filepath.Join(t.TempDir(), "postgres-dsn"), Mode: "distributed", PlacementMode: PlacementModeDynamic}
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	if config.PostgreSQLPrimary.ComputerStartTimeoutSeconds != config.DispatchTimeoutSeconds {
		t.Fatalf("dynamic Computer start timeout=%d dispatch timeout=%d", config.PostgreSQLPrimary.ComputerStartTimeoutSeconds, config.DispatchTimeoutSeconds)
	}
	config = validConfig(t)
	config.PostgreSQLPrimary = &PostgreSQLPrimaryConfig{DSNFile: filepath.Join(t.TempDir(), "postgres-dsn"), Mode: "distributed"}
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	config.PostgreSQLPrimary.PlacementMode = PlacementModeDynamic
	config.PostgreSQLPrimary.ComputerStartTimeoutSeconds = config.DispatchTimeoutSeconds
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	config.PostgreSQLPrimary.PlacementMode = "random"
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted an unknown PostgreSQL placement mode")
	}
	config.PostgreSQLPrimary.PlacementMode = PlacementModeDynamic
	config.PostgreSQLPrimary.ComputerStartTimeoutSeconds = 29
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted a short Computer start timeout")
	}
	config.PostgreSQLPrimary.ComputerStartTimeoutSeconds = 1801
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted a long Computer start timeout")
	}
	config.PostgreSQLPrimary.ComputerStartTimeoutSeconds = 300
	config.PostgreSQLPrimary.PlacementMode = PlacementModeStatic
	config.PostgreSQLPrimary.Mode = "leaderless-ish"
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted an unknown PostgreSQL primary mode")
	}
	config = validConfig(t)
	config.PostgreSQLPrimary = &PostgreSQLPrimaryConfig{DSNFile: "postgres-dsn"}
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted a relative PostgreSQL primary DSN file")
	}
	config = validConfig(t)
	config.PostgreSQLMirror = &PostgreSQLMirrorConfig{DSNFile: filepath.Join(t.TempDir(), "mirror-dsn")}
	config.PostgreSQLPrimary = &PostgreSQLPrimaryConfig{DSNFile: filepath.Join(t.TempDir(), "primary-dsn")}
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted simultaneous PostgreSQL mirror and primary")
	}
	config = validConfig(t)
	config.PostgreSQLPrimary = &PostgreSQLPrimaryConfig{DSNFile: filepath.Join(t.TempDir(), "primary-dsn"), PlacementMode: PlacementModeDynamic}
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted dynamic placement without distributed PostgreSQL")
	}
}

func TestConfigCredentialBrokerRequiresDistributedPostgreSQLAndBoundedTTL(t *testing.T) {
	config := validConfig(t)
	config.PostgreSQLPrimary = &PostgreSQLPrimaryConfig{DSNFile: filepath.Join(t.TempDir(), "postgres-dsn"), Mode: "distributed"}
	config.CredentialBroker = &CredentialBrokerConfig{DevelopmentStaticKeyFile: filepath.Join(t.TempDir(), "credential-wrapper.key")}
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	if config.CredentialBroker.CapabilityTTLSeconds != 300 {
		t.Fatalf("Credential capability TTL=%d", config.CredentialBroker.CapabilityTTLSeconds)
	}
	config = validConfig(t)
	config.CredentialBroker = &CredentialBrokerConfig{DevelopmentStaticKeyFile: filepath.Join(t.TempDir(), "credential-wrapper.key")}
	if err := config.Validate(); err == nil {
		t.Fatal("Credential broker without distributed PostgreSQL was accepted")
	}
	config = validConfig(t)
	config.PostgreSQLPrimary = &PostgreSQLPrimaryConfig{DSNFile: filepath.Join(t.TempDir(), "postgres-dsn"), Mode: "distributed"}
	config.CredentialBroker = &CredentialBrokerConfig{DevelopmentStaticKeyFile: "relative.key", CapabilityTTLSeconds: 901}
	if err := config.Validate(); err == nil {
		t.Fatal("unsafe Credential broker configuration was accepted")
	}
}

func TestConfigNodeIdentityIssuerRequiresDistributedPostgreSQLAndHasBoundedAuthority(t *testing.T) {
	config := validConfig(t)
	root := t.TempDir()
	config.PostgreSQLPrimary = &PostgreSQLPrimaryConfig{DSNFile: filepath.Join(root, "postgres-dsn"), Mode: "distributed"}
	config.NodeIdentity = &NodeIdentityConfig{
		SigningCertificateFile: filepath.Join(root, "node-ca.pem"), SigningPrivateKeyFile: filepath.Join(root, "node-ca.key"),
		EnrollmentTokens: []NodeEnrollmentProvision{{NodeID: "node-a", TokenSHA256: strings.Repeat("a1", 32), ExpiresAt: "2026-08-09T00:00:00Z"}},
	}
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	if config.NodeIdentity.CertificateTTLSeconds != 21600 || config.NodeIdentity.RenewBeforeSeconds != 1800 {
		t.Fatalf("Node identity defaults=%#v", config.NodeIdentity)
	}
	config.NodeIdentity.EnrollmentTokens[0].NodeID = "missing-node"
	if err := config.Validate(); err == nil {
		t.Fatal("Node identity issuer accepted an unprovisioned enrollment Node")
	}
	config = validConfig(t)
	config.NodeIdentity = &NodeIdentityConfig{SigningCertificateFile: "/ca.pem", SigningPrivateKeyFile: "/ca.key"}
	if err := config.Validate(); err == nil {
		t.Fatal("Node identity issuer without distributed PostgreSQL was accepted")
	}
	config = validConfig(t)
	config.PostgreSQLPrimary = &PostgreSQLPrimaryConfig{DSNFile: filepath.Join(root, "postgres-dsn"), Mode: "distributed"}
	config.NodeIdentity = &NodeIdentityConfig{SigningCertificateFile: "relative.pem", SigningPrivateKeyFile: "/ca.key", CertificateTTLSeconds: 300, RenewBeforeSeconds: 150}
	if err := config.Validate(); err == nil {
		t.Fatal("unsafe Node identity issuer authority was accepted")
	}
}

func TestConfigValidatesGitHubAppScopeAndIdentity(t *testing.T) {
	config := validConfig(t)
	config.GitHubApps = []githubapp.Config{{
		ID: "github", TenantID: "acme", ProjectID: "weather", AppID: 1, InstallationID: 2,
		PrivateKeyFile: filepath.Join(t.TempDir(), "app.pem"), Owner: "owner", Repository: "repo", DefaultBaseBranch: "main",
	}}
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	duplicate := config.GitHubApps[0]
	config.GitHubApps = append(config.GitHubApps, duplicate)
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted duplicate GitHub App provision")
	}
	config = validConfig(t)
	config.GitHubApps = []githubapp.Config{{
		ID: "github", TenantID: "missing", ProjectID: "project", AppID: 1, InstallationID: 2,
		PrivateKeyFile: filepath.Join(t.TempDir(), "app.pem"), Owner: "owner", Repository: "repo", DefaultBaseBranch: "main",
	}}
	if err := config.Validate(); err == nil {
		t.Fatal("config accepted GitHub App without a matching Node scope")
	}
}
