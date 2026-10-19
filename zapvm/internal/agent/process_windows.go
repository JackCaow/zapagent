//go:build windows

package agent

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func prepareProcess(cmd *exec.Cmd, uid, gid uint32, isolate bool, stateRoot, sessionID, requestID, credentialSource, workspaceRoot string, protectedWorkspacePaths, deniedWorkspacePatterns []string) (processIsolation, error) {
	return noopIsolation{}, nil
}

func killProcessTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}

func signalProcessTree(cmd *exec.Cmd, signal string) error {
	if cmd.Process == nil {
		return nil
	}
	switch strings.ToUpper(signal) {
	case "INT", "SIGINT":
		return cmd.Process.Signal(os.Interrupt)
	case "TERM", "SIGTERM", "KILL", "SIGKILL":
		return cmd.Process.Kill()
	default:
		return fmt.Errorf("unsupported signal %q", signal)
	}
}
