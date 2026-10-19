package daemonconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func validTestConfig(t *testing.T) Config {
	t.Helper()
	root := t.TempDir()
	return Config{
		SchemaVersion: SchemaVersion,
		Endpoint:      filepath.Join(root, "daemon.sock"), ImageRoot: filepath.Join(root, "images"),
		ImagePublicKey: filepath.Join(root, "image.pem"), StateRoot: filepath.Join(root, "state"),
		Credentials: []CredentialBinding{{ID: "model-api-key", Path: filepath.Join(root, "model.key")}},
	}
}

func TestConfigStrictDefaultsAndArguments(t *testing.T) {
	config := validTestConfig(t)
	config.AgentRoot = filepath.Join(filepath.Dir(config.StateRoot), "agents")
	config.AgentPublicKey = filepath.Join(filepath.Dir(config.StateRoot), "agent.pem")
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "daemon.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(loaded.ServeArguments(), "\n")
	for _, expected := range []string{"--image-root", "--image-public-key", "--agent-root", "--agent-public-key", "--state-root", "--max-workers", "model-api-key="} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("daemon arguments missing %q: %q", expected, joined)
		}
	}
	if loaded.MaxWorkers != 4 || loaded.MaxPerWorkspace != 2 || loaded.IdleTimeoutMillis != 3600000 || loaded.CPUCount != 2 || loaded.MemoryMiB != 2048 {
		t.Fatalf("daemon config defaults = %#v", loaded)
	}
	unknown := append(data[:len(data)-1], []byte(`,"unknown":true}`)...)
	if err := os.WriteFile(path, unknown, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("daemon config accepted an unknown field")
	}
	if runtime.GOOS != "windows" {
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil {
			t.Fatal("daemon config accepted broad permissions")
		}
	}
}

func TestConfigRejectsInvalidAuthority(t *testing.T) {
	for name, mutate := range map[string]func(*Config){
		"relative image":       func(config *Config) { config.ImageRoot = "images" },
		"worker overflow":      func(config *Config) { config.MaxWorkers = 65 },
		"workspace overflow":   func(config *Config) { config.MaxWorkers, config.MaxPerWorkspace = 2, 3 },
		"short idle":           func(config *Config) { config.IdleTimeoutMillis = 999 },
		"gc without retention": func(config *Config) { config.TaskGCIntervalMillis = 60000 },
		"duplicate credential": func(config *Config) { config.Credentials = append(config.Credentials, config.Credentials[0]) },
		"unpaired Agent root":  func(config *Config) { config.AgentRoot = filepath.Join(filepath.Dir(config.StateRoot), "agents") },
	} {
		t.Run(name, func(t *testing.T) {
			config := validTestConfig(t)
			mutate(&config)
			if err := config.Validate(); err == nil {
				t.Fatalf("invalid config accepted: %#v", config)
			}
		})
	}
}
