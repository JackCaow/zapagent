// Package dim implements the Dim native sandbox runner protocol v1 as a zapVM
// Host adapter. It does not import Dim source code; the external JSON contract
// is intentionally kept at this boundary.
package dim

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"zapvm/internal/agentadapter"
	"zapvm/internal/workspacepolicy"
)

const (
	ProtocolName    = "dim-sandbox-runner-v1"
	ProtocolVersion = 1
	defaultTimeout  = time.Minute
)

type Protocol struct{}

func New() *Protocol { return &Protocol{} }

func (*Protocol) Name() string { return ProtocolName }

func (*Protocol) Match(data []byte) bool {
	var header struct {
		Version   int             `json:"version"`
		RequestID string          `json:"requestId"`
		Command   json.RawMessage `json:"command"`
		Policy    json.RawMessage `json:"policy"`
	}
	return json.Unmarshal(data, &header) == nil && header.RequestID != "" &&
		len(header.Command) != 0 && len(header.Policy) != 0
}

func (*Protocol) Decode(data []byte) (agentadapter.Request, error) {
	var wire runnerRequest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return agentadapter.Request{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return agentadapter.Request{}, errors.New("Dim runner request contains trailing JSON")
	}
	if wire.Version != ProtocolVersion {
		return agentadapter.Request{}, fmt.Errorf("unsupported dim-sandbox runner protocol version: %d", wire.Version)
	}
	if !validIdentifier(wire.RequestID) {
		return agentadapter.Request{}, errors.New("Dim runner request requires a valid requestId")
	}
	if wire.Stdio != nil && wire.Stdio.Mode != "buffered" {
		return agentadapter.Request{}, errors.New("Dim runner adapter currently supports buffered stdio only")
	}
	if !wire.Policy.Enabled || wire.Policy.Mode == "off" || wire.Policy.Mode == "danger-full-access" {
		return agentadapter.Request{}, errors.New("Dim adapter requires an enabled read-only or workspace-write policy")
	}
	if wire.Policy.Mode != "read-only" && wire.Policy.Mode != "workspace-write" {
		return agentadapter.Request{}, fmt.Errorf("unsupported Dim sandbox mode %q", wire.Policy.Mode)
	}
	if wire.Policy.CPULimit != nil || wire.Policy.MemoryLimit != nil || wire.Policy.ProcessLimit != nil || wire.Policy.BlockChildProcesses {
		return agentadapter.Request{}, errors.New("Dim resource and child-process limits cannot be represented by the zapVM daemon adapter")
	}

	workspace, cwd, err := normalizeWorkspace(wire.Policy.WorkspaceRoot, wire.CWD)
	if err != nil {
		return agentadapter.Request{}, err
	}
	if err := validateRoots(workspace, wire.Policy.ReadableRoots, "readable"); err != nil {
		return agentadapter.Request{}, err
	}
	if err := validateRoots(workspace, wire.Policy.WritableRoots, "writable"); err != nil {
		return agentadapter.Request{}, err
	}
	if !containsRoot(workspace, wire.Policy.ReadableRoots) {
		return agentadapter.Request{}, errors.New("Dim readableRoots must include the complete workspace for the zapVM mount")
	}
	if wire.Policy.Mode == "workspace-write" && !containsRoot(workspace, wire.Policy.WritableRoots) {
		return agentadapter.Request{}, errors.New("Dim writableRoots must include the complete workspace for a read-write zapVM mount")
	}
	if wire.Policy.OutputLimit != nil && (wire.Policy.OutputLimit.StdoutBytes < 0 || wire.Policy.OutputLimit.StderrBytes < 0) {
		return agentadapter.Request{}, errors.New("Dim output limits must not be negative")
	}
	command, commandDiagnostic, err := translateCommand(wire.Command)
	if err != nil {
		return agentadapter.Request{}, err
	}
	network, domains, ports, err := translateNetwork(wire.Policy)
	if err != nil {
		return agentadapter.Request{}, err
	}
	timeout, err := translateTimeout(wire.TimeoutMillis, wire.Policy.TimeoutMillis)
	if err != nil {
		return agentadapter.Request{}, err
	}
	deniedPatterns, ignoredDenyPaths, err := translateReadDenyPaths(workspace, wire.Policy.ReadDenyPaths)
	if err != nil {
		return agentadapter.Request{}, err
	}

	diagnostics := []agentadapter.Diagnostic{commandDiagnostic, {
		Level: "info", Code: "REQUEST_SCOPED_SESSION",
		Message: "Dim runner protocol v1 has no Session ID; the adapter uses a request-scoped Guest Session",
	}}
	if len(deniedPatterns) != 0 {
		diagnostics = append(diagnostics, agentadapter.Diagnostic{
			Level: "info", Code: "READ_DENY_PATHS_GUEST_ENFORCED",
			Message: "workspace readDenyPaths are masked inside the Guest mount namespace",
		})
	}
	if ignoredDenyPaths > 0 {
		diagnostics = append(diagnostics, agentadapter.Diagnostic{
			Level: "info", Code: "HOST_DENY_PATHS_ISOLATED",
			Message: "readDenyPaths outside the workspace are already isolated because Host paths are not mounted in the Guest",
			Details: map[string]any{"count": ignoredDenyPaths},
		})
	}
	if len(wire.Env) != 0 {
		diagnostics = append(diagnostics, agentadapter.Diagnostic{
			Level: "warning", Code: "HOST_ENV_IGNORED",
			Message: "Host environment values are not forwarded; the Guest uses zapVM's fixed safe environment",
		})
	}
	if wire.Policy.OutputLimit != nil && (wire.Policy.OutputLimit.StdoutBytes > 64<<20 || wire.Policy.OutputLimit.StderrBytes > 64<<20) {
		diagnostics = append(diagnostics, agentadapter.Diagnostic{
			Level: "warning", Code: "OUTPUT_LIMIT_CLAMPED",
			Message: "Dim output limits above 64 MiB are clamped by the adapter",
		})
	}

	return agentadapter.Request{
		RequestID:               wire.RequestID,
		SessionID:               requestSessionID(workspace, wire.RequestID),
		SourceCommand:           append([]string(nil), wire.Command...),
		SourceCWD:               wire.CWD,
		Workspace:               workspace,
		WorkspaceReadOnly:       wire.Policy.Mode == "read-only",
		Network:                 network,
		AllowedDomains:          domains,
		AllowedPorts:            ports,
		DeniedWorkspacePatterns: deniedPatterns,
		Command:                 command,
		CWD:                     cwd,
		Timeout:                 timeout,
		StdoutLimit:             outputLimit(wire.Policy.OutputLimit, true),
		StderrLimit:             outputLimit(wire.Policy.OutputLimit, false),
		Diagnostics:             diagnostics,
	}, nil
}

