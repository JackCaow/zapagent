package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"time"

	"zapvm/internal/credential"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/task"
)

var errComputerTaskCanceled = errors.New("Agent Computer Task cancellation requested")

const automaticTaskPruneLimit = 100

func (server *daemonServer) submitComputerTask(request daemonrpc.ComputerTaskSubmitRequest) (daemonrpc.ComputerTask, error) {
	return server.createComputerTask(request, "", nil)
}

func (server *daemonServer) submitCredentialedComputerTask(request daemonrpc.ComputerTaskCredentialSubmitRequest) (daemonrpc.ComputerTask, error) {
	return server.createComputerTask(request.Task, "", request.Values)
}

func (server *daemonServer) createComputerTask(request daemonrpc.ComputerTaskSubmitRequest, retryOf string, dynamicCredentials map[string][]byte) (daemonrpc.ComputerTask, error) {
	if server.taskStore == nil {
		return daemonrpc.ComputerTask{}, errors.New("Agent Computer Task store is unavailable")
	}
	if _, err := server.inspectComputer(request.ComputerID); err != nil {
		return daemonrpc.ComputerTask{}, err
	}
	taskID := request.ID
	if taskID == "" {
		var err error
		taskID, err = randomDaemonID()
		if err != nil {
			return daemonrpc.ComputerTask{}, err
		}
	}
	digest, err := computerTaskRequestDigest(request.ComputerID, request.Command)
	if err != nil {
		return daemonrpc.ComputerTask{}, err
	}
	var view task.View
	var created bool
	if retryOf == "" {
		view, created, err = server.taskStore.Create(taskID, request.ComputerID, digest)
	} else {
		view, created, err = server.taskStore.CreateRetry(taskID, request.ComputerID, digest, retryOf)
	}
	if err != nil {
		return daemonrpc.ComputerTask{}, err
	}
	if !created {
		server.taskLogEvent("task_submit", taskID, "replayed", "none", 0)
		return daemonTaskFromView(view), nil
	}
	server.taskLogEvent("task_submit", taskID, "created", "none", 0)
	command := request.Command
	// A server-owned Task ID is also the guest command ID. Retries with the
	// same idempotency key therefore cannot collide under a fresh command ID.
	command.ID = taskID
	execRequest := daemonrpc.ExecRequest{ComputerID: request.ComputerID, Command: command}
	if dynamicCredentials != nil {
		execRequest.CredentialValues = cloneCredentialValues(dynamicCredentials)
	}
	if !server.launchComputerTask(taskID, execRequest) {
		credential.ZeroValues(execRequest.CredentialValues)
		current, inspectErr := server.taskStore.Inspect(taskID)
		if inspectErr != nil {
			return daemonrpc.ComputerTask{}, inspectErr
		}
		if task.IsTerminal(current.State) {
			return daemonTaskFromView(current), nil
		}
		_, view, appendErr := server.taskStore.Append(taskID, task.Event{Type: "task.interrupted", Error: "daemon_stopping"})
		if appendErr != nil {
			return daemonrpc.ComputerTask{}, appendErr
		}
		server.notifyTask(taskID)
		server.deleteTaskSignal(taskID)
		return daemonTaskFromView(view), nil
	}
	return daemonTaskFromView(view), nil
}

func (server *daemonServer) launchComputerTask(id string, request daemonrpc.ExecRequest) bool {
	server.taskLifecycleMu.Lock()
	defer server.taskLifecycleMu.Unlock()
	if server.taskAdmissionClosed || server.ctx.Err() != nil {
		return false
	}
	taskCtx, cancel := context.WithCancelCause(server.ctx)
	if server.taskRuns == nil {
		server.taskRuns = make(map[string]context.CancelCauseFunc)
	}
	server.taskRuns[id] = cancel
	server.taskWG.Add(1)
	go func() {
		defer func() {
			server.taskLifecycleMu.Lock()
			delete(server.taskRuns, id)
			server.taskLifecycleMu.Unlock()
			cancel(nil)
			server.taskWG.Done()
		}()
		server.runComputerTask(taskCtx, id, request)
	}()
	return true
}

func (server *daemonServer) closeTaskAdmission() {
	server.taskLifecycleMu.Lock()
	server.taskAdmissionClosed = true
	server.taskLifecycleMu.Unlock()
}

