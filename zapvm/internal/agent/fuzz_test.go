package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"zapvm/internal/protocol"
)

func FuzzAuthenticatedRPCDispatch(f *testing.F) {
	for index, method := range []string{
		"exec.start",
		"exec.signal",
		"state.flush",
		"health",
		"agent.restart",
		"agent.crash",
		"unsupported.method",
	} {
		f.Add(uint8(index), []byte(`{"signal":"TERM"}`), false)
		if method == "agent.crash" {
			f.Add(uint8(index), []byte(`{}`), true)
		}
	}

	root := f.TempDir()
	secret := bytes.Repeat([]byte{0x7a}, 32)
	f.Fuzz(func(t *testing.T, selector uint8, payload []byte, enableFault bool) {
		if len(payload) > 16*1024 {
			payload = payload[:16*1024]
		}
		methods := []string{
			"exec.start",
			"exec.signal",
			"state.flush",
			"health",
			"agent.restart",
			"agent.crash",
			"unsupported." + strings.Repeat("x", int(selector%32)+1),
		}
		method := methods[int(selector)%len(methods)]
		if !json.Valid(payload) {
			encoded, err := json.Marshal(string(payload))
			if err != nil {
				t.Fatal(err)
			}
			payload = encoded
		}
		// Never execute fuzzer-controlled programs. The exec method still reaches
		// its payload parser and validation boundary with a guaranteed-invalid
		// executable while the other methods retain the fuzzed JSON value.
		if method == "exec.start" {
			payload = []byte(`{"argv":[""]}`)
		}

		server, err := NewServer(root, secret, 1)
		if err != nil {
			t.Fatal(err)
		}
		server.flushState = func() error { return nil }
		if enableFault {
			server.EnableFaultInjection()
		}
		clientConnection, serverConnection := net.Pipe()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		serverError := make(chan error, 1)
		go func() { serverError <- server.Serve(ctx, serverConnection) }()
		codec := protocol.NewCodec(clientConnection, clientConnection)
		if err := protocol.AuthenticateClient(codec, secret); err != nil {
			t.Fatal(err)
		}
		envelope := protocol.Envelope{
			Version:   protocol.Version,
			ID:        "fuzz-request",
			SessionID: "fuzz-session",
			Type:      method,
			Payload:   append(json.RawMessage(nil), payload...),
		}
		if err := codec.Write(envelope); err != nil {
			t.Fatal(err)
		}
		if err := clientConnection.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
			t.Fatal(err)
		}
		response, err := codec.Read()
		if err != nil {
			t.Fatalf("read %s response: %v", method, err)
		}
		if response.Version != protocol.Version || response.ID != envelope.ID || response.SessionID != envelope.SessionID {
			t.Fatalf("response correlation changed: %#v", response)
		}
		if response.Type == "" {
			t.Fatal("server emitted an empty response type")
		}
		_ = clientConnection.Close()
		cancel()
		select {
		case err := <-serverError:
			if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, context.Canceled) && !errors.Is(err, ErrRestartRequested) && !errors.Is(err, ErrCrashInjected) {
				t.Fatalf("server returned unexpected error: %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("server did not stop after fuzz connection closed")
		}
		if active := server.activeCommands(); active != 0 {
			t.Fatalf("server leaked %d active commands", active)
		}
	})
}

func FuzzExecRequestValidation(f *testing.F) {
	f.Add([]byte(`{"argv":["/bin/true"],"cwd":".","timeout_ms":1,"env":{"A":"B"}}`))
	f.Add([]byte(`{"argv":["/bin/true"],"credentials":{"api-token":"c2VjcmV0"}}`))
	f.Add([]byte(`{"argv":[]}`))
	f.Add([]byte(`{"argv":[""],"timeout_ms":18446744073709551615}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 64*1024 {
			data = data[:64*1024]
		}
		var request ExecStart
		if err := decodeExecStart(data, &request); err != nil {
			return
		}
		if err := validateExec(request); err != nil {
			return
		}
		if request.Argv[0] == "" || len(request.Argv) > maxArguments {
			t.Fatalf("validation accepted invalid argv: %#v", request.Argv)
		}
		if _, err := resolveExecTimeout(request.TimeoutMillis); err != nil {
			return
		}
		for _, entry := range safeEnvironment(request.Env, "") {
			if strings.IndexByte(entry, 0) >= 0 || !strings.Contains(entry, "=") {
				t.Fatalf("unsafe environment entry: %q", entry)
			}
		}
	})
}
