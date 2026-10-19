package acpclient

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"zapvm/internal/workspacefs"
)

func TestRunCompletesACPAgentLoopInsideWorkspace(t *testing.T) {
	testBinary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	state := filepath.Join(root, "state")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	wrapper := filepath.Join(root, "fake-agent")
	script := fmt.Sprintf("#!/bin/sh\nexec %q -test.run=TestACPHelperProcess\n", testBinary)
	if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	config := Config{
		AgentPath:   wrapper,
		Workspace:   workspace,
		StateDir:    state,
		Prompt:      "create marker",
		Model:       "test-model",
		Env:         append(os.Environ(), "GO_WANT_ACP_HELPER=1"),
		TerminalEnv: []string{"PATH=/bin:/usr/bin"},
		Output:      &output,
		Stderr:      os.Stderr,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	info, err := Run(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "dim" || info.Version != "test-version" {
		t.Fatalf("agent info = %#v", info)
	}
	marker, err := os.ReadFile(filepath.Join(workspace, "acp-vm-marker.txt"))
	if err != nil || string(marker) != "ACP_VM_OK" {
		t.Fatalf("marker = %q, %v", marker, err)
	}
	stream := output.String()
	for _, expected := range []string{`"protocol":"acp"`, `"name":"dim"`, `"delta":"SESSION_READY"`, `"type":"tool_use"`, `"type":"tool_result"`, `"delta":"DIM_ACP_OK"`, `"type":"result"`} {
		if !strings.Contains(stream, expected) {
			t.Fatalf("stream missing %q:\n%s", expected, stream)
		}
	}
	stored, err := os.Stat(filepath.Join(state, "acp-session.json"))
	if err != nil || stored.Mode().Perm() != 0o600 {
		t.Fatalf("stored session mode = %v, %v", stored, err)
	}
	config.Continue = true
	if _, err := Run(ctx, config); err != nil {
		t.Fatalf("resume failed: %v", err)
	}
	if !strings.Contains(output.String(), "SESSION_RESUMED") {
		t.Fatal("runtime did not resume the existing Agent session")
	}
}

func TestPermissionRemainsOneShotAndSessionBound(t *testing.T) {
	runtime := &runtime{sessionID: "session-1"}
	for _, test := range []struct {
		name    string
		params  string
		allowed bool
	}{
		{"one shot", `{"sessionId":"session-1","options":[{"optionId":"yes","kind":"allow_once"}]}`, true},
		{"permanent", `{"sessionId":"session-1","options":[{"optionId":"yes","kind":"allow_always"}]}`, false},
		{"wrong session", `{"sessionId":"other","options":[{"optionId":"yes","kind":"allow_once"}]}`, false},
		{"no grant", `{"sessionId":"session-1","options":[]}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := runtime.permission(json.RawMessage(test.params))
			if (err == nil) != test.allowed {
				t.Fatalf("permission error = %v", err)
			}
		})
	}
}

func TestWorkspaceRelativeRejectsOutsideAndProtectedPaths(t *testing.T) {
	root := t.TempDir()
	explorer, err := workspacefs.New(root)
	if err != nil {
		t.Fatal(err)
	}
	runtime := &runtime{config: Config{Workspace: root}, explorer: explorer}
	for _, unsafe := range []string{"/etc/passwd", filepath.Join(root, ".git", "config"), filepath.Join(root, ".zapcode", "settings.json")} {
		if _, err := runtime.workspaceRelative(unsafe, false); err == nil {
			t.Fatalf("unsafe path %q was accepted", unsafe)
		}
	}
}

func TestACPHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_ACP_HELPER") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	workspace := ""
	terminalID := ""
	var promptID any
	stage := ""
	for scanner.Scan() {
		var message map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			os.Exit(91)
		}
		method, _ := message["method"].(string)
		id := message["id"]
		params, _ := message["params"].(map[string]any)
		switch method {
		case "initialize":
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
				"protocolVersion":   1,
				"agentInfo":         map[string]string{"name": "dim", "title": "Dim", "version": "test-version"},
				"agentCapabilities": map[string]any{"sessionCapabilities": map[string]any{"resume": map[string]any{}}},
			}})
		case "session/new":
			workspace, _ = params["cwd"].(string)
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{
				"sessionId": "dim-session-1", "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]string{"type": "text", "text": "SESSION_READY"}},
			}})
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
				"sessionId":     "dim-session-1",
				"configOptions": []map[string]any{{"id": "permission", "currentValue": "read-only", "options": []map[string]string{{"value": "read-only"}, {"value": "full-access"}}}},
			}})
		case "session/resume":
			workspace, _ = params["cwd"].(string)
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{
				"sessionId": "dim-session-1", "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]string{"type": "text", "text": "SESSION_RESUMED"}},
			}})
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
				"configOptions": []map[string]any{{"id": "permission", "currentValue": "full-access", "options": []map[string]string{{"value": "read-only"}, {"value": "full-access"}}}},
			}})
		case "session/set_config_option":
			// The runtime must not replace the Agent's own permission mode.
			os.Exit(92)
		case "session/prompt":
			prompt, _ := params["prompt"].([]any)
			if len(prompt) != 1 {
				os.Exit(93)
			}
			block, _ := prompt[0].(map[string]any)
			if block["text"] != "create marker" {
				os.Exit(94)
			}
			promptID = id
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{
				"sessionId": "dim-session-1", "update": map[string]any{"sessionUpdate": "tool_call", "toolCallId": "tool-1", "title": "terminal", "kind": "execute", "status": "in_progress"},
			}})
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": 900, "method": "terminal/create", "params": map[string]any{
				"sessionId": "dim-session-1", "command": "/bin/sh", "args": []string{"-c", "printf ACP_VM_OK > acp-vm-marker.txt"}, "cwd": workspace, "outputByteLimit": 4096,
			}})
			stage = "create"
		case "":
			if stage == "create" {
				result, _ := message["result"].(map[string]any)
				terminalID, _ = result["terminalId"].(string)
				_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": 901, "method": "terminal/wait_for_exit", "params": map[string]any{"sessionId": "dim-session-1", "terminalId": terminalID}})
				stage = "wait"
			} else if stage == "wait" {
				_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{
					"sessionId": "dim-session-1", "update": map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "tool-1", "status": "completed", "rawOutput": "ACP_VM_OK"},
				}})
				_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{
					"sessionId": "dim-session-1", "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]string{"type": "text", "text": "DIM_ACP_OK"}},
				}})
				_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": promptID, "result": map[string]string{"stopReason": "end_turn"}})
				stage = "done"
			}
		}
	}
	os.Exit(0)
}