func translateReadDenyPaths(workspace string, values []string) ([]string, int, error) {
	patterns := make([]string, 0, len(values))
	ignored := 0
	home, _ := os.UserHomeDir()
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" {
			return nil, 0, errors.New("Dim readDenyPaths contains an empty path")
		}
		if strings.HasPrefix(value, "~/") && home != "" {
			value = filepath.Join(home, strings.TrimPrefix(value, "~/"))
		}
		if filepath.IsAbs(value) {
			clean := filepath.Clean(value)
			relative, err := filepath.Rel(workspace, clean)
			if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
				ignored++
				continue
			}
			value = filepath.ToSlash(relative)
		} else {
			value = filepath.ToSlash(value)
		}
		patterns = append(patterns, value)
	}
	if err := workspacepolicy.ValidateDeniedPatterns(patterns); err != nil {
		return nil, 0, fmt.Errorf("invalid Dim workspace readDenyPaths: %w", err)
	}
	return patterns, ignored, nil
}

func (*Protocol) EncodeResult(output io.Writer, request agentadapter.Request, result agentadapter.Result) error {
	diagnostics := make([]runnerDiagnostic, 0, len(result.Diagnostics))
	for _, diagnostic := range result.Diagnostics {
		diagnostics = append(diagnostics, runnerDiagnostic{
			Level: diagnostic.Level, Code: diagnostic.Code, Message: diagnostic.Message, Details: diagnostic.Details,
		})
	}
	wire := runnerResult{
		Version: ProtocolVersion, RequestID: request.RequestID,
		Command: append([]string(nil), request.SourceCommand...), CWD: request.SourceCWD,
		Stdout: result.Stdout, Stderr: result.Stderr, ExitCode: result.ExitCode,
		Signal: result.Signal, TimedOut: result.TimedOut, WallTimeMillis: result.WallTime.Milliseconds(),
		Backend: result.Backend, Diagnostics: diagnostics,
	}
	return json.NewEncoder(output).Encode(wire)
}

