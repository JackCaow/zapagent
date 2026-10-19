package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"zapvm/internal/cloudplane"
)

func TestRunRequiresSubcommandAndDSNEnvironmentWithoutAcceptingDSNArgument(t *testing.T) {
	if err := run(nil); err == nil || !strings.Contains(err.Error(), "usage") {
		t.Fatalf("missing command error=%v", err)
	}
	if err := run([]string{"--dsn-env", "invalid-name", "status"}); err == nil || !strings.Contains(err.Error(), "name is invalid") {
		t.Fatalf("invalid env error=%v", err)
	}
	if err := run([]string{"import-file"}); err == nil || !strings.Contains(err.Error(), "--control-config") {
		t.Fatalf("missing Control config error=%v", err)
	}
	if err := run([]string{"--control-config", "/tmp/control.json", "status"}); err == nil || !strings.Contains(err.Error(), "only for") {
		t.Fatalf("unexpected Control config error=%v", err)
	}
	if err := run([]string{"--control-config", "/tmp/control.json", "--repair-drift", "verify-file"}); err == nil || !strings.Contains(err.Error(), "require import-file") {
		t.Fatalf("verify drift option error=%v", err)
	}
	if err := run([]string{"--dsn", "postgres://secret@example/db", "status"}); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("raw DSN argument error=%v", err)
	}
	_ = os.Unsetenv("ZAPVM_POSTGRES_DSN")
	if err := run([]string{"status"}); err == nil || !strings.Contains(err.Error(), "is not set") {
		t.Fatalf("missing DSN error=%v", err)
	}
}

func TestFileImportCLIIntegration(t *testing.T) {
	dsn := os.Getenv("ZAPVM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAPVM_TEST_POSTGRES_DSN is not configured")
	}
	originalDSN, originalDSNExists := os.LookupEnv("ZAPVM_POSTGRES_DSN")
	defer func() {
		if originalDSNExists {
			_ = os.Setenv("ZAPVM_POSTGRES_DSN", originalDSN)
		} else {
			_ = os.Unsetenv("ZAPVM_POSTGRES_DSN")
		}
	}()
	root := t.TempDir()
	provisions := []cloudplane.NodeProvision{{
		ID: "node-cli", Capacity: 1,
		Scopes:    []cloudplane.Scope{{TenantID: "acme", ProjectID: "cli"}},
		Computers: []cloudplane.ComputerProvision{{ID: "computer-cli", TenantID: "acme", ProjectID: "cli"}},
	}}
	store, err := cloudplane.Open(root, provisions, cloudplane.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterNode("node-cli", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(t.TempDir(), "control.json")
	config := cloudplane.Config{
		SchemaVersion: 1, Listen: "127.0.0.1:9444", StateRoot: root, TrustDomain: "example.test", ControlID: "cli",
		ClientCA: "/run/zapvm/ca.pem", Certificate: "/run/zapvm/control.pem", PrivateKey: "/run/zapvm/control.key",
		Administrators: []string{"spiffe://example.test/tenant/acme/project/cli/client/admin"}, Nodes: provisions,
	}
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{"--development-insecure-localhost", "--control-config", configPath, "import-file"}
	if err := os.Setenv("ZAPVM_POSTGRES_DSN", dsn); err != nil {
		t.Fatal(err)
	}
	if err := run(args); err != nil {
		t.Fatal(err)
	}
	if err := os.Setenv("ZAPVM_POSTGRES_DSN", dsn); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--development-insecure-localhost", "--control-config", configPath, "verify-file"}); err != nil {
		t.Fatal(err)
	}
	locked, err := cloudplane.Open(root, provisions, cloudplane.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Close()
	if err := os.Setenv("ZAPVM_POSTGRES_DSN", dsn); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--development-insecure-localhost", "--control-config", configPath, "verify-file"}); err == nil {
		t.Fatal("verify-file read state.json while the Control Store lock was held")
	}
}
