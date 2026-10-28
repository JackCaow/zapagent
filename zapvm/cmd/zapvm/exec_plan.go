package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"zapvm/internal/agent"
	"zapvm/internal/credential"
	"zapvm/internal/daemonrpc"
	vmimage "zapvm/internal/image"
	"zapvm/internal/platform"
	"zapvm/internal/workspacepolicy"
)

const (
	maxExecPlanSize     = 1 << 20
	maxExecPlanCommands = 32
	maxParallelCommands = 8
)

type execPlan struct {
	SchemaVersion int               `json:"schema_version"`
	Parallel      bool              `json:"parallel,omitempty"`
	Commands      []execPlanCommand `json:"commands"`
}

type execPlanCommand struct {
	ID                      string   `json:"id"`
	SessionID               string   `json:"session_id"`
	Argv                    []string `json:"argv"`
	Cwd                     string   `json:"cwd,omitempty"`
	CredentialIDs           []string `json:"credential_ids,omitempty"`
	ProtectedWorkspacePaths []string `json:"protected_workspace_paths,omitempty"`
	DeniedWorkspacePatterns []string `json:"denied_workspace_patterns,omitempty"`
	TimeoutMillis           uint64   `json:"timeout_ms,omitempty"`
	RequireProcessSeal      bool     `json:"require_process_seal,omitempty"`
}

type execPlanEvent struct {
	SchemaVersion int                    `json:"schema_version"`
	Timestamp     string                 `json:"timestamp"`
	CommandID     string                 `json:"command_id,omitempty"`
	Type          string                 `json:"type"`
	Stream        string                 `json:"stream,omitempty"`
	Data          []byte                 `json:"data,omitempty"`
	PID           int                    `json:"pid,omitempty"`
	OK            *bool                  `json:"ok,omitempty"`
	ExitCode      *int                   `json:"exit_code,omitempty"`
	Seal          *daemonrpc.ProcessSeal `json:"seal,omitempty"`
	Error         string                 `json:"error,omitempty"`
}

type execPlanEventSink struct {
	mu      sync.Mutex
	encoder *json.Encoder
}

type execPlanStreamWriter struct {
	sink      *execPlanEventSink
	commandID string
	stream    string
}

type execCommandRunner struct {
	dialer         platform.AgentDialer
	secret         []byte
	networkMode    platform.NetworkMode
	defaultTimeout time.Duration
	sink           *execPlanEventSink
	credentials    *credential.Broker
}

func loadExecPlan(path string, defaultTimeout time.Duration) (execPlan, error) {
	if path == "" {
		return execPlan{}, errors.New("execution plan path is required")
	}
	data, err := vmimage.ReadBoundedRegular(path, maxExecPlanSize)
	if err != nil {
		return execPlan{}, err
	}
	if !utf8.Valid(data) {
		return execPlan{}, errors.New("execution plan must be valid UTF-8")
	}
	var plan execPlan
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&plan); err != nil {
		return execPlan{}, fmt.Errorf("decode execution plan: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return execPlan{}, errors.New("execution plan contains trailing data")
	}
	if plan.SchemaVersion != 1 || len(plan.Commands) == 0 || len(plan.Commands) > maxExecPlanCommands {
		return execPlan{}, fmt.Errorf("execution plan requires schema 1 and 1-%d commands", maxExecPlanCommands)
	}
	seen := make(map[string]struct{}, len(plan.Commands))
	for index := range plan.Commands {
		command := &plan.Commands[index]
		if err := validateExecPlanCommand(*command, defaultTimeout); err != nil {
			return execPlan{}, fmt.Errorf("command %d: %w", index, err)
		}
		if _, exists := seen[command.ID]; exists {
			return execPlan{}, fmt.Errorf("duplicate execution plan command id %q", command.ID)
		}
		seen[command.ID] = struct{}{}
	}
	return plan, nil
}

