package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"zapvm/internal/agent"
	"zapvm/internal/clierror"
	"zapvm/internal/platform"
	"zapvm/internal/protocol"
)

func TestReportCLIErrorUsesStableMachineCodeAndExitStatus(t *testing.T) {
	var output bytes.Buffer
	exitCode := reportCLIError([]string{"image-smoke"}, errors.New("bad signature"), &output)
	if exitCode != clierror.ExitInvalidData || output.String() != "ZAPVM_ERROR[invalid_image]: bad signature\n" {
		t.Fatalf("image error exit=%d output=%q", exitCode, output.String())
	}
	output.Reset()
	exitCode = reportCLIError([]string{"run"}, fmt.Errorf("open state: %w", syscall.EACCES), &output)
	if exitCode != clierror.ExitPermissionDenied || !strings.HasPrefix(output.String(), "ZAPVM_ERROR[permission_denied]:") {
		t.Fatalf("permission error exit=%d output=%q", exitCode, output.String())
	}
}

func TestReportCLIErrorPreservesGuestCommandExitWithoutTransportMetadata(t *testing.T) {
	for _, code := range []int{1, 23, 127, 255} {
		var output bytes.Buffer
		err := fmt.Errorf("execution: %w", &guestCommandExitError{Code: code})
		if got := reportCLIError([]string{"daemon", "exec"}, err, &output); got != code || output.Len() != 0 {
			t.Fatalf("guest exit=%d got=%d output=%q", code, got, output.String())
		}
	}
}

type startupRetryDialer struct {
	secret   []byte
	attempts atomic.Int32
}

func (dialer *startupRetryDialer) DialAgent(context.Context, uint32) (io.ReadWriteCloser, error) {
	client, server := net.Pipe()
	if dialer.attempts.Add(1) < 3 {
		_ = server.Close()
		return client, nil
	}
	go func() {
		defer server.Close()
		_ = protocol.AuthenticateServer(protocol.NewCodec(server, server), dialer.secret)
	}()
	return client, nil
}

func TestInitialAgentAuthenticationRetriesEarlyTransportReset(t *testing.T) {
	secret := bytes.Repeat([]byte{0x42}, 32)
	dialer := &startupRetryDialer{secret: secret}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	connection, _, err := connectAuthenticatedAgentWithRetry(ctx, dialer, secret)
	if err != nil {
		t.Fatal(err)
	}
	_ = connection.Close()
	if attempts := dialer.attempts.Load(); attempts != 3 {
		t.Fatalf("authentication attempts = %d, want 3", attempts)
	}
}

type restartGenerationDialer struct {
	secret   []byte
	attempts atomic.Int32
}

func (dialer *restartGenerationDialer) DialAgent(context.Context, uint32) (io.ReadWriteCloser, error) {
	client, server := net.Pipe()
	attempt := dialer.attempts.Add(1)
	instanceID := "old-instance"
	if attempt > 1 {
		instanceID = "new-instance"
	}
	go func() {
		defer server.Close()
		codec := protocol.NewCodec(server, server)
		if err := protocol.AuthenticateServer(codec, dialer.secret); err != nil {
			return
		}
		request, err := codec.Read()
		if err != nil {
			return
		}
		response, err := protocol.NewEnvelope(request.ID, "system", "health.ok", agent.Health{
			ProtocolVersion: protocol.Version,
			InstanceID:      instanceID,
		})
		if err == nil {
			_ = codec.Write(response)
		}
	}()
	return client, nil
}

