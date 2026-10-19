package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"zapvm/internal/agent"
	"zapvm/internal/credential"
	"zapvm/internal/platform"
)

type fakeExecStreamController struct {
	pauses  atomic.Int32
	resumes atomic.Int32
}

func (controller *fakeExecStreamController) Pause(context.Context) error {
	controller.pauses.Add(1)
	return nil
}

func (controller *fakeExecStreamController) Resume(context.Context) error {
	controller.resumes.Add(1)
	return nil
}

func TestDecodeExecStreamRequestStrict(t *testing.T) {
	valid := []string{
		`{"schema_version":1,"type":"ping","id":"probe"}`,
		`{"schema_version":1,"type":"cancel","id":"one"}`,
		`{"schema_version":1,"type":"shutdown"}`,
		`{"schema_version":1,"type":"exec","command":{"id":"one","session_id":"a","argv":["/bin/true"]}}`,
	}
	for _, data := range valid {
		if _, err := decodeExecStreamRequest([]byte(data), time.Minute); err != nil {
			t.Fatalf("valid request rejected: %s: %v", data, err)
		}
	}
	invalid := []string{
		`{}`,
		`{"schema_version":1,"type":"ping"}`,
		`{"schema_version":1,"type":"cancel"}`,
		`{"schema_version":1,"type":"shutdown","id":"extra"}`,
		`{"schema_version":1,"type":"exec"}`,
		`{"schema_version":1,"type":"surprise"}`,
		`{"schema_version":1,"type":"ping","id":"probe","unknown":true}`,
	}
	for _, data := range invalid {
		if _, err := decodeExecStreamRequest([]byte(data), time.Minute); err == nil {
			t.Fatalf("invalid request accepted: %s", data)
		}
	}
}

