package dim

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"zapvm/internal/agentadapter"
)

func TestDecodeWorkspaceWriteRequest(t *testing.T) {
	workspace := t.TempDir()
	subdir := filepath.Join(workspace, "subdir")
	if err := os.Mkdir(subdir, 0o700); err != nil {
		t.Fatal(err)
	}
	protocol := New()
	request, err := protocol.Decode(dimRequest(t, workspace, subdir, map[string]any{
		"mode": "workspace-write", "allowedDomains": []string{"EXAMPLE.com", "example.com"},
	}))
	if err != nil {
		t.Fatal(err)
	}
	resolvedWorkspace, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		t.Fatal(err)
	}
	if request.Workspace != resolvedWorkspace || request.CWD != "subdir" || request.WorkspaceReadOnly {
		t.Fatalf("unexpected workspace mapping: %+v", request)
	}
	if request.Network != agentadapter.NetworkRestricted || len(request.AllowedDomains) != 1 || request.AllowedDomains[0] != "example.com" {
		t.Fatalf("unexpected network mapping: %+v", request)
	}
	wantCommand := []string{"/bin/sh", "-lc", "go test ./..."}
	if strings.Join(request.Command, "\x00") != strings.Join(wantCommand, "\x00") {
		t.Fatalf("unexpected Guest command: %q", request.Command)
	}
	if request.Timeout != 90*time.Second || !strings.HasPrefix(request.SessionID, "dim-") {
		t.Fatalf("unexpected timeout or Session: %+v", request)
	}
	if len(request.DeniedWorkspacePatterns) != 1 || request.DeniedWorkspacePatterns[0] != "**/.env" {
		t.Fatalf("read deny paths were not mapped into Guest policy: %+v", request.DeniedWorkspacePatterns)
	}
}

func TestDecodeRejectsStreamingStdioUntilProtocolSupportsIt(t *testing.T) {
	workspace := t.TempDir()
	data := dimRequest(t, workspace, workspace, nil)
	var wire map[string]any
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatal(err)
	}
	wire["stdio"] = map[string]string{"mode": "stream"}
	data, _ = json.Marshal(wire)
	if _, err := New().Decode(data); err == nil || !strings.Contains(err.Error(), "buffered stdio only") {
		t.Fatalf("unexpected stream mode result: %v", err)
	}
}

func TestDecodeReadOnlyNetworkOff(t *testing.T) {
	workspace := t.TempDir()
	request, err := New().Decode(dimRequest(t, workspace, workspace, map[string]any{
		"mode": "read-only", "disableNetwork": true, "allowedDomains": []string{"*"},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !request.WorkspaceReadOnly || request.Network != agentadapter.NetworkOff {
		t.Fatalf("unexpected policy mapping: %+v", request)
	}
}

func TestDecodeRejectsEscapesAndUnsupportedAuthority(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	tests := []struct {
		name      string
		cwd       string
		overrides map[string]any
		command   []string
	}{
		{name: "cwd escape", cwd: outside},
		{name: "root escape", cwd: workspace, overrides: map[string]any{"readableRoots": []string{workspace, outside}}},
		{name: "narrow writable root", cwd: workspace, overrides: map[string]any{"writableRoots": []string{filepath.Join(workspace, "subdir")}}},
		{name: "process limit", cwd: workspace, overrides: map[string]any{"processLimit": map[string]any{"pids": 1}}},
		{name: "windows shell", cwd: workspace, command: []string{"powershell.exe", "-Command", "Get-ChildItem"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.name == "narrow writable root" {
				if err := os.Mkdir(filepath.Join(workspace, "subdir"), 0o700); err != nil && !os.IsExist(err) {
					t.Fatal(err)
				}
			}
			data := dimRequestWithCommand(t, workspace, test.cwd, test.overrides, test.command)
			if _, err := New().Decode(data); err == nil {
				t.Fatal("unsupported Dim request was accepted")
			}
		})
	}
}

func TestDecodeRejectsUnsupportedProtocolVersion(t *testing.T) {
	workspace := t.TempDir()
	data := dimRequest(t, workspace, workspace, nil)
	var wire map[string]any
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatal(err)
	}
	wire["version"] = 255
	data, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	if !New().Match(data) {
		t.Fatal("Dim request shape with unsupported version was not recognized")
	}
	if _, err := New().Decode(data); err == nil || !strings.Contains(err.Error(), "unsupported dim-sandbox runner protocol version") {
		t.Fatalf("unexpected version error: %v", err)
	}
}

func TestEncodeResultUsesDimWireContract(t *testing.T) {
	zero := 0
	request := agentadapter.Request{RequestID: "request-a", SourceCommand: []string{"/bin/zsh", "-lc", "pwd"}, SourceCWD: "/tmp/project"}
	result := agentadapter.Result{
		Stdout: "ok\n", ExitCode: &zero, WallTime: 1250 * time.Millisecond, Backend: "zapvm-daemon-cli/dim-sandbox-runner-v1",
		Diagnostics: []agentadapter.Diagnostic{{Level: "info", Code: "TEST", Message: "test"}},
	}
	var output bytes.Buffer
	if err := New().EncodeResult(&output, request, result); err != nil {
		t.Fatal(err)
	}
	var wire runnerResult
	if err := json.Unmarshal(output.Bytes(), &wire); err != nil {
		t.Fatal(err)
	}
	if wire.Version != 1 || wire.RequestID != "request-a" || wire.ExitCode == nil || *wire.ExitCode != 0 || wire.WallTimeMillis != 1250 || wire.Diagnostics[0].Code != "TEST" {
		t.Fatalf("unexpected Dim result: %+v", wire)
	}
}

func dimRequest(t *testing.T, workspace, cwd string, overrides map[string]any) []byte {
	t.Helper()
	return dimRequestWithCommand(t, workspace, cwd, overrides, nil)
}

func dimRequestWithCommand(t *testing.T, workspace, cwd string, overrides map[string]any, command []string) []byte {
	t.Helper()
	policy := map[string]any{
		"enabled": true, "mode": "workspace-write", "workspaceRoot": workspace,
		"readableRoots": []string{workspace}, "writableRoots": []string{workspace},
		"readDenyPaths": []string{"**/.env"}, "allowedDomains": []string{"*"},
		"envAllowlist": []string{"PATH"}, "timeoutMs": 90000,
	}
	for key, value := range overrides {
		policy[key] = value
	}
	if command == nil {
		command = []string{"/bin/zsh", "-lc", "go test ./..."}
	}
	wire := map[string]any{
		"version": 1, "requestId": "request-a", "command": command, "cwd": cwd,
		"env": map[string]string{"PATH": "/host/bin"}, "policy": policy,
		"stdio": map[string]string{"mode": "buffered"},
	}
	data, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
