package agentadapter

import (
	"context"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestBuildDaemonExecArgumentsPreservesAuthorityAndArgv(t *testing.T) {
	request := Request{
		Workspace: "/work/project", WorkspaceReadOnly: true,
		Network: NetworkRestricted, AllowedDomains: []string{"example.com"}, AllowedPorts: []uint16{443},
		DeniedWorkspacePatterns: []string{"**/.env"},
		SessionID:               "session-a", CWD: "subdir", Timeout: 2 * time.Minute,
		Command: []string{"/bin/sh", "-lc", "printf '%s' hello"},
	}
	want := []string{
		"daemon", "exec", "--endpoint", "/tmp/zapvm.sock", "--workspace", "/work/project",
		"--network", "restricted", "--session-id", "session-a", "--cwd", "subdir",
		"--exec-timeout", "2m0s", "--workspace-read-only", "--allow-domain", "example.com",
		"--allow-port", "443", "--deny-workspace-pattern", "**/.env", "--", "/bin/sh", "-lc", "printf '%s' hello",
	}
	if got := buildDaemonExecArguments(request, "/tmp/zapvm.sock"); !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected daemon arguments:\n got: %q\nwant: %q", got, want)
	}
}

func TestCLIExecutorUsesStructuredGuestExitCode(t *testing.T) {
	executor, err := NewCLIExecutor(CLIExecutorOptions{
		Binary: os.Args[0], PrefixArgs: []string{"-test.run=TestCLIExecutorHelper", "--"},
		Env: append(os.Environ(), "GO_WANT_ADAPTER_HELPER=1", "ADAPTER_HELPER_GUEST_EXIT=23"),
	})
	if err != nil {
		t.Fatal(err)
	}
	result := executor.Execute(context.Background(), Request{
		Protocol: "test-v1", RequestID: "request-a", SessionID: "session-a",
		Workspace: t.TempDir(), Network: NetworkOff, Command: []string{"false"}, CWD: ".", Timeout: time.Minute,
	})
	if result.ExitCode == nil || *result.ExitCode != 23 {
		t.Fatalf("structured Guest exit code was not preserved: %+v", result)
	}
	if result.Stderr != "helper stderr" {
		t.Fatalf("Guest stderr was not preserved: %q", result.Stderr)
	}
}

func TestCLIExecutorCapturesResultAndDiagnostics(t *testing.T) {
	executor, err := NewCLIExecutor(CLIExecutorOptions{
		Binary: os.Args[0], PrefixArgs: []string{"-test.run=TestCLIExecutorHelper", "--"},
		Env: append(os.Environ(), "GO_WANT_ADAPTER_HELPER=1", "ADAPTER_HELPER_EXIT=7"),
	})
	if err != nil {
		t.Fatal(err)
	}
	request := Request{
		Protocol: "test-v1", RequestID: "request-a", SessionID: "session-a",
		Workspace: t.TempDir(), Network: NetworkOff, Command: []string{"echo", "hello"},
		CWD: ".", Timeout: time.Minute, StdoutLimit: 4, StderrLimit: 32,
		Diagnostics: []Diagnostic{{Level: "info", Code: "SOURCE", Message: "source diagnostic"}},
	}
	result := executor.Execute(context.Background(), request)
	if result.ExitCode == nil || *result.ExitCode != 7 {
		t.Fatalf("unexpected exit code: %+v", result.ExitCode)
	}
	if result.Stdout != "help" || !strings.Contains(result.Stderr, "helper stderr") {
		t.Fatalf("unexpected captured output: stdout=%q stderr=%q", result.Stdout, result.Stderr)
	}
	codes := make(map[string]bool)
	for _, diagnostic := range result.Diagnostics {
		codes[diagnostic.Code] = true
	}
	if !codes["SOURCE"] || !codes["STDOUT_TRUNCATED"] {
		t.Fatalf("missing diagnostics: %+v", result.Diagnostics)
	}
}

func TestCLIExecutorHelper(t *testing.T) {
	if os.Getenv("GO_WANT_ADAPTER_HELPER") != "1" {
		return
	}
	if os.Getenv("ADAPTER_HELPER_GUEST_EXIT") == "23" {
		for index, argument := range os.Args {
			if argument == "--result-file" && index+1 < len(os.Args) {
				if err := os.WriteFile(os.Args[index+1], []byte(`{"exit_code":23}`), 0o600); err != nil {
					os.Exit(70)
				}
				_, _ = os.Stderr.WriteString("helper stderr")
				os.Exit(1)
			}
		}
		os.Exit(71)
	}
	_, _ = os.Stdout.WriteString("helper stdout")
	_, _ = os.Stderr.WriteString("helper stderr")
	code := 0
	if os.Getenv("ADAPTER_HELPER_EXIT") == "7" {
		code = 7
	}
	os.Exit(code)
}
