package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"zapvm/internal/computer"
	"zapvm/internal/credential"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/localipc"
	"zapvm/internal/platform"
	"zapvm/internal/task"
	"zapvm/internal/vmpool"
)

func TestDaemonExecClientErrorUsesStructuredGuestResult(t *testing.T) {
	guestFailure := errors.New("guest command exited with code 23")
	exitCode := 23
	terminal := &daemonrpc.Event{ExitCode: &exitCode}
	if err := daemonExecClientError("/private/result.json", terminal, guestFailure); err != nil {
		t.Fatalf("structured Guest failure leaked as Host CLI error: %v", err)
	}
	if err := daemonExecClientError("", terminal, guestFailure); !errors.Is(err, guestFailure) {
		t.Fatalf("interactive CLI failure = %v, want %v", err, guestFailure)
	}
	if err := daemonExecClientError("/private/result.json", &daemonrpc.Event{}, guestFailure); !errors.Is(err, guestFailure) {
		t.Fatalf("infrastructure failure = %v, want %v", err, guestFailure)
	}
}

func TestDaemonReusesWorkerAcrossIndependentClientConnections(t *testing.T) {
	t.Setenv("GO_WANT_DAEMON_WORKER_HELPER", "1")
	endpoint := daemonTestEndpoint(t)
	listener, err := localipc.Listen(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	broker, err := credential.Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Close()
	serverCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := &daemonServer{
		ctx: serverCtx, cancel: cancel,
		image:     daemonImageConfig{allowUnsigned: true, digest: repeatHex('a', 64)},
		stateRoot: t.TempDir(), executable: os.Args[0], credentials: broker,
		cpuCount: 2, memoryBytes: 512 * platform.MiB, stopTimeout: 3 * time.Second,
		policies: make(map[string]daemonPolicy),
	}
	var starts atomic.Int32
	pool, err := vmpool.New(vmpool.Options{
		MaxWorkers: 2, MaxPerWorkspace: 2, IdleTimeout: time.Minute, StopTimeout: 3 * time.Second,
	}, func(ctx context.Context, route vmpool.Route) (vmpool.Worker, error) {
		starts.Add(1)
		return startDaemonStdioWorker(ctx, os.Args[0], []string{"-test.run=^TestDaemonWorkerHelper$"}, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	server.pool = pool
	t.Cleanup(func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer closeCancel()
		_ = pool.Close(closeCtx)
	})
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.serve(listener) }()

	workspace, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"first", "second"} {
		request := daemonrpc.ExecRequest{
			Workspace: workspace, Network: platform.NetworkOff,
			Command: daemonrpc.Command{ID: id, SessionID: "test-session", Argv: []string{id}, TimeoutMillis: 1000},
		}
		var stdout bytes.Buffer
		if err := daemonClientExecTo(endpoint, id, request, &stdout, nil); err != nil {
			t.Fatalf("exec %s: %v", id, err)
		}
		if want := "helper-" + id; stdout.String() != want {
			t.Fatalf("exec %s output = %q, want %q", id, stdout.String(), want)
		}
	}
	if starts.Load() != 1 {
		t.Fatalf("worker starts = %d, want 1", starts.Load())
	}
	response, err := daemonSimpleRequest(endpoint, daemonrpc.TypeStatus)
	if err != nil {
		t.Fatal(err)
	}
	status, err := daemonrpc.DecodePayload[daemonrpc.Status](response.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if response.Type != daemonrpc.TypeStatus || status.Version != version || status.ImageDigest != repeatHex('a', 64) ||
		status.Workers != 1 || status.Leases != 0 || len(status.RouteIDs) != 1 {
		t.Fatalf("unexpected status type=%q value=%+v", response.Type, status)
	}
	response, err = daemonSimpleRequest(endpoint, daemonrpc.TypePause)
	if err != nil || response.Type != daemonrpc.TypePaused {
		t.Fatalf("pause response = %q, %v", response.Type, err)
	}
	response, err = daemonSimpleRequest(endpoint, daemonrpc.TypeStatus)
	if err != nil {
		t.Fatal(err)
	}
	status, err = daemonrpc.DecodePayload[daemonrpc.Status](response.Payload)
	if err != nil || !status.Paused {
		t.Fatalf("paused status = %+v, %v", status, err)
	}
	blocked := daemonrpc.ExecRequest{
		Workspace: workspace, Network: platform.NetworkOff,
		Command: daemonrpc.Command{ID: "blocked", SessionID: "test-session", Argv: []string{"blocked"}, TimeoutMillis: 1000},
	}
	if err := daemonClientExecTo(endpoint, "blocked", blocked, nil, nil); err == nil {
		t.Fatal("paused daemon accepted a new execution lease")
	}
	response, err = daemonSimpleRequest(endpoint, daemonrpc.TypeResume)
	if err != nil || response.Type != daemonrpc.TypeResumed {
		t.Fatalf("resume response = %q, %v", response.Type, err)
	}
	var resumedOutput bytes.Buffer
	blocked.Command.ID = "third"
	blocked.Command.Argv = []string{"third"}
	if err := daemonClientExecTo(endpoint, "third", blocked, &resumedOutput, nil); err != nil {
		t.Fatal(err)
	}
	if resumedOutput.String() != "helper-third" || starts.Load() != 1 {
		t.Fatalf("post-resume output=%q starts=%d", resumedOutput.String(), starts.Load())
	}
	response, err = daemonSimpleRequest(endpoint, daemonrpc.TypeShutdown)
	if err != nil {
		t.Fatal(err)
	}
	if response.Type != daemonrpc.TypeStopped {
		t.Fatalf("shutdown response = %q", response.Type)
	}
	select {
	case err := <-serveDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon server did not stop")
	}
}

func TestDaemonComputerLifecycleAcrossClientConnections(t *testing.T) {
	t.Setenv("GO_WANT_DAEMON_WORKER_HELPER", "1")
	endpoint := daemonTestEndpoint(t)
	listener, err := localipc.Listen(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	broker, err := credential.Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Close()
	stateRoot := t.TempDir()
	computerStore, err := computer.Open(filepath.Join(stateRoot, "computers"))
	if err != nil {
		t.Fatal(err)
	}
	serverCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := &daemonServer{
		ctx: serverCtx, cancel: cancel, computers: computerStore,
		image:     daemonImageConfig{allowUnsigned: true, digest: repeatHex('a', 64)},
		stateRoot: stateRoot, executable: os.Args[0], credentials: broker,
		cpuCount: 2, memoryBytes: 512 * platform.MiB, stopTimeout: 3 * time.Second,
		policies: make(map[string]daemonPolicy),
	}
	routes := make(chan vmpool.Route, 1)
	pool, err := vmpool.New(vmpool.Options{
		MaxWorkers: 2, MaxPerWorkspace: 2, IdleTimeout: time.Minute, StopTimeout: 3 * time.Second,
	}, func(ctx context.Context, route vmpool.Route) (vmpool.Worker, error) {
		routes <- route
		return startDaemonStdioWorker(ctx, os.Args[0], []string{"-test.run=^TestDaemonWorkerHelper$"}, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	server.pool = pool
	t.Cleanup(func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer closeCancel()
		_ = pool.Close(closeCtx)
	})
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.serve(listener) }()

	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "README.md"), []byte("workspace explorer\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(workspace, "src"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "src", "main.go"), []byte("package main\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, protected := range []string{".git", ".zapcode"} {
		if err := os.MkdirAll(filepath.Join(workspace, protected), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(workspace, protected, "secret"), []byte("hidden\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("outside\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlinkCreated := true
	if err := os.Symlink(outside, filepath.Join(workspace, "escape")); err != nil {
		if !os.IsPermission(err) {
			t.Fatal(err)
		}
		symlinkCreated = false
	}
	response, err := daemonRequest(endpoint, daemonrpc.TypeComputerCreate, daemonrpc.ComputerCreateRequest{Computer: daemonrpc.ComputerSpec{
		ID: "project-a", Workspace: workspace, Network: platform.NetworkRestricted,
		AllowedDomains: []string{" Example.COM. ", "example.com"}, AllowedPorts: []uint16{443},
	}})
	if err != nil || response.Type != daemonrpc.TypeComputer {
		t.Fatalf("create response=%q err=%v", response.Type, err)
	}
	created, err := daemonrpc.DecodePayload[daemonrpc.ComputerSpec](response.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if created.RuntimeState != vmpool.ComputerStopped || created.CPUCount != 2 || created.MemoryMiB != 512 || !reflect.DeepEqual(created.AllowedDomains, []string{"example.com"}) {
		t.Fatalf("created Computer = %+v", created)
	}
	response, err = daemonRequest(endpoint, daemonrpc.TypeComputerStart, daemonrpc.ComputerReference{ID: created.ID})
	if err != nil || response.Type != daemonrpc.TypeComputer {
		t.Fatalf("start response=%q err=%v", response.Type, err)
	}
	started, err := daemonrpc.DecodePayload[daemonrpc.ComputerSpec](response.Payload)
	if err != nil || started.RuntimeState != vmpool.ComputerRunning {
		t.Fatalf("started Computer = %+v, %v", started, err)
	}
	response, err = daemonSimpleRequest(endpoint, daemonrpc.TypeStatus)
	if err != nil || response.Type != daemonrpc.TypeStatus {
		t.Fatalf("running status response=%q err=%v", response.Type, err)
	}
	status, err := daemonrpc.DecodePayload[daemonrpc.Status](response.Payload)
	if err != nil || len(status.ComputerRuntimes) != 1 || status.ComputerRuntimes[0].ID != created.ID || status.ComputerRuntimes[0].State != vmpool.ComputerRunning {
		t.Fatalf("running Computer status = %+v, %v", status, err)
	}
	route := <-routes
	if route.ComputerID != created.ID || route.StateDigest != computerStateDigest(created.ID) || route.CPUCount != 2 || route.MemoryBytes != 512*platform.MiB {
		t.Fatalf("Computer route = %+v", route)
	}

	response, err = daemonRequest(endpoint, daemonrpc.TypeComputerWorkspaceList, daemonrpc.ComputerWorkspaceRequest{ComputerID: created.ID})
	if err != nil || response.Type != daemonrpc.TypeWorkspaceListing {
		t.Fatalf("workspace list response=%q err=%v", response.Type, err)
	}
	listing, err := daemonrpc.DecodePayload[daemonrpc.WorkspaceListing](response.Payload)
	if err != nil {
		t.Fatal(err)
	}
	wantNames := []string{"src", "README.md"}
	if symlinkCreated {
		wantNames = append(wantNames, "escape")
	}
	gotNames := make([]string, 0, len(listing.Entries))
	for _, entry := range listing.Entries {
		gotNames = append(gotNames, entry.Name)
	}
	if !reflect.DeepEqual(gotNames, wantNames) {
		t.Fatalf("workspace listing = %+v", listing)
	}

	response, err = daemonRequest(endpoint, daemonrpc.TypeComputerWorkspaceRead, daemonrpc.ComputerWorkspaceRequest{ComputerID: created.ID, Path: "README.md"})
	if err != nil || response.Type != daemonrpc.TypeWorkspaceFile {
		t.Fatalf("workspace read response=%q err=%v", response.Type, err)
	}
	file, err := daemonrpc.DecodePayload[daemonrpc.WorkspaceFile](response.Payload)
	if err != nil || string(file.Data) != "workspace explorer\n" || len(file.SHA256) != 64 || file.Path != "README.md" {
		t.Fatalf("workspace file = %+v, err=%v", file, err)
	}
	unsafePaths := []string{"../outside.txt", ".git/secret"}
	if symlinkCreated {
		unsafePaths = append(unsafePaths, "escape")
	}
	for _, unsafe := range unsafePaths {
		if _, err := daemonRequest(endpoint, daemonrpc.TypeComputerWorkspaceRead, daemonrpc.ComputerWorkspaceRequest{ComputerID: created.ID, Path: unsafe}); err == nil {
			t.Fatalf("unsafe workspace read %q succeeded", unsafe)
		}
	}

	requestID := "computer-command"
	request := daemonrpc.ComputerExecRequest{ID: created.ID, Command: daemonrpc.Command{
		ID: requestID, SessionID: "test-session", Argv: []string{"computer"}, TimeoutMillis: 1000,
	}}
	var stdout bytes.Buffer
	if err := daemonClientStreamTo(endpoint, requestID, daemonrpc.TypeComputerExec, request, &stdout, nil); err != nil {
		t.Fatal(err)
	}
	if stdout.String() != "helper-computer-command" {
		t.Fatalf("Computer exec output = %q", stdout.String())
	}
	response, err = daemonRequest(endpoint, daemonrpc.TypeComputerList, daemonrpc.Empty{})
	if err != nil || response.Type != daemonrpc.TypeComputers {
		t.Fatalf("list response=%q err=%v", response.Type, err)
	}
	list, err := daemonrpc.DecodePayload[daemonrpc.ComputerList](response.Payload)
	if err != nil || len(list.Computers) != 1 || list.Computers[0].RuntimeState != vmpool.ComputerRunning {
		t.Fatalf("Computer list = %+v, %v", list, err)
	}

	response, err = daemonRequest(endpoint, daemonrpc.TypeComputerStop, daemonrpc.ComputerReference{ID: created.ID})
	if err != nil || response.Type != daemonrpc.TypeComputerStopped {
		t.Fatalf("stop response=%q err=%v", response.Type, err)
	}
	stopped, err := daemonrpc.DecodePayload[daemonrpc.ComputerSpec](response.Payload)
	if err != nil || stopped.RuntimeState != vmpool.ComputerStopped {
		t.Fatalf("stopped Computer = %+v, %v", stopped, err)
	}
	response, err = daemonSimpleRequest(endpoint, daemonrpc.TypeStatus)
	if err != nil || response.Type != daemonrpc.TypeStatus {
		t.Fatalf("stopped status response=%q err=%v", response.Type, err)
	}
	status, err = daemonrpc.DecodePayload[daemonrpc.Status](response.Payload)
	if err != nil || len(status.ComputerRuntimes) != 1 || status.ComputerRuntimes[0].ID != created.ID || status.ComputerRuntimes[0].State != vmpool.ComputerStopped {
		t.Fatalf("stopped Computer status = %+v, %v", status, err)
	}

	cancel()
	_ = listener.Close()
	select {
	case err := <-serveDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon server did not stop")
	}
}

func TestDaemonComputerTaskSurvivesClientDisconnectAndReplaysCursor(t *testing.T) {
	t.Setenv("GO_WANT_DAEMON_WORKER_HELPER", "1")
	t.Setenv("DAEMON_WORKER_WAIT_FOR_CANCEL_ID", "task-cancel")
	endpoint := daemonTestEndpoint(t)
	listener, err := localipc.Listen(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	broker, err := credential.Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Close()
	stateRoot := t.TempDir()
	computerStore, err := computer.Open(filepath.Join(stateRoot, "computers"))
	if err != nil {
		t.Fatal(err)
	}
	taskStore, err := task.Open(filepath.Join(stateRoot, "tasks"))
	if err != nil {
		t.Fatal(err)
	}
	serverCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := &daemonServer{
		ctx: serverCtx, cancel: cancel, computers: computerStore, taskStore: taskStore,
		image:     daemonImageConfig{allowUnsigned: true, digest: repeatHex('a', 64)},
		stateRoot: stateRoot, executable: os.Args[0], credentials: broker,
		cpuCount: 2, memoryBytes: 512 * platform.MiB, stopTimeout: 3 * time.Second,
		policies: make(map[string]daemonPolicy), taskNotify: make(map[string]chan struct{}),
	}
	var starts atomic.Int32
	pool, err := vmpool.New(vmpool.Options{
		MaxWorkers: 2, MaxPerWorkspace: 2, IdleTimeout: time.Minute, StopTimeout: 3 * time.Second,
	}, func(ctx context.Context, route vmpool.Route) (vmpool.Worker, error) {
		starts.Add(1)
		return startDaemonStdioWorker(ctx, os.Args[0], []string{"-test.run=^TestDaemonWorkerHelper$"}, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	server.pool = pool
	t.Cleanup(func() {
		server.closeTaskAdmission()
		cancel()
		server.taskWG.Wait()
		closeCtx, closeCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer closeCancel()
		_ = pool.Close(closeCtx)
	})
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.serve(listener) }()

	workspace, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	response, err := daemonRequest(endpoint, daemonrpc.TypeComputerCreate, daemonrpc.ComputerCreateRequest{Computer: daemonrpc.ComputerSpec{
		ID: "project-task", Workspace: workspace, Network: platform.NetworkOff,
	}})
	if err != nil || response.Type != daemonrpc.TypeComputer {
		t.Fatalf("create response=%q err=%v", response.Type, err)
	}

	submit := daemonrpc.ComputerTaskSubmitRequest{
		ID: "task-a", ComputerID: "project-task",
		Command: daemonrpc.Command{ID: "client-one", SessionID: "task-session", Argv: []string{"slow"}, TimeoutMillis: 5000},
	}
	response, err = daemonRequest(endpoint, daemonrpc.TypeComputerTaskSubmit, submit)
	if err != nil || response.Type != daemonrpc.TypeComputerTask {
		t.Fatalf("submit response=%q err=%v", response.Type, err)
	}
	created, err := daemonrpc.DecodePayload[daemonrpc.ComputerTask](response.Payload)
	if err != nil || created.ID != "task-a" || created.ComputerID != "project-task" {
		t.Fatalf("created Task = %+v, %v", created, err)
	}
	// A retry may generate a different transient command ID; the Task request
	// digest intentionally excludes it and must not launch a second execution.
	submit.Command.ID = "client-two"
	response, err = daemonRequest(endpoint, daemonrpc.TypeComputerTaskSubmit, submit)
	if err != nil || response.Type != daemonrpc.TypeComputerTask {
		t.Fatalf("idempotent submit response=%q err=%v", response.Type, err)
	}
	conflict := submit
	conflict.Command.Argv = []string{"different"}
	if _, err := daemonRequest(endpoint, daemonrpc.TypeComputerTaskSubmit, conflict); !errors.Is(err, task.ErrConflict) && (err == nil || !strings.Contains(err.Error(), task.ErrConflict.Error())) {
		t.Fatalf("conflicting Task submit error = %v", err)
	}

	// Read the currently durable prefix without following, then close the
	// connection. The background execution must continue independently.
	var firstOutput bytes.Buffer
	if err := daemonClientTaskAttach(endpoint, "attach-prefix", daemonrpc.ComputerTaskAttachRequest{ID: "task-a", Follow: false}, false, &firstOutput, nil); err != nil {
		t.Fatal(err)
	}
	if firstOutput.Len() != 0 {
		t.Fatalf("prefix attach unexpectedly reached output: %q", firstOutput.String())
	}

	deadline := time.Now().Add(5 * time.Second)
	var completed daemonrpc.ComputerTask
	for time.Now().Before(deadline) {
		response, err = daemonRequest(endpoint, daemonrpc.TypeComputerTaskInspect, daemonrpc.ComputerTaskReference{ID: "task-a"})
		if err != nil {
			t.Fatal(err)
		}
		completed, err = daemonrpc.DecodePayload[daemonrpc.ComputerTask](response.Payload)
		if err != nil {
			t.Fatal(err)
		}
		if completed.State == task.StateSucceeded {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if completed.State != task.StateSucceeded || completed.LastCursor != 6 || starts.Load() != 1 {
		t.Fatalf("completed Task=%+v worker starts=%d", completed, starts.Load())
	}

	// Cursor 4 is exec.started; reconnecting after it replays output/result but
	// not the already-consumed lifecycle prefix.
	var replay bytes.Buffer
	var replayStatus bytes.Buffer
	if err := daemonClientTaskAttach(endpoint, "attach-replay", daemonrpc.ComputerTaskAttachRequest{ID: "task-a", AfterCursor: 4, Follow: true}, false, &replay, &replayStatus); err != nil {
		t.Fatal(err)
	}
	if replay.String() != "helper-task-a" || !strings.Contains(replayStatus.String(), "state=succeeded cursor=6") {
		t.Fatalf("replay output=%q status=%q", replay.String(), replayStatus.String())
	}

	cancelSubmit := daemonrpc.ComputerTaskSubmitRequest{
		ID: "task-cancel", ComputerID: "project-task",
		Command: daemonrpc.Command{ID: "client-cancel", SessionID: "task-session", Argv: []string{"slow"}, TimeoutMillis: 5000},
	}
	response, err = daemonRequest(endpoint, daemonrpc.TypeComputerTaskSubmit, cancelSubmit)
	if err != nil || response.Type != daemonrpc.TypeComputerTask {
		t.Fatalf("cancel Task submit response=%q err=%v", response.Type, err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		response, err = daemonRequest(endpoint, daemonrpc.TypeComputerTaskInspect, daemonrpc.ComputerTaskReference{ID: "task-cancel"})
		if err != nil {
			t.Fatal(err)
		}
		current, decodeErr := daemonrpc.DecodePayload[daemonrpc.ComputerTask](response.Payload)
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		if current.State == task.StateRunning {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	response, err = daemonRequest(endpoint, daemonrpc.TypeComputerTaskCancel, daemonrpc.ComputerTaskReference{ID: "task-cancel"})
	if err != nil || response.Type != daemonrpc.TypeComputerTask {
		t.Fatalf("cancel response=%q err=%v", response.Type, err)
	}
	deadline = time.Now().Add(5 * time.Second)
	var canceled daemonrpc.ComputerTask
	for time.Now().Before(deadline) {
		response, err = daemonRequest(endpoint, daemonrpc.TypeComputerTaskInspect, daemonrpc.ComputerTaskReference{ID: "task-cancel"})
		if err != nil {
			t.Fatal(err)
		}
		canceled, err = daemonrpc.DecodePayload[daemonrpc.ComputerTask](response.Payload)
		if err != nil {
			t.Fatal(err)
		}
		if canceled.State == task.StateCanceled {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if canceled.State != task.StateCanceled {
		t.Fatalf("canceled Task = %+v", canceled)
	}
	if err := daemonClientTaskAttach(endpoint, "attach-canceled", daemonrpc.ComputerTaskAttachRequest{ID: "task-cancel", Follow: true}, false, nil, nil); err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("canceled attach error = %v", err)
	}

	retry := daemonrpc.ComputerTaskRetryRequest{SourceID: "task-cancel", ID: "task-retry", Command: cancelSubmit.Command}
	retry.Command.ID = "client-retry"
	mismatch := retry
	mismatch.Command.Argv = []string{"different"}
	if _, err := daemonRequest(endpoint, daemonrpc.TypeComputerTaskRetry, mismatch); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("mismatched retry error = %v", err)
	}
	response, err = daemonRequest(endpoint, daemonrpc.TypeComputerTaskRetry, retry)
	if err != nil || response.Type != daemonrpc.TypeComputerTask {
		t.Fatalf("retry response=%q err=%v", response.Type, err)
	}
	deadline = time.Now().Add(5 * time.Second)
	var retried daemonrpc.ComputerTask
	for time.Now().Before(deadline) {
		response, err = daemonRequest(endpoint, daemonrpc.TypeComputerTaskInspect, daemonrpc.ComputerTaskReference{ID: "task-retry"})
		if err != nil {
			t.Fatal(err)
		}
		retried, err = daemonrpc.DecodePayload[daemonrpc.ComputerTask](response.Payload)
		if err != nil {
			t.Fatal(err)
		}
		if retried.State == task.StateSucceeded {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if retried.State != task.StateSucceeded || retried.RetryOf != "task-cancel" || starts.Load() != 1 {
		t.Fatalf("retried Task=%+v worker starts=%d", retried, starts.Load())
	}

	cancel()
	_ = listener.Close()
	select {
	case err := <-serveDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon server did not stop")
	}
}

func TestUnsignedDaemonImageDigestTracksContent(t *testing.T) {
	directory := t.TempDir()
	kernel := filepath.Join(directory, "kernel")
	rootDisk := filepath.Join(directory, "root.raw")
	stateTemplate := filepath.Join(directory, "state.raw")
	for path, value := range map[string]string{kernel: "kernel-a", rootDisk: "root", stateTemplate: "state"} {
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	first, err := loadDaemonImage("", "", true, kernel, "", rootDisk, stateTemplate)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(kernel)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(kernel, []byte("kernel-b"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(kernel, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	second, err := loadDaemonImage("", "", true, kernel, "", rootDisk, stateTemplate)
	if err != nil {
		t.Fatal(err)
	}
	if first.digest == second.digest {
		t.Fatal("unsigned image digest ignored same-size content change with restored mtime")
	}
}

func TestDaemonPolicyDigestUsesCanonicalRules(t *testing.T) {
	firstDigest, first, err := normalizeDaemonPolicy(daemonrpc.ExecRequest{
		Network: platform.NetworkRestricted, AllowedDomains: []string{" Example.COM. ", "*.BÜCHER.example"}, AllowedPorts: []uint16{8443, 443},
	})
	if err != nil {
		t.Fatal(err)
	}
	secondDigest, second, err := normalizeDaemonPolicy(daemonrpc.ExecRequest{
		Network: platform.NetworkRestricted, AllowedDomains: []string{"*.xn--bcher-kva.example", "example.com", "example.com"}, AllowedPorts: []uint16{443, 8443, 443},
	})
	if err != nil {
		t.Fatal(err)
	}
	if firstDigest != secondDigest || !reflect.DeepEqual(first, second) {
		t.Fatalf("equivalent policies differ: %s %+v != %s %+v", firstDigest, first, secondDigest, second)
	}
}

func TestHostPowerOwnershipDoesNotResumeExplicitPause(t *testing.T) {
	newPool := func() *vmpool.Pool {
		pool, err := vmpool.New(vmpool.Options{IdleTimeout: time.Minute, StopTimeout: time.Second}, func(context.Context, vmpool.Route) (vmpool.Worker, error) {
			return nil, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = pool.Close(context.Background()) })
		return pool
	}

	explicitPool := newPool()
	if err := explicitPool.Pause(context.Background()); err != nil {
		t.Fatal(err)
	}
	explicitServer := &daemonServer{pool: explicitPool, stopTimeout: time.Second}
	explicitHandlers := explicitServer.hostPowerHandlers()
	if err := explicitHandlers.Suspend(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := explicitHandlers.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !explicitPool.Stats().Paused || explicitServer.powerOwnsPause {
		t.Fatal("Host wake released an explicit user pause")
	}

	automaticPool := newPool()
	var powerLog bytes.Buffer
	automaticServer := &daemonServer{pool: automaticPool, stopTimeout: time.Second, powerLog: &powerLog}
	automaticHandlers := automaticServer.hostPowerHandlers()
	if err := automaticHandlers.Suspend(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !automaticPool.Stats().Paused || !automaticServer.powerOwnsPause {
		t.Fatal("Host sleep did not acquire automatic pause ownership")
	}
	if err := automaticHandlers.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	if automaticPool.Stats().Paused || automaticServer.powerOwnsPause {
		t.Fatal("Host wake did not release automatic pause ownership")
	}
	if got, want := powerLog.String(), "zapVM daemon Host suspend completed ownership=true\nzapVM daemon Host resume completed\n"; got != want {
		t.Fatalf("Host power log = %q, want %q", got, want)
	}
}

func TestDaemonStatusEndpointFromOwnerOnlyConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "daemon.json")
	endpoint := daemonTestEndpoint(t)
	data := fmt.Sprintf(`{
  "schema_version": 1,
  "endpoint": %q,
  "image_root": %q,
  "image_public_key": %q,
  "state_root": %q
}`, endpoint, filepath.Join(t.TempDir(), "images"), filepath.Join(t.TempDir(), "image-public.pem"), filepath.Join(t.TempDir(), "state"))
	if err := os.WriteFile(configPath, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	selected, err := daemonStatusEndpoint("", configPath)
	if err != nil {
		t.Fatal(err)
	}
	if selected != endpoint {
		t.Fatalf("selected endpoint = %q, want %q", selected, endpoint)
	}
	if _, err := daemonStatusEndpoint(endpoint, configPath); err == nil || !strings.Contains(err.Error(), "only one") {
		t.Fatalf("combined endpoint/config error = %v", err)
	}
}

func daemonTestEndpoint(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		return `\\.\pipe\zapvm-test-` + repeatHex('b', 16)
	}
	directory, err := os.MkdirTemp("/tmp", "zdt-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(directory, "daemon.sock")
}

func repeatHex(value byte, count int) string {
	result := make([]byte, count)
	for index := range result {
		result[index] = value
	}
	return string(result)
}