func validateExecPlanCommand(command execPlanCommand, defaultTimeout time.Duration) error {
	if !validPlanIdentifier(command.ID) {
		return errors.New("invalid id")
	}
	if !validPlanIdentifier(command.SessionID) {
		return fmt.Errorf("command %q has an invalid session_id", command.ID)
	}
	if len(command.Argv) == 0 || len(command.Argv) > 256 || command.Argv[0] == "" {
		return fmt.Errorf("command %q must contain 1-256 argv entries and a non-empty executable", command.ID)
	}
	for _, argument := range command.Argv {
		if len(argument) > 128<<10 || strings.IndexByte(argument, 0) >= 0 {
			return fmt.Errorf("command %q contains an invalid argument", command.ID)
		}
	}
	if len(command.Cwd) > 4096 || strings.IndexByte(command.Cwd, 0) >= 0 {
		return fmt.Errorf("command %q has an invalid cwd", command.ID)
	}
	if len(command.CredentialIDs) > credential.MaxCredentials {
		return fmt.Errorf("command %q has too many credential IDs", command.ID)
	}
	seenCredentials := make(map[string]struct{}, len(command.CredentialIDs))
	for _, id := range command.CredentialIDs {
		if !credential.ValidID(id) {
			return fmt.Errorf("command %q has an invalid credential ID", command.ID)
		}
		if _, exists := seenCredentials[id]; exists {
			return fmt.Errorf("command %q repeats credential ID %q", command.ID, id)
		}
		seenCredentials[id] = struct{}{}
	}
	if err := workspacepolicy.ValidateProtectedPaths(command.ProtectedWorkspacePaths); err != nil {
		return fmt.Errorf("command %q: %w", command.ID, err)
	}
	if err := workspacepolicy.ValidateDeniedPatterns(command.DeniedWorkspacePatterns); err != nil {
		return fmt.Errorf("command %q: %w", command.ID, err)
	}
	timeout := defaultTimeout
	if command.TimeoutMillis != 0 {
		if command.TimeoutMillis > uint64((24 * time.Hour).Milliseconds()) {
			return fmt.Errorf("command %q timeout exceeds 24h", command.ID)
		}
		timeout = time.Duration(command.TimeoutMillis) * time.Millisecond
	}
	if err := validateExecTimeout(timeout); err != nil {
		return fmt.Errorf("command %q: %w", command.ID, err)
	}
	return nil
}

func validPlanIdentifier(value string) bool {
	return value != "" && len(value) <= 256 && utf8.ValidString(value) && strings.IndexByte(value, 0) < 0
}

func (writer *execPlanStreamWriter) Write(data []byte) (int, error) {
	copyData := append([]byte(nil), data...)
	err := writer.sink.write(execPlanEvent{
		SchemaVersion: 1, CommandID: writer.commandID, Type: "output", Stream: writer.stream, Data: copyData,
	})
	if err != nil {
		return 0, err
	}
	return len(data), nil
}

func (sink *execPlanEventSink) write(event execPlanEvent) error {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if event.Timestamp == "" {
		event.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	}
	return sink.encoder.Encode(event)
}

func (runner *execCommandRunner) writeResult(commandID string, commandErr error) error {
	return runner.writeResultWithSeal(commandID, commandErr, nil)
}

func (runner *execCommandRunner) writeResultWithSeal(commandID string, commandErr error, seal *daemonrpc.ProcessSeal) error {
	ok := commandErr == nil
	event := execPlanEvent{SchemaVersion: 1, CommandID: commandID, Type: "result", OK: &ok, Seal: seal}
	if commandErr == nil {
		exitCode := 0
		event.ExitCode = &exitCode
	}
	if commandErr != nil {
		event.Error = commandErr.Error()
		var exitErr *guestCommandExitError
		if errors.As(commandErr, &exitErr) {
			exitCode := exitErr.Code
			event.ExitCode = &exitCode
		}
	}
	return runner.sink.write(event)
}

func (runner *execCommandRunner) run(ctx context.Context, command execPlanCommand) error {
	return runner.runCredentialed(ctx, command, nil)
}

