package main

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"time"

	"zapvm/internal/agentpackage"
	"zapvm/internal/credential"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/hostpolicy"
	"zapvm/internal/platform"
	"zapvm/internal/vmpool"
)

// prepareDaemonExecution rebuilds every Computer-owned authority from the
// protected registry. Callers may supply only the Computer ID and command.
func (server *daemonServer) prepareDaemonExecution(request daemonrpc.ExecRequest) (daemonrpc.ExecRequest, vmpool.Route, error) {
	if request.ComputerID != "" {
		if server.computers == nil {
			return daemonrpc.ExecRequest{}, vmpool.Route{}, errors.New("Agent Computer store is unavailable")
		}
		record, err := server.computers.Get(request.ComputerID)
		if err != nil {
			return daemonrpc.ExecRequest{}, vmpool.Route{}, err
		}
		request.Workspace = record.Workspace
		request.WorkspaceReadOnly = record.WorkspaceReadOnly
		request.Network = record.Network
		request.AllowedDomains = append([]string(nil), record.AllowedDomains...)
		request.AllowedPorts = append([]uint16(nil), record.AllowedPorts...)
	}
	if err := request.Validate(); err != nil {
		return daemonrpc.ExecRequest{}, vmpool.Route{}, err
	}
	workspace, err := hostpolicy.ValidateWorkspace(request.Workspace)
	if err != nil {
		return daemonrpc.ExecRequest{}, vmpool.Route{}, err
	}
	request.Workspace = workspace
	policyDigest, policy, err := normalizeDaemonPolicy(request)
	if err != nil {
		return daemonrpc.ExecRequest{}, vmpool.Route{}, err
	}
	if policyDigest != "" {
		server.policiesMu.Lock()
		if _, exists := server.policies[policyDigest]; !exists && len(server.policies) >= 1024 {
			server.policiesMu.Unlock()
			return daemonrpc.ExecRequest{}, vmpool.Route{}, errors.New("daemon restricted-policy capacity is exhausted")
		}
		server.policies[policyDigest] = policy
		server.policiesMu.Unlock()
	}
	if request.CredentialValues != nil {
		if err := daemonrpc.ValidateCredentialValues(request.Command.CredentialIDs, request.CredentialValues); err != nil {
			return daemonrpc.ExecRequest{}, vmpool.Route{}, err
		}
	} else {
		values, err := server.credentials.Resolve(request.Command.CredentialIDs)
		credential.ZeroValues(values)
		if err != nil {
			return daemonrpc.ExecRequest{}, vmpool.Route{}, err
		}
	}
	image, err := server.currentImage()
	if err != nil {
		return daemonrpc.ExecRequest{}, vmpool.Route{}, err
	}
	agentReference := ""
	agentDigest := ""
	if request.ComputerID != "" {
		record, err := server.computers.Get(request.ComputerID)
		if err != nil {
			return daemonrpc.ExecRequest{}, vmpool.Route{}, err
		}
		agentReference = record.Agent
		if agentReference != "" {
			selectedAgent, err := agentpackage.Resolve(server.agentRoot, agentReference, server.agentPublicKey, runtime.GOOS, runtime.GOARCH, image.agentContract())
			if err != nil {
				return daemonrpc.ExecRequest{}, vmpool.Route{}, fmt.Errorf("resolve Computer Agent: %w", err)
			}
			agentDigest = selectedAgent.Digest
		}
	}
	cpuCount, memoryBytes := server.cpuCount, server.memoryBytes
	if request.ComputerID != "" {
		record, err := server.computers.Get(request.ComputerID)
		if err != nil {
			return daemonrpc.ExecRequest{}, vmpool.Route{}, err
		}
		cpuCount, memoryBytes = record.CPUCount, record.MemoryMiB*platform.MiB
	}
	route := vmpool.Route{
		ComputerID: request.ComputerID,
		Workspace:  request.Workspace, WorkspaceReadOnly: request.WorkspaceReadOnly,
		Network: request.Network, NetworkPolicyDigest: policyDigest, ImageDigest: image.digest,
		AgentReference: agentReference, AgentDigest: agentDigest,
		CredentialScopeDigest: server.credentialDigest, CPUCount: cpuCount, MemoryBytes: memoryBytes,
	}
	if route.ComputerID == "" {
		route.StateDigest = daemonStateDigest(route)
	} else {
		route.StateDigest = computerStateDigest(route.ComputerID)
	}
	return request, route, nil
}

