package main

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
	"sync"
	"testing"
	"time"

	"zapvm/internal/daemonrpc"
)

func TestDaemonStdioWorkerRoutesConcurrentCommandsAndStops(t *testing.T) {
	t.Setenv("GO_WANT_DAEMON_WORKER_HELPER", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	worker, err := startDaemonStdioWorker(ctx, os.Args[0], []string{"-test.run=^TestDaemonWorkerHelper$"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	commands := []daemonrpc.Command{
		{ID: "one", SessionID: "a", Argv: []string{"one"}, TimeoutMillis: 1000},
		{ID: "two", SessionID: "b", Argv: []string{"two"}, TimeoutMillis: 1000},
	}
	outputs := make(map[string]string)
	var outputMu sync.Mutex
	var wait sync.WaitGroup
	errorsSeen := make(chan error, len(commands))
	for _, command := range commands {
		command := command
		wait.Add(1)
		go func() {
			defer wait.Done()
			err := worker.Execute(ctx, command, func(event daemonrpc.Event) error {
				if event.Type == "output" {
					outputMu.Lock()
					outputs[event.CommandID] += string(event.Data)
					outputMu.Unlock()
				}
				return nil
			})
			errorsSeen <- err
		}()
	}
	wait.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		if err != nil {
			t.Fatal(err)
		}
	}
	if outputs["one"] != "helper-one" || outputs["two"] != "helper-two" {
		t.Fatalf("routed outputs = %+v", outputs)
	}
	if err := worker.Pause(ctx); err != nil {
		t.Fatal(err)
	}
	if err := worker.Resume(ctx); err != nil {
		t.Fatal(err)
	}
	if err := worker.Suspend(ctx); err != nil {
		t.Fatal(err)
	}
	if err := worker.Resume(ctx); err != nil {
		t.Fatal(err)
	}
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer stopCancel()
	if err := worker.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
	if err := worker.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
}

func TestDaemonStdioWorkerCancelsCommandWithoutStoppingWorker(t *testing.T) {
	t.Setenv("GO_WANT_DAEMON_WORKER_HELPER", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	worker, err := startDaemonStdioWorker(ctx, os.Args[0], []string{"-test.run=^TestDaemonWorkerHelper$"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	var startedOnce sync.Once
	execCtx, execCancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- worker.Execute(execCtx, daemonrpc.Command{ID: "cancel-me", SessionID: "a", Argv: []string{"slow"}, TimeoutMillis: 5000}, func(event daemonrpc.Event) error {
			if event.Type == "started" {
				startedOnce.Do(func() { close(started) })
			}
			return nil
		})
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	execCancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled Execute error = %v", err)
	}
	if err := worker.Execute(ctx, daemonrpc.Command{ID: "after-cancel", SessionID: "a", Argv: []string{"fast"}, TimeoutMillis: 1000}, nil); err != nil {
		t.Fatalf("worker was not reusable after command cancel: %v", err)
	}
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer stopCancel()
	if err := worker.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
}

func TestDaemonWorkerRejectsInvalidFirstEvent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := startDaemonStdioWorker(ctx, "/bin/sh", []string{"-c", "printf '%s\\n' '{\"schema_version\":1,\"type\":\"not-ready\"}'"}, nil); err == nil {
		t.Fatal("worker accepted a non-ready first event")
	}
}

func TestDaemonWorkerRuntimeSurvivesBrokenStdout(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "survived")
	command := exec.Command(os.Args[0], "-test.run=^TestDaemonWorkerBrokenStdoutHelper$")
	command.Env = append(os.Environ(), "GO_WANT_DAEMON_BROKEN_STDOUT_HELPER=1", "ZAPVM_DAEMON_WORKER=1", "DAEMON_BROKEN_STDOUT_MARKER="+marker)
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	if err := stdout.Close(); err != nil {
		t.Fatal(err)
	}
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "survived" {
		t.Fatalf("broken-pipe marker = %q, %v", data, err)
	}
}

func TestDaemonWorkerBrokenStdoutHelper(t *testing.T) {
	if os.Getenv("GO_WANT_DAEMON_BROKEN_STDOUT_HELPER") != "1" {
		return
	}
	prepareDaemonWorkerRuntime()
	_, _ = io.ReadAll(os.Stdin)
	_, _ = fmt.Fprintln(os.Stdout, "expected broken pipe")
	if err := os.WriteFile(os.Getenv("DAEMON_BROKEN_STDOUT_MARKER"), []byte("survived"), 0o600); err != nil {
		os.Exit(2)
	}
}

func TestDaemonWorkerHelper(t *testing.T) {
	if os.Getenv("GO_WANT_DAEMON_WORKER_HELPER") != "1" {
		return
	}
	encoder := json.NewEncoder(os.Stdout)
	_ = encoder.Encode(execPlanEvent{SchemaVersion: 1, Type: "ready"})
	scanner := bufio.NewScanner(os.Stdin)
	var writerMu sync.Mutex
	var commands sync.WaitGroup
	var commandsMu sync.Mutex
	cancels := make(map[string]context.CancelFunc)
	for scanner.Scan() {
		var request execStreamRequest
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			os.Exit(2)
		}
		switch request.Type {
		case "exec":
			if request.Command == nil {
				os.Exit(3)
			}
			command := *request.Command
			commandCtx, commandCancel := context.WithCancel(context.Background())
			commandsMu.Lock()
			cancels[command.ID] = commandCancel
			commandsMu.Unlock()
			commands.Add(1)
			go func() {
				defer func() {
					commandsMu.Lock()
					delete(cancels, command.ID)
					commandsMu.Unlock()
					commandCancel()
					commands.Done()
				}()
				delay := 10 * time.Millisecond
				if len(command.Argv) > 0 && command.Argv[0] == "slow" {
					delay = 250 * time.Millisecond
				}
				ok := true
				writerMu.Lock()
				for _, event := range []execPlanEvent{
					{SchemaVersion: 1, CommandID: command.ID, Type: "scheduled"},
					{SchemaVersion: 1, CommandID: command.ID, Type: "started", PID: 123},
				} {
					_ = encoder.Encode(event)
				}
				writerMu.Unlock()
				// Cancellation fixtures must not race a short success timer on
				// busy CI hosts. Other commands, including retries, still finish.
				var completed <-chan time.Time
				if id := os.Getenv("DAEMON_WORKER_WAIT_FOR_CANCEL_ID"); id == "" || command.ID != id {
					completed = time.After(delay)
				}
				select {
				case <-completed:
					writerMu.Lock()
					_ = encoder.Encode(execPlanEvent{SchemaVersion: 1, CommandID: command.ID, Type: "output", Stream: "stdout", Data: []byte(fmt.Sprintf("helper-%s", command.ID))})
					_ = encoder.Encode(execPlanEvent{SchemaVersion: 1, CommandID: command.ID, Type: "result", OK: &ok})
					writerMu.Unlock()
				case <-commandCtx.Done():
					ok = false
					writerMu.Lock()
					_ = encoder.Encode(execPlanEvent{SchemaVersion: 1, CommandID: command.ID, Type: "result", OK: &ok, Error: "canceled"})
					writerMu.Unlock()
				}
			}()
		case "cancel":
			commandsMu.Lock()
			cancel := cancels[request.ID]
			commandsMu.Unlock()
			if cancel != nil {
				cancel()
			}
		case "shutdown":
			commands.Wait()
			writerMu.Lock()
			_ = encoder.Encode(execPlanEvent{SchemaVersion: 1, Type: "drained"})
			_ = encoder.Encode(execPlanEvent{SchemaVersion: 1, Type: "vm_stopped"})
			writerMu.Unlock()
			os.Exit(0)
		case "pause", "suspend":
			writerMu.Lock()
			_ = encoder.Encode(execPlanEvent{SchemaVersion: 1, CommandID: request.ID, Type: "paused"})
			writerMu.Unlock()
		case "resume":
			writerMu.Lock()
			_ = encoder.Encode(execPlanEvent{SchemaVersion: 1, CommandID: request.ID, Type: "resumed"})
			writerMu.Unlock()
		default:
			os.Exit(4)
		}
	}
	os.Exit(5)
}