func (server *daemonServer) runComputerTask(ctx context.Context, id string, request daemonrpc.ExecRequest) {
	defer credential.ZeroValues(request.CredentialValues)
	started := time.Now()
	server.taskLogEvent("task_execute", id, "started", "none", 0)
	defer func() {
		result, code := "finished", "none"
		if current, err := server.taskStore.Inspect(id); err == nil {
			result = current.State
		}
		server.taskLogEvent("task_execute", id, result, code, time.Since(started))
	}()
	err := server.executeDaemonRequest(ctx, request, func() error {
		_, _, err := server.taskStore.Append(id, task.Event{Type: "task.started"})
		if err == nil {
			server.notifyTask(id)
		}
		return err
	}, func(event daemonrpc.Event) error {
		journalEvent := task.Event{
			Type: "exec." + event.Type, CommandID: event.CommandID, Stream: event.Stream,
			Data: append([]byte(nil), event.Data...), PID: event.PID, OK: event.OK, Error: event.Error,
		}
		_, _, err := server.taskStore.Append(id, journalEvent)
		if err == nil {
			server.notifyTask(id)
		}
		return err
	})
	if err == nil {
		server.deleteTaskSignal(id)
		return
	}
	if errors.Is(context.Cause(ctx), errComputerTaskCanceled) {
		if _, _, appendErr := server.taskStore.Append(id, task.Event{Type: "task.canceled", Error: "user_requested"}); appendErr == nil {
			server.notifyTask(id)
			server.deleteTaskSignal(id)
		} else if errors.Is(appendErr, task.ErrTerminal) {
			server.deleteTaskSignal(id)
		}
		return
	}
	errorCode := "execution_failed"
	if server.ctx.Err() != nil || errors.Is(err, context.Canceled) {
		errorCode = "daemon_stopped"
	}
	if _, _, appendErr := server.taskStore.Append(id, task.Event{Type: "task.interrupted", Error: errorCode}); appendErr == nil {
		server.notifyTask(id)
		server.deleteTaskSignal(id)
	}
}

func (server *daemonServer) cancelComputerTask(id string) (daemonrpc.ComputerTask, error) {
	if server.taskStore == nil {
		return daemonrpc.ComputerTask{}, errors.New("Agent Computer Task store is unavailable")
	}
	view, err := server.taskStore.Inspect(id)
	if err != nil {
		return daemonrpc.ComputerTask{}, err
	}
	if task.IsTerminal(view.State) {
		server.taskLogEvent("task_cancel", id, "terminal_replay", "none", 0)
		return daemonTaskFromView(view), nil
	}
	var journalErr error
	if view.State != task.StateCanceling {
		_, updated, appendErr := server.taskStore.Append(id, task.Event{Type: "task.cancel_requested"})
		switch {
		case appendErr == nil:
			view = updated
			server.notifyTask(id)
		case errors.Is(appendErr, task.ErrTerminal):
			current, inspectErr := server.taskStore.Inspect(id)
			return daemonTaskFromView(current), inspectErr
		case !errors.Is(appendErr, task.ErrJournalFull):
			journalErr = appendErr
		}
	}
	server.taskLifecycleMu.Lock()
	cancel := server.taskRuns[id]
	server.taskLifecycleMu.Unlock()
	if cancel != nil {
		cancel(errComputerTaskCanceled)
	} else {
		_, updated, appendErr := server.taskStore.Append(id, task.Event{Type: "task.canceled", Error: "user_requested_before_start"})
		if appendErr != nil && !errors.Is(appendErr, task.ErrTerminal) {
			return daemonrpc.ComputerTask{}, appendErr
		}
		if appendErr == nil {
			view = updated
			server.notifyTask(id)
			server.deleteTaskSignal(id)
		}
	}
	if journalErr != nil {
		return daemonrpc.ComputerTask{}, journalErr
	}
	current, err := server.taskStore.Inspect(id)
	if err != nil {
		return daemonrpc.ComputerTask{}, err
	}
	server.taskLogEvent("task_cancel", id, current.State, "none", 0)
	return daemonTaskFromView(current), nil
}

func (server *daemonServer) taskLogEvent(operation, taskID, result, code string, duration time.Duration) {
	output := server.taskLog
	if output == nil {
		return
	}
	_, _ = fmt.Fprintf(output, "component=daemon operation=%s task_id=%s result=%s code=%s duration_ms=%d\n", operation, taskID, result, code, duration/time.Millisecond)
}

