// Package acpclient implements the Guest-side Agent Client Protocol runtime.
// It deliberately depends only on the ACP JSON-RPC contract so signed Agent
// packages can be upgraded independently of the zapVM Runtime image.
package acpclient

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"zapvm/internal/workspacefs"
)

const (
	ProtocolVersion = 1
	MaxMessageSize  = 4 << 20
	MaxPromptSize   = 256 << 10
	MaxTerminalOut  = 1 << 20
)

var environmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

type Config struct {
	AgentPath   string
	Workspace   string
	StateDir    string
	Prompt      string
	Continue    bool
	Model       string
	Env         []string
	TerminalEnv []string
	Output      io.Writer
	Stderr      io.Writer
}

type AgentInfo struct {
	Name    string `json:"name"`
	Title   string `json:"title,omitempty"`
	Version string `json:"version,omitempty"`
}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type runtime struct {
	config      Config
	command     *exec.Cmd
	input       io.WriteCloser
	scanner     *bufio.Scanner
	requestID   int64
	sessionID   string
	pendingID   string
	explorer    *workspacefs.Explorer
	terminals   map[string]*terminal
	terminalSeq uint64
}

type terminal struct {
	command   *exec.Cmd
	output    *boundedOutput
	done      chan struct{}
	exitCode  *int
	signal    string
	waitError error
	mu        sync.Mutex
}

type boundedOutput struct {
	mu        sync.Mutex
	data      []byte
	limit     int
	truncated bool
}

func Run(ctx context.Context, config Config) (AgentInfo, error) {
	if ctx == nil {
		return AgentInfo{}, errors.New("ACP context is required")
	}
	if config.AgentPath == "" || !filepath.IsAbs(config.AgentPath) || config.Workspace == "" || !filepath.IsAbs(config.Workspace) ||
		config.StateDir == "" || !filepath.IsAbs(config.StateDir) || config.Output == nil || config.Stderr == nil {
		return AgentInfo{}, errors.New("ACP runtime paths and writers are required")
	}
	if config.Prompt == "" || len(config.Prompt) > MaxPromptSize || !utf8.ValidString(config.Prompt) || strings.IndexByte(config.Prompt, 0) >= 0 {
		return AgentInfo{}, errors.New("ACP prompt is invalid")
	}
	explorer, err := workspacefs.New(config.Workspace)
	if err != nil {
		return AgentInfo{}, err
	}
	runtime := &runtime{config: config, explorer: explorer, terminals: make(map[string]*terminal)}
	defer runtime.releaseAll()
	if err := runtime.start(ctx); err != nil {
		return AgentInfo{}, err
	}
	defer func() {
		_ = runtime.input.Close()
		if runtime.command.Process != nil {
			_ = runtime.command.Process.Kill()
		}
		_ = runtime.command.Wait()
	}()
	info, resume, err := runtime.initialize(ctx)
	if err != nil {
		return AgentInfo{}, err
	}
	if err := runtime.emit(map[string]any{"type": "system", "subtype": "init", "protocol": "acp", "protocol_version": ProtocolVersion, "model": config.Model, "agent": info}); err != nil {
		return AgentInfo{}, err
	}
	if err := runtime.openSession(ctx, resume); err != nil {
		return AgentInfo{}, err
	}
	result, err := runtime.call(ctx, "session/prompt", map[string]any{
		"sessionId": runtime.sessionID,
		"prompt":    []map[string]any{{"type": "text", "text": config.Prompt}},
	})
	if err != nil {
		_ = runtime.emit(map[string]any{"type": "error", "message": err.Error()})
		return AgentInfo{}, err
	}
	var promptResult struct {
		StopReason string `json:"stopReason"`
	}
	if err := json.Unmarshal(result, &promptResult); err != nil || promptResult.StopReason == "" {
		return AgentInfo{}, errors.New("ACP Agent returned an invalid prompt result")
	}
	if err := runtime.emit(map[string]any{"type": "result", "ok": true, "stop_reason": promptResult.StopReason}); err != nil {
		return AgentInfo{}, err
	}
	return info, nil
}

