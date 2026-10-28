//go:build linux

package agent

import (
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// This preflight advertises a supported backend, not a promise that a later
// request will successfully acquire and empty its own cgroup.
func processSealCapability(isolate bool) string {
	if !isolate || os.Geteuid() != 0 {
		return ""
	}
	launcher := os.Getenv("ZAPVM_LAUNCHER_PATH")
	if launcher == "" {
		launcher = "/usr/local/sbin/zapvm-launcher"
	}
	if info, err := os.Stat(launcher); err != nil || !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		return ""
	}
	var stat unix.Statfs_t
	if unix.Statfs(cgroupRoot, &stat) != nil || uint64(stat.Type) != uint64(unix.CGROUP2_SUPER_MAGIC) {
		return ""
	}
	if _, err := os.ReadFile(filepath.Join(cgroupRoot, "cgroup.controllers")); err != nil {
		return ""
	}
	fd, err := os.OpenFile(filepath.Join(cgroupRoot, "cgroup.subtree_control"), os.O_WRONLY, 0)
	if err != nil {
		return ""
	}
	if fd.Close() != nil {
		return ""
	}
	return "cgroup-v2"
}

const (
	cgroupRoot       = "/sys/fs/cgroup"
	defaultMemoryMax = 1024 * 1024 * 1024
	defaultPIDsMax   = 256
	defaultCPUQuota  = 100000
	defaultCPUPeriod = 100000
)

type linuxIsolation struct {
	fd          *os.File
	path        string
	sessionPath string
}

func prepareProcess(cmd *exec.Cmd, uid, gid uint32, isolate bool, stateRoot, sessionID, requestID, credentialSource, workspaceRoot string, protectedWorkspacePaths, deniedWorkspacePatterns []string) (processIsolation, error) {
	attributes := &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	if uid != uint32(os.Geteuid()) || gid != uint32(os.Getegid()) {
		if os.Geteuid() != 0 {
			return nil, fmt.Errorf("cannot switch command identity from %d:%d to %d:%d", os.Geteuid(), os.Getegid(), uid, gid)
		}
		attributes.Credential = &syscall.Credential{Uid: uid, Gid: gid}
	}
	if !isolate {
		cmd.SysProcAttr = attributes
		return noopIsolation{}, nil
	}
	launcher := os.Getenv("ZAPVM_LAUNCHER_PATH")
	if launcher == "" {
		launcher = "/usr/local/sbin/zapvm-launcher"
	}
	if info, err := os.Stat(launcher); err != nil || info.Mode()&0o111 == 0 {
		return nil, fmt.Errorf("isolated process launcher %s is unavailable", launcher)
	}
	sessionHome, err := prepareSessionHome(stateRoot, sessionID, uid, gid)
	if err != nil {
		return nil, err
	}
	computerNixRoot, err := prepareComputerNixRoot(stateRoot, uid, gid)
	if err != nil {
		return nil, err
	}
	isolation, err := prepareCgroup(sessionID, requestID)
	if err != nil {
		return nil, err
	}
	originalPath := cmd.Path
	originalArgs := append([]string(nil), cmd.Args[1:]...)
	cmd.Path = launcher
	cmd.Args = []string{
		launcher,
		"--uid", strconv.FormatUint(uint64(uid), 10),
		"--gid", strconv.FormatUint(uint64(gid), 10),
	}
	if sessionHome != "" {
		cmd.Args = append(cmd.Args, "--home-source", sessionHome)
	}
	if computerNixRoot != "" {
		cmd.Args = append(cmd.Args, "--nix-source", computerNixRoot)
	}
	if credentialSource != "" {
		cmd.Args = append(cmd.Args, "--credential-source", credentialSource)
	}
	if len(protectedWorkspacePaths) > 0 || len(deniedWorkspacePatterns) > 0 {
		cmd.Args = append(cmd.Args, "--workspace-root", workspaceRoot)
		for _, protectedPath := range protectedWorkspacePaths {
			cmd.Args = append(cmd.Args, "--protect-workspace-path", protectedPath)
		}
		for _, deniedPattern := range deniedWorkspacePatterns {
			cmd.Args = append(cmd.Args, "--deny-workspace-pattern", deniedPattern)
		}
	}
	cmd.Args = append(cmd.Args, "--", originalPath)
	cmd.Args = append(cmd.Args, originalArgs...)
	// The launcher needs root only long enough to prepare private mounts. It
	// clears supplementary groups and permanently drops to uid:gid before exec.
	attributes.Credential = nil
	attributes.Cloneflags = syscall.CLONE_NEWNS | syscall.CLONE_NEWPID | syscall.CLONE_NEWUTS | syscall.CLONE_NEWIPC
	attributes.UseCgroupFD = true
	attributes.CgroupFD = int(isolation.fd.Fd())
	cmd.SysProcAttr = attributes
	return isolation, nil
}

