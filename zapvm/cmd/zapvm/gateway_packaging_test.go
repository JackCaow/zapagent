package main

import (
	"encoding/xml"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"zapvm/internal/remoteauth"
)

func TestGatewayServiceTemplatesAreDirectAndHardened(t *testing.T) {
	repositoryRoot := filepath.Clean(filepath.Join("..", ".."))
	for _, name := range []string{"zapvm-gateway.service", "zapvm-tunnel.service"} {
		data, err := os.ReadFile(filepath.Join(repositoryRoot, "packaging", "systemd", name))
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		for _, required := range []string{
			"ExecStart=/usr/local/bin/zapvm gateway run --config=", "UMask=0077", "NoNewPrivileges=true",
			"RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6", "Restart=on-failure",
		} {
			if !strings.Contains(text, required) {
				t.Fatalf("%s is missing %q", name, required)
			}
		}
		if strings.Contains(text, "/bin/sh") || strings.Contains(text, "EnvironmentFile=") {
			t.Fatalf("%s unexpectedly delegates authority through a shell or environment file", name)
		}
	}
	for _, name := range []string{"com.zapvm.gateway.plist.example", "com.zapvm.tunnel.plist.example"} {
		data, err := os.ReadFile(filepath.Join(repositoryRoot, "packaging", "macos", name))
		if err != nil {
			t.Fatal(err)
		}
		var document any
		if err := xml.Unmarshal(data, &document); err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		text := string(data)
		for _, required := range []string{"gateway", "run", "--config", "<integer>63</integer>", "<key>SuccessfulExit</key>"} {
			if !strings.Contains(text, required) {
				t.Fatalf("%s is missing %q", name, required)
			}
		}
		if strings.Contains(text, "/bin/sh") {
			t.Fatalf("%s unexpectedly invokes a shell", name)
		}
	}
}

func TestGatewayExampleConfigurationsMatchSchema(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("repository examples use POSIX absolute paths; Windows operators must substitute drive-qualified paths")
	}
	repositoryRoot := filepath.Clean(filepath.Join("..", ".."))
	for _, test := range []struct {
		name string
		mode string
	}{
		{name: "gateway-serve.json", mode: remoteauth.GatewayModeServe},
		{name: "gateway-tunnel.json", mode: remoteauth.GatewayModeTunnel},
	} {
		data, err := os.ReadFile(filepath.Join(repositoryRoot, "packaging", "examples", test.name))
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), test.name)
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		config, err := remoteauth.LoadGatewayConfig(path)
		if err != nil {
			t.Fatalf("load %s: %v", test.name, err)
		}
		if config.Mode != test.mode {
			t.Fatalf("%s mode = %q", test.name, config.Mode)
		}
	}
}