// startComputer acquires and immediately releases a VM lease. The pool keeps
// the compatible idle worker warm, so a later Task can start without paying
// the boot cost. The synthetic command is validated but never executed.
func (server *daemonServer) startComputer(ctx context.Context, computerID string) (daemonrpc.ComputerSpec, error) {
	_, route, err := server.prepareDaemonExecution(daemonrpc.ExecRequest{
		ComputerID: computerID,
		Command: daemonrpc.Command{
			ID: "computer-start", SessionID: "computer-start",
			Argv: []string{"/bin/true"}, TimeoutMillis: 1,
		},
	})
	if err != nil {
		return daemonrpc.ComputerSpec{}, err
	}
	lease, err := server.pool.Acquire(ctx, route)
	if err != nil {
		return daemonrpc.ComputerSpec{}, err
	}
	if err := lease.Release(); err != nil {
		return daemonrpc.ComputerSpec{}, err
	}
	current, err := server.inspectComputer(computerID)
	if err != nil {
		return daemonrpc.ComputerSpec{}, err
	}
	if current.RuntimeState != vmpool.ComputerRunning {
		return daemonrpc.ComputerSpec{}, errors.New("Computer did not become ready after VM start")
	}
	return current, nil
}

// executeDaemonRequest owns a complete pool lease independently from any
// client connection. onReady runs only after a compatible VM worker is leased.
// The terminal result is emitted only after the lease is released.
func (server *daemonServer) executeDaemonRequest(
	ctx context.Context,
	request daemonrpc.ExecRequest,
	onReady func() error,
	emit func(daemonrpc.Event) error,
) error {
	request, route, err := server.prepareDaemonExecution(request)
	if err != nil {
		return err
	}
	lease, err := server.pool.Acquire(ctx, route)
	if err != nil {
		return err
	}
	worker, ok := lease.Worker().(*daemonStdioWorker)
	if !ok {
		_ = lease.Discard(context.Background())
		return errors.New("VM pool returned an incompatible worker")
	}
	if onReady != nil {
		if err := onReady(); err != nil {
			discardCtx, discardCancel := context.WithTimeout(context.Background(), 15*time.Second)
			discardErr := lease.Discard(discardCtx)
			discardCancel()
			return errors.Join(err, discardErr)
		}
	}
	var terminalResult *daemonrpc.Event
	execErr := worker.ExecuteCredentialed(ctx, request.Command, request.CredentialValues, func(event daemonrpc.Event) error {
		if event.Type == "result" {
			result := event
			result.Data = append([]byte(nil), event.Data...)
			terminalResult = &result
			return nil
		}
		if emit == nil {
			return nil
		}
		return emit(event)
	})
	var canceledErr *daemonCommandCanceledError
	if errors.As(execErr, &canceledErr) {
		return errors.Join(execErr, lease.Release())
	}
	var guestErr *daemonGuestCommandError
	if execErr == nil || errors.As(execErr, &guestErr) {
		if terminalResult == nil {
			_ = lease.Discard(context.Background())
			return errors.New("daemon worker completed without a result event")
		}
		if err := lease.Release(); err != nil {
			return err
		}
		if emit != nil {
			return emit(*terminalResult)
		}
		return nil
	}
	discardCtx, discardCancel := context.WithTimeout(context.Background(), 15*time.Second)
	discardErr := lease.Discard(discardCtx)
	discardCancel()
	return errors.Join(execErr, discardErr)
}