func (runtime *runtime) start(ctx context.Context) error {
	info, err := os.Lstat(runtime.config.AgentPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o111 == 0 {
		return errors.New("ACP Agent entrypoint is unavailable")
	}
	runtime.command = exec.CommandContext(ctx, runtime.config.AgentPath, "acp")
	runtime.command.Dir = runtime.config.Workspace
	runtime.command.Env = runtime.config.Env
	runtime.command.Stderr = runtime.config.Stderr
	stdout, err := runtime.command.StdoutPipe()
	if err != nil {
		return errors.New("prepare ACP Agent stdout")
	}
	runtime.input, err = runtime.command.StdinPipe()
	if err != nil {
		return errors.New("prepare ACP Agent stdin")
	}
	if err := runtime.command.Start(); err != nil {
		return fmt.Errorf("start ACP Agent: %w", err)
	}
	runtime.scanner = bufio.NewScanner(stdout)
	runtime.scanner.Buffer(make([]byte, 64<<10), MaxMessageSize)
	return nil
}

func (runtime *runtime) initialize(ctx context.Context) (AgentInfo, bool, error) {
	result, err := runtime.call(ctx, "initialize", map[string]any{
		"protocolVersion": ProtocolVersion,
		"clientCapabilities": map[string]any{
			"fs":       map[string]bool{"readTextFile": true, "writeTextFile": true},
			"terminal": true,
		},
		"clientInfo": map[string]string{"name": "zapvm", "title": "zapVM Agent Computer", "version": "1"},
	})
	if err != nil {
		return AgentInfo{}, false, err
	}
	var response struct {
		ProtocolVersion   int       `json:"protocolVersion"`
		AgentInfo         AgentInfo `json:"agentInfo"`
		AgentCapabilities struct {
			SessionCapabilities struct {
				Resume json.RawMessage `json:"resume"`
			} `json:"sessionCapabilities"`
		} `json:"agentCapabilities"`
	}
	if err := json.Unmarshal(result, &response); err != nil || response.ProtocolVersion != ProtocolVersion || response.AgentInfo.Name == "" {
		return AgentInfo{}, false, errors.New("ACP Agent returned an incompatible initialize response")
	}
	return response.AgentInfo, len(response.AgentCapabilities.SessionCapabilities.Resume) > 0 && string(response.AgentCapabilities.SessionCapabilities.Resume) != "null", nil
}

func (runtime *runtime) openSession(ctx context.Context, resumeSupported bool) error {
	stored, _ := runtime.loadSessionID()
	if runtime.config.Continue && stored != "" {
		if !resumeSupported {
			return errors.New("ACP Agent does not support session/resume")
		}
		runtime.sessionID = stored
		_, err := runtime.call(ctx, "session/resume", map[string]any{"sessionId": stored, "cwd": runtime.config.Workspace, "mcpServers": []any{}})
		if err != nil {
			runtime.sessionID = ""
			return fmt.Errorf("resume ACP session: %w", err)
		}
		return nil
	}
	result, err := runtime.call(ctx, "session/new", map[string]any{"cwd": runtime.config.Workspace, "mcpServers": []any{}})
	if err != nil {
		return fmt.Errorf("create ACP session: %w", err)
	}
	var response struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(result, &response); err != nil || !validSessionID(response.SessionID) {
		return errors.New("ACP Agent returned an invalid session ID")
	}
	if runtime.pendingID != "" && runtime.pendingID != response.SessionID {
		return errors.New("ACP Agent changed session ID while creating the session")
	}
	runtime.sessionID = response.SessionID
	runtime.pendingID = ""
	return runtime.saveSessionID(response.SessionID)
}

func (runtime *runtime) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := atomic.AddInt64(&runtime.requestID, 1)
	message := map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}
	if err := runtime.write(message); err != nil {
		return nil, err
	}
	wanted := strconv.FormatInt(id, 10)
	for runtime.scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		line := append([]byte(nil), runtime.scanner.Bytes()...)
		var incoming rpcMessage
		if err := json.Unmarshal(line, &incoming); err != nil || incoming.JSONRPC != "2.0" {
			return nil, errors.New("ACP Agent emitted malformed JSON-RPC")
		}
		if incoming.Method != "" {
			if len(incoming.ID) == 0 {
				if err := runtime.notification(incoming.Method, incoming.Params); err != nil {
					return nil, err
				}
				continue
			}
			if err := runtime.request(ctx, incoming); err != nil {
				return nil, err
			}
			continue
		}
		if strings.TrimSpace(string(incoming.ID)) != wanted {
			return nil, errors.New("ACP Agent returned an unexpected response ID")
		}
		if incoming.Error != nil {
			return nil, fmt.Errorf("ACP %s failed: %s", method, incoming.Error.Message)
		}
		if incoming.Result == nil {
			return nil, errors.New("ACP Agent response has no result")
		}
		return incoming.Result, nil
	}
	if err := runtime.scanner.Err(); err != nil {
		return nil, fmt.Errorf("read ACP Agent response: %w", err)
	}
	return nil, errors.New("ACP Agent closed the protocol stream")
}

