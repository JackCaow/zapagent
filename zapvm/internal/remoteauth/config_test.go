package remoteauth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func validServeGatewayConfig(t *testing.T) GatewayConfig {
	t.Helper()
	root := t.TempDir()
	return GatewayConfig{
		SchemaVersion: GatewayConfigSchemaVersion, Mode: GatewayModeServe,
		Serve: &GatewayServeConfig{
			Listen: "127.0.0.1:9443", DaemonEndpoint: filepath.Join(root, "daemon.sock"),
			ClientCA: filepath.Join(root, "client-ca.pem"), Certificate: filepath.Join(root, "node.pem"),
			PrivateKey: filepath.Join(root, "node.key"), Policy: filepath.Join(root, "policy.json"),
			AuditLog: filepath.Join(root, "audit.jsonl"),
		},
	}
}

func TestGatewayConfigValidatesExclusiveModes(t *testing.T) {
	serve := validServeGatewayConfig(t)
	if err := serve.Validate(); err != nil {
		t.Fatal(err)
	}
	tunnelRoot := t.TempDir()
	tunnel := GatewayConfig{
		SchemaVersion: GatewayConfigSchemaVersion, Mode: GatewayModeTunnel,
		Tunnel: &GatewayTunnelConfig{
			Endpoint: filepath.Join(tunnelRoot, "tunnel.sock"), Remote: "host.example.test:9443",
			ServerCA: filepath.Join(tunnelRoot, "server-ca.pem"), Certificate: filepath.Join(tunnelRoot, "client.pem"),
			PrivateKey: filepath.Join(tunnelRoot, "client.key"), NodeURI: "spiffe://example.test/node/host-a",
		},
	}
	if err := tunnel.Validate(); err != nil {
		t.Fatal(err)
	}
	tunnel.Tunnel.Endpoint = `\\.\pipe\ZapVM-config-test`
	if err := tunnel.Validate(); err != nil {
		t.Fatalf("validate Windows named-pipe endpoint: %v", err)
	}
	serve.Tunnel = tunnel.Tunnel
	if err := serve.Validate(); err == nil {
		t.Fatal("serve config accepted a tunnel object")
	}
	tunnel.Tunnel.Remote = "host.example.test:0"
	if err := tunnel.Validate(); err == nil {
		t.Fatal("tunnel config accepted port zero")
	}
	tunnel.Tunnel.Remote = ":9443"
	if err := tunnel.Validate(); err == nil {
		t.Fatal("tunnel config accepted an empty remote host")
	}
}

func TestLoadGatewayConfigIsStrictAndOwnerOnly(t *testing.T) {
	config := validServeGatewayConfig(t)
	directory := t.TempDir()
	path := filepath.Join(directory, "gateway.json")
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadGatewayConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Mode != GatewayModeServe || loaded.Serve.Listen != config.Serve.Listen {
		t.Fatalf("unexpected gateway config %#v", loaded)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadGatewayConfig(path); err == nil {
			t.Fatal("gateway config accepted group-readable permissions")
		}
		if err := os.Chmod(path, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	unknown := append(data[:len(data)-1], []byte(`,"unknown":true}`)...)
	if err := os.WriteFile(path, unknown, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadGatewayConfig(path); err == nil {
		t.Fatal("gateway config accepted an unknown field")
	}
}

func TestGatewayConfigRejectsRelativeAuthorityPaths(t *testing.T) {
	config := validServeGatewayConfig(t)
	config.Serve.PrivateKey = "node.key"
	if err := config.Validate(); err == nil {
		t.Fatal("gateway config accepted a relative private key path")
	}
	config = validServeGatewayConfig(t)
	config.Serve.DaemonEndpoint = "daemon.sock"
	if err := config.Validate(); err == nil {
		t.Fatal("gateway config accepted a relative daemon endpoint")
	}
}
