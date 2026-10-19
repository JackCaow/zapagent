package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"

	"zapvm/internal/daemonrpc"
)

type daemonStdioWorker struct {
	command *exec.Cmd
	stdin   io.WriteCloser

	writeMu sync.Mutex
	mu      sync.Mutex
	active  map[string]*daemonCommandStream
	ready   chan error
	done    chan struct{}
	doneErr error
	stop    sync.Once
}

type daemonCommandStream struct {
	events chan execPlanEvent
	done   chan struct{}
}

type daemonGuestCommandError struct {
	message string
}

func (err *daemonGuestCommandError) Error() string { return err.message }

type daemonCommandCanceledError struct{ cause error }

func (err *daemonCommandCanceledError) Error() string { return err.cause.Error() }
func (err *daemonCommandCanceledError) Unwrap() error { return err.cause }

func startDaemonStdioWorker(ctx context.Context, executable string, arguments []string, diagnostics io.Writer) (*daemonStdioWorker, error) {
	if executable == "" {
		return nil, errors.New("daemon worker executable is required")
	}
	if diagnostics == nil {
		diagnostics = io.Discard
	}
	command := exec.Command(executable, arguments...)
	configureDaemonWorkerProcess(command)
	command.Env = append(os.Environ(), "ZAPVM_DAEMON_WORKER=1")
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	command.Stderr = diagnostics
	worker := &daemonStdioWorker{
		command: command, stdin: stdin, active: make(map[string]*daemonCommandStream),
		ready: make(chan error, 1), done: make(chan struct{}),
	}
	if err := command.Start(); err != nil {
		_ = stdin.Close()
		return nil, err
	}
	go worker.read(stdout)
	select {
	case err := <-worker.ready:
		if err != nil {
			_ = worker.forceStop()
			return nil, err
		}
		select {
		case <-worker.done:
			return nil, errors.Join(errors.New("daemon worker exited immediately after ready"), worker.terminalError())
		default:
		}
		return worker, nil
	case <-ctx.Done():
		_ = worker.forceStop()
		return nil, ctx.Err()
	}
}

func (worker *daemonStdioWorker) Execute(ctx context.Context, command daemonrpc.Command, emit func(daemonrpc.Event) error) error {
	return worker.ExecuteCredentialed(ctx, command, nil, emit)
}

func (worker *daemonStdioWorker) ExecuteCredentialed(ctx context.Context, command daemonrpc.Command, values map[string][]byte, emit func(daemonrpc.Event) error) error {
	if err := command.Validate(); err != nil {
		return err
	}
	if values != nil {
		if err := daemonrpc.ValidateCredentialValues(command.CredentialIDs, values); err != nil {
			return err
		}
	}
	stream := &daemonCommandStream{events: make(chan execPlanEvent, 64), done: make(chan struct{})}
	worker.mu.Lock()
	if _, exists := worker.active[command.ID]; exists {
		worker.mu.Unlock()
		return fmt.Errorf("daemon worker command %q is already active", command.ID)
	}
	worker.active[command.ID] = stream
	worker.mu.Unlock()
	defer func() {
		worker.mu.Lock()
		delete(worker.active, command.ID)
		worker.mu.Unlock()
		close(stream.done)
	}()
	request := execStreamRequest{SchemaVersion: 1, Type: "exec", Command: &execPlanCommand{
		ID: command.ID, SessionID: command.SessionID, Argv: command.Argv, Cwd: command.Cwd,
		CredentialIDs: command.CredentialIDs, ProtectedWorkspacePaths: command.ProtectedWorkspacePaths,
		DeniedWorkspacePatterns: command.DeniedWorkspacePatterns,
		TimeoutMillis:           command.TimeoutMillis,
	}, CredentialValues: values}
	worker.writeMu.Lock()
	err := json.NewEncoder(worker.stdin).Encode(request)
	worker.writeMu.Unlock()
	if err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			if err := worker.writeRequest(execStreamRequest{SchemaVersion: 1, Type: "cancel", ID: command.ID}); err != nil {
				return errors.Join(ctx.Err(), err)
			}
			timer := time.NewTimer(10 * time.Second)
			defer timer.Stop()
			for {
				select {
				case <-worker.done:
					return errors.Join(ctx.Err(), worker.terminalError())
				case <-timer.C:
					return errors.Join(ctx.Err(), errors.New("daemon worker command cancellation timed out"))
				case event := <-stream.events:
					if event.Type == "result" {
						return &daemonCommandCanceledError{cause: ctx.Err()}
					}
					if emit != nil && (event.Type == "scheduled" || event.Type == "started" || event.Type == "output") {
						if err := emit(daemonEvent(event)); err != nil {
							return errors.Join(ctx.Err(), err)
						}
					}
				}
			}
		case <-worker.done:
			err := worker.terminalError()
			if err == nil {
				err = errors.New("daemon worker stopped before command result")
			}
			return err
		case event := <-stream.events:
			converted := daemonEvent(event)
			if emit != nil {
				if err := emit(converted); err != nil {
					return err
				}
			}
			if event.Type == "result" {
				if event.OK == nil || !*event.OK {
					if event.Error == "" {
						return &daemonGuestCommandError{message: "daemon worker command failed"}
					}
					return &daemonGuestCommandError{message: event.Error}
				}
				return nil
			}
		}
	}
}

func (worker *daemonStdioWorker) writeRequest(request execStreamRequest) error {
	worker.writeMu.Lock()
	defer worker.writeMu.Unlock()
	return json.NewEncoder(worker.stdin).Encode(request)
}