func prepareCgroup(sessionID, requestID string) (*linuxIsolation, error) {
	if sessionID == "" {
		sessionID = "default"
	}
	basePath := filepath.Join(cgroupRoot, "zapvm")
	if err := os.MkdirAll(basePath, 0o755); err != nil {
		return nil, fmt.Errorf("create zapVM cgroup root: %w", err)
	}
	if err := enableControllers(cgroupRoot); err != nil {
		return nil, err
	}
	if err := enableControllers(basePath); err != nil {
		return nil, err
	}
	sessionPath := filepath.Join(basePath, safeIdentifier(sessionID))
	if err := os.MkdirAll(sessionPath, 0o755); err != nil {
		return nil, fmt.Errorf("create Session cgroup: %w", err)
	}
	if err := enableControllers(sessionPath); err != nil {
		return nil, err
	}
	requestPath := filepath.Join(sessionPath, safeIdentifier(requestID))
	if err := os.Mkdir(requestPath, 0o755); err != nil {
		return nil, fmt.Errorf("create request cgroup: %w", err)
	}
	cleanupOnError := true
	defer func() {
		if cleanupOnError {
			_ = os.Remove(requestPath)
			_ = os.Remove(sessionPath)
		}
	}()
	for path, value := range map[string]string{
		"memory.max": fmt.Sprintf("%d", defaultMemoryMax),
		"pids.max":   fmt.Sprintf("%d", defaultPIDsMax),
		"cpu.max":    fmt.Sprintf("%d %d", defaultCPUQuota, defaultCPUPeriod),
	} {
		if err := os.WriteFile(filepath.Join(requestPath, path), []byte(value), 0o644); err != nil {
			return nil, fmt.Errorf("configure cgroup %s: %w", path, err)
		}
	}
	fd, err := os.Open(requestPath)
	if err != nil {
		return nil, fmt.Errorf("open request cgroup: %w", err)
	}
	cleanupOnError = false
	return &linuxIsolation{fd: fd, path: requestPath, sessionPath: sessionPath}, nil
}

func enableControllers(path string) error {
	data, err := os.ReadFile(filepath.Join(path, "cgroup.controllers"))
	if err != nil {
		return fmt.Errorf("read cgroup controllers: %w", err)
	}
	available := strings.Fields(string(data))
	wanted := make([]string, 0, 3)
	for _, controller := range available {
		if controller == "cpu" || controller == "memory" || controller == "pids" {
			wanted = append(wanted, "+"+controller)
		}
	}
	if len(wanted) == 0 {
		return errors.New("cgroup v2 cpu, memory and pids controllers are unavailable")
	}
	if err := os.WriteFile(filepath.Join(path, "cgroup.subtree_control"), []byte(strings.Join(wanted, " ")), 0o644); err != nil {
		return fmt.Errorf("enable cgroup controllers at %s: %w", path, err)
	}
	return nil
}

func (i *linuxIsolation) AfterStart() error {
	if i.fd == nil {
		return nil
	}
	err := i.fd.Close()
	i.fd = nil
	return err
}

func (i *linuxIsolation) Kill() error {
	return os.WriteFile(filepath.Join(i.path, "cgroup.kill"), []byte("1"), 0o644)
}

func (i *linuxIsolation) Seal() (*ProcessSeal, error) {
	if err := i.Kill(); err != nil {
		return nil, fmt.Errorf("kill workload cgroup: %w", err)
	}
	if err := waitCgroupEmpty(filepath.Join(i.path, "cgroup.events"), 5*time.Second); err != nil {
		return nil, fmt.Errorf("verify workload cgroup empty: %w", err)
	}
	return &ProcessSeal{Mechanism: "cgroup-v2", State: "empty"}, nil
}

func (i *linuxIsolation) Cleanup() error {
	if i.fd != nil {
		_ = i.fd.Close()
		i.fd = nil
	}
	_ = i.Kill()
	requestErr := os.Remove(i.path)
	if errors.Is(requestErr, os.ErrNotExist) {
		requestErr = nil
	}
	sessionErr := os.Remove(i.sessionPath)
	if errors.Is(sessionErr, os.ErrNotExist) || errors.Is(sessionErr, syscall.ENOTEMPTY) {
		sessionErr = nil
	}
	return errors.Join(requestErr, sessionErr)
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