func (server *daemonServer) retryComputerTask(request daemonrpc.ComputerTaskRetryRequest) (daemonrpc.ComputerTask, error) {
	if server.taskStore == nil {
		return daemonrpc.ComputerTask{}, errors.New("Agent Computer Task store is unavailable")
	}
	source, err := server.taskStore.Inspect(request.SourceID)
	if err != nil {
		return daemonrpc.ComputerTask{}, err
	}
	if source.State != task.StateFailed && source.State != task.StateCanceled && source.State != task.StateInterrupted {
		return daemonrpc.ComputerTask{}, errors.New("only failed, canceled, or interrupted Tasks may be retried")
	}
	digest, err := computerTaskRequestDigest(source.ComputerID, request.Command)
	if err != nil {
		return daemonrpc.ComputerTask{}, err
	}
	if digest != source.RequestSHA256 {
		return daemonrpc.ComputerTask{}, errors.New("retry command does not match the source Task request digest")
	}
	return server.createComputerTask(daemonrpc.ComputerTaskSubmitRequest{
		ID: request.ID, ComputerID: source.ComputerID, Command: request.Command,
	}, source.ID, nil)
}

func cloneCredentialValues(values map[string][]byte) map[string][]byte {
	if values == nil {
		return nil
	}
	cloned := make(map[string][]byte, len(values))
	for id, value := range values {
		cloned[id] = append([]byte(nil), value...)
	}
	return cloned
}

func (server *daemonServer) pruneComputerTasks(retention time.Duration, limit int) (daemonrpc.ComputerTasksPruned, error) {
	if server.taskStore == nil {
		return daemonrpc.ComputerTasksPruned{}, errors.New("Agent Computer Task store is unavailable")
	}
	before := time.Now().UTC().Add(-retention)
	removed, err := server.taskStore.Prune(before, limit)
	if err != nil {
		return daemonrpc.ComputerTasksPruned{}, err
	}
	for _, id := range removed {
		server.deleteTaskSignal(id)
	}
	return daemonrpc.ComputerTasksPruned{TaskIDs: removed, Before: before.Format(time.RFC3339Nano)}, nil
}

func (server *daemonServer) sweepComputerTasks(retention, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-server.ctx.Done():
			return
		case <-ticker.C:
			if _, err := server.pruneComputerTasks(retention, automaticTaskPruneLimit); err != nil && server.ctx.Err() == nil {
				output := server.taskLog
				if output == nil {
					output = os.Stderr
				}
				fmt.Fprintln(output, "component=daemon operation=task_gc object_id=none result=failed code=task_gc_failed")
			}
		}
	}
}

func (server *daemonServer) inspectComputerTask(id string) (daemonrpc.ComputerTask, error) {
	if server.taskStore == nil {
		return daemonrpc.ComputerTask{}, errors.New("Agent Computer Task store is unavailable")
	}
	view, err := server.taskStore.Inspect(id)
	if err != nil {
		return daemonrpc.ComputerTask{}, err
	}
	return daemonTaskFromView(view), nil
}

func (server *daemonServer) listComputerTasks(computerID string) ([]daemonrpc.ComputerTask, error) {
	if server.taskStore == nil {
		return nil, errors.New("Agent Computer Task store is unavailable")
	}
	views, err := server.taskStore.List(computerID)
	if err != nil {
		return nil, err
	}
	result := make([]daemonrpc.ComputerTask, 0, len(views))
	for _, view := range views {
		result = append(result, daemonTaskFromView(view))
	}
	return result, nil
}

