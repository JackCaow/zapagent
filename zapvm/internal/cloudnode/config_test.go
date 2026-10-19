package cloudnode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func testConfig(t *testing.T) Config {
	t.Helper()
	root := t.TempDir()
	return Config{
		SchemaVersion: 1, ControlURL: "https://control.example.test:9444",
		TrustDomain: "example.test", ControlID: "primary", NodeID: "node-a",
		ServerCA: filepath.Join(root, "ca.pem"), Certificate: filepath.Join(root, "node.pem"),
		PrivateKey: filepath.Join(root, "node.key"), DaemonEndpoint: filepath.Join(root, "daemon.sock"),
	}
}

func TestConfigStrictDefaultsAndOwnerOnly(t *testing.T) {
	config := testConfig(t)
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "node.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.PollMillis != 250 || loaded.MaxConcurrent == 0 || loaded.RelayMode != "auto" || loaded.NodeURI() != "spiffe://example.test/node/node-a" {
		t.Fatalf("loaded config = %#v", loaded)
	}
	unknown := append(data[:len(data)-1], []byte(`,"unknown":true}`)...)
	if err := os.WriteFile(path, unknown, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("node config accepted an unknown field")
	}
	if runtime.GOOS != "windows" {
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadConfig(path); err == nil {
			t.Fatal("node config accepted broad permissions")
		}
	}
}

func TestConfigRejectsInvalidRelayMode(t *testing.T) {
	config := testConfig(t)
	config.RelayMode = "sometimes"
	if err := config.Validate(); err == nil {
		t.Fatal("node config accepted an invalid Relay mode")
	}
}

func TestConfigRejectsNonHTTPSControl(t *testing.T) {
	config := testConfig(t)
	config.ControlURL = "http://control.example.test:9444"
	if err := config.Validate(); err == nil {
		t.Fatal("node config accepted a non-HTTPS control plane")
	}
}

func TestConfigManagedIdentityIsExclusiveAndDefaultsRenewal(t *testing.T) {
	config := testConfig(t)
	config.Certificate = ""
	config.PrivateKey = ""
	config.EnrollmentTokenFile = filepath.Join(t.TempDir(), "enrollment.token")
	config.IdentityDirectory = filepath.Join(t.TempDir(), "identity")
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	if !config.ManagedIdentity() || config.RenewBeforeSeconds != 1800 {
		t.Fatalf("managed config=%#v", config)
	}
	config.Certificate = filepath.Join(t.TempDir(), "legacy.pem")
	if err := config.Validate(); err == nil {
		t.Fatal("managed identity accepted a static certificate path")
	}
}
