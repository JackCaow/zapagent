package main

import (
	"encoding/json"
	"encoding/xml"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"zapvm/internal/cloudnode"
	"zapvm/internal/cloudplane"
	"zapvm/internal/daemonconfig"
	"zapvm/internal/webbff"
)

func TestCloudPackagingExamplesAndUnits(t *testing.T) {
	root := filepath.Clean(filepath.Join("..", ".."))
	services := map[string]string{
		"zapvm-control.service": "ExecStart=/usr/local/bin/zapvm-control",
		"zapvm-daemon.service":  "ExecStart=/usr/local/bin/zapvm daemon run --config=",
		"zapvm-node.service":    "ExecStart=/usr/local/bin/zapvm-node",
		"zapvm-web.service":     "ExecStart=/usr/local/bin/zapvm-web",
	}
	for name, execStart := range services {
		data, err := os.ReadFile(filepath.Join(root, "packaging", "systemd", name))
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		for _, required := range []string{execStart, "UMask=0077", "NoNewPrivileges=true", "Restart=on-failure"} {
			if !strings.Contains(text, required) {
				t.Fatalf("%s is missing %q", name, required)
			}
		}
		if strings.Contains(text, "/bin/sh") || strings.Contains(text, "EnvironmentFile=") {
			t.Fatalf("%s delegates authority through a shell or environment file", name)
		}
	}
	if runtime.GOOS == "windows" {
		t.Skip("repository examples use POSIX paths")
	}
	for _, item := range []struct {
		name string
		load func(string) error
	}{
		{name: "cloud-control.json", load: func(path string) error { _, err := cloudplane.LoadConfig(path); return err }},
		{name: "cloud-node.json", load: func(path string) error { _, err := cloudnode.LoadConfig(path); return err }},
		{name: "daemon.json", load: func(path string) error { _, err := daemonconfig.Load(path); return err }},
		{name: "web-bff.json", load: func(path string) error { _, err := webbff.LoadConfig(path); return err }},
	} {
		data, err := os.ReadFile(filepath.Join(root, "packaging", "examples", item.name))
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), item.name)
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := item.load(path); err != nil {
			t.Fatalf("load %s: %v", item.name, err)
		}
	}
	for _, name := range []string{"com.zapvm.daemon.plist.example", "com.zapvm.node.plist.example"} {
		data, err := os.ReadFile(filepath.Join(root, "packaging", "macos", name))
		if err != nil {
			t.Fatal(err)
		}
		var document struct {
			XMLName xml.Name `xml:"plist"`
		}
		if err := xml.Unmarshal(data, &document); err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		text := string(data)
		for _, required := range []string{"<key>ProgramArguments</key>", "<key>RunAtLoad</key>", "<key>KeepAlive</key>", "<key>Umask</key>", "<integer>63</integer>"} {
			if !strings.Contains(text, required) {
				t.Fatalf("%s is missing %q", name, required)
			}
		}
		if strings.Contains(text, "/bin/sh") || strings.Contains(text, "EnvironmentVariables") {
			t.Fatalf("%s delegates authority through shell or environment", name)
		}
	}
}