func (runtime *runtime) notification(method string, params json.RawMessage) error {
	if method != "session/update" {
		return nil
	}
	var notification struct {
		SessionID string         `json:"sessionId"`
		Update    map[string]any `json:"update"`
	}
	if err := json.Unmarshal(params, &notification); err != nil || !validSessionID(notification.SessionID) {
		return errors.New("ACP Agent emitted an invalid session update")
	}
	if runtime.sessionID == "" {
		if runtime.pendingID != "" && runtime.pendingID != notification.SessionID {
			return errors.New("ACP Agent emitted updates for multiple pending sessions")
		}
		runtime.pendingID = notification.SessionID
	} else if notification.SessionID != runtime.sessionID {
		return errors.New("ACP Agent emitted an update for another session")
	}
	return runtime.normalizeUpdate(notification.Update)
}

func validSessionID(value string) bool {
	return value != "" && len(value) <= 512 && utf8.ValidString(value) && strings.IndexByte(value, 0) < 0
}

func (runtime *runtime) request(ctx context.Context, message rpcMessage) error {
	var result any
	var err error
	switch message.Method {
	case "session/request_permission":
		result, err = runtime.permission(message.Params)
	case "fs/read_text_file":
		result, err = runtime.readText(message.Params)
	case "fs/write_text_file":
		result, err = runtime.writeText(message.Params)
	case "terminal/create":
		result, err = runtime.createTerminal(ctx, message.Params)
	case "terminal/output":
		result, err = runtime.terminalOutput(message.Params)
	case "terminal/wait_for_exit":
		result, err = runtime.waitTerminal(ctx, message.Params)
	case "terminal/kill":
		result, err = runtime.killTerminal(message.Params)
	case "terminal/release":
		result, err = runtime.releaseTerminal(message.Params)
	default:
		err = fmt.Errorf("unsupported ACP client method %q", message.Method)
	}
	if err != nil {
		return runtime.write(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(message.ID), "error": map[string]any{"code": -32000, "message": err.Error()}})
	}
	return runtime.write(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(message.ID), "result": result})
}

func (runtime *runtime) permission(params json.RawMessage) (any, error) {
	var request struct {
		SessionID string `json:"sessionId"`
		Options   []struct {
			OptionID string `json:"optionId"`
			Kind     string `json:"kind"`
		} `json:"options"`
	}
	if err := json.Unmarshal(params, &request); err != nil || request.SessionID != runtime.sessionID {
		return nil, errors.New("invalid ACP permission request")
	}
	for _, option := range request.Options {
		if option.Kind == "allow_once" && option.OptionID != "" {
			return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": option.OptionID}}, nil
		}
	}
	return nil, errors.New("ACP permission request has no one-shot grant")
}

func (runtime *runtime) readText(params json.RawMessage) (any, error) {
	var request struct {
		SessionID string `json:"sessionId"`
		Path      string `json:"path"`
		Line      *int   `json:"line"`
		Limit     *int   `json:"limit"`
	}
	if err := json.Unmarshal(params, &request); err != nil || request.SessionID != runtime.sessionID {
		return nil, errors.New("invalid ACP file read request")
	}
	relative, err := runtime.workspaceRelative(request.Path, false)
	if err != nil {
		return nil, err
	}
	file, err := runtime.explorer.Read(relative)
	if err != nil {
		return nil, err
	}
	content := string(file.Data)
	if request.Line != nil || request.Limit != nil {
		line := 1
		if request.Line != nil {
			line = *request.Line
		}
		limit := len(strings.Split(content, "\n"))
		if request.Limit != nil {
			limit = *request.Limit
		}
		if line < 1 || limit < 0 || limit > 100000 {
			return nil, errors.New("ACP file read range is invalid")
		}
		lines := strings.SplitAfter(content, "\n")
		start := line - 1
		if start > len(lines) {
			start = len(lines)
		}
		end := start + limit
		if end > len(lines) {
			end = len(lines)
		}
		content = strings.Join(lines[start:end], "")
	}
	return map[string]string{"content": content}, nil
}

