package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
	"unicode/utf8"

	"zapvm/internal/credential"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/platform"
)

const maxExecStreamOutstanding = 32

type execStreamRequest struct {
	SchemaVersion    int               `json:"schema_version"`
	Type             string            `json:"type"`
	ID               string            `json:"id,omitempty"`
	Command          *execPlanCommand  `json:"command,omitempty"`
	CredentialValues map[string][]byte `json:"credential_values,omitempty"`
}

type execStreamInput struct {
	data []byte
	err  error
}

type execStreamDone struct {
	id  string
	err error
}

type execStreamController interface {
	Pause(context.Context) error
	Resume(context.Context) error
}

func decodeExecStreamRequest(data []byte, defaultTimeout time.Duration) (execStreamRequest, error) {
	if len(data) == 0 || len(data) > maxExecPlanSize || !utf8.Valid(data) {
		return execStreamRequest{}, errors.New("stream request is empty, oversized, or invalid UTF-8")
	}
	var request execStreamRequest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return execStreamRequest{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return execStreamRequest{}, errors.New("stream request contains trailing JSON")
	}
	if request.SchemaVersion != 1 {
		return execStreamRequest{}, errors.New("unsupported stream request schema")
	}
	switch request.Type {
	case "exec":
		if request.ID != "" || request.Command == nil {
			return execStreamRequest{}, errors.New("exec request requires command and no top-level id")
		}
		if err := validateExecPlanCommand(*request.Command, defaultTimeout); err != nil {
			return execStreamRequest{}, err
		}
		if request.CredentialValues != nil {
			if err := daemonrpc.ValidateCredentialValues(request.Command.CredentialIDs, request.CredentialValues); err != nil {
				credential.ZeroValues(request.CredentialValues)
				return execStreamRequest{}, err
			}
		}
	case "ping", "pause", "suspend", "resume", "cancel":
		if !validPlanIdentifier(request.ID) || request.Command != nil || request.CredentialValues != nil {
			return execStreamRequest{}, fmt.Errorf("%s request requires id and no command", request.Type)
		}
	case "shutdown":
		if request.ID != "" || request.Command != nil || request.CredentialValues != nil {
			return execStreamRequest{}, errors.New("shutdown request must not contain id or command")
		}
	default:
		return execStreamRequest{}, fmt.Errorf("unsupported stream request type %q", request.Type)
	}
	return request, nil
}