func TestRailwayPackaging(t *testing.T) {
	root := filepath.Clean(filepath.Join("..", ".."))
	for _, name := range []string{"Dockerfile.railway", "railway.json", filepath.Join("packaging", "railway", "entrypoint.sh")} {
		data, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		if len(data) == 0 {
			t.Fatalf("%s is empty", name)
		}
	}
	dockerfile, err := os.ReadFile(filepath.Join(root, "Dockerfile.railway"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(dockerfile), "\nVOLUME ") {
		t.Fatal("Railway rejects Dockerfile VOLUME; attach /data through Railway instead")
	}

	railwayData, err := os.ReadFile(filepath.Join(root, "railway.json"))
	if err != nil {
		t.Fatal(err)
	}
	var railwayConfig map[string]any
	if err := json.Unmarshal(railwayData, &railwayConfig); err != nil {
		t.Fatalf("decode railway.json: %v", err)
	}
	deploy, ok := railwayConfig["deploy"].(map[string]any)
	if !ok || deploy["numReplicas"] != float64(1) {
		t.Fatal("Railway control plane must remain single-active")
	}

	entrypoint, err := os.ReadFile(filepath.Join(root, "packaging", "railway", "entrypoint.sh"))
	if err != nil {
		t.Fatal(err)
	}
	entrypointText := string(entrypoint)
	for _, required := range []string{"set -eu", "umask 077", "unset ZAPVM_CONTROL_CONFIG_B64", "ZAPVM_CONTROL_REPAIR_PAYLOAD_DIGESTS", "--repair-payload-digests", "ZAPVM_GITHUB_APP_PRIVATE_KEY_B64", "github-app-private-key.pem", "ZAPVM_POSTGRES_MIGRATE", "ZAPVM_POSTGRES_DSN_B64", "postgres-dsn", "ZAPVM_CREDENTIAL_WRAPPER_KEY_B64", "credential-wrapper.key", "zapvm-control-db migrate", "unset ZAPVM_POSTGRES_DSN", "su-exec zapvm:zapvm"} {
		if !strings.Contains(entrypointText, required) {
			t.Fatalf("Railway entrypoint is missing %q", required)
		}
	}
	if strings.Contains(entrypointText, "set -x") {
		t.Fatal("Railway entrypoint must not trace secret values")
	}
	if !strings.Contains(string(dockerfile), "/usr/local/bin/zapvm-control-db") {
		t.Fatal("Railway image must include the explicit PostgreSQL migration tool")
	}

	if runtime.GOOS == "windows" {
		t.Skip("Railway example uses POSIX paths")
	}
	example, err := os.ReadFile(filepath.Join(root, "packaging", "examples", "cloud-control.railway.json"))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "cloud-control.railway.json")
	if err := os.WriteFile(path, example, 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := cloudplane.LoadConfig(path)
	if err != nil {
		t.Fatalf("load Railway control config: %v", err)
	}
	if config.Listen != "0.0.0.0:9444" || config.StateRoot != "/data/state" {
		t.Fatalf("unexpected Railway listen/state: %s %s", config.Listen, config.StateRoot)
	}
}

func TestMacOSHostInstallerPackaging(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX installer syntax gate")
	}
	root := filepath.Clean(filepath.Join("..", ".."))
	for _, name := range []string{"zapvm-host-macos.sh", "acceptance-host-install-macos.sh"} {
		path := filepath.Join(root, "scripts", name)
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode()&0o111 == 0 {
			t.Fatalf("%s is not executable", name)
		}
		if output, err := exec.Command("/bin/sh", "-n", path).CombinedOutput(); err != nil {
			t.Fatalf("%s syntax: %v: %s", name, err, output)
		}
	}
	installer, err := os.ReadFile(filepath.Join(root, "scripts", "zapvm-host-macos.sh"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(installer)
	for _, required := range []string{
		"com.apple.security.virtualization", "codesign --verify --strict", "daemon run --config", "--validate",
		"zapvm-node\" --config", "launchctl bootstrap", "launchctl bootout", "set_pointer", "previous release was restored",
		"action=uninstall retained=",
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("macOS installer is missing %q", required)
		}
	}
	for _, forbidden := range []string{"rm -rf", "eval ", "curl ", "sudo ", "EnvironmentVariables"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("macOS installer contains forbidden pattern %q", forbidden)
		}
	}
}

func TestLinuxHostInstallerPackaging(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX installer syntax gate")
	}
	root := filepath.Clean(filepath.Join("..", ".."))
	for _, name := range []string{"zapvm-host-linux.sh", "acceptance-host-install-linux.sh"} {
		path := filepath.Join(root, "scripts", name)
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode()&0o111 == 0 {
			t.Fatalf("%s is not executable", name)
		}
		if output, err := exec.Command("/bin/sh", "-n", path).CombinedOutput(); err != nil {
			t.Fatalf("%s syntax: %v: %s", name, err, output)
		}
	}
	installer, err := os.ReadFile(filepath.Join(root, "scripts", "zapvm-host-linux.sh"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(installer)
	for _, required := range []string{
		"openssl", "pkeyutl -verify", "SHA256SUMS.sig", "systemd 254+", "/dev/kvm", "loginctl linger",
		"daemon run --config", "--print-endpoint", "--print-daemon-endpoint", "systemctl_bin\" --user enable",
		"systemd_analyze_bin\" --user verify", "previous release was restored", "action=uninstall retained=",
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("Linux installer is missing %q", required)
		}
	}
	for _, forbidden := range []string{"rm -rf", "eval ", "sudo ", "Environment=", "EnvironmentFile=", "curl "} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("Linux installer contains forbidden pattern %q", forbidden)
		}
	}
}

func TestWindowsHostInstallerPackaging(t *testing.T) {
	root := filepath.Clean(filepath.Join("..", ".."))
	installerPath := filepath.Join(root, "scripts", "zapvm-host-windows.ps1")
	acceptancePath := filepath.Join(root, "scripts", "acceptance-host-install-windows.ps1")
	installer, err := os.ReadFile(installerPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(installer)
	for _, required := range []string{
		"Get-AuthenticodeSignature", "SignerThumbprint", "Windows build 20348+", "vmcompute", "hns",
		"daemon service-run --config", "--service-run --config", `\\.\pipe\zapvm-`, "LocalSystem",
		"previous release was restored", "action=uninstall retained=", "host-state.json",
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("Windows installer is missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"Invoke-Expression", "Start-Process powershell", "ExecutionPolicy Bypass", "DownloadString", "Invoke-WebRequest", "Remove-Item $InstallRoot",
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("Windows installer contains forbidden pattern %q", forbidden)
		}
	}
	acceptance, err := os.ReadFile(acceptancePath)
	if err != nil {
		t.Fatal(err)
	}
	acceptanceText := string(acceptance)
	for _, required := range []string{
		"New-SelfSignedCertificate", "Set-AuthenticodeSignature", "Wait-NodeVersion", "failed-upgrade.log",
		"WINDOWS_HOST_INSTALL_ACCEPTANCE_OK", "Get-CimInstance Win32_Service",
	} {
		if !strings.Contains(acceptanceText, required) {
			t.Fatalf("Windows acceptance is missing %q", required)
		}
	}
}
