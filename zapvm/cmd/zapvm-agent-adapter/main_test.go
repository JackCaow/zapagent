package main

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"zapvm/internal/agentadapter"
	dimadapter "zapvm/internal/agentadapter/dim"
)

type recordingExecutor struct {
	request agentadapter.Request
}

func (executor *recordingExecutor) Execute(_ context.Context, request agentadapter.Request) agentadapter.Result {
	executor.request = request
	zero := 0
	return agentadapter.Result{Stdout: "adapter-ok\n", ExitCode: &zero, Backend: "test/dim"}
}

func TestRunAdapterAutoDetectsDimProtocol(t *testing.T) {
	workspace := t.TempDir()
	wire := map[string]any{
		"version": 1, "requestId": "request-a", "command": []string{"/bin/sh", "-lc", "pwd"}, "cwd": workspace,
		"policy": map[string]any{
			"enabled": true, "mode": "workspace-write", "workspaceRoot": workspace,
			"readableRoots": []string{workspace}, "writableRoots": []string{workspace},
			"readDenyPaths": []string{}, "allowedDomains": []string{}, "envAllowlist": []string{},
		},
	}
	input, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := agentadapter.NewRegistry(dimadapter.New())
	if err != nil {
		t.Fatal(err)
	}
	executor := &recordingExecutor{}
	var output bytes.Buffer
	if err := runAdapter(context.Background(), registry, bytes.NewReader(input), &output, func() (agentadapter.Executor, error) {
		return executor, nil
	}); err != nil {
		t.Fatal(err)
	}
	if executor.request.Protocol != dimadapter.ProtocolName || executor.request.Command[0] != "/bin/sh" || executor.request.Network != agentadapter.NetworkOff {
		t.Fatalf("unexpected normalized request: %+v", executor.request)
	}
	var result map[string]any
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result["requestId"] != "request-a" || result["stdout"] != "adapter-ok\n" || result["backend"] != "test/dim" {
		t.Fatalf("unexpected Dim wire result: %+v", result)
	}
}

func TestRunListsRegisteredProtocols(t *testing.T) {
	var output bytes.Buffer
	if err := run(context.Background(), []string{"list"}, bytes.NewReader(nil), &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != dimadapter.ProtocolName+"\n" {
		t.Fatalf("unexpected adapter list: %q", output.String())
	}
}