func (server *daemonServer) handleComputerTaskAttach(connection net.Conn, codec *daemonrpc.Codec, requestID string, request daemonrpc.ComputerTaskAttachRequest) error {
	if server.taskStore == nil {
		return errors.New("Agent Computer Task store is unavailable")
	}
	ctx, cancel := context.WithCancel(server.ctx)
	defer cancel()
	go func() {
		var extra [1]byte
		_, _ = connection.Read(extra[:])
		cancel()
	}()
	accepted, _ := daemonrpc.NewEnvelope(requestID, daemonrpc.TypeAccepted, daemonrpc.Empty{})
	if err := codec.Write(accepted); err != nil {
		return err
	}
	cursor := request.AfterCursor
	for {
		signal := server.taskSignal(request.ID)
		events, view, err := server.taskStore.Read(request.ID, cursor, 1024)
		if err != nil {
			return err
		}
		for _, event := range events {
			response, err := daemonrpc.NewEnvelope(requestID, daemonrpc.TypeComputerTaskEvent, daemonTaskEvent(event))
			if err != nil {
				return err
			}
			if err := codec.Write(response); err != nil {
				return err
			}
			cursor = event.Cursor
		}
		if !request.Follow || task.IsTerminal(view.State) {
			if task.IsTerminal(view.State) {
				server.forgetTaskSignal(request.ID, signal)
			}
			response, err := daemonrpc.NewEnvelope(requestID, daemonrpc.TypeComputerTaskEnd, daemonTaskFromView(view))
			if err != nil {
				return err
			}
			return codec.Write(response)
		}
		if len(events) == 1024 {
			continue
		}
		select {
		case <-ctx.Done():
			return nil
		case <-signal:
		}
	}
}

func (server *daemonServer) forgetTaskSignal(id string, signal <-chan struct{}) {
	server.taskNotifyMu.Lock()
	defer server.taskNotifyMu.Unlock()
	if current := server.taskNotify[id]; current == signal {
		delete(server.taskNotify, id)
	}
}

func (server *daemonServer) deleteTaskSignal(id string) {
	server.taskNotifyMu.Lock()
	delete(server.taskNotify, id)
	server.taskNotifyMu.Unlock()
}

func (server *daemonServer) taskSignal(id string) <-chan struct{} {
	server.taskNotifyMu.Lock()
	defer server.taskNotifyMu.Unlock()
	if server.taskNotify == nil {
		server.taskNotify = make(map[string]chan struct{})
	}
	if server.taskNotify[id] == nil {
		server.taskNotify[id] = make(chan struct{})
	}
	return server.taskNotify[id]
}

func (server *daemonServer) notifyTask(id string) {
	server.taskNotifyMu.Lock()
	defer server.taskNotifyMu.Unlock()
	if server.taskNotify == nil {
		server.taskNotify = make(map[string]chan struct{})
	}
	if current := server.taskNotify[id]; current != nil {
		close(current)
	}
	server.taskNotify[id] = make(chan struct{})
}

func computerTaskRequestDigest(computerID string, command daemonrpc.Command) (string, error) {
	payload := struct {
		ComputerID              string   `json:"computer_id"`
		SessionID               string   `json:"session_id"`
		Argv                    []string `json:"argv"`
		Cwd                     string   `json:"cwd,omitempty"`
		CredentialIDs           []string `json:"credential_ids,omitempty"`
		ProtectedWorkspacePaths []string `json:"protected_workspace_paths,omitempty"`
		DeniedWorkspacePatterns []string `json:"denied_workspace_patterns,omitempty"`
		TimeoutMillis           uint64   `json:"timeout_ms"`
	}{
		ComputerID: computerID, SessionID: command.SessionID, Argv: command.Argv, Cwd: command.Cwd,
		CredentialIDs: command.CredentialIDs, ProtectedWorkspacePaths: command.ProtectedWorkspacePaths,
		DeniedWorkspacePatterns: command.DeniedWorkspacePatterns,
		TimeoutMillis:           command.TimeoutMillis,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(append([]byte("zapvm-computer-task-v1\x00"), encoded...))
	return hex.EncodeToString(digest[:]), nil
}

func daemonTaskFromView(view task.View) daemonrpc.ComputerTask {
	return daemonrpc.ComputerTask{
		ID: view.ID, ComputerID: view.ComputerID, RequestSHA256: view.RequestSHA256,
		RetryOf: view.RetryOf, State: view.State, CreatedAt: view.CreatedAt, UpdatedAt: view.UpdatedAt, LastCursor: view.LastCursor,
	}
}

func daemonTaskEvent(event task.Event) daemonrpc.ComputerTaskEvent {
	return daemonrpc.ComputerTaskEvent{
		Cursor: event.Cursor, Timestamp: event.Timestamp, TaskID: event.TaskID, Type: event.Type,
		CommandID: event.CommandID, Stream: event.Stream, Data: append([]byte(nil), event.Data...),
		PID: event.PID, OK: event.OK, Error: event.Error,
	}
}