func (runtime *runtime) writeText(params json.RawMessage) (any, error) {
	var request struct {
		SessionID string `json:"sessionId"`
		Path      string `json:"path"`
		Content   string `json:"content"`
	}
	if err := json.Unmarshal(params, &request); err != nil || request.SessionID != runtime.sessionID {
		return nil, errors.New("invalid ACP file write request")
	}
	relative, err := runtime.workspaceRelative(request.Path, false)
	if err != nil {
		return nil, err
	}
	if err := runtime.explorer.WriteText(relative, []byte(request.Content)); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

func (runtime *runtime) workspaceRelative(value string, allowRoot bool) (string, error) {
	if !filepath.IsAbs(value) || len(value) > 4096 || strings.IndexByte(value, 0) >= 0 {
		return "", errors.New("ACP workspace path must be absolute")
	}
	relative, err := filepath.Rel(runtime.config.Workspace, filepath.Clean(value))
	if err != nil {
		return "", errors.New("resolve ACP workspace path")
	}
	if relative == "." {
		if allowRoot {
			return "", nil
		}
		return "", errors.New("ACP workspace file path is required")
	}
	relative = filepath.ToSlash(relative)
	if err := workspacefs.ValidatePath(relative, allowRoot); err != nil {
		return "", err
	}
	return relative, nil
}

func (runtime *runtime) normalizeUpdate(update map[string]any) error {
	kind, _ := update["sessionUpdate"].(string)
	switch kind {
	case "agent_message_chunk":
		if text := contentText(update["content"]); text != "" {
			return runtime.emit(map[string]any{"type": "assistant", "delta": text})
		}
	case "agent_thought_chunk":
		if text := contentText(update["content"]); text != "" {
			return runtime.emit(map[string]any{"type": "observation", "detail": text, "source": "acp-thought"})
		}
	case "tool_call":
		return runtime.emit(map[string]any{"type": "tool_use", "id": update["toolCallId"], "name": update["title"], "input": update["rawInput"], "status": update["status"], "kind": update["kind"]})
	case "tool_call_update":
		status, _ := update["status"].(string)
		if status == "completed" || status == "failed" {
			return runtime.emit(map[string]any{"type": "tool_result", "id": update["toolCallId"], "ok": status == "completed", "output": update["rawOutput"], "content": update["content"], "status": status})
		}
		return runtime.emit(map[string]any{"type": "tool_use", "id": update["toolCallId"], "name": update["title"], "status": status})
	case "plan":
		return runtime.emit(map[string]any{"type": "observation", "detail": update["entries"], "source": "acp-plan"})
	}
	return nil
}

func contentText(value any) string {
	content, ok := value.(map[string]any)
	if !ok || content["type"] != "text" {
		return ""
	}
	text, _ := content["text"].(string)
	return text
}

func (runtime *runtime) write(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > MaxMessageSize {
		return errors.New("ACP JSON-RPC message exceeds the size limit")
	}
	data = append(data, '\n')
	_, err = runtime.input.Write(data)
	return err
}

func (runtime *runtime) emit(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	_, err = runtime.config.Output.Write(data)
	return err
}

func (runtime *runtime) sessionPath() string {
	return filepath.Join(runtime.config.StateDir, "acp-session.json")
}

func (runtime *runtime) loadSessionID() (string, error) {
	data, err := os.ReadFile(runtime.sessionPath())
	if err != nil {
		return "", err
	}
	var state struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(data, &state); err != nil || !validSessionID(state.SessionID) {
		return "", errors.New("stored ACP session is invalid")
	}
	return state.SessionID, nil
}

func (runtime *runtime) saveSessionID(sessionID string) error {
	if err := os.MkdirAll(runtime.config.StateDir, 0o700); err != nil {
		return errors.New("create ACP session state directory")
	}
	data, err := json.Marshal(map[string]string{"session_id": sessionID})
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(runtime.config.StateDir, ".acp-session-")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(append(data, '\n')); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, runtime.sessionPath())
}

func (output *boundedOutput) Write(data []byte) (int, error) {
	output.mu.Lock()
	defer output.mu.Unlock()
	original := len(data)
	output.data = append(output.data, data...)
	if len(output.data) > output.limit {
		overflow := len(output.data) - output.limit
		output.data = append([]byte(nil), output.data[overflow:]...)
		for len(output.data) > 0 && !utf8.Valid(output.data) {
			output.data = output.data[1:]
		}
		output.truncated = true
	}
	return original, nil
}

func (output *boundedOutput) snapshot() (string, bool) {
	output.mu.Lock()
	defer output.mu.Unlock()
	return string(output.data), output.truncated
}
