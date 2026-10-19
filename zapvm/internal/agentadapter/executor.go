package agentadapter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"zapvm/internal/workspacepolicy"
)

const (
	defaultOutputLimit = int64(8 << 20)
	maximumOutputLimit = int64(64 << 20)
)

type CLIExecutorOptions struct {
	Binary     string
	Endpoint   string
	PrefixArgs []string
	Env        []string
}

// CLIExecutor deliberately uses the public zapvm daemon CLI instead of the
// owner-only daemon codec. External adapters therefore receive Computer-level
// execution capability without importing VMM or Guest RPC authority.
type CLIExecutor struct {
	options CLIExecutorOptions
}

func NewCLIExecutor(options CLIExecutorOptions) (*CLIExecutor, error) {
	if strings.TrimSpace(options.Binary) == "" {
		return nil, errors.New("zapvm executable is required")
	}
	return &CLIExecutor{options: options}, nil
}

func (executor *CLIExecutor) Execute(ctx context.Context, request Request) Result {
	started := time.Now()
	result := Result{Backend: "zapvm-daemon-cli/" + request.Protocol}
	if err := validateExecutionRequest(request); err != nil {
		code := 64
		result.ExitCode = &code
		result.Stderr = err.Error()
		result.WallTime = time.Since(started)
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Level: "error", Code: "ADAPTER_REQUEST_INVALID", Message: err.Error(),
		})
		return result
	}

	args := append([]string(nil), executor.options.PrefixArgs...)
	args = append(args, buildDaemonExecArguments(request, executor.options.Endpoint)...)
	resultDirectory, resultDirectoryErr := os.MkdirTemp("", "zapvm-agent-adapter-result-")
	if resultDirectoryErr != nil {
		code := 69
		result.ExitCode = &code
		result.Stderr = resultDirectoryErr.Error()
		result.WallTime = time.Since(started)
		return result
	}
	defer os.RemoveAll(resultDirectory)
	resultPath := filepath.Join(resultDirectory, "result.json")
	separator := len(args) - len(request.Command) - 1
	args = append(args[:separator], append([]string{"--result-file", resultPath}, args[separator:]...)...)
	commandContext, cancel := context.WithTimeout(ctx, request.Timeout+30*time.Second)
	defer cancel()
	command := exec.CommandContext(commandContext, executor.options.Binary, args...)
	if executor.options.Env == nil {
		command.Env = os.Environ()
	} else {
		command.Env = append([]string(nil), executor.options.Env...)
	}
	stdout := newCaptureBuffer(resolveOutputLimit(request.StdoutLimit))
	stderr := newCaptureBuffer(resolveOutputLimit(request.StderrLimit))
	command.Stdout = stdout
	command.Stderr = stderr

	err := command.Run()
	result.Stdout = stdout.String()
	result.Stderr = stderr.String()
	result.WallTime = time.Since(started)
	result.Diagnostics = append(result.Diagnostics, request.Diagnostics...)
	if stdout.Truncated() {
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Level: "warning", Code: "STDOUT_TRUNCATED", Message: "stdout exceeded the adapter capture limit",
		})
	}
	if stderr.Truncated() {
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Level: "warning", Code: "STDERR_TRUNCATED", Message: "stderr exceeded the adapter capture limit",
		})
	}

	exitCode := 0
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			exitCode = exitError.ExitCode()
			if exitCode < 0 {
				exitCode = 1
			}
		} else {
			exitCode = 69
			if result.Stderr != "" && !strings.HasSuffix(result.Stderr, "\n") {
				result.Stderr += "\n"
			}
			result.Stderr += err.Error()
		}
	}
	result.ExitCode = &exitCode
	if data, readErr := os.ReadFile(resultPath); readErr == nil {
		var terminal struct {
			ExitCode *int `json:"exit_code"`
		}
		if decodeErr := json.Unmarshal(data, &terminal); decodeErr == nil && terminal.ExitCode != nil {
			result.ExitCode = terminal.ExitCode
		} else {
			result.Diagnostics = append(result.Diagnostics, Diagnostic{
				Level: "error", Code: "DAEMON_RESULT_INVALID", Message: "zapVM daemon returned an invalid structured result",
			})
		}
	} else if err != nil {
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Level: "warning", Code: "DAEMON_RESULT_UNAVAILABLE", Message: "zapVM daemon did not provide a structured Guest exit result",
		})
	}
	if errors.Is(commandContext.Err(), context.DeadlineExceeded) {
		result.TimedOut = true
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Level: "error", Code: "ADAPTER_TIMEOUT", Message: "zapVM adapter execution exceeded its deadline",
		})
	} else if errors.Is(commandContext.Err(), context.Canceled) {
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Level: "info", Code: "ADAPTER_CANCELED", Message: "zapVM adapter execution was canceled",
		})
	}
	return result
}

