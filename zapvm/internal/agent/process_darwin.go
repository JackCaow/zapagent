//go:build darwin

package agent

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
)

func prepareProcess(cmd *exec.Cmd, uid, gid uint32, isolate bool, stateRoot, sessionID, requestID, credentialSource, workspaceRoot string, protectedWorkspacePaths, deniedWorkspacePatterns []string) (processIsolation, error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if uid != uint32(os.Geteuid()) || gid != uint32(os.Getegid()) {
		if os.Geteuid() != 0 {
			return nil, fmt.Errorf("cannot switch command identity from %d:%d to %d:%d", os.Geteuid(), os.Getegid(), uid, gid)
		}
		cmd.SysProcAttr.Credential = &syscall.Credential{Uid: uid, Gid: gid}
	}
	return noopIsolation{}, nil
}

func killProcessTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}

func signalProcessTree(cmd *exec.Cmd, signal string) error {
	if cmd.Process == nil {
		return nil
	}
	value, err := unixSignal(signal)
	if err != nil {
		return err
	}
	return syscall.Kill(-cmd.Process.Pid, value)
}

func unixSignal(signal string) (syscall.Signal, error) {
	switch strings.ToUpper(signal) {
	case "INT", "SIGINT":
		return syscall.SIGINT, nil
	case "TERM", "SIGTERM":
		return syscall.SIGTERM, nil
	case "KILL", "SIGKILL":
		return syscall.SIGKILL, nil
	default:
		return 0, fmt.Errorf("unsupported signal %q", signal)
	}
}