type runnerRequest struct {
	Version       int               `json:"version"`
	RequestID     string            `json:"requestId"`
	Command       []string          `json:"command"`
	CWD           string            `json:"cwd"`
	Env           map[string]string `json:"env,omitempty"`
	Policy        sandboxPolicy     `json:"policy"`
	TimeoutMillis int64             `json:"timeoutMs,omitempty"`
	Stdio         *stdioMode        `json:"stdio,omitempty"`
}

type stdioMode struct {
	Mode string `json:"mode"`
}

type sandboxPolicy struct {
	Enabled             bool             `json:"enabled"`
	Mode                string           `json:"mode"`
	WorkspaceRoot       string           `json:"workspaceRoot"`
	ReadableRoots       []string         `json:"readableRoots"`
	WritableRoots       []string         `json:"writableRoots"`
	ReadDenyPaths       []string         `json:"readDenyPaths"`
	AllowedDomains      []string         `json:"allowedDomains"`
	EnvAllowlist        []string         `json:"envAllowlist"`
	TimeoutMillis       int64            `json:"timeoutMs,omitempty"`
	CPULimit            *resourceLimit   `json:"cpuLimit,omitempty"`
	MemoryLimit         *resourceLimit   `json:"memoryLimit,omitempty"`
	ProcessLimit        *processLimit    `json:"processLimit,omitempty"`
	OutputLimit         *outputLimitSpec `json:"outputLimit,omitempty"`
	DisableNetwork      bool             `json:"disableNetwork,omitempty"`
	BlockChildProcesses bool             `json:"blockChildProcesses,omitempty"`
}

type resourceLimit struct {
	Cores int64 `json:"cores,omitempty"`
	Bytes int64 `json:"bytes,omitempty"`
}

type processLimit struct {
	PIDs int64 `json:"pids,omitempty"`
}

type outputLimitSpec struct {
	StdoutBytes int64 `json:"stdoutBytes,omitempty"`
	StderrBytes int64 `json:"stderrBytes,omitempty"`
}