func TestServeExecStreamRunsRequestsUntilShutdown(t *testing.T) {
	secret := bytes.Repeat([]byte{0x6b}, 32)
	server, err := agent.NewServer(t.TempDir(), secret, maxParallelCommands)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	input := strings.NewReader(strings.Join([]string{
		`{"schema_version":1,"type":"ping","id":"probe"}`,
		`{"schema_version":1,"type":"exec","command":{"id":"one","session_id":"a","argv":["/bin/sh","-c","printf one"]}}`,
		`{"schema_version":1,"type":"exec","command":{"id":"two","session_id":"b","argv":["/bin/sh","-c","printf two >&2"]}}`,
		`{"schema_version":1,"type":"shutdown"}`,
	}, "\n") + "\n")
	var output bytes.Buffer
	if err := serveExecStream(ctx, input, &output, execPlanTestDialer{ctx: ctx, server: server}, secret, platform.NetworkOff, time.Minute, time.Minute, nil, nil); err != nil {
		t.Fatal(err)
	}

	types := map[string]int{}
	results := map[string]bool{}
	streams := map[string]string{}
	scanner := bufio.NewScanner(&output)
	for scanner.Scan() {
		var event execPlanEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		types[event.Type]++
		if event.Type == "result" && event.OK != nil && *event.OK {
			results[event.CommandID] = true
		}
		if event.Type == "output" {
			streams[event.CommandID+":"+event.Stream] += string(event.Data)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if types["ready"] != 1 || types["pong"] != 1 || types["drained"] != 1 || types["started"] != 2 || !results["one"] || !results["two"] {
		t.Fatalf("types=%+v results=%+v output=%s", types, results, output.String())
	}
	if streams["one:stdout"] != "one" || streams["two:stderr"] != "two" {
		t.Fatalf("streams=%+v", streams)
	}
}

func TestServeExecStreamCancelStopsGuestCommand(t *testing.T) {
	secret := bytes.Repeat([]byte{0x6c}, 32)
	workspace := t.TempDir()
	marker := filepath.Join(workspace, "should-not-exist")
	server, err := agent.NewServer(workspace, secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	serveDone := make(chan error, 1)
	go func() {
		err := serveExecStream(ctx, inputReader, outputWriter, execPlanTestDialer{ctx: ctx, server: server}, secret, platform.NetworkOff, time.Minute, time.Minute, nil, nil)
		_ = outputWriter.CloseWithError(err)
		serveDone <- err
	}()
	encoder := json.NewEncoder(inputWriter)
	scanner := bufio.NewScanner(outputReader)
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"type":"ready"`) {
		t.Fatalf("missing ready event: %q, %v", scanner.Text(), scanner.Err())
	}
	command := execStreamRequest{SchemaVersion: 1, Type: "exec", Command: &execPlanCommand{
		ID: "cancel-me", SessionID: "cancel-session",
		Argv: []string{"/bin/sh", "-c", `sleep 30; printf bad > "$1"`, "sh", marker},
	}}
	if err := encoder.Encode(command); err != nil {
		t.Fatal(err)
	}
	started := false
	for scanner.Scan() {
		var event execPlanEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		if event.CommandID == "cancel-me" && event.Type == "started" {
			started = true
			break
		}
	}
	if !started {
		t.Fatalf("command did not start: %v", scanner.Err())
	}
	if err := encoder.Encode(execStreamRequest{SchemaVersion: 1, Type: "cancel", ID: "cancel-me"}); err != nil {
		t.Fatal(err)
	}
	if err := encoder.Encode(execStreamRequest{SchemaVersion: 1, Type: "shutdown"}); err != nil {
		t.Fatal(err)
	}
	var canceled, drained bool
	for scanner.Scan() {
		var event execPlanEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		if event.CommandID == "cancel-me" && event.Type == "result" && event.OK != nil && !*event.OK {
			canceled = true
		}
		if event.Type == "drained" {
			drained = true
		}
	}
	_ = inputWriter.Close()
	if err := <-serveDone; err != nil {
		t.Fatal(err)
	}
	if !canceled || !drained {
		t.Fatalf("canceled=%t drained=%t", canceled, drained)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("canceled Guest command wrote marker: %v", err)
	}
}

func TestServeExecStreamReportsProtocolErrorAndContinues(t *testing.T) {
	secret := bytes.Repeat([]byte{0x7c}, 32)
	server, err := agent.NewServer(t.TempDir(), secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	input := strings.NewReader("not-json\n{\"schema_version\":1,\"type\":\"ping\",\"id\":\"still-alive\"}\n{\"schema_version\":1,\"type\":\"shutdown\"}\n")
	var output bytes.Buffer
	if err := serveExecStream(ctx, input, &output, execPlanTestDialer{ctx: ctx, server: server}, secret, platform.NetworkOff, time.Minute, time.Minute, nil, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"type":"protocol_error"`) || !strings.Contains(output.String(), `"type":"pong"`) {
		t.Fatalf("stream did not recover from bad request: %s", output.String())
	}
}

func TestServeExecStreamPausesRejectsExecAndResumesBeforeShutdown(t *testing.T) {
	secret := bytes.Repeat([]byte{0x7e}, 32)
	server, err := agent.NewServer(t.TempDir(), secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	input := strings.NewReader(strings.Join([]string{
		`{"schema_version":1,"type":"pause","id":"sleep"}`,
		`{"schema_version":1,"type":"exec","command":{"id":"blocked","session_id":"a","argv":["/bin/true"]}}`,
		`{"schema_version":1,"type":"resume","id":"wake"}`,
		`{"schema_version":1,"type":"shutdown"}`,
	}, "\n") + "\n")
	controller := &fakeExecStreamController{}
	var output bytes.Buffer
	if err := serveExecStream(ctx, input, &output, execPlanTestDialer{ctx: ctx, server: server}, secret, platform.NetworkOff, time.Minute, time.Minute, nil, controller); err != nil {
		t.Fatal(err)
	}
	if controller.pauses.Load() != 1 || controller.resumes.Load() != 1 {
		t.Fatalf("pause/resume counts = %d/%d", controller.pauses.Load(), controller.resumes.Load())
	}
	var paused, resumed, blocked, drained bool
	scanner := bufio.NewScanner(&output)
	for scanner.Scan() {
		var event execPlanEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		switch {
		case event.Type == "paused" && event.CommandID == "sleep":
			paused = true
		case event.Type == "resumed" && event.CommandID == "wake":
			resumed = true
		case event.Type == "result" && event.CommandID == "blocked" && event.OK != nil && !*event.OK && strings.Contains(event.Error, "paused"):
			blocked = true
		case event.Type == "drained":
			drained = true
		}
	}
	if !paused || !resumed || !blocked || !drained {
		t.Fatalf("paused=%v resumed=%v blocked=%v drained=%v output=%s", paused, resumed, blocked, drained, output.String())
	}
}

func TestServeExecStreamResolvesCredentialIDsWithoutLeakingValues(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "token")
	if err := os.WriteFile(path, []byte("stream-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	broker, err := credential.Load([]string{"api-token=" + path})
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Close()
	secret := bytes.Repeat([]byte{0x7d}, 32)
	server, err := agent.NewServer(directory, secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	input := strings.NewReader(strings.Join([]string{
		`{"schema_version":1,"type":"exec","command":{"id":"credential","session_id":"a","argv":["/bin/sh","-c","test \"$(cat \"$ZAPVM_CREDENTIAL_DIR/api-token\")\" = stream-secret; printf stream-credential-ok"],"credential_ids":["api-token"]}}`,
		`{"schema_version":1,"type":"exec","command":{"id":"missing","session_id":"a","argv":["/bin/true"],"credential_ids":["missing"]}}`,
		`{"schema_version":1,"type":"shutdown"}`,
	}, "\n") + "\n")
	var output bytes.Buffer
	if err := serveExecStream(ctx, input, &output, execPlanTestDialer{ctx: ctx, server: server}, secret, platform.NetworkOff, time.Minute, time.Minute, broker, nil); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	if strings.Contains(text, "stream-secret") || !strings.Contains(text, "c3RyZWFtLWNyZWRlbnRpYWwtb2s=") {
		t.Fatalf("credential stream leaked or lost output: %s", text)
	}
	var credentialOK, missingFailed bool
	scanner := bufio.NewScanner(strings.NewReader(text))
	for scanner.Scan() {
		var event execPlanEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		if event.Type == "result" && event.CommandID == "credential" && event.OK != nil && *event.OK {
			credentialOK = true
		}
		if event.Type == "result" && event.CommandID == "missing" && event.OK != nil && !*event.OK && strings.Contains(event.Error, "not authorized") {
			missingFailed = true
		}
	}
	if !credentialOK || !missingFailed {
		t.Fatalf("credentialOK=%v missingFailed=%v output=%s", credentialOK, missingFailed, text)
	}
}

func TestServeExecStreamInjectsDynamicRequestCredentialWithoutStaticBroker(t *testing.T) {
	secret := bytes.Repeat([]byte{0x7e}, 32)
	server, err := agent.NewServer(t.TempDir(), secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := execStreamRequest{
		SchemaVersion: 1, Type: "exec",
		Command: &execPlanCommand{
			ID: "dynamic-credential", SessionID: "dynamic", CredentialIDs: []string{"api-token"},
			Argv: []string{"/bin/sh", "-c", `test "$(cat "$ZAPVM_CREDENTIAL_DIR/api-token")" = dynamic-private-value; printf dynamic-ok`},
		},
		CredentialValues: map[string][]byte{"api-token": []byte("dynamic-private-value")},
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	input := bytes.NewBuffer(append(append(encoded, '\n'), []byte("{\"schema_version\":1,\"type\":\"shutdown\"}\n")...))
	var output bytes.Buffer
	if err := serveExecStream(ctx, input, &output, execPlanTestDialer{ctx: ctx, server: server}, secret, platform.NetworkOff, time.Minute, time.Minute, nil, nil); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	if strings.Contains(text, "dynamic-private-value") || !strings.Contains(text, "ZHluYW1pYy1vaw==") {
		t.Fatalf("dynamic Credential leaked or failed: %s", text)
	}
	var succeeded bool
	scanner := bufio.NewScanner(strings.NewReader(text))
	for scanner.Scan() {
		var event execPlanEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		if event.Type == "result" && event.CommandID == "dynamic-credential" && event.OK != nil && *event.OK {
			succeeded = true
		}
	}
	if !succeeded {
		t.Fatalf("dynamic Credential command did not succeed: %s", text)
	}
}

func TestServeExecStreamIdleTimeout(t *testing.T) {
	secret := bytes.Repeat([]byte{0x8d}, 32)
	server, err := agent.NewServer(t.TempDir(), secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var output bytes.Buffer
	started := time.Now()
	if err := serveExecStream(ctx, reader, &output, execPlanTestDialer{ctx: ctx, server: server}, secret, platform.NetworkOff, time.Minute, time.Second, nil, nil); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed < time.Second || elapsed > 3*time.Second {
		t.Fatalf("idle shutdown took %s", elapsed)
	}
	if !strings.Contains(output.String(), `"type":"idle_timeout"`) {
		t.Fatalf("missing idle event: %s", output.String())
	}
}