func TestReconnectRestartedAgentRejectsOldInstance(t *testing.T) {
	secret := bytes.Repeat([]byte{0x43}, 32)
	dialer := &restartGenerationDialer{secret: secret}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	connection, _, err := reconnectRestartedAgent(ctx, dialer, secret, "old-instance", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = connection.Close()
	if attempts := dialer.attempts.Load(); attempts != 2 {
		t.Fatalf("dial attempts = %d, want 2", attempts)
	}
}

func TestConnectHealthyAgentRejectsMismatchedInstance(t *testing.T) {
	secret := bytes.Repeat([]byte{0x44}, 32)
	dialer := &restartGenerationDialer{secret: secret}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	connection, _, health, err := connectHealthyAgentWithRetry(ctx, dialer, secret, "new-instance", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = connection.Close()
	if health.InstanceID != "new-instance" {
		t.Fatalf("instance ID = %q, want new-instance", health.InstanceID)
	}
	if attempts := dialer.attempts.Load(); attempts != 2 {
		t.Fatalf("dial attempts = %d, want 2", attempts)
	}
}

func TestDefaultKernelCmdlineLoadsBackendRootModules(t *testing.T) {
	for _, test := range []struct {
		hostOS  string
		options []string
	}{
		{hostOS: "darwin", options: []string{"root=/dev/vda", "rootfstype=ext4", "modules=ext4,virtio_blk,virtiofs,virtio_balloon"}},
		{hostOS: "linux", options: []string{"root=/dev/vda", "rootfstype=ext4", "modules=ext4,virtio_blk,virtiofs,virtio_balloon"}},
		{hostOS: "windows", options: []string{"root=/dev/vda", "rootfstype=ext4", "modules=ext4,sd_mod,scsi_mod,hv_storvsc,9p,9pnet,9pnet_virtio,hv_sock"}},
	} {
		t.Run(test.hostOS, func(t *testing.T) {
			cmdline := defaultKernelCmdline(test.hostOS)
			for _, option := range test.options {
				if !strings.Contains(cmdline, option) {
					t.Fatalf("default cmdline %q does not contain %q", cmdline, option)
				}
			}
		})
	}
}

func TestDefaultAgentStartTimeoutAccountsForHCSVariance(t *testing.T) {
	if got := defaultAgentStartTimeout("windows"); got != 90*time.Second {
		t.Fatalf("Windows agent start timeout = %s, want 90s", got)
	}
	for _, hostOS := range []string{"darwin", "linux"} {
		if got := defaultAgentStartTimeout(hostOS); got != 30*time.Second {
			t.Fatalf("%s agent start timeout = %s, want 30s", hostOS, got)
		}
	}
}

func TestValidateAgentStartTimeout(t *testing.T) {
	for _, timeout := range []time.Duration{time.Second, 90 * time.Second, 5 * time.Minute} {
		if err := validateAgentStartTimeout(timeout); err != nil {
			t.Fatalf("timeout %s was rejected: %v", timeout, err)
		}
	}
	for _, timeout := range []time.Duration{0, time.Second - time.Nanosecond, 5*time.Minute + time.Nanosecond} {
		if err := validateAgentStartTimeout(timeout); err == nil {
			t.Fatalf("timeout %s was accepted", timeout)
		}
	}
}

func TestVMConsoleOutputProtectsStdioProtocol(t *testing.T) {
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	if got := vmConsoleOutput(false, stdout, stderr); got != stdout {
		t.Fatal("interactive VM console was not routed to stdout")
	}
	if got := vmConsoleOutput(true, stdout, stderr); got != stderr {
		t.Fatal("stdio worker diagnostics were not routed away from protocol stdout")
	}
}

func TestServeStdioAllowsConsoleDiagnostics(t *testing.T) {
	err := runVM([]string{
		"--serve-stdio",
		"--console=true",
		"--image-root", filepath.Join(t.TempDir(), "missing-images"),
	})
	if err == nil {
		t.Fatal("run without an active image unexpectedly succeeded")
	}
	if strings.Contains(err.Error(), "requires --console=false") {
		t.Fatalf("stdio worker rejected console diagnostics: %v", err)
	}
}

func TestRunUsesConfiguredImageDefaultsBeforeValidation(t *testing.T) {
	t.Setenv(imageRootEnvironment, filepath.Join(t.TempDir(), "missing-images"))
	t.Setenv(imagePublicKeyEnvironment, filepath.Join(t.TempDir(), "missing-key.pem"))
	err := runVM([]string{"--stop-after-exec", "--", "true"})
	if err == nil || !strings.Contains(err.Error(), "active") {
		t.Fatalf("run did not use configured image defaults: %v", err)
	}
}

func TestImageSmokeRequiresCompleteSignedCandidateIdentity(t *testing.T) {
	for _, arguments := range [][]string{
		nil,
		{"--image-root", t.TempDir()},
		{"--image-root", t.TempDir(), "--image-public-key", filepath.Join(t.TempDir(), "key")},
	} {
		if err := runImageSmoke(arguments); err == nil || !strings.Contains(err.Error(), "requires image-root") {
			t.Fatalf("incomplete image-smoke identity was not rejected: %v", err)
		}
	}
	if err := runImageSmoke([]string{
		"--image-root", t.TempDir(),
		"--image-public-key", filepath.Join(t.TempDir(), "missing.pem"),
		"--image-version", "candidate",
		"--timeout", "9s",
	}); err == nil || !strings.Contains(err.Error(), "between 10s and 10m") {
		t.Fatalf("unsafe smoke timeout was not rejected: %v", err)
	}
}

func TestShellSingleQuote(t *testing.T) {
	if got := shellSingleQuote("agent-1.2.3"); got != "'agent-1.2.3'" {
		t.Fatalf("unexpected ordinary shell quote %q", got)
	}
	if got := shellSingleQuote("a'b"); got != "'a'\"'\"'b'" {
		t.Fatalf("single quote was not escaped: %q", got)
	}
}

func TestRunVMAuditLogsRedactedPreflightFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lifecycle.jsonl")
	err := runVM([]string{"--id", "sensitive-vm-name", "--audit-log", path})
	if err == nil {
		t.Fatal("run without an image unexpectedly succeeded")
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	text := string(data)
	if strings.Contains(text, "sensitive-vm-name") {
		t.Fatalf("audit log leaked VM ID: %s", text)
	}
	if strings.Count(text, "\n") != 2 || !strings.Contains(text, `"event":"run_requested"`) || !strings.Contains(text, `"event":"run_failed"`) {
		t.Fatalf("unexpected audit log: %s", text)
	}
}

func TestValidateExecTimeout(t *testing.T) {
	for _, timeout := range []time.Duration{time.Millisecond, time.Minute, 24 * time.Hour} {
		if err := validateExecTimeout(timeout); err != nil {
			t.Fatalf("timeout %s was rejected: %v", timeout, err)
		}
	}
	for _, timeout := range []time.Duration{0, time.Nanosecond, 24*time.Hour + time.Millisecond} {
		if err := validateExecTimeout(timeout); err == nil {
			t.Fatalf("timeout %s was accepted", timeout)
		}
	}
}

func TestPrepareBootstrapGeneratesSecretAndIdentity(t *testing.T) {
	directory, secret, cleanup, err := prepareBootstrap("", "", false, false, platform.NetworkOff)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if len(secret) != 32 {
		t.Fatalf("secret length = %d, want 32", len(secret))
	}
	onDisk, err := os.ReadFile(filepath.Join(directory, "rpc-secret"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(secret, onDisk) {
		t.Fatal("returned secret does not match bootstrap file")
	}
	info, err := os.Stat(filepath.Join(directory, "rpc-secret"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("secret mode = %o, want 600", info.Mode().Perm())
	}
	identityData, err := os.ReadFile(filepath.Join(directory, "identity.json"))
	if err != nil {
		t.Fatal(err)
	}
	var identity bootstrapIdentity
	if err := json.Unmarshal(identityData, &identity); err != nil {
		t.Fatal(err)
	}
	if identity.UID == 0 || identity.GID == 0 {
		t.Fatalf("generated root identity: %+v", identity)
	}
	if identity.NetworkMode != platform.NetworkOff {
		t.Fatalf("network mode = %q, want off", identity.NetworkMode)
	}
}

func TestPrepareBootstrapPersistsUnrestrictedNetworkMode(t *testing.T) {
	directory, _, cleanup, err := prepareBootstrap("", "", false, false, platform.NetworkUnrestricted)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	data, err := os.ReadFile(filepath.Join(directory, "identity.json"))
	if err != nil {
		t.Fatal(err)
	}
	var identity bootstrapIdentity
	if err := json.Unmarshal(data, &identity); err != nil {
		t.Fatal(err)
	}
	if identity.NetworkMode != platform.NetworkUnrestricted {
		t.Fatalf("network mode = %q", identity.NetworkMode)
	}
}

func TestPrepareBootstrapCanGateFaultInjection(t *testing.T) {
	directory, _, cleanup, err := prepareBootstrap("", "", true, false, platform.NetworkOff)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	data, err := os.ReadFile(filepath.Join(directory, "identity.json"))
	if err != nil {
		t.Fatal(err)
	}
	var identity bootstrapIdentity
	if err := json.Unmarshal(data, &identity); err != nil {
		t.Fatal(err)
	}
	if !identity.FaultInjection {
		t.Fatal("fault injection gate was not persisted")
	}
}

func TestPrepareBootstrapRejectsShortSecret(t *testing.T) {
	secretPath := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(secretPath, []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := prepareBootstrap("", secretPath, false, false, platform.NetworkOff); err == nil {
		t.Fatal("expected short secret to be rejected")
	}
}

func TestPrepareBootstrapRequiresIdentityForExistingShare(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "rpc-secret"), bytes.Repeat([]byte{1}, 32), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := prepareBootstrap(directory, "", false, false, platform.NetworkOff); err == nil {
		t.Fatal("expected missing identity to be rejected")
	}
}

func TestPrepareBootstrapPersistsWorkspaceMode(t *testing.T) {
	directory, _, cleanup, err := prepareBootstrap("", "", false, true, platform.NetworkOff)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	data, err := os.ReadFile(filepath.Join(directory, "identity.json"))
	if err != nil {
		t.Fatal(err)
	}
	var identity bootstrapIdentity
	if err := json.Unmarshal(data, &identity); err != nil {
		t.Fatal(err)
	}
	if !identity.WorkspaceReadOnly {
		t.Fatal("read-only workspace mode was not persisted")
	}
}

func TestPrepareBootstrapRejectsReservedExistingIdentity(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "rpc-secret"), bytes.Repeat([]byte{1}, 32), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "identity.json"), []byte(`{"uid":998,"gid":20}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := prepareBootstrap(directory, "", false, false, platform.NetworkOff); err == nil {
		t.Fatal("reserved proxy identity was accepted")
	}
}
