package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"

	"zapvm/internal/daemonrpc"
	"zapvm/internal/task"
)

func runComputerTask(args []string) error {
	if len(args) == 0 {
		return errors.New("computer task requires submit, list, inspect, attach, cancel, retry, or prune")
	}
	switch args[0] {
	case "submit":
		return runComputerTaskSubmit(args[1:])
	case "list":
		return runComputerTaskList(args[1:])
	case "inspect":
		return runComputerTaskInspect(args[1:])
	case "attach":
		return runComputerTaskAttach(args[1:])
	case "cancel":
		return runComputerTaskCancel(args[1:])
	case "retry":
		return runComputerTaskRetry(args[1:])
	case "prune":
		return runComputerTaskPrune(args[1:])
	default:
		return fmt.Errorf("unknown computer task command %q", args[0])
	}
}

func runComputerTaskSubmit(args []string) error {
	flags := flag.NewFlagSet("computer task submit", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	taskID := flags.String("task-id", "", "optional idempotency key")
	sessionID := flags.String("session-id", "cli-session", "logical Session identity")
	cwd := flags.String("cwd", ".", "guest command working directory")
	timeout := flags.Duration("exec-timeout", time.Minute, "guest command timeout")
	var credentialIDs []string
	var protectedWorkspacePaths []string
	flags.Func("credential-id", "request a daemon-authorized credential ID; repeatable", func(value string) error {
		credentialIDs = append(credentialIDs, value)
		return nil
	})
	flags.Func("protect-workspace-path", "workspace-relative path to expose read-only inside the Guest; repeatable", func(value string) error {
		protectedWorkspacePaths = append(protectedWorkspacePaths, value)
		return nil
	})
	if err := flags.Parse(args); err != nil {
		return err
	}
	remaining := flags.Args()
	if len(remaining) > 1 && remaining[1] == "--" {
		remaining = append(remaining[:1], remaining[2:]...)
	}
	if len(remaining) < 2 {
		return errors.New("computer task submit requires a Computer ID and command")
	}
	commandID, err := randomDaemonID()
	if err != nil {
		return err
	}
	request := daemonrpc.ComputerTaskSubmitRequest{
		ID: *taskID, ComputerID: remaining[0],
		Command: daemonrpc.Command{
			ID: commandID, SessionID: *sessionID, Argv: remaining[1:], Cwd: *cwd,
			CredentialIDs: credentialIDs, ProtectedWorkspacePaths: protectedWorkspacePaths,
			TimeoutMillis: uint64(timeout.Milliseconds()),
		},
	}
	if err := request.Command.Validate(); err != nil {
		return err
	}
	response, err := daemonRequest(*endpoint, daemonrpc.TypeComputerTaskSubmit, request)
	if err != nil {
		return err
	}
	return printComputerTaskResponse(response, daemonrpc.TypeComputerTask)
}

func runComputerTaskList(args []string) error {
	flags := flag.NewFlagSet("computer task list", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	computerID := flags.String("computer", "", "optional Computer ID filter")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("computer task list does not accept positional arguments")
	}
	response, err := daemonRequest(*endpoint, daemonrpc.TypeComputerTaskList, daemonrpc.ComputerTaskListRequest{ComputerID: *computerID})
	if err != nil {
		return err
	}
	if response.Type != daemonrpc.TypeComputerTasks {
		return fmt.Errorf("unexpected Computer Task list response %q", response.Type)
	}
	list, err := daemonrpc.DecodePayload[daemonrpc.ComputerTaskList](response.Payload)
	if err != nil {
		return err
	}
	return printJSON(list)
}

func runComputerTaskInspect(args []string) error {
	flags := flag.NewFlagSet("computer task inspect", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return errors.New("computer task inspect requires one Task ID")
	}
	response, err := daemonRequest(*endpoint, daemonrpc.TypeComputerTaskInspect, daemonrpc.ComputerTaskReference{ID: flags.Arg(0)})
	if err != nil {
		return err
	}
	return printComputerTaskResponse(response, daemonrpc.TypeComputerTask)
}

func runComputerTaskCancel(args []string) error {
	flags := flag.NewFlagSet("computer task cancel", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return errors.New("computer task cancel requires one Task ID")
	}
	response, err := daemonRequest(*endpoint, daemonrpc.TypeComputerTaskCancel, daemonrpc.ComputerTaskReference{ID: flags.Arg(0)})
	if err != nil {
		return err
	}
	return printComputerTaskResponse(response, daemonrpc.TypeComputerTask)
}

func runComputerTaskRetry(args []string) error {
	flags := flag.NewFlagSet("computer task retry", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	taskID := flags.String("task-id", "", "optional new idempotency key")
	sessionID := flags.String("session-id", "cli-session", "logical Session identity; must match the source Task")
	cwd := flags.String("cwd", ".", "guest command working directory; must match the source Task")
	timeout := flags.Duration("exec-timeout", time.Minute, "guest command timeout; must match the source Task")
	var credentialIDs []string
	var protectedWorkspacePaths []string
	flags.Func("credential-id", "source Task credential ID; repeatable and order-sensitive", func(value string) error {
		credentialIDs = append(credentialIDs, value)
		return nil
	})
	flags.Func("protect-workspace-path", "source Task protected workspace path; repeatable and order-sensitive", func(value string) error {
		protectedWorkspacePaths = append(protectedWorkspacePaths, value)
		return nil
	})
	if err := flags.Parse(args); err != nil {
		return err
	}
	remaining := flags.Args()
	if len(remaining) > 1 && remaining[1] == "--" {
		remaining = append(remaining[:1], remaining[2:]...)
	}
	if len(remaining) < 2 {
		return errors.New("computer task retry requires a source Task ID and the original command")
	}
	commandID, err := randomDaemonID()
	if err != nil {
		return err
	}
	request := daemonrpc.ComputerTaskRetryRequest{
		SourceID: remaining[0], ID: *taskID,
		Command: daemonrpc.Command{
			ID: commandID, SessionID: *sessionID, Argv: remaining[1:], Cwd: *cwd,
			CredentialIDs: credentialIDs, ProtectedWorkspacePaths: protectedWorkspacePaths,
			TimeoutMillis: uint64(timeout.Milliseconds()),
		},
	}
	if err := request.Command.Validate(); err != nil {
		return err
	}
	response, err := daemonRequest(*endpoint, daemonrpc.TypeComputerTaskRetry, request)
	if err != nil {
		return err
	}
	return printComputerTaskResponse(response, daemonrpc.TypeComputerTask)
}

func runComputerTaskPrune(args []string) error {
	flags := flag.NewFlagSet("computer task prune", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	olderThan := flags.Duration("older-than", 30*24*time.Hour, "delete only terminal Task journals older than this duration")
	limit := flags.Int("limit", 1000, "maximum Task journals to delete")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("computer task prune does not accept positional arguments")
	}
	request := daemonrpc.ComputerTaskPruneRequest{RetentionMillis: uint64(olderThan.Milliseconds()), Limit: *limit}
	encoded, err := json.Marshal(request)
	if err != nil {
		return err
	}
	if _, err := daemonrpc.DecodeComputerTaskPrune(encoded); err != nil {
		return err
	}
	response, err := daemonRequest(*endpoint, daemonrpc.TypeComputerTaskPrune, request)
	if err != nil {
		return err
	}
	if response.Type != daemonrpc.TypeComputerTasksPruned {
		return fmt.Errorf("unexpected Computer Task prune response %q", response.Type)
	}
	pruned, err := daemonrpc.DecodePayload[daemonrpc.ComputerTasksPruned](response.Payload)
	if err != nil {
		return err
	}
	return printJSON(pruned)
}

func runComputerTaskAttach(args []string) error {
	flags := flag.NewFlagSet("computer task attach", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	follow := flags.Bool("follow", true, "wait for new events until the Task is terminal")
	jsonEvents := flags.Bool("json", false, "print every cursor event as JSON")
	var afterCursor uint64
	flags.Func("after", "resume after this output cursor", func(value string) error {
		parsed, err := strconv.ParseUint(value, 10, 64)
		if err != nil {
			return fmt.Errorf("invalid Task cursor %q", value)
		}
		afterCursor = parsed
		return nil
	})
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return errors.New("computer task attach requires one Task ID")
	}
	requestID, err := randomDaemonID()
	if err != nil {
		return err
	}
	request := daemonrpc.ComputerTaskAttachRequest{ID: flags.Arg(0), AfterCursor: afterCursor, Follow: *follow}
	return daemonClientTaskAttach(*endpoint, requestID, request, *jsonEvents, os.Stdout, os.Stderr)
}

func daemonClientTaskAttach(endpoint, requestID string, request daemonrpc.ComputerTaskAttachRequest, jsonEvents bool, stdout, stderr io.Writer) error {
	if stdout == nil {
		stdout = io.Discard
	}
	if stderr == nil {
		stderr = io.Discard
	}
	connection, codec, err := dialDaemon(endpoint)
	if err != nil {
		return err
	}
	defer connection.Close()
	envelope, err := daemonrpc.NewEnvelope(requestID, daemonrpc.TypeComputerTaskAttach, request)
	if err != nil {
		return err
	}
	if err := codec.Write(envelope); err != nil {
		return err
	}
	encoder := json.NewEncoder(stdout)
	for {
		response, err := codec.Read()
		if err != nil {
			return err
		}
		if response.ID != requestID {
			return errors.New("daemon response request ID mismatch")
		}
		switch response.Type {
		case daemonrpc.TypeAccepted:
			if err := daemonrpc.DecodeEmpty(response.Payload); err != nil {
				return err
			}
		case daemonrpc.TypeComputerTaskEvent:
			event, err := daemonrpc.DecodePayload[daemonrpc.ComputerTaskEvent](response.Payload)
			if err != nil {
				return err
			}
			if jsonEvents {
				if err := encoder.Encode(event); err != nil {
					return err
				}
			} else if event.Type == "exec.output" {
				writer := stdout
				if event.Stream == "stderr" {
					writer = stderr
				}
				if _, err := writer.Write(event.Data); err != nil {
					return err
				}
			}
		case daemonrpc.TypeComputerTaskEnd:
			current, err := daemonrpc.DecodePayload[daemonrpc.ComputerTask](response.Payload)
			if err != nil {
				return err
			}
			_, _ = fmt.Fprintf(stderr, "zapVM Task %s state=%s cursor=%d\n", current.ID, current.State, current.LastCursor)
			switch current.State {
			case task.StateFailed:
				return errors.New("Agent Computer Task failed")
			case task.StateInterrupted:
				return errors.New("Agent Computer Task was interrupted")
			case task.StateCanceled:
				return errors.New("Agent Computer Task was canceled")
			default:
				return nil
			}
		case daemonrpc.TypeError:
			message, err := daemonrpc.DecodePayload[daemonrpc.Error](response.Payload)
			if err != nil {
				return err
			}
			return errors.New(message.Message)
		default:
			return fmt.Errorf("unexpected Task attach response %q", response.Type)
		}
	}
}

func printComputerTaskResponse(response daemonrpc.Envelope, expectedType string) error {
	if response.Type != expectedType {
		return fmt.Errorf("unexpected Computer Task response %q", response.Type)
	}
	current, err := daemonrpc.DecodePayload[daemonrpc.ComputerTask](response.Payload)
	if err != nil {
		return err
	}
	return printJSON(current)
}