func serveExecStream(ctx context.Context, input io.Reader, output io.Writer, dialer platform.AgentDialer, secret []byte, networkMode platform.NetworkMode, defaultTimeout, idleTimeout time.Duration, credentials *credential.Broker, controller execStreamController) (returnErr error) {
	if idleTimeout < time.Second || idleTimeout > 24*time.Hour {
		return errors.New("stream idle timeout must be between 1s and 24h")
	}
	sink := &execPlanEventSink{encoder: json.NewEncoder(output)}
	runner := &execCommandRunner{dialer: dialer, secret: secret, networkMode: networkMode, defaultTimeout: defaultTimeout, sink: sink, credentials: credentials}
	if err := sink.write(execPlanEvent{SchemaVersion: 1, Type: "ready"}); err != nil {
		return err
	}

	inputs := make(chan execStreamInput, 1)
	go readExecStream(input, inputs)
	done := make(chan execStreamDone, maxExecStreamOutstanding)
	semaphore := make(chan struct{}, maxParallelCommands)
	active := make(map[string]context.CancelFunc)
	paused := false
	defer func() {
		if paused && controller != nil {
			resumeCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			returnErr = errors.Join(returnErr, controller.Resume(resumeCtx))
			cancel()
		}
	}()
	var workers sync.WaitGroup
	idleTimer := time.NewTimer(idleTimeout)
	defer idleTimer.Stop()

	resetIdle := func() {
		if !idleTimer.Stop() {
			select {
			case <-idleTimer.C:
			default:
			}
		}
		idleTimer.Reset(idleTimeout)
	}
	consumeDone := func(result execStreamDone) {
		if cancel := active[result.id]; cancel != nil {
			cancel()
		}
		delete(active, result.id)
		resetIdle()
	}
	waitForActive := func() error {
		for len(active) > 0 {
			select {
			case result := <-done:
				consumeDone(result)
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		workers.Wait()
		return nil
	}
	resume := func() error {
		if !paused {
			return nil
		}
		if controller == nil {
			return errors.New("execution stream does not support VM resume")
		}
		if err := controller.Resume(ctx); err != nil {
			return err
		}
		paused = false
		return nil
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-idleTimer.C:
			if len(active) == 0 {
				if err := resume(); err != nil {
					return fmt.Errorf("resume VM before idle shutdown: %w", err)
				}
				_ = sink.write(execPlanEvent{SchemaVersion: 1, Type: "idle_timeout"})
				return nil
			}
			idleTimer.Reset(idleTimeout)
		case result := <-done:
			consumeDone(result)
		case incoming := <-inputs:
			if incoming.err != nil {
				if errors.Is(incoming.err, io.EOF) {
					if err := resume(); err != nil {
						return fmt.Errorf("resume VM before stream EOF: %w", err)
					}
					if err := waitForActive(); err != nil {
						return err
					}
					_ = sink.write(execPlanEvent{SchemaVersion: 1, Type: "eof"})
					return nil
				}
				return incoming.err
			}
			resetIdle()
			request, err := decodeExecStreamRequest(incoming.data, defaultTimeout)
			credential.ZeroBytes(incoming.data)
			if err != nil {
				if writeErr := sink.write(execPlanEvent{SchemaVersion: 1, Type: "protocol_error", Error: err.Error()}); writeErr != nil {
					return errors.Join(err, writeErr)
				}
				continue
			}
			switch request.Type {
			case "ping":
				if err := sink.write(execPlanEvent{SchemaVersion: 1, CommandID: request.ID, Type: "pong"}); err != nil {
					return err
				}
			case "pause":
				if controller == nil {
					err := errors.New("execution stream does not support VM pause")
					if writeErr := sink.write(execPlanEvent{SchemaVersion: 1, CommandID: request.ID, Type: "control_error", Error: err.Error()}); writeErr != nil {
						return errors.Join(err, writeErr)
					}
					continue
				}
				if err := waitForActive(); err != nil {
					return err
				}
				if !paused {
					if err := controller.Pause(ctx); err != nil {
						if writeErr := sink.write(execPlanEvent{SchemaVersion: 1, CommandID: request.ID, Type: "control_error", Error: err.Error()}); writeErr != nil {
							return errors.Join(err, writeErr)
						}
						continue
					}
					paused = true
				}
				if err := sink.write(execPlanEvent{SchemaVersion: 1, CommandID: request.ID, Type: "paused"}); err != nil {
					return err
				}
			case "suspend":
				if controller == nil {
					err := errors.New("execution stream does not support VM suspend")
					if writeErr := sink.write(execPlanEvent{SchemaVersion: 1, CommandID: request.ID, Type: "control_error", Error: err.Error()}); writeErr != nil {
						return errors.Join(err, writeErr)
					}
					continue
				}
				if !paused {
					if err := controller.Pause(ctx); err != nil {
						if writeErr := sink.write(execPlanEvent{SchemaVersion: 1, CommandID: request.ID, Type: "control_error", Error: err.Error()}); writeErr != nil {
							return errors.Join(err, writeErr)
						}
						continue
					}
					paused = true
				}
				if err := sink.write(execPlanEvent{SchemaVersion: 1, CommandID: request.ID, Type: "paused"}); err != nil {
					return err
				}
			case "resume":
				if err := resume(); err != nil {
					if writeErr := sink.write(execPlanEvent{SchemaVersion: 1, CommandID: request.ID, Type: "control_error", Error: err.Error()}); writeErr != nil {
						return errors.Join(err, writeErr)
					}
					continue
				}
				if err := sink.write(execPlanEvent{SchemaVersion: 1, CommandID: request.ID, Type: "resumed"}); err != nil {
					return err
				}
			case "cancel":
				cancel := active[request.ID]
				if cancel == nil {
					if err := sink.write(execPlanEvent{SchemaVersion: 1, CommandID: request.ID, Type: "control_error", Error: "command is not active"}); err != nil {
						return err
					}
					continue
				}
				cancel()
			case "shutdown":
				if err := resume(); err != nil {
					return fmt.Errorf("resume VM before stream shutdown: %w", err)
				}
				if err := waitForActive(); err != nil {
					return err
				}
				if err := sink.write(execPlanEvent{SchemaVersion: 1, Type: "drained"}); err != nil {
					return err
				}
				return nil
			case "exec":
				command := *request.Command
				values := request.CredentialValues
				request.CredentialValues = nil
				if paused {
					credential.ZeroValues(values)
					err := errors.New("VM is paused")
					if writeErr := runner.writeResult(command.ID, err); writeErr != nil {
						return errors.Join(err, writeErr)
					}
					continue
				}
				if _, exists := active[command.ID]; exists {
					credential.ZeroValues(values)
					err := fmt.Errorf("command id %q is already active", command.ID)
					if writeErr := runner.writeResult(command.ID, err); writeErr != nil {
						return errors.Join(err, writeErr)
					}
					continue
				}
				if len(active) >= maxExecStreamOutstanding {
					credential.ZeroValues(values)
					err := fmt.Errorf("maximum %d outstanding commands reached", maxExecStreamOutstanding)
					if writeErr := runner.writeResult(command.ID, err); writeErr != nil {
						return errors.Join(err, writeErr)
					}
					continue
				}
				commandCtx, commandCancel := context.WithCancel(ctx)
				active[command.ID] = commandCancel
				workers.Add(1)
				go func(values map[string][]byte) {
					defer workers.Done()
					defer credential.ZeroValues(values)
					select {
					case semaphore <- struct{}{}:
						defer func() { <-semaphore }()
					case <-commandCtx.Done():
						done <- execStreamDone{id: command.ID, err: commandCtx.Err()}
						return
					}
					err := runner.runCredentialed(commandCtx, command, values)
					done <- execStreamDone{id: command.ID, err: err}
				}(values)
			}
		}
	}
}

func readExecStream(reader io.Reader, output chan<- execStreamInput) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64<<10), maxExecPlanSize+1)
	for scanner.Scan() {
		data := append([]byte(nil), scanner.Bytes()...)
		output <- execStreamInput{data: data}
	}
	if err := scanner.Err(); err != nil {
		output <- execStreamInput{err: fmt.Errorf("read execution stream: %w", err)}
	} else {
		output <- execStreamInput{err: io.EOF}
	}
}
