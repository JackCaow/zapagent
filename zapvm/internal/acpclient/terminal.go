package acpclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"unicode/utf8"
)

type terminalReference struct {
	SessionID  string `json:"sessionId"`
	TerminalID string `json:"terminalId"`
}

func (runtime *runtime) createTerminal(ctx context.Context, params json.RawMessage) (any, error) {
	var request struct {
		SessionID       string   `json:"sessionId"`
		Command         string   `json:"command"`
		Args            []string `json:"args"`
		Cwd             *string  `json:"cwd"`
		OutputByteLimit *int     `json:"outputByteLimit"`
		Env             []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"env"`
	}
	if err := json.Unmarshal(params, &request); err != nil || request.SessionID != runtime.sessionID ||
		request.Command == "" || len(request.Command) > 4096 || strings.IndexByte(request.Command, 0) >= 0 || len(request.Args) > 1024 {
		return nil, errors.New("invalid ACP terminal create request")
	}
	for _, argument := range request.Args {
		if len(argument) > 1<<20 || !utf8.ValidString(argument) || strings.IndexByte(argument, 0) >= 0 {
			return nil, errors.New("ACP terminal argument is invalid")
		}
	}
	cwd := runtime.config.Workspace
	if request.Cwd != nil && *request.Cwd != "" {
		relative, err := runtime.workspaceRelative(*request.Cwd, true)
		if err != nil {
			return nil, err
		}
		if relative != "" {
			if _, err := runtime.explorer.List(relative); err != nil {
				return nil, errors.New("ACP terminal working directory is unavailable")
			}
			cwd = filepath.Join(runtime.config.Workspace, filepath.FromSlash(relative))
		}
	}
	limit := 64 << 10
	if request.OutputByteLimit != nil {
		limit = *request.OutputByteLimit
	}
	if limit < 1 || limit > MaxTerminalOut {
		return nil, errors.New("ACP terminal output limit is invalid")
	}
	environment, err := terminalEnvironment(runtime.config.TerminalEnv, request.Env)
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, request.Command, request.Args...)
	command.Dir = cwd
	command.Env = environment
	output := &boundedOutput{limit: limit}
	command.Stdout = output
	command.Stderr = output
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start ACP terminal: %w", err)
	}
	id := "terminal-" + strconv.FormatUint(atomicAdd(&runtime.terminalSeq), 10)
	terminal := &terminal{command: command, output: output, done: make(chan struct{})}
	runtime.terminals[id] = terminal
	go terminal.wait()
	return map[string]string{"terminalId": id}, nil
}

func atomicAdd(value *uint64) uint64 {
	return atomic.AddUint64(value, 1)
}

func terminalEnvironment(base []string, overrides []struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}) ([]string, error) {
	if len(overrides) > 64 {
		return nil, errors.New("ACP terminal environment exceeds the limit")
	}
	blocked := func(name string) bool {
		upper := strings.ToUpper(name)
		return strings.HasPrefix(upper, "ZAPVM_") || strings.HasPrefix(upper, "DIMCODE_") ||
			strings.Contains(upper, "CREDENTIAL") || strings.Contains(upper, "API_KEY") || strings.Contains(upper, "TOKEN") ||
			upper == "HOME" || upper == "PATH" || upper == "LD_PRELOAD" || upper == "DYLD_INSERT_LIBRARIES"
	}
	values := make(map[string]string, len(overrides))
	for _, variable := range overrides {
		if !environmentName.MatchString(variable.Name) || blocked(variable.Name) || len(variable.Value) > 64<<10 || strings.IndexByte(variable.Value, 0) >= 0 {
			return nil, errors.New("ACP terminal environment variable is invalid")
		}
		values[variable.Name] = variable.Value
	}
	result := make([]string, 0, len(base)+len(values))
	for _, entry := range base {
		name, _, found := strings.Cut(entry, "=")
		if found {
			if _, replaced := values[name]; replaced {
				continue
			}
		}
		result = append(result, entry)
	}
	for name, value := range values {
		result = append(result, name+"="+value)
	}
	return result, nil
}

func (terminal *terminal) wait() {
	err := terminal.command.Wait()
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	terminal.waitError = err
	if terminal.command.ProcessState != nil {
		code := terminal.command.ProcessState.ExitCode()
		terminal.exitCode = &code
		if status, ok := terminal.command.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			terminal.signal = status.Signal().String()
			terminal.exitCode = nil
		}
	}
	close(terminal.done)
}

func (runtime *runtime) terminalFor(params json.RawMessage) (*terminal, terminalReference, error) {
	var reference terminalReference
	if err := json.Unmarshal(params, &reference); err != nil || reference.SessionID != runtime.sessionID || reference.TerminalID == "" {
		return nil, reference, errors.New("invalid ACP terminal reference")
	}
	terminal := runtime.terminals[reference.TerminalID]
	if terminal == nil {
		return nil, reference, errors.New("ACP terminal is unavailable")
	}
	return terminal, reference, nil
}

func (runtime *runtime) terminalOutput(params json.RawMessage) (any, error) {
	terminal, _, err := runtime.terminalFor(params)
	if err != nil {
		return nil, err
	}
	output, truncated := terminal.output.snapshot()
	result := map[string]any{"output": output, "truncated": truncated}
	select {
	case <-terminal.done:
		result["exitStatus"] = terminal.exitStatus()
	default:
	}
	return result, nil
}

func (runtime *runtime) waitTerminal(ctx context.Context, params json.RawMessage) (any, error) {
	terminal, _, err := runtime.terminalFor(params)
	if err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-terminal.done:
		return terminal.exitStatus(), nil
	}
}

func (terminal *terminal) exitStatus() map[string]any {
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	result := map[string]any{}
	if terminal.exitCode != nil {
		result["exitCode"] = *terminal.exitCode
	} else {
		result["exitCode"] = nil
	}
	if terminal.signal != "" {
		result["signal"] = terminal.signal
	}
	return result
}

func (runtime *runtime) killTerminal(params json.RawMessage) (any, error) {
	terminal, _, err := runtime.terminalFor(params)
	if err != nil {
		return nil, err
	}
	select {
	case <-terminal.done:
		return map[string]any{}, nil
	default:
	}
	if terminal.command.Process == nil {
		return nil, errors.New("ACP terminal has no process")
	}
	if err := terminal.command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return nil, err
	}
	return map[string]any{}, nil
}

func (runtime *runtime) releaseTerminal(params json.RawMessage) (any, error) {
	terminal, reference, err := runtime.terminalFor(params)
	if err != nil {
		return nil, err
	}
	select {
	case <-terminal.done:
		delete(runtime.terminals, reference.TerminalID)
		return map[string]any{}, nil
	default:
		return nil, errors.New("ACP terminal is still running")
	}
}

func (runtime *runtime) releaseAll() {
	for id, terminal := range runtime.terminals {
		select {
		case <-terminal.done:
		default:
			if terminal.command.Process != nil {
				_ = terminal.command.Process.Kill()
			}
			<-terminal.done
		}
		delete(runtime.terminals, id)
	}
}
