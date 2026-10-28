package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"zapvm/internal/protocol"
)

func TestResolveExecTimeoutRejectsBeforeDurationOverflow(t *testing.T) {
	for _, milliseconds := range []uint64{uint64(maxTimeout/time.Millisecond) + 1, math.MaxUint64} {
		if _, err := resolveExecTimeout(milliseconds); err == nil {
			t.Fatalf("timeout %dms was accepted", milliseconds)
		}
	}
	if timeout, err := resolveExecTimeout(0); err != nil || timeout != maxTimeout {
		t.Fatalf("default timeout = %s, %v", timeout, err)
	}
	if timeout, err := resolveExecTimeout(uint64(maxTimeout / time.Millisecond)); err != nil || timeout != maxTimeout {
		t.Fatalf("maximum timeout = %s, %v", timeout, err)
	}
}

func TestExecStreamsOutput(t *testing.T) {
	root := t.TempDir()
	secret := bytes.Repeat([]byte{0x33}, 32)
	server, err := NewServer(root, secret, 2)
	if err != nil {
		t.Fatal(err)
	}
	clientConn, serverConn := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Serve(ctx, serverConn) }()
	codec := protocol.NewCodec(clientConn, clientConn)
	if err := protocol.AuthenticateClient(codec, secret); err != nil {
		t.Fatal(err)
	}
	request, err := protocol.NewEnvelope("exec-1", "session-1", "exec.start", ExecStart{
		Argv: []string{"/bin/echo", "hello zapvm"}, Cwd: ".", TimeoutMillis: 5000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := codec.Write(request); err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	gotStarted := false
	for {
		message, err := codec.Read()
		if err != nil {
			t.Fatal(err)
		}
		switch message.Type {
		case "exec.started":
			gotStarted = true
		case "exec.stdout":
			var chunk ExecOutput
			if err := json.Unmarshal(message.Payload, &chunk); err != nil {
				t.Fatal(err)
			}
			output.Write(chunk.Data)
		case "exec.exit":
			var exit ExecExit
			if err := json.Unmarshal(message.Payload, &exit); err != nil || exit.Seal != nil {
				t.Fatalf("non-isolated execution must not attest a seal: %+v, %v", exit, err)
			}
			if !gotStarted || output.String() != "hello zapvm\n" {
				t.Fatalf("started=%v output=%q", gotStarted, output.String())
			}
			_ = clientConn.Close()
			cancel()
			if err := <-serverErr; err != nil && !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			return
		case "error":
			t.Fatalf("unexpected error response: %s", message.Payload)
		}
	}
}

func TestExecSealFailureNeverReportsExitSuccess(t *testing.T) {
	secret := bytes.Repeat([]byte{0x42}, 32)
	server, err := NewServer(t.TempDir(), secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	server.sealWorkload = func(processIsolation) (*ProcessSeal, error) { return nil, errors.New("simulated cgroup failure") }
	client, serverConn := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Serve(ctx, serverConn) }()
	codec := protocol.NewCodec(client, client)
	if err := protocol.AuthenticateClient(codec, secret); err != nil {
		t.Fatal(err)
	}
	request, err := protocol.NewEnvelope("seal-failure", "session", "exec.start", ExecStart{Argv: []string{"/bin/echo", "hello"}, TimeoutMillis: 5000})
	if err != nil {
		t.Fatal(err)
	}
	if err := codec.Write(request); err != nil {
		t.Fatal(err)
	}
	for {
		message, err := codec.Read()
		if err != nil {
			t.Fatal(err)
		}
		if message.Type == "exec.exit" {
			t.Fatal("seal failure reported as an exit result")
		}
		if message.Type == "error" {
			if !server.degraded.Load() {
				t.Fatal("seal failure must degrade the agent")
			}
			if !strings.Contains(string(message.Payload), "process isolation seal failed") {
				t.Fatalf("unexpected failure: %s", message.Payload)
			}
			_ = client.Close()
			cancel()
			<-serverErr
			return
		}
	}
}

func TestNonIsolatedHealthDoesNotAdvertiseSeal(t *testing.T) {
	if got := processSealCapability(false); got != "" {
		t.Fatalf("non-isolated backend advertised %q", got)
	}
}

func TestInheritedOutputPipeCannotDelayCommandIndefinitely(t *testing.T) {
	secret := bytes.Repeat([]byte{0x43}, 32)
	server, err := NewServer(t.TempDir(), secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	client, serverConn := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Serve(ctx, serverConn) }()
	codec := protocol.NewCodec(client, client)
	if err := protocol.AuthenticateClient(codec, secret); err != nil {
		t.Fatal(err)
	}
	request, err := protocol.NewEnvelope("inherited-output", "session", "exec.start", ExecStart{
		Argv: []string{"/bin/sh", "-c", "sleep 20 & printf parent-exited"}, TimeoutMillis: 10_000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := codec.Write(request); err != nil {
		t.Fatal(err)
	}
	if err := client.SetReadDeadline(time.Now().Add(7 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var output string
	for {
		message, err := codec.Read()
		if err != nil {
			t.Fatal(err)
		}
		switch message.Type {
		case "exec.stdout":
			var chunk ExecOutput
			if err := json.Unmarshal(message.Payload, &chunk); err != nil {
				t.Fatal(err)
			}
			output += string(chunk.Data)
		case "exec.exit":
			t.Fatal("inherited output pipe must not produce a successful result")
		case "error":
			if !strings.Contains(output, "parent-exited") {
				t.Fatalf("lost the parent's output: %q", output)
			}
			_ = client.Close()
			cancel()
			<-serverErr
			return
		}
	}
}

func TestExecCredentialsAreRequestFilesAndLeaseIsRemoved(t *testing.T) {
	root := t.TempDir()
	secret := bytes.Repeat([]byte{0x31}, 32)
	server, err := NewServer(root, secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	server.credentialRoot = t.TempDir()
	clientConn, serverConn := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Serve(ctx, serverConn) }()
	codec := protocol.NewCodec(clientConn, clientConn)
	if err := protocol.AuthenticateClient(codec, secret); err != nil {
		t.Fatal(err)
	}
	request, err := protocol.NewEnvelope("credential-exec", "session-a", "exec.start", ExecStart{
		Argv:          []string{"/bin/sh", "-c", `set -eu; test "$ZAPVM_CREDENTIAL_DIR" != /untrusted; test "$(cat "$ZAPVM_CREDENTIAL_DIR/api-token")" = super-secret; printf credential-ok`},
		Env:           map[string]string{"ZAPVM_CREDENTIAL_DIR": "/untrusted"},
		Credentials:   map[string][]byte{"api-token": []byte("super-secret")},
		TimeoutMillis: 5000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := codec.Write(request); err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	for {
		message, err := codec.Read()
		if err != nil {
			t.Fatal(err)
		}
		switch message.Type {
		case "exec.stdout":
			var chunk ExecOutput
			if err := json.Unmarshal(message.Payload, &chunk); err != nil {
				t.Fatal(err)
			}
			output.Write(chunk.Data)
		case "exec.exit":
			if output.String() != "credential-ok" {
				t.Fatalf("credential command output = %q", output.String())
			}
			entries, err := os.ReadDir(server.credentialRoot)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 0 {
				t.Fatalf("credential lease was not removed: %v", entries)
			}
			_ = clientConn.Close()
			cancel()
			if err := <-serverErr; err != nil && !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			return
		case "error":
			t.Fatalf("unexpected credential error: %s", message.Payload)
		}
	}
}

func TestStateFlushAcknowledgement(t *testing.T) {
	root := t.TempDir()
	secret := bytes.Repeat([]byte{0x34}, 32)
	server, err := NewServer(root, secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	clientConn, serverConn := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go server.Serve(ctx, serverConn)
	codec := protocol.NewCodec(clientConn, clientConn)
	if err := protocol.AuthenticateClient(codec, secret); err != nil {
		t.Fatal(err)
	}
	request, err := protocol.NewEnvelope("flush-1", "system", "state.flush", struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	if err := codec.Write(request); err != nil {
		t.Fatal(err)
	}
	response, err := codec.Read()
	if err != nil {
		t.Fatal(err)
	}
	if response.ID != request.ID || response.Type != "state.flushed" {
		t.Fatalf("unexpected flush response: %#v", response)
	}
	_ = clientConn.Close()
}

func TestHealthAndRestartWhenIdle(t *testing.T) {
	root := t.TempDir()
	secret := bytes.Repeat([]byte{0x35}, 32)
	server, err := NewServer(root, secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	clientConn, serverConn := net.Pipe()
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Serve(context.Background(), serverConn) }()
	codec := protocol.NewCodec(clientConn, clientConn)
	if err := protocol.AuthenticateClient(codec, secret); err != nil {
		t.Fatal(err)
	}
	healthRequest, _ := protocol.NewEnvelope("health-1", "system", "health", struct{}{})
	if err := codec.Write(healthRequest); err != nil {
		t.Fatal(err)
	}
	healthResponse, err := codec.Read()
	if err != nil {
		t.Fatal(err)
	}
	var health Health
	if err := json.Unmarshal(healthResponse.Payload, &health); err != nil {
		t.Fatal(err)
	}
	if healthResponse.Type != "health.ok" || health.ProtocolVersion != protocol.Version || health.InstanceID == "" || health.ActiveCommands != 0 {
		t.Fatalf("unexpected health response: %#v %+v", healthResponse, health)
	}
	restartRequest, _ := protocol.NewEnvelope("restart-1", "system", "agent.restart", struct{}{})
	if err := codec.Write(restartRequest); err != nil {
		t.Fatal(err)
	}
	restartResponse, err := codec.Read()
	if err != nil {
		t.Fatal(err)
	}
	if restartResponse.Type != "agent.restarting" {
		t.Fatalf("unexpected restart response: %#v", restartResponse)
	}
	select {
	case <-server.RestartRequested():
	case <-time.After(time.Second):
		t.Fatal("restart signal was not published")
	}
	if err := <-serverErr; !errors.Is(err, ErrRestartRequested) {
		t.Fatalf("server error = %v, want restart", err)
	}
	_ = clientConn.Close()
}

func TestCrashInjectionIsExplicitlyGated(t *testing.T) {
	root := t.TempDir()
	secret := bytes.Repeat([]byte{0x37}, 32)
	server, err := NewServer(root, secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	clientConn, serverConn := net.Pipe()
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Serve(context.Background(), serverConn) }()
	codec := protocol.NewCodec(clientConn, clientConn)
	if err := protocol.AuthenticateClient(codec, secret); err != nil {
		t.Fatal(err)
	}
	request, _ := protocol.NewEnvelope("crash-disabled", "system", "agent.crash", struct{}{})
	if err := codec.Write(request); err != nil {
		t.Fatal(err)
	}
	response, err := codec.Read()
	if err != nil {
		t.Fatal(err)
	}
	if response.Type != "error" || !strings.Contains(string(response.Payload), "disabled") {
		t.Fatalf("unexpected disabled crash response: %#v", response)
	}
	_ = clientConn.Close()
	<-serverErr

	enabled, err := NewServer(root, secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	enabled.EnableFaultInjection()
	clientConn, serverConn = net.Pipe()
	serverErr = make(chan error, 1)
	go func() { serverErr <- enabled.Serve(context.Background(), serverConn) }()
	codec = protocol.NewCodec(clientConn, clientConn)
	if err := protocol.AuthenticateClient(codec, secret); err != nil {
		t.Fatal(err)
	}
	request, _ = protocol.NewEnvelope("crash-enabled", "system", "agent.crash", struct{}{})
	if err := codec.Write(request); err != nil {
		t.Fatal(err)
	}
	response, err = codec.Read()
	if err != nil || response.Type != "agent.crashing" {
		t.Fatalf("enabled crash response=%#v err=%v", response, err)
	}
	if err := <-serverErr; !errors.Is(err, ErrCrashInjected) {
		t.Fatalf("server error = %v, want crash injection", err)
	}
	_ = clientConn.Close()
}

func TestHealthConnectionCloseDoesNotKillCommand(t *testing.T) {
	if _, err := os.Stat("/bin/sleep"); err != nil {
		t.Skip("sleep is unavailable")
	}
	root := t.TempDir()
	secret := bytes.Repeat([]byte{0x36}, 32)
	server, err := NewServer(root, secret, 2)
	if err != nil {
		t.Fatal(err)
	}
	commandClient, commandServer := net.Pipe()
	go server.Serve(context.Background(), commandServer)
	commandCodec := protocol.NewCodec(commandClient, commandClient)
	if err := protocol.AuthenticateClient(commandCodec, secret); err != nil {
		t.Fatal(err)
	}
	request, _ := protocol.NewEnvelope("owned-sleep", "session", "exec.start", ExecStart{Argv: []string{"/bin/sleep", "60"}})
	if err := commandCodec.Write(request); err != nil {
		t.Fatal(err)
	}
	started, err := commandCodec.Read()
	if err != nil || started.Type != "exec.started" {
		t.Fatalf("started=%#v err=%v", started, err)
	}

	healthClient, healthServer := net.Pipe()
	go server.Serve(context.Background(), healthServer)
	healthCodec := protocol.NewCodec(healthClient, healthClient)
	if err := protocol.AuthenticateClient(healthCodec, secret); err != nil {
		t.Fatal(err)
	}
	healthRequest, _ := protocol.NewEnvelope("health-active", "system", "health", struct{}{})
	if err := healthCodec.Write(healthRequest); err != nil {
		t.Fatal(err)
	}
	healthResponse, err := healthCodec.Read()
	if err != nil {
		t.Fatal(err)
	}
	var health Health
	if err := json.Unmarshal(healthResponse.Payload, &health); err != nil {
		t.Fatal(err)
	}
	if health.ActiveCommands != 1 {
		t.Fatalf("active commands = %d, want 1", health.ActiveCommands)
	}
	_ = healthClient.Close()

	if err := commandClient.SetReadDeadline(time.Now().Add(150 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if response, err := commandCodec.Read(); err == nil {
		t.Fatalf("health disconnect killed command: %#v", response)
	} else if netErr, ok := err.(net.Error); !ok || !netErr.Timeout() {
		t.Fatalf("unexpected command read error: %v", err)
	}
	if err := commandClient.SetReadDeadline(time.Time{}); err != nil {
		t.Fatal(err)
	}
	signal, _ := protocol.NewEnvelope("owned-sleep", "session", "exec.signal", ExecSignal{Signal: "KILL"})
	if err := commandCodec.Write(signal); err != nil {
		t.Fatal(err)
	}
	for {
		response, err := commandCodec.Read()
		if err != nil {
			t.Fatal(err)
		}
		if response.Type == "exec.exit" {
			break
		}
	}
	_ = commandClient.Close()
}

func TestWorkingDirectorySymlinkCannotEscapeRoot(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(root, bytes.Repeat([]byte{1}, 32), 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.resolveCwd("escape"); err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSafeEnvironmentPreservesRuntimeIdentity(t *testing.T) {
	values := make(map[string]string)
	for _, entry := range safeEnvironment(map[string]string{
		"HOME":                 "/workspace/escape",
		"TMPDIR":               "/workspace/escape",
		"PATH":                 "/untrusted",
		"USER":                 "root",
		"LOGNAME":              "root",
		"LANG":                 "unsafe",
		"NIX_CONFIG":           "allow-unsafe-native-code-during-evaluation = true",
		"NIX_REMOTE":           "daemon",
		"NIX_USER_PROFILE_DIR": "/workspace/profile",
		"XDG_CACHE_HOME":       "/workspace/cache",
		"XDG_STATE_HOME":       "/workspace/state",
		"HTTPS_PROXY":          "http://127.0.0.1:3128",
		"ZAPVM_CREDENTIAL_DIR": "/untrusted",
	}, guestCredentialDirectory) {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			t.Fatalf("invalid environment entry %q", entry)
		}
		values[key] = value
	}
	if values["HOME"] != "/home/zapvm" || values["TMPDIR"] != "/tmp" || values["USER"] != "zapvm" || values["LOGNAME"] != "zapvm" {
		t.Fatalf("runtime identity was overridden: %#v", values)
	}
	if values["PATH"] != "/nix/var/nix/profiles/zap-computer/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" || values["LANG"] != "C.UTF-8" {
		t.Fatalf("runtime defaults were overridden: %#v", values)
	}
	if values["NIX_REMOTE"] != "local" || values["NIX_USER_PROFILE_DIR"] != "/nix/var/nix/profiles/zap-computer" ||
		values["XDG_CACHE_HOME"] != "/nix/var/nix/zap-cache" || values["XDG_STATE_HOME"] != "/nix/var/nix/zap-state" ||
		!strings.Contains(values["NIX_CONFIG"], "sandbox = false") {
		t.Fatalf("persistent tool environment was overridden: %#v", values)
	}
	if values["HTTPS_PROXY"] != "http://127.0.0.1:3128" {
		t.Fatalf("non-reserved environment was not preserved: %#v", values)
	}
	if values["ZAPVM_CREDENTIAL_DIR"] != guestCredentialDirectory {
		t.Fatalf("credential directory was overridden: %#v", values)
	}
}

func TestDecodeExecStartRejectsUnknownAndTrailingFields(t *testing.T) {
	for _, data := range []string{
		`{"argv":["/bin/true"],"unknown":true}`,
		`{"argv":["/bin/true"]} {}`,
	} {
		var request ExecStart
		if err := decodeExecStart([]byte(data), &request); err == nil {
			t.Fatalf("invalid exec request accepted: %s", data)
		}
	}
}

func TestConnectionCloseKillsRunningCommand(t *testing.T) {
	if _, err := os.Stat("/bin/sleep"); err != nil {
		t.Skip("sleep is unavailable")
	}
	root := t.TempDir()
	secret := bytes.Repeat([]byte{0x55}, 32)
	server, err := NewServer(root, secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	clientConn, serverConn := net.Pipe()
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Serve(context.Background(), serverConn) }()
	codec := protocol.NewCodec(clientConn, clientConn)
	if err := protocol.AuthenticateClient(codec, secret); err != nil {
		t.Fatal(err)
	}
	request, _ := protocol.NewEnvelope("sleep", "session", "exec.start", ExecStart{Argv: []string{"/bin/sleep", "60"}})
	if err := codec.Write(request); err != nil {
		t.Fatal(err)
	}
	message, err := codec.Read()
	if err != nil || message.Type != "exec.started" {
		t.Fatalf("message=%#v err=%v", message, err)
	}
	if err := clientConn.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-serverErr:
		if err != nil && !errors.Is(err, io.EOF) {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server did not stop after connection close")
	}
}

func TestExecTimeoutKillsCommand(t *testing.T) {
	if _, err := os.Stat("/bin/sleep"); err != nil {
		t.Skip("sleep is unavailable")
	}
	root := t.TempDir()
	secret := bytes.Repeat([]byte{0x66}, 32)
	server, err := NewServer(root, secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	clientConn, serverConn := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go server.Serve(ctx, serverConn)
	codec := protocol.NewCodec(clientConn, clientConn)
	if err := protocol.AuthenticateClient(codec, secret); err != nil {
		t.Fatal(err)
	}
	request, _ := protocol.NewEnvelope("timeout", "session", "exec.start", ExecStart{
		Argv: []string{"/bin/sleep", "60"}, TimeoutMillis: 100,
	})
	started := time.Now()
	if err := codec.Write(request); err != nil {
		t.Fatal(err)
	}
	for {
		message, err := codec.Read()
		if err != nil {
			t.Fatal(err)
		}
		if message.Type == "exec.exit" {
			if time.Since(started) > 3*time.Second {
				t.Fatal("timed out command was not killed promptly")
			}
			_ = clientConn.Close()
			return
		}
	}
}

func TestMaxConcurrencyRejectsSecondCommand(t *testing.T) {
	if _, err := os.Stat("/bin/sleep"); err != nil {
		t.Skip("sleep is unavailable")
	}
	root := t.TempDir()
	secret := bytes.Repeat([]byte{0x77}, 32)
	server, err := NewServer(root, secret, 1)
	if err != nil {
		t.Fatal(err)
	}
	clientConn, serverConn := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go server.Serve(ctx, serverConn)
	codec := protocol.NewCodec(clientConn, clientConn)
	if err := protocol.AuthenticateClient(codec, secret); err != nil {
		t.Fatal(err)
	}
	first, _ := protocol.NewEnvelope("first", "session", "exec.start", ExecStart{Argv: []string{"/bin/sleep", "60"}})
	if err := codec.Write(first); err != nil {
		t.Fatal(err)
	}
	message, err := codec.Read()
	if err != nil || message.Type != "exec.started" || message.ID != "first" {
		t.Fatalf("first response=%#v err=%v", message, err)
	}
	second, _ := protocol.NewEnvelope("second", "session", "exec.start", ExecStart{Argv: []string{"/bin/echo", "unexpected"}})
	if err := codec.Write(second); err != nil {
		t.Fatal(err)
	}
	message, err = codec.Read()
	if err != nil || message.Type != "error" || message.ID != "second" || !strings.Contains(string(message.Payload), "maximum concurrent") {
		t.Fatalf("second response=%#v err=%v", message, err)
	}
	signal, _ := protocol.NewEnvelope("first", "session", "exec.signal", ExecSignal{Signal: "KILL"})
	if err := codec.Write(signal); err != nil {
		t.Fatal(err)
	}
	for {
		message, err = codec.Read()
		if err != nil {
			t.Fatal(err)
		}
		if message.Type == "exec.exit" && message.ID == "first" {
			_ = clientConn.Close()
			return
		}
	}
}