func buildDaemonExecArguments(request Request, endpoint string) []string {
	args := []string{"daemon", "exec"}
	if endpoint != "" {
		args = append(args, "--endpoint", endpoint)
	}
	args = append(args,
		"--workspace", request.Workspace,
		"--network", string(request.Network),
		"--session-id", request.SessionID,
		"--cwd", request.CWD,
		"--exec-timeout", request.Timeout.String(),
	)
	if request.WorkspaceReadOnly {
		args = append(args, "--workspace-read-only")
	}
	for _, domain := range request.AllowedDomains {
		args = append(args, "--allow-domain", domain)
	}
	for _, port := range request.AllowedPorts {
		args = append(args, "--allow-port", strconv.FormatUint(uint64(port), 10))
	}
	for _, pattern := range request.DeniedWorkspacePatterns {
		args = append(args, "--deny-workspace-pattern", pattern)
	}
	args = append(args, "--")
	return append(args, request.Command...)
}

func validateExecutionRequest(request Request) error {
	if request.RequestID == "" || request.SessionID == "" {
		return errors.New("adapter request and Session IDs are required")
	}
	if !filepath.IsAbs(request.Workspace) {
		return errors.New("adapter workspace must be absolute")
	}
	if request.CWD == "" || filepath.IsAbs(request.CWD) || request.CWD == ".." || strings.HasPrefix(request.CWD, ".."+string(filepath.Separator)) {
		return errors.New("adapter Guest cwd must stay relative to the workspace")
	}
	if len(request.Command) == 0 || request.Command[0] == "" {
		return errors.New("adapter command is required")
	}
	for _, argument := range request.Command {
		if strings.IndexByte(argument, 0) >= 0 || !utf8.ValidString(argument) {
			return errors.New("adapter command contains an invalid argument")
		}
	}
	if request.Timeout < time.Millisecond || request.Timeout > 24*time.Hour {
		return errors.New("adapter timeout must be between 1ms and 24h")
	}
	if err := workspacepolicy.ValidateDeniedPatterns(request.DeniedWorkspacePatterns); err != nil {
		return err
	}
	switch request.Network {
	case NetworkOff, NetworkUnrestricted:
		if len(request.AllowedDomains) != 0 || len(request.AllowedPorts) != 0 {
			return errors.New("adapter network allow rules require restricted mode")
		}
	case NetworkRestricted:
		if len(request.AllowedDomains) == 0 {
			return errors.New("adapter restricted network requires allowed domains")
		}
	default:
		return errors.New("adapter network mode is invalid")
	}
	return nil
}

func resolveOutputLimit(value int64) int64 {
	if value <= 0 {
		return defaultOutputLimit
	}
	if value > maximumOutputLimit {
		return maximumOutputLimit
	}
	return value
}

type captureBuffer struct {
	mu        sync.Mutex
	buffer    bytes.Buffer
	limit     int64
	written   int64
	truncated bool
}

func newCaptureBuffer(limit int64) *captureBuffer {
	return &captureBuffer{limit: limit}
}

func (buffer *captureBuffer) Write(data []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	buffer.written += int64(len(data))
	remaining := buffer.limit - int64(buffer.buffer.Len())
	if remaining > 0 {
		count := int64(len(data))
		if count > remaining {
			count = remaining
		}
		_, _ = buffer.buffer.Write(data[:count])
	}
	if buffer.written > buffer.limit {
		buffer.truncated = true
	}
	return len(data), nil
}

func (buffer *captureBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.String()
}

func (buffer *captureBuffer) Truncated() bool {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.truncated
}

func ResolveZapVMBinary(explicit string) (string, error) {
	if explicit != "" {
		if !filepath.IsAbs(explicit) {
			return "", errors.New("ZAPVM_BIN must be an absolute path")
		}
		return explicit, nil
	}
	executable, err := os.Executable()
	if err == nil {
		name := "zapvm"
		if filepath.Ext(executable) == ".exe" {
			name += ".exe"
		}
		candidate := filepath.Join(filepath.Dir(executable), name)
		if info, statErr := os.Stat(candidate); statErr == nil && info.Mode().IsRegular() && (runtime.GOOS == "windows" || info.Mode().Perm()&0o111 != 0) {
			return candidate, nil
		}
	}
	resolved, err := exec.LookPath("zapvm")
	if err != nil {
		return "", fmt.Errorf("locate zapvm executable: %w", err)
	}
	return resolved, nil
}