func daemonEvent(event execPlanEvent) daemonrpc.Event {
	return daemonrpc.Event{
		Timestamp: event.Timestamp, CommandID: event.CommandID, Type: event.Type,
		Stream: event.Stream, Data: event.Data, PID: event.PID, OK: event.OK, ExitCode: event.ExitCode, Error: event.Error,
	}
}

func (worker *daemonStdioWorker) Pause(ctx context.Context) error {
	return worker.control(ctx, "pause", "paused")
}

func (worker *daemonStdioWorker) Suspend(ctx context.Context) error {
	return worker.control(ctx, "suspend", "paused")
}

func (worker *daemonStdioWorker) Resume(ctx context.Context) error {
	return worker.control(ctx, "resume", "resumed")
}

func (worker *daemonStdioWorker) control(ctx context.Context, requestType, responseType string) error {
	id, err := randomDaemonID()
	if err != nil {
		return err
	}
	stream := &daemonCommandStream{events: make(chan execPlanEvent, 4), done: make(chan struct{})}
	worker.mu.Lock()
	if _, exists := worker.active[id]; exists {
		worker.mu.Unlock()
		return errors.New("daemon worker generated a duplicate control ID")
	}
	worker.active[id] = stream
	worker.mu.Unlock()
	defer func() {
		worker.mu.Lock()
		delete(worker.active, id)
		worker.mu.Unlock()
		close(stream.done)
	}()
	worker.writeMu.Lock()
	err = json.NewEncoder(worker.stdin).Encode(execStreamRequest{SchemaVersion: 1, Type: requestType, ID: id})
	worker.writeMu.Unlock()
	if err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-worker.done:
			return errors.Join(errors.New("daemon worker stopped during "+requestType), worker.terminalError())
		case event := <-stream.events:
			switch event.Type {
			case responseType:
				return nil
			case "control_error":
				if event.Error == "" {
					return errors.New("daemon worker " + requestType + " failed without detail")
				}
				return errors.New(event.Error)
			default:
				return fmt.Errorf("daemon worker %s returned unexpected event %q", requestType, event.Type)
			}
		}
	}
}

func (worker *daemonStdioWorker) Stop(ctx context.Context) error {
	worker.stop.Do(func() {
		worker.writeMu.Lock()
		_ = json.NewEncoder(worker.stdin).Encode(execStreamRequest{SchemaVersion: 1, Type: "shutdown"})
		_ = worker.stdin.Close()
		worker.writeMu.Unlock()
	})
	select {
	case <-worker.done:
		return worker.terminalError()
	case <-ctx.Done():
		return errors.Join(ctx.Err(), worker.forceStop())
	}
}

func (worker *daemonStdioWorker) forceStop() error {
	if worker.command.Process == nil {
		return nil
	}
	err := worker.command.Process.Signal(os.Interrupt)
	if err != nil && !errors.Is(err, os.ErrProcessDone) {
		_ = worker.command.Process.Kill()
		return err
	}
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-worker.done:
		return nil
	case <-timer.C:
		err = worker.command.Process.Kill()
		if errors.Is(err, os.ErrProcessDone) {
			return nil
		}
		return err
	}
}

func (worker *daemonStdioWorker) read(stdout io.Reader) {
	readySent := false
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), maxExecPlanSize+1)
	for scanner.Scan() {
		var event execPlanEvent
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&event); err != nil {
			if !readySent {
				worker.ready <- fmt.Errorf("decode daemon worker event: %w", err)
				readySent = true
			}
			readErr := fmt.Errorf("decode daemon worker event: %w", err)
			_ = worker.command.Process.Kill()
			worker.finishRead(readErr, readySent)
			return
		}
		var trailing any
		if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			if !readySent {
				worker.ready <- errors.New("daemon worker event contains trailing JSON")
				readySent = true
			}
			_ = worker.command.Process.Kill()
			worker.finishRead(errors.New("daemon worker event contains trailing JSON"), readySent)
			return
		}
		if event.SchemaVersion != 1 || event.Type == "" {
			if !readySent {
				worker.ready <- errors.New("daemon worker event has invalid schema or type")
				readySent = true
			}
			_ = worker.command.Process.Kill()
			worker.finishRead(errors.New("daemon worker event has invalid schema or type"), readySent)
			return
		}
		if !readySent {
			if event.Type != "ready" || event.SchemaVersion != 1 {
				worker.ready <- fmt.Errorf("daemon worker first event is %q, want ready", event.Type)
				readySent = true
				continue
			}
			worker.ready <- nil
			readySent = true
			continue
		}
		if event.CommandID != "" {
			worker.mu.Lock()
			target := worker.active[event.CommandID]
			worker.mu.Unlock()
			if target != nil {
				select {
				case target.events <- event:
				case <-target.done:
				case <-worker.done:
					return
				}
			}
		}
	}
	worker.finishRead(scanner.Err(), readySent)
}

func (worker *daemonStdioWorker) finishRead(readErr error, readySent bool) {
	waitErr := worker.command.Wait()
	result := errors.Join(readErr, waitErr)
	if !readySent {
		if result == nil {
			result = errors.New("daemon worker exited before ready")
		}
		worker.ready <- result
	}
	worker.mu.Lock()
	worker.doneErr = result
	worker.mu.Unlock()
	close(worker.done)
}

func (worker *daemonStdioWorker) terminalError() error {
	worker.mu.Lock()
	defer worker.mu.Unlock()
	return worker.doneErr
}