func (runner *execCommandRunner) runCredentialed(ctx context.Context, command execPlanCommand, dynamic map[string][]byte) error {
	if err := runner.sink.write(execPlanEvent{SchemaVersion: 1, CommandID: command.ID, Type: "scheduled"}); err != nil {
		return err
	}
	credentials := dynamic
	var err error
	if dynamic == nil {
		credentials, err = resolveCommandCredentials(runner.credentials, command.CredentialIDs)
		if err != nil {
			return errors.Join(err, runner.writeResult(command.ID, err))
		}
	} else if err := daemonrpc.ValidateCredentialValues(command.CredentialIDs, dynamic); err != nil {
		return errors.Join(err, runner.writeResult(command.ID, err))
	}
	defer credential.ZeroValues(credentials)
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	connection, codec, err := connectAuthenticatedAgentWithRetry(dialCtx, runner.dialer, runner.secret)
	cancel()
	var seal *daemonrpc.ProcessSeal
	if err == nil {
		defer connection.Close()
		cancelDone := make(chan struct{})
		go func() {
			select {
			case <-ctx.Done():
				_ = connection.Close()
			case <-cancelDone:
			}
		}()
		defer close(cancelDone)
		if command.RequireProcessSeal {
			health, healthErr := checkAgentHealth(connection, codec, 0, 10*time.Second)
			if healthErr != nil || health.ProcessSeal != "cgroup-v2" {
				err = errors.New("guest does not provide required process sealing")
				return errors.Join(err, runner.writeResult(command.ID, err))
			}
		}
		timeout := runner.defaultTimeout
		if command.TimeoutMillis != 0 {
			timeout = time.Duration(command.TimeoutMillis) * time.Millisecond
		}
		stdout := &execPlanStreamWriter{sink: runner.sink, commandID: command.ID, stream: "stdout"}
		stderr := &execPlanStreamWriter{sink: runner.sink, commandID: command.ID, stream: "stderr"}
		err = executeGuestTo(codec, command.ID, command.Argv, command.Cwd, runner.networkMode, command.SessionID, timeout, credentials, command.ProtectedWorkspacePaths, command.DeniedWorkspacePatterns, stdout, stderr, func(started agent.ExecStarted) error {
			return runner.sink.write(execPlanEvent{SchemaVersion: 1, CommandID: command.ID, Type: "started", PID: started.PID})
		}, func(exit agent.ExecExit) error {
			if exit.Seal != nil {
				seal = &daemonrpc.ProcessSeal{Mechanism: exit.Seal.Mechanism, State: exit.Seal.State}
			}
			if command.RequireProcessSeal && (seal == nil || seal.Mechanism != "cgroup-v2" || seal.State != "empty") {
				return errors.New("guest did not confirm process sealing")
			}
			return nil
		})
		if ctx.Err() != nil {
			err = errors.Join(ctx.Err(), err)
		}
	}
	if writeErr := runner.writeResultWithSeal(command.ID, err, seal); writeErr != nil {
		return errors.Join(err, writeErr)
	}
	return err
}

func runExecPlan(ctx context.Context, dialer platform.AgentDialer, secret []byte, plan execPlan, networkMode platform.NetworkMode, defaultTimeout time.Duration, credentials *credential.Broker) error {
	return runExecPlanTo(ctx, dialer, secret, plan, networkMode, defaultTimeout, credentials, os.Stdout)
}

func runExecPlanTo(ctx context.Context, dialer platform.AgentDialer, secret []byte, plan execPlan, networkMode platform.NetworkMode, defaultTimeout time.Duration, credentials *credential.Broker, output io.Writer) error {
	sink := &execPlanEventSink{encoder: json.NewEncoder(output)}
	runner := &execCommandRunner{dialer: dialer, secret: secret, networkMode: networkMode, defaultTimeout: defaultTimeout, sink: sink, credentials: credentials}

	if !plan.Parallel {
		for _, command := range plan.Commands {
			if err := runner.run(ctx, command); err != nil {
				return fmt.Errorf("execution plan command %q: %w", command.ID, err)
			}
		}
		return nil
	}

	var wait sync.WaitGroup
	semaphore := make(chan struct{}, maxParallelCommands)
	errorsByIndex := make([]error, len(plan.Commands))
	for index, command := range plan.Commands {
		wait.Add(1)
		go func(index int, command execPlanCommand) {
			defer wait.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				errorsByIndex[index] = errors.Join(ctx.Err(), runner.writeResult(command.ID, ctx.Err()))
				return
			}
			errorsByIndex[index] = runner.run(ctx, command)
		}(index, command)
	}
	wait.Wait()
	var failures []error
	for index, err := range errorsByIndex {
		if err != nil {
			failures = append(failures, fmt.Errorf("command %q: %w", plan.Commands[index].ID, err))
		}
	}
	return errors.Join(failures...)
}

func resolveCommandCredentials(broker *credential.Broker, ids []string) (map[string][]byte, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	if broker == nil {
		return nil, errors.New("command requested credentials but no credential bindings were authorized")
	}
	return broker.Resolve(ids)
}

func validatePlanCredentialBindings(plan execPlan, broker *credential.Broker) error {
	for _, command := range plan.Commands {
		values, err := resolveCommandCredentials(broker, command.CredentialIDs)
		credential.ZeroValues(values)
		if err != nil {
			return fmt.Errorf("command %q credentials: %w", command.ID, err)
		}
	}
	return nil
}
