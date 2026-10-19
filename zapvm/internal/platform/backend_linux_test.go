//go:build linux

package platform

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestLinuxRuntimeVersionValidation(t *testing.T) {
	directory := t.TempDir()
	writeRuntime := func(name, output string) string {
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf '%s\\n' '"+output+"'\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		return path
	}

	if err := validateLinuxRuntimeCommand(context.Background(), writeRuntime("cloud-hypervisor", "cloud-hypervisor v53.0"), "v53.0", "Cloud Hypervisor"); err != nil {
		t.Fatal(err)
	}
	if err := validateLinuxRuntimeCommand(context.Background(), writeRuntime("virtiofsd", "virtiofsd 1.14.0"), "v1.14.0", "virtiofsd"); err != nil {
		t.Fatal(err)
	}
	if err := validateLinuxRuntimeCommand(context.Background(), writeRuntime("wrong", "virtiofsd 11.14.0"), "v1.14.0", "virtiofsd"); err == nil || !strings.Contains(err.Error(), "signed version") {
		t.Fatalf("unexpected version mismatch error: %v", err)
	}
	if err := os.Chmod(writeRuntime("not-executable", "virtiofsd 1.14.0"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateLinuxRuntimeCommand(context.Background(), filepath.Join(directory, "not-executable"), "v1.14.0", "virtiofsd"); err == nil || !strings.Contains(err.Error(), "executable regular file") {
		t.Fatalf("unexpected executable error: %v", err)
	}
}

func TestLinuxCloudHypervisorDiskAndConsoleArguments(t *testing.T) {
	if got := linuxRawDiskArgument("/images/root.raw", true); got != "path=/images/root.raw,image_type=raw,readonly=on" {
		t.Fatalf("read-only disk argument = %q", got)
	}
	if got := linuxRawDiskArgument("/state/state.raw", false); got != "path=/state/state.raw,image_type=raw" {
		t.Fatalf("writable disk argument = %q", got)
	}
	if got := strings.Join(linuxConsoleArguments(true), " "); got != "--console tty --serial off" {
		t.Fatalf("enabled console arguments = %q", got)
	}
	if got := strings.Join(linuxConsoleArguments(false), " "); got != "--console off --serial off" {
		t.Fatalf("disabled console arguments = %q", got)
	}
}

func TestCloudHypervisorVSockAcknowledgement(t *testing.T) {
	for _, acknowledgement := range []string{"OK 1073741824\n", "OK 4294967295\n"} {
		if err := readCloudHypervisorVSockAck(strings.NewReader(acknowledgement)); err != nil {
			t.Fatalf("valid acknowledgement %q rejected: %v", acknowledgement, err)
		}
	}
	for _, acknowledgement := range []string{
		"", "OK\n", "NO 1073741824\n", "OK 0\n", "OK 4294967296\n", strings.Repeat("X", 32),
	} {
		if err := readCloudHypervisorVSockAck(strings.NewReader(acknowledgement)); err == nil {
			t.Fatalf("invalid acknowledgement %q accepted", acknowledgement)
		}
	}
}

func TestLinuxSupervisorConfigValidation(t *testing.T) {
	directory := t.TempDir()
	valid := linuxSupervisorConfig{
		VMMPath:       "/bin/true",
		VMMArgs:       []string{"--version"},
		VirtioFSDPath: "/bin/false",
		Shares: []linuxSupervisorShare{{
			Tag: "zapvm_workspace", Path: "/tmp/workspace", SocketPath: "/tmp/workspace.sock",
		}},
	}

	t.Run("valid", func(t *testing.T) {
		path := filepath.Join(directory, "valid.json")
		if err := writeLinuxSupervisorConfig(path, valid); err != nil {
			t.Fatal(err)
		}
		got, err := loadLinuxSupervisorConfig(path)
		if err != nil || got.VMMPath != valid.VMMPath || len(got.Shares) != 1 {
			t.Fatalf("config = %+v, %v", got, err)
		}
	})

	t.Run("public-mode", func(t *testing.T) {
		path := filepath.Join(directory, "public.json")
		if err := writeLinuxSupervisorConfig(path, valid); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := loadLinuxSupervisorConfig(path); err == nil || !strings.Contains(err.Error(), "private regular file") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("duplicate-share", func(t *testing.T) {
		config := valid
		config.Shares = append(append([]linuxSupervisorShare(nil), valid.Shares...), valid.Shares[0])
		path := filepath.Join(directory, "duplicate.json")
		if err := writeLinuxSupervisorConfig(path, config); err != nil {
			t.Fatal(err)
		}
		if _, err := loadLinuxSupervisorConfig(path); err == nil || !strings.Contains(err.Error(), "duplicate") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("unknown-field", func(t *testing.T) {
		path := filepath.Join(directory, "unknown.json")
		if err := os.WriteFile(path, []byte(`{"vmm_path":"/bin/true","vmm_args":["x"],"virtiofsd_path":"/bin/false","unknown":true}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadLinuxSupervisorConfig(path); err == nil || !strings.Contains(err.Error(), "unknown field") {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestLinuxSupervisorCleanExitConsumesConfig(t *testing.T) {
	truePath, err := filepath.Abs("/bin/true")
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(t.TempDir(), "supervisor.json")
	config := linuxSupervisorConfig{VMMPath: truePath, VMMArgs: []string{"--version"}, VirtioFSDPath: "/bin/false"}
	if err := writeLinuxSupervisorConfig(configPath, config); err != nil {
		t.Fatal(err)
	}
	if err := RunLinuxVMMSupervisor(configPath, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(configPath); !os.IsNotExist(err) {
		t.Fatalf("supervisor config was not consumed: %v", err)
	}
}

func TestLinuxKillUnitWaitsForSupervisorReap(t *testing.T) {
	command := exec.Command("sleep", "30")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(t.TempDir(), "systemctl")
	if err := os.WriteFile(script, []byte(fmt.Sprintf("#!/bin/sh\nkill -KILL %d\n", command.Process.Pid)), 0o700); err != nil {
		_ = command.Process.Kill()
		t.Fatal(err)
	}
	instance := &linuxInstance{
		processInstance: processInstance{id: "kill-wait", cmd: command, done: make(chan struct{})},
		unitName:        "zapvm-test.scope",
		systemctlPath:   script,
		lifecycle:       newLifecycleState(StateRunning),
	}
	go instance.reap()
	if err := instance.killUnit(); err != nil {
		t.Fatal(err)
	}
	if state := instance.State(); state != StateFailed {
		t.Fatalf("state = %s, want failed after external SIGKILL", state)
	}
	select {
	case <-instance.done:
	default:
		t.Fatal("killUnit returned before supervisor reap completed")
	}
}

func TestLinuxReapTreatsRequestedNonzeroExitAsStopped(t *testing.T) {
	command := exec.Command("/bin/sh", "-c", "exit 7")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	instance := &linuxInstance{
		processInstance: processInstance{id: "requested-stop", cmd: command, done: make(chan struct{})},
		lifecycle:       newLifecycleState(StateRunning),
	}
	if _, state, accepted := instance.lifecycle.Apply(lifecycleStopRequested); !accepted || state != StateStopping {
		t.Fatalf("stop transition = %s, accepted = %v", state, accepted)
	}
	go instance.reap()
	if err := instance.Wait(context.Background()); err != nil {
		t.Fatalf("requested stop returned process exit error: %v", err)
	}
	if state := instance.State(); state != StateStopped {
		t.Fatalf("state = %s, want stopped", state)
	}
}

func TestLinuxReapTreatsUnexpectedCleanExitAsFailed(t *testing.T) {
	command := exec.Command("/bin/true")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	instance := &linuxInstance{
		processInstance: processInstance{id: "unexpected-exit", cmd: command, done: make(chan struct{})},
		lifecycle:       newLifecycleState(StateRunning),
	}
	go instance.reap()
	if err := instance.Wait(context.Background()); err == nil || !strings.Contains(err.Error(), "without a Host stop request") {
		t.Fatalf("unexpected exit error = %v", err)
	}
	if state := instance.State(); state != StateFailed {
		t.Fatalf("state = %s, want failed", state)
	}
}