type runnerDiagnostic struct {
	Level   string         `json:"level"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

type runnerResult struct {
	Version        int                `json:"version"`
	RequestID      string             `json:"requestId"`
	Command        []string           `json:"command"`
	CWD            string             `json:"cwd"`
	Stdout         string             `json:"stdout"`
	Stderr         string             `json:"stderr"`
	ExitCode       *int               `json:"exitCode,omitempty"`
	Signal         string             `json:"signal,omitempty"`
	TimedOut       bool               `json:"timedOut,omitempty"`
	WallTimeMillis int64              `json:"wallTimeMs"`
	Backend        string             `json:"backend,omitempty"`
	Diagnostics    []runnerDiagnostic `json:"diagnostics,omitempty"`
}

func normalizeWorkspace(root, requestedCWD string) (string, string, error) {
	if !filepath.IsAbs(root) || root == "" {
		return "", "", errors.New("Dim workspaceRoot must be absolute")
	}
	workspace, err := filepath.EvalSymlinks(filepath.Clean(root))
	if err != nil {
		return "", "", fmt.Errorf("resolve Dim workspaceRoot: %w", err)
	}
	candidate := requestedCWD
	if candidate == "" || candidate == "." {
		candidate = workspace
	} else if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(workspace, candidate)
	}
	candidate, err = filepath.EvalSymlinks(filepath.Clean(candidate))
	if err != nil {
		return "", "", fmt.Errorf("resolve Dim cwd: %w", err)
	}
	relative, err := filepath.Rel(workspace, candidate)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", "", errors.New("Dim cwd escapes workspaceRoot")
	}
	return workspace, filepath.ToSlash(relative), nil
}

func validateRoots(workspace string, roots []string, kind string) error {
	for _, root := range roots {
		if !filepath.IsAbs(root) {
			return fmt.Errorf("Dim %s root must be absolute", kind)
		}
		resolved, err := filepath.EvalSymlinks(filepath.Clean(root))
		if err != nil {
			return fmt.Errorf("resolve Dim %s root: %w", kind, err)
		}
		relative, err := filepath.Rel(workspace, resolved)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return fmt.Errorf("Dim %s root escapes workspaceRoot", kind)
		}
	}
	return nil
}

func containsRoot(workspace string, roots []string) bool {
	for _, root := range roots {
		resolved, err := filepath.EvalSymlinks(filepath.Clean(root))
		if err == nil && resolved == workspace {
			return true
		}
	}
	return false
}

func translateCommand(command []string) ([]string, agentadapter.Diagnostic, error) {
	if len(command) == 0 || command[0] == "" {
		return nil, agentadapter.Diagnostic{}, errors.New("Dim command is required")
	}
	for _, argument := range command {
		if strings.IndexByte(argument, 0) >= 0 || !utf8.ValidString(argument) {
			return nil, agentadapter.Diagnostic{}, errors.New("Dim command contains an invalid argument")
		}
	}
	shell := strings.ToLower(filepath.Base(command[0]))
	switch shell {
	case "sh", "bash", "zsh", "dash", "ksh":
		if len(command) != 3 || command[1] != "-lc" {
			return nil, agentadapter.Diagnostic{}, errors.New("Dim POSIX shell command must use exactly -lc <script>")
		}
		return []string{"/bin/sh", "-lc", command[2]}, agentadapter.Diagnostic{
			Level: "info", Code: "HOST_SHELL_TRANSLATED", Message: "Host POSIX shell was translated to /bin/sh in the Linux Guest",
		}, nil
	case "pwsh", "pwsh.exe", "powershell", "powershell.exe", "cmd", "cmd.exe":
		return nil, agentadapter.Diagnostic{}, errors.New("Dim Windows shell syntax cannot be safely translated to the Linux Guest")
	default:
		return append([]string(nil), command...), agentadapter.Diagnostic{
			Level: "info", Code: "STRUCTURED_ARGV_PRESERVED", Message: "structured command argv was forwarded without Host shell evaluation",
		}, nil
	}
}

func translateNetwork(policy sandboxPolicy) (agentadapter.NetworkMode, []string, []uint16, error) {
	if policy.DisableNetwork || len(policy.AllowedDomains) == 0 {
		return agentadapter.NetworkOff, nil, nil, nil
	}
	domains := make([]string, 0, len(policy.AllowedDomains))
	seen := make(map[string]struct{}, len(policy.AllowedDomains))
	for _, input := range policy.AllowedDomains {
		domain := strings.TrimSpace(strings.ToLower(input))
		if domain == "" {
			return "", nil, nil, errors.New("Dim allowedDomains contains an empty value")
		}
		if _, exists := seen[domain]; !exists {
			seen[domain] = struct{}{}
			domains = append(domains, domain)
		}
	}
	if _, unrestricted := seen["*"]; unrestricted {
		if len(domains) != 1 {
			return "", nil, nil, errors.New("Dim wildcard network access cannot be combined with domain rules")
		}
		return agentadapter.NetworkUnrestricted, nil, nil, nil
	}
	return agentadapter.NetworkRestricted, domains, []uint16{443}, nil
}

func translateTimeout(request, policy int64) (time.Duration, error) {
	milliseconds := request
	if milliseconds == 0 {
		milliseconds = policy
	}
	if milliseconds == 0 {
		return defaultTimeout, nil
	}
	if milliseconds < 1 || milliseconds > (24*time.Hour).Milliseconds() {
		return 0, errors.New("Dim timeout must be between 1ms and 24h")
	}
	return time.Duration(milliseconds) * time.Millisecond, nil
}

func outputLimit(limit *outputLimitSpec, stdout bool) int64 {
	if limit == nil {
		return 0
	}
	if stdout {
		return limit.StdoutBytes
	}
	return limit.StderrBytes
}

func requestSessionID(workspace, requestID string) string {
	digest := sha256.Sum256([]byte(workspace + "\x00" + requestID))
	return "dim-" + hex.EncodeToString(digest[:12])
}

func validIdentifier(value string) bool {
	return value != "" && len(value) <= 256 && utf8.ValidString(value) && strings.IndexByte(value, 0) < 0
}
