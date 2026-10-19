package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPrintValidatedDaemonEndpoint(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("owner-only POSIX config fixture")
	}
	directory := t.TempDir()
	endpoint := filepath.Join(directory, "daemon.sock")
	configPath := filepath.Join(directory, "cloud-node.json")
	config := fmt.Sprintf(`{
  "schema_version": 1,
  "control_url": "https://control.example.test:9444",
  "trust_domain": "example.test",
  "control_id": "primary",
  "node_id": "host-a",
  "server_ca": %q,
  "certificate": %q,
  "private_key": %q,
  "daemon_endpoint": %q
}`, filepath.Join(directory, "ca.pem"), filepath.Join(directory, "node.pem"), filepath.Join(directory, "node.key"), endpoint)
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}

	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stdout
	os.Stdout = write
	runErr := run([]string{"--config", configPath, "--print-daemon-endpoint"})
	_ = write.Close()
	os.Stdout = original
	output, readErr := io.ReadAll(read)
	_ = read.Close()
	if runErr != nil {
		t.Fatal(runErr)
	}
	if readErr != nil {
		t.Fatal(readErr)
	}
	if got := strings.TrimSpace(string(output)); got != endpoint {
		t.Fatalf("printed endpoint = %q, want %q", got, endpoint)
	}
	if err := run([]string{"--config", configPath, "--validate", "--print-daemon-endpoint"}); err == nil || !strings.Contains(err.Error(), "only one") {
		t.Fatalf("combined validation/print error = %v", err)
	}
}
