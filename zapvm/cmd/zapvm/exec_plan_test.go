package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"zapvm/internal/agent"
	"zapvm/internal/credential"
	"zapvm/internal/platform"
)

func TestLoadExecPlanStrictValidation(t *testing.T) {
	writePlan := func(name, content string) string {
		path := filepath.Join(t.TempDir(), name)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	validPath := writePlan("valid.json", `{
      "schema_version":1,
      "parallel":true,
      "commands":[
        {"id":"one","session_id":"a","argv":["/bin/echo","one"],"protected_workspace_paths":[".git"],"denied_workspace_patterns":["**/.env"]},
        {"id":"two","session_id":"b","argv":["/bin/echo","two"],"timeout_ms":5000}
      ]
    }`)
	plan, err := loadExecPlan(validPath, time.Minute)
	if err != nil || !plan.Parallel || len(plan.Commands) != 2 {
		t.Fatalf("plan = %+v, %v", plan, err)
	}

	for name, content := range map[string]string{
		"unknown":   `{"schema_version":1,"commands":[{"id":"one","session_id":"a","argv":["true"]}],"unknown":true}`,
		"duplicate": `{"schema_version":1,"commands":[{"id":"one","session_id":"a","argv":["true"]},{"id":"one","session_id":"b","argv":["true"]}]}`,
		"timeout":   `{"schema_version":1,"commands":[{"id":"one","session_id":"a","argv":["true"],"timeout_ms":86400001}]}`,
		"protected": `{"schema_version":1,"commands":[{"id":"one","session_id":"a","argv":["true"],"protected_workspace_paths":["../escape"]}]}`,
		"denied":    `{"schema_version":1,"commands":[{"id":"one","session_id":"a","argv":["true"],"denied_workspace_patterns":["../escape"]}]}`,
		"trailing":  `{"schema_version":1,"commands":[{"id":"one","session_id":"a","argv":["true"]}]} {}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := loadExecPlan(writePlan(name+".json", content), time.Minute); err == nil {
				t.Fatal("invalid execution plan was accepted")
			}
		})
	}
}

func TestWriteResultPreservesGuestExitCode(t *testing.T) {
	var output bytes.Buffer
	runner := execCommandRunner{sink: &execPlanEventSink{encoder: json.NewEncoder(&output)}}
	if err := runner.writeResult("failed", &guestCommandExitError{Code: 23}); err != nil {
		t.Fatal(err)
	}
	var event execPlanEvent
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &event); err != nil {
		t.Fatal(err)
	}
	if event.OK == nil || *event.OK || event.ExitCode == nil || *event.ExitCode != 23 {
		t.Fatalf("Guest exit code was not preserved: %+v", event)
	}
}

type execPlanTestDialer struct {
	ctx    context.Context
	server *agent.Server
}

func (dialer execPlanTestDialer) DialAgent(context.Context, uint32) (io.ReadWriteCloser, error) {
	client, server := net.Pipe()
	go func() { _ = dialer.server.Serve(dialer.ctx, server) }()
	return client, nil
}

func TestRunExecPlanParallelRoutesOutputByCommand(t *testing.T) {
	secret := bytes.Repeat([]byte{0x5a}, 32)
	server, err := agent.NewServer(t.TempDir(), secret, maxParallelCommands)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	plan := execPlan{SchemaVersion: 1, Parallel: true, Commands: []execPlanCommand{
		{ID: "one", SessionID: "session-a", Argv: []string{"/bin/sh", "-c", "printf one"}},
		{ID: "two", SessionID: "session-b", Argv: []string{"/bin/sh", "-c", "printf two >&2"}},
	}}
	var output bytes.Buffer
	if err := runExecPlanTo(ctx, execPlanTestDialer{ctx: ctx, server: server}, secret, plan, platform.NetworkOff, time.Minute, nil, &output); err != nil {
		t.Fatal(err)
	}

	seenOutput := map[string]string{}
	seenResult := map[string]bool{}
	seenScheduled := map[string]bool{}
	seenStarted := map[string]bool{}
	scanner := bufio.NewScanner(&output)
	for scanner.Scan() {
		var event execPlanEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		switch event.Type {
		case "scheduled":
			seenScheduled[event.CommandID] = true
		case "started":
			if event.PID <= 0 {
				t.Fatalf("invalid started event: %+v", event)
			}
			seenStarted[event.CommandID] = true
		case "output":
			seenOutput[event.CommandID+":"+event.Stream] += string(event.Data)
		case "result":
			if event.OK == nil || !*event.OK || event.Error != "" {
				t.Fatalf("failed result event: %+v", event)
			}
			seenResult[event.CommandID] = true
		default:
			t.Fatalf("unexpected event: %+v", event)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(seenOutput["one:stdout"]) != "one" || strings.TrimSpace(seenOutput["two:stderr"]) != "two" {
		t.Fatalf("routed output = %+v", seenOutput)
	}
	if !seenScheduled["one"] || !seenScheduled["two"] || !seenStarted["one"] || !seenStarted["two"] || !seenResult["one"] || !seenResult["two"] {
		t.Fatalf("scheduled = %+v, started = %+v, result = %+v", seenScheduled, seenStarted, seenResult)
	}
}

func TestRunExecPlanResolvesOnlyRequestedCredentials(t *testing.T) {
	directory := t.TempDir()
	tokenPath := filepath.Join(directory, "token")
	unusedPath := filepath.Join(directory, "unused")
	if err := os.WriteFile(tokenPath, []byte("plan-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unusedPath, []byte("must-not-appear"), 0o600); err != nil {
		t.Fatal(err)
	}
	broker, err := credential.Load([]string{"api-token=" + tokenPath, "unused=" + unusedPath})
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Close()
	secret := bytes.Repeat([]byte{0x59}, 32)
	server, err := agent.NewServer(directory, secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	plan := execPlan{SchemaVersion: 1, Commands: []execPlanCommand{{
		ID: "credential", SessionID: "session-a",
		Argv:          []string{"/bin/sh", "-c", `set -eu; test "$(cat "$ZAPVM_CREDENTIAL_DIR/api-token")" = plan-secret; test ! -e "$ZAPVM_CREDENTIAL_DIR/unused"; printf credential-plan-ok`},
		CredentialIDs: []string{"api-token"},
	}}}
	var output bytes.Buffer
	if err := runExecPlanTo(ctx, execPlanTestDialer{ctx: ctx, server: server}, secret, plan, platform.NetworkOff, time.Minute, broker, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Y3JlZGVudGlhbC1wbGFuLW9r") || strings.Contains(output.String(), "plan-secret") || strings.Contains(output.String(), "must-not-appear") {
		t.Fatalf("unexpected credential plan output: %s", output.String())
	}
	unknown := plan
	unknown.Commands = append([]execPlanCommand(nil), plan.Commands...)
	unknown.Commands[0].CredentialIDs = []string{"missing"}
	if err := validatePlanCredentialBindings(unknown, broker); err == nil {
		t.Fatal("unknown credential ID passed plan preflight")
	}
}
