package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"time"

	"zapvm/internal/daemonrpc"
	"zapvm/internal/platform"
)

func runComputer(args []string) error {
	if len(args) == 0 {
		return errors.New("computer requires create, list, inspect, exec, stop, or task")
	}
	switch args[0] {
	case "create":
		return runComputerCreate(args[1:])
	case "list":
		return runComputerList(args[1:])
	case "inspect":
		return runComputerInspect(args[1:])
	case "exec":
		return runComputerExec(args[1:])
	case "stop":
		return runComputerStop(args[1:])
	case "task":
		return runComputerTask(args[1:])
	default:
		return fmt.Errorf("unknown computer command %q", args[0])
	}
}

func runComputerCreate(args []string) error {
	flags := flag.NewFlagSet("computer create", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	id := flags.String("id", "", "stable Agent Computer ID")
	agent := flags.String("agent", "", "signed pluggable Agent id@version; empty uses the Runtime image default")
	workspace := flags.String("workspace", "", "authorized workspace (default current directory)")
	workspaceReadOnly := flags.Bool("workspace-read-only", false, "share workspace read-only")
	network := flags.String("network", "unrestricted", "off, restricted, or unrestricted")
	cpus := flags.Uint("cpus", 0, "vCPUs (default daemon setting)")
	memoryMiB := flags.Uint64("memory-mib", 0, "memory MiB (default daemon setting)")
	var domains []string
	var ports []uint16
	flags.Func("allow-domain", "restricted-network domain; repeatable", func(value string) error {
		domains = append(domains, value)
		return nil
	})
	flags.Func("allow-port", "restricted-network port; repeatable", func(value string) error {
		parsed, err := strconv.ParseUint(value, 10, 16)
		if err != nil || parsed == 0 {
			return fmt.Errorf("invalid port %q", value)
		}
		ports = append(ports, uint16(parsed))
		return nil
	})
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *id == "" {
		return errors.New("computer create requires --id and accepts no positional arguments")
	}
	if *workspace == "" {
		var err error
		*workspace, err = os.Getwd()
		if err != nil {
			return err
		}
	}
	request := daemonrpc.ComputerCreateRequest{Computer: daemonrpc.ComputerSpec{
		ID: *id, Agent: *agent, Workspace: *workspace, WorkspaceReadOnly: *workspaceReadOnly,
		Network: platform.NetworkMode(*network), AllowedDomains: domains, AllowedPorts: ports,
		CPUCount: *cpus, MemoryMiB: *memoryMiB,
	}}
	if err := request.Computer.Validate(true); err != nil {
		return err
	}
	response, err := daemonRequest(*endpoint, daemonrpc.TypeComputerCreate, request)
	if err != nil {
		return err
	}
	return printComputerResponse(response, daemonrpc.TypeComputer)
}

func runComputerList(args []string) error {
	flags := flag.NewFlagSet("computer list", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("computer list does not accept positional arguments")
	}
	response, err := daemonRequest(*endpoint, daemonrpc.TypeComputerList, daemonrpc.Empty{})
	if err != nil {
		return err
	}
	if response.Type != daemonrpc.TypeComputers {
		return fmt.Errorf("unexpected computer list response %q", response.Type)
	}
	list, err := daemonrpc.DecodePayload[daemonrpc.ComputerList](response.Payload)
	if err != nil {
		return err
	}
	return printJSON(list)
}

func runComputerInspect(args []string) error {
	flags := flag.NewFlagSet("computer inspect", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return errors.New("computer inspect requires one Computer ID")
	}
	response, err := daemonRequest(*endpoint, daemonrpc.TypeComputerInspect, daemonrpc.ComputerReference{ID: flags.Arg(0)})
	if err != nil {
		return err
	}
	return printComputerResponse(response, daemonrpc.TypeComputer)
}

func runComputerExec(args []string) error {
	flags := flag.NewFlagSet("computer exec", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
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
		return errors.New("computer exec requires a Computer ID and command")
	}
	requestID, err := randomDaemonID()
	if err != nil {
		return err
	}
	request := daemonrpc.ComputerExecRequest{
		ID: remaining[0],
		Command: daemonrpc.Command{
			ID: requestID, SessionID: *sessionID, Argv: remaining[1:], Cwd: *cwd,
			CredentialIDs: credentialIDs, ProtectedWorkspacePaths: protectedWorkspacePaths,
			TimeoutMillis: uint64(timeout.Milliseconds()),
		},
	}
	if err := request.Command.Validate(); err != nil {
		return err
	}
	return daemonClientStreamTo(*endpoint, requestID, daemonrpc.TypeComputerExec, request, os.Stdout, os.Stderr)
}

func runComputerStop(args []string) error {
	flags := flag.NewFlagSet("computer stop", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return errors.New("computer stop requires one Computer ID")
	}
	response, err := daemonRequest(*endpoint, daemonrpc.TypeComputerStop, daemonrpc.ComputerReference{ID: flags.Arg(0)})
	if err != nil {
		return err
	}
	return printComputerResponse(response, daemonrpc.TypeComputerStopped)
}

func printComputerResponse(response daemonrpc.Envelope, expectedType string) error {
	if response.Type != expectedType {
		return fmt.Errorf("unexpected Computer response %q", response.Type)
	}
	computer, err := daemonrpc.DecodePayload[daemonrpc.ComputerSpec](response.Payload)
	if err != nil {
		return err
	}
	return printJSON(computer)
}

func printJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
