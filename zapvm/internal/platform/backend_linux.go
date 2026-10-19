//go:build linux

package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const cloudHypervisorReadyTimeout = 15 * time.Second

type linuxBackend struct{}

func newBackend() Backend { return &linuxBackend{} }

func (*linuxBackend) Name() string { return "cloud-hypervisor-kvm" }

func (b *linuxBackend) Doctor(ctx context.Context) DoctorReport {
	report := baseReport(b.Name())
	if os.Geteuid() == 0 {
		report.Checks = append(report.Checks, Check{"non-root-host", CheckFail, "zapVM Linux Host control plane must run as a non-root user"})
	} else {
		report.Checks = append(report.Checks, Check{"non-root-host", CheckPass, "Host control plane is non-root"})
	}
	if err := validateLinuxVirtioFSDSandbox(os.ReadFile); err != nil {
		report.Checks = append(report.Checks, Check{"virtiofsd-userns-sandbox", CheckFail, err.Error()})
	} else {
		report.Checks = append(report.Checks, Check{"virtiofsd-userns-sandbox", CheckPass, "unprivileged user namespaces are available for the virtiofsd namespace sandbox"})
	}
	file, err := os.OpenFile("/dev/kvm", os.O_RDWR, 0)
	if err != nil {
		report.Checks = append(report.Checks, Check{"kvm", CheckFail, err.Error()})
	} else {
		_ = file.Close()
		report.Checks = append(report.Checks, Check{"kvm", CheckPass, "/dev/kvm is readable and writable"})
	}
	paths := make(map[string]string)
	for _, binary := range []string{"systemd-run", "systemctl"} {
		path, lookErr := exec.LookPath(binary)
		if lookErr != nil {
			report.Checks = append(report.Checks, Check{binary, CheckFail, lookErr.Error()})
		} else {
			paths[binary] = path
			report.Checks = append(report.Checks, Check{binary, CheckPass, path})
		}
	}
	report.Checks = append(report.Checks, Check{
		"signed-vmm-runtime", CheckPass,
		"Cloud Hypervisor and virtiofsd are resolved and reverified from the signed active image at VM start",
	})
	if _, err := os.Stat("/sys/fs/cgroup/cgroup.controllers"); err != nil {
		report.Checks = append(report.Checks, Check{"cgroup-v2", CheckFail, err.Error()})
	} else {
		report.Checks = append(report.Checks, Check{"cgroup-v2", CheckPass, "unified cgroup v2 is available"})
	}
	if systemdRunPath := paths["systemd-run"]; systemdRunPath != "" {
		output, versionErr := exec.CommandContext(ctx, systemdRunPath, "--version").Output()
		version, parseErr := parseSystemdVersion(string(output))
		switch {
		case versionErr != nil:
			report.Checks = append(report.Checks, Check{"systemd-version", CheckFail, versionErr.Error()})
		case parseErr != nil:
			report.Checks = append(report.Checks, Check{"systemd-version", CheckFail, parseErr.Error()})
		case version < minimumSystemdVersion:
			report.Checks = append(report.Checks, Check{"systemd-version", CheckFail, fmt.Sprintf("systemd %d is too old; need %d+", version, minimumSystemdVersion)})
		default:
			report.Checks = append(report.Checks, Check{"systemd-version", CheckPass, fmt.Sprintf("systemd %d", version)})
		}
	}
	if systemctlPath := paths["systemctl"]; systemctlPath != "" {
		command := exec.CommandContext(ctx, systemctlPath, "--user", "list-units", "--no-legend", "--no-pager", "--type=scope")
		command.Stdout = io.Discard
		command.Stderr = io.Discard
		if err := command.Run(); err != nil {
			report.Checks = append(report.Checks, Check{"systemd-user-manager", CheckFail, err.Error()})
		} else {
			report.Checks = append(report.Checks, Check{"systemd-user-manager", CheckPass, "user service manager is reachable"})
		}
	}
	return report
}

func (b *linuxBackend) Start(ctx context.Context, spec Spec, console io.Writer) (Instance, error) {
	spec.SetDefaults()
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	if spec.Network == NetworkUnrestricted {
		return nil, fmt.Errorf("not implemented: Linux networking requires tap and host egress proxy setup")
	}
	if os.Geteuid() == 0 {
		return nil, errors.New("refusing to run the Linux Host control plane as root")
	}
	if err := validateLinuxVirtioFSDSandbox(os.ReadFile); err != nil {
		return nil, fmt.Errorf("virtiofsd namespace sandbox is unavailable: %w", err)
	}
	vmmPath := spec.VMMPath
	if vmmPath == "" {
		resolvedPath, lookErr := exec.LookPath("cloud-hypervisor")
		if lookErr != nil {
			return nil, lookErr
		}
		vmmPath = resolvedPath
	}
	virtioFSDPath := spec.VirtioFSDPath
	if virtioFSDPath == "" {
		resolvedPath, lookErr := exec.LookPath("virtiofsd")
		if lookErr != nil {
			return nil, lookErr
		}
		virtioFSDPath = resolvedPath
	}
	systemdRunPath, err := exec.LookPath("systemd-run")
	if err != nil {
		return nil, err
	}
	systemctlPath, err := exec.LookPath("systemctl")
	if err != nil {
		return nil, err
	}
	versionOutput, err := exec.CommandContext(ctx, systemdRunPath, "--version").Output()
	if err != nil {
		return nil, fmt.Errorf("query systemd version: %w", err)
	}
	systemdVersion, err := parseSystemdVersion(string(versionOutput))
	if err != nil {
		return nil, err
	}
	if systemdVersion < minimumSystemdVersion {
		return nil, fmt.Errorf("systemd %d is too old; need %d+ for literal transient-scope arguments", systemdVersion, minimumSystemdVersion)
	}
	if err := validateLinuxRuntimeCommand(ctx, vmmPath, spec.VMMVersion, "Cloud Hypervisor"); err != nil {
		return nil, err
	}
	if err := validateLinuxRuntimeCommand(ctx, virtioFSDPath, spec.VirtioFSDVersion, "virtiofsd"); err != nil {
		return nil, err
	}
	runtimeDir, err := os.MkdirTemp("", "zapvm-")
	if err != nil {
		return nil, err
	}
	cleanupRuntime := true
	defer func() {
		if cleanupRuntime {
			_ = os.RemoveAll(runtimeDir)
		}
	}()

	fsArgs := make([]string, 0, 4)
	shares := make([]linuxSupervisorShare, 0, 2)
	addShare := func(tag, path string, readOnly bool) {
		if path == "" {
			return
		}
		socketPath := filepath.Join(runtimeDir, tag+".sock")
		shares = append(shares, linuxSupervisorShare{Tag: tag, Path: path, SocketPath: socketPath, ReadOnly: readOnly})
		fsArgs = append(fsArgs, "--fs", "tag="+tag+",socket="+socketPath+",num_queues=1,queue_size=512")
	}
	addShare("zapvm_boot", spec.BootSharePath, true)
	addShare("zapvm_workspace", spec.WorkspacePath, spec.WorkspaceReadOnly)

	memory := "size=" + strconv.FormatUint(spec.MemoryBytes, 10)
	if len(fsArgs) > 0 {
		memory += ",shared=on"
	}
	vsockPath := filepath.Join(runtimeDir, "agent.vsock")
	cid := crc32.ChecksumIEEE([]byte(spec.ID))
	if cid < 3 {
		cid += 3
	}
	apiSocketPath := filepath.Join(runtimeDir, "api.sock")
	args := []string{
		"--kernel", spec.KernelPath,
		"--disk", linuxRawDiskArgument(spec.RootDiskPath, true),
		"--cpus", "boot=" + strconv.FormatUint(uint64(spec.CPUCount), 10),
		"--memory", memory,
		"--api-socket", "path=" + apiSocketPath,
		"--vsock", "cid=" + strconv.FormatUint(uint64(cid), 10) + ",socket=" + vsockPath,
	}
	args = append(args, linuxConsoleArguments(spec.Console)...)
	if spec.InitrdPath != "" {
		args = append(args, "--initramfs", spec.InitrdPath)
	}
	if spec.KernelCmdline != "" {
		args = append(args, "--cmdline", spec.KernelCmdline)
	}
	if spec.StateDiskPath != "" {
		args = append(args, "--disk", linuxRawDiskArgument(spec.StateDiskPath, false))
	}
	if spec.AgentDiskPath != "" {
		args = append(args, "--disk", linuxRawDiskArgument(spec.AgentDiskPath, true))
	}
	args = append(args, fsArgs...)
	configPath := filepath.Join(runtimeDir, "supervisor.json")
	config := linuxSupervisorConfig{VMMPath: vmmPath, VMMArgs: args, VirtioFSDPath: virtioFSDPath, Shares: shares}
	if err := writeLinuxSupervisorConfig(configPath, config); err != nil {
		return nil, err
	}
	executablePath, err := os.Executable()
	if err != nil {
		return nil, err
	}
	unitName := systemdScopeUnitName(spec.ID, runtimeDir)
	cmd := exec.Command(systemdRunPath, systemdScopeArguments(unitName, executablePath, configPath, spec)...)
	cmd.Stdout = console
	cmd.Stderr = console
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	instance := &linuxInstance{
		processInstance: processInstance{id: spec.ID, cmd: cmd, done: make(chan struct{})},
		vsockPath:       vsockPath,
		api:             newCloudHypervisorAPI(apiSocketPath),
		runtimeDir:      runtimeDir,
		unitName:        unitName,
		systemctlPath:   systemctlPath,
		lifecycle:       newLifecycleState(StateStarting),
	}
	cleanupRuntime = false
	go instance.reap()
	readyContext, cancelReady := context.WithTimeout(ctx, cloudHypervisorReadyTimeout)
	defer cancelReady()
	if err := instance.waitReady(readyContext); err != nil {
		stopContext, cancelStop := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelStop()
		_ = instance.stopProcess(stopContext)
		return nil, fmt.Errorf("start Cloud Hypervisor VM: %w", err)
	}
	return instance, nil
}

func linuxRawDiskArgument(path string, readOnly bool) string {
	argument := "path=" + path + ",image_type=raw"
	if readOnly {
		argument += ",readonly=on"
	}
	return argument
}

func linuxConsoleArguments(enabled bool) []string {
	if enabled {
		// The shared kernel command line uses console=hvc0, which is Cloud
		// Hypervisor's virtio console. Keep the legacy serial port disabled.
		return []string{"--console", "tty", "--serial", "off"}
	}
	return []string{"--console", "off", "--serial", "off"}
}

type boundedRuntimeOutput struct {
	buffer bytes.Buffer
}

func (output *boundedRuntimeOutput) Write(data []byte) (int, error) {
	if output.buffer.Len()+len(data) > 64<<10 {
		return 0, errors.New("runtime version output exceeds 64 KiB")
	}
	return output.buffer.Write(data)
}

func validateLinuxRuntimeCommand(parent context.Context, path, expectedVersion, name string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect %s runtime: %w", name, err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("%s runtime is not an executable regular file", name)
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, path, "--version")
	var output boundedRuntimeOutput
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		return fmt.Errorf("execute %s --version: %w: %s", name, err, strings.TrimSpace(output.buffer.String()))
	}
	if expectedVersion != "" {
		if !runtimeOutputHasVersion(output.buffer.String(), expectedVersion) {
			return fmt.Errorf("%s runtime version output %q does not contain signed version %q", name, strings.TrimSpace(output.buffer.String()), expectedVersion)
		}
	}
	return nil
}

func runtimeOutputHasVersion(output, expected string) bool {
	expected = strings.TrimPrefix(expected, "v")
	for _, field := range strings.Fields(output) {
		field = strings.Trim(field, "vV,;()[]{}")
		if field == expected {
			return true
		}
	}
	return false
}

type linuxSupervisorShare struct {
	Tag        string `json:"tag"`
	Path       string `json:"path"`
	SocketPath string `json:"socket_path"`
	ReadOnly   bool   `json:"read_only"`
}

type linuxSupervisorConfig struct {
	VMMPath       string                 `json:"vmm_path"`
	VMMArgs       []string               `json:"vmm_args"`
	VirtioFSDPath string                 `json:"virtiofsd_path"`
	Shares        []linuxSupervisorShare `json:"shares"`
}

func writeLinuxSupervisorConfig(path string, config linuxSupervisorConfig) error {
	data, err := json.Marshal(config)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	failed := true
	defer func() {
		_ = file.Close()
		if failed {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	failed = false
	return nil
}

func loadLinuxSupervisorConfig(path string) (linuxSupervisorConfig, error) {
	var config linuxSupervisorConfig
	if !filepath.IsAbs(path) {
		return config, errors.New("Linux VMM supervisor config path must be absolute")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return config, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 1<<20 {
		return config, errors.New("Linux VMM supervisor config must be a private regular file no larger than 1 MiB")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return config, errors.New("Linux VMM supervisor config must be owned by the current user")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return config, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return config, fmt.Errorf("decode Linux VMM supervisor config: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return config, errors.New("Linux VMM supervisor config contains trailing data")
	}
	if !filepath.IsAbs(config.VMMPath) || !filepath.IsAbs(config.VirtioFSDPath) || len(config.VMMArgs) == 0 {
		return config, errors.New("Linux VMM supervisor requires absolute VMM/virtiofsd paths and VMM arguments")
	}
	seenShares := make(map[string]struct{}, len(config.Shares))
	for _, share := range config.Shares {
		if share.Tag != "zapvm_boot" && share.Tag != "zapvm_workspace" {
			return config, fmt.Errorf("invalid Linux VMM share tag %q", share.Tag)
		}
		if _, exists := seenShares[share.Tag]; exists {
			return config, fmt.Errorf("duplicate Linux VMM share tag %q", share.Tag)
		}
		seenShares[share.Tag] = struct{}{}
		if !filepath.IsAbs(share.Path) || !filepath.IsAbs(share.SocketPath) {
			return config, errors.New("Linux VMM share paths must be absolute")
		}
	}
	return config, nil
}

func RunLinuxVMMSupervisor(configPath string, stdout, stderr io.Writer) error {
	config, err := loadLinuxSupervisorConfig(configPath)
	if err != nil {
		return err
	}
	if err := os.Remove(configPath); err != nil {
		return fmt.Errorf("consume Linux VMM supervisor config: %w", err)
	}
	children := make([]*managedProcess, 0, len(config.Shares))
	childFailure := make(chan error, len(config.Shares))
	defer stopProcesses(children)
	for _, share := range config.Shares {
		child, err := startVirtioFSD(config.VirtioFSDPath, share.Path, share.SocketPath, share.ReadOnly, stdout, stderr)
		if err != nil {
			return fmt.Errorf("start %s virtiofsd: %w", share.Tag, err)
		}
		children = append(children, child)
		go func(tag string, process *managedProcess) {
			<-process.done
			if err := process.waitError(); err != nil {
				childFailure <- fmt.Errorf("%s virtiofsd exited: %w", tag, err)
			} else {
				childFailure <- fmt.Errorf("%s virtiofsd exited unexpectedly", tag)
			}
		}(share.Tag, child)
	}
	command := exec.Command(config.VMMPath, config.VMMArgs...)
	command.Stdout = stdout
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		return fmt.Errorf("start Cloud Hypervisor: %w", err)
	}
	process := newManagedProcess(command)
	defer process.stop()
	select {
	case <-process.done:
		return process.waitError()
	case err := <-childFailure:
		_ = process.stop()
		return err
	}
}

func startVirtioFSD(path, sharedDir, socketPath string, readOnly bool, stdout, stderr io.Writer) (*managedProcess, error) {
	args := []string{"--socket-path=" + socketPath, "--shared-dir=" + sharedDir, "--cache=never"}
	if readOnly {
		args = append(args, "--readonly")
	}
	cmd := exec.Command(path, args...)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	process := newManagedProcess(cmd)
	timeout := time.NewTimer(5 * time.Second)
	defer timeout.Stop()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-process.done:
			if err := process.waitError(); err != nil {
				return nil, fmt.Errorf("backend not ready: virtiofsd exited before creating its socket: %w", err)
			}
			return nil, errorsNotReady("virtiofsd exited before creating its socket")
		case <-timeout.C:
			_ = process.stop()
			return nil, errorsNotReady("virtiofsd did not create its socket")
		case <-ticker.C:
			if _, err := os.Stat(socketPath); err == nil {
				return process, nil
			}
		}
	}
}

func errorsNotReady(message string) error { return fmt.Errorf("backend not ready: %s", message) }

type processInstance struct {
	id    string
	cmd   *exec.Cmd
	done  chan struct{}
	once  sync.Once
	errMu sync.RWMutex
	err   error
}

type managedProcess struct {
	cmd   *exec.Cmd
	done  chan struct{}
	errMu sync.RWMutex
	err   error
}

func newManagedProcess(cmd *exec.Cmd) *managedProcess {
	process := &managedProcess{cmd: cmd, done: make(chan struct{})}
	go func() {
		err := cmd.Wait()
		process.errMu.Lock()
		process.err = err
		process.errMu.Unlock()
		close(process.done)
	}()
	return process
}

func (p *managedProcess) waitError() error {
	p.errMu.RLock()
	defer p.errMu.RUnlock()
	return p.err
}

func (p *managedProcess) stop() error {
	if p == nil || p.cmd == nil || p.cmd.Process == nil {
		return nil
	}
	select {
	case <-p.done:
		return nil
	default:
	}
	if err := p.cmd.Process.Kill(); err != nil {
		select {
		case <-p.done:
			return nil
		default:
			return err
		}
	}
	select {
	case <-p.done:
		return nil
	case <-time.After(5 * time.Second):
		return fmt.Errorf("timed out waiting for child process %d to exit", p.cmd.Process.Pid)
	}
}

func (i *processInstance) ID() string { return i.id }

func (i *processInstance) State() State {
	select {
	case <-i.done:
		i.errMu.RLock()
		defer i.errMu.RUnlock()
		if i.err != nil {
			return StateFailed
		}
		return StateStopped
	default:
		return StateRunning
	}
}

type linuxInstance struct {
	processInstance
	vsockPath     string
	api           *cloudHypervisorAPI
	runtimeDir    string
	unitName      string
	systemctlPath string
	cleanup       sync.Once
	opMu          sync.Mutex
	lifecycle     *lifecycleState
}

func (i *linuxInstance) reap() {
	waitErr := i.cmd.Wait()
	before, _, _ := i.lifecycle.Apply(lifecycleExited)
	runErr := waitErr
	if before == StateStopping {
		// API shutdown and the SIGKILL fallback can both produce a non-zero
		// supervisor exit. If Host stop won the event race, that exit is the
		// requested terminal transition rather than a VM crash.
		runErr = nil
	} else if runErr == nil {
		runErr = errors.New("Cloud Hypervisor exited without a Host stop request")
	}
	i.errMu.Lock()
	i.err = runErr
	i.errMu.Unlock()
	i.once.Do(func() { close(i.done) })
	i.cleanupResources()
}

func (i *linuxInstance) State() State {
	return i.lifecycle.State()
}

func (i *linuxInstance) waitReady(ctx context.Context) error {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	var lastError error
	for {
		select {
		case <-ctx.Done():
			if lastError != nil {
				return fmt.Errorf("API did not report Running before deadline: %w", lastError)
			}
			return fmt.Errorf("API did not report Running before deadline: %w", ctx.Err())
		case <-i.done:
			i.errMu.RLock()
			err := i.err
			i.errMu.RUnlock()
			if err == nil {
				return errorsNotReady("Cloud Hypervisor exited before API reported Running")
			}
			return fmt.Errorf("Cloud Hypervisor exited before API reported Running: %w", err)
		case <-ticker.C:
			if _, err := i.api.ping(ctx); err != nil {
				lastError = err
				continue
			}
			info, err := i.api.vmInfo(ctx)
			if err != nil {
				lastError = err
				continue
			}
			switch strings.ToLower(info.State) {
			case "running":
				if _, state, accepted := i.lifecycle.Apply(lifecycleReady); !accepted || state != StateRunning {
					return fmt.Errorf("Cloud Hypervisor reported Running after lifecycle reached %s", state)
				}
				return nil
			case "created":
				lastError = fmt.Errorf("VM state is %s", info.State)
			case "shutdown":
				return errorsNotReady("Cloud Hypervisor API reported VM state Shutdown")
			default:
				lastError = fmt.Errorf("unrecognized Cloud Hypervisor VM state %q", info.State)
			}
		}
	}
}

func (i *linuxInstance) cleanupResources() {
	i.cleanup.Do(func() {
		_ = os.RemoveAll(i.runtimeDir)
	})
}

func (i *linuxInstance) Wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-i.done:
		i.errMu.RLock()
		defer i.errMu.RUnlock()
		return i.err
	}
}

func (i *linuxInstance) Pause(ctx context.Context) (returnErr error) {
	i.opMu.Lock()
	defer i.opMu.Unlock()
	state := i.State()
	if state == StatePaused {
		return nil
	}
	if _, state, accepted := i.lifecycle.Apply(lifecyclePauseRequested); !accepted || state != StatePausing {
		return fmt.Errorf("cannot pause Linux VM from state %s", state)
	}
	defer func() {
		if returnErr != nil {
			i.lifecycle.Apply(lifecyclePauseRejected)
		}
	}()
	if err := i.api.pauseVM(ctx); err != nil {
		return fmt.Errorf("pause Cloud Hypervisor VM: %w", err)
	}
	if _, state, accepted := i.lifecycle.Apply(lifecyclePaused); !accepted || state != StatePaused {
		return fmt.Errorf("Cloud Hypervisor pause completed after lifecycle reached %s", state)
	}
	return nil
}

func (i *linuxInstance) Resume(ctx context.Context) (returnErr error) {
	i.opMu.Lock()
	defer i.opMu.Unlock()
	state := i.State()
	if state == StateRunning {
		return nil
	}
	if _, state, accepted := i.lifecycle.Apply(lifecycleResumeRequested); !accepted || state != StateResuming {
		return fmt.Errorf("cannot resume Linux VM from state %s", state)
	}
	defer func() {
		if returnErr != nil {
			i.lifecycle.Apply(lifecycleResumeRejected)
		}
	}()
	if err := i.api.resumeVM(ctx); err != nil {
		return fmt.Errorf("resume Cloud Hypervisor VM: %w", err)
	}
	if _, state, accepted := i.lifecycle.Apply(lifecycleReady); !accepted || state != StateRunning {
		return fmt.Errorf("Cloud Hypervisor resume completed after lifecycle reached %s", state)
	}
	return nil
}

func (i *linuxInstance) Stop(ctx context.Context) (returnErr error) {
	i.opMu.Lock()
	defer i.opMu.Unlock()
	state := i.State()
	if i.cmd.Process == nil || state == StateStopped || state == StateFailed {
		return nil
	}
	if _, state, accepted := i.lifecycle.Apply(lifecycleStopRequested); !accepted || state != StateStopping {
		return fmt.Errorf("cannot request Linux VM stop from state %s", state)
	}
	defer func() {
		if returnErr != nil {
			i.lifecycle.Apply(lifecycleStopRejected)
		}
	}()
	vmShutdownError := i.api.shutdownVM(ctx)
	vmmShutdownError := i.api.shutdownVMM(ctx)
	if vmmShutdownError == nil {
		select {
		case <-i.done:
			return nil
		case <-ctx.Done():
			return i.killUnit()
		}
	}
	if err := i.stopProcess(ctx); err != nil {
		return fmt.Errorf("Cloud Hypervisor API shutdown failed (%v; %v), process fallback failed: %w", vmShutdownError, vmmShutdownError, err)
	}
	return nil
}

func (i *linuxInstance) stopProcess(ctx context.Context) error {
	if i.cmd.Process == nil || i.unitName == "" || i.systemctlPath == "" {
		return nil
	}
	command := exec.CommandContext(ctx, i.systemctlPath, "--user", "stop", i.unitName)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		select {
		case <-i.done:
			return nil
		default:
			if killErr := i.killUnit(); killErr != nil {
				return errors.Join(err, killErr)
			}
		}
	}
	select {
	case <-i.done:
		return nil
	case <-ctx.Done():
		return i.killUnit()
	}
}

func (i *linuxInstance) killUnit() error {
	if i.cmd.Process == nil || i.unitName == "" || i.systemctlPath == "" {
		return nil
	}
	killContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	command := exec.CommandContext(killContext, i.systemctlPath, "--user", "kill", "--kill-whom=all", "--signal=SIGKILL", i.unitName)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	err := command.Run()
	if err != nil {
		select {
		case <-i.done:
			return nil
		default:
			return errors.Join(err, i.killWrapperAndWait())
		}
	}
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-i.done:
		return nil
	case <-timer.C:
		return i.killWrapperAndWait()
	}
}

func (i *linuxInstance) killWrapperAndWait() error {
	if i.cmd.Process == nil {
		return nil
	}
	killErr := i.cmd.Process.Kill()
	if errors.Is(killErr, os.ErrProcessDone) {
		killErr = nil
	}
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-i.done:
		return killErr
	case <-timer.C:
		return errors.Join(killErr, errors.New("timed out waiting for Linux VMM supervisor to exit after SIGKILL"))
	}
}

func (i *linuxInstance) DialAgent(ctx context.Context, port uint32) (io.ReadWriteCloser, error) {
	dialer := net.Dialer{}
	for {
		connection, err := dialer.DialContext(ctx, "unix", i.vsockPath)
		if err == nil {
			if _, err := fmt.Fprintf(connection, "CONNECT %d\n", port); err != nil {
				_ = connection.Close()
				return nil, err
			}
			if deadline, ok := ctx.Deadline(); ok {
				if err := connection.SetDeadline(deadline); err != nil {
					_ = connection.Close()
					return nil, err
				}
			}
			if err := readCloudHypervisorVSockAck(connection); err != nil {
				_ = connection.Close()
				return nil, err
			}
			if err := connection.SetDeadline(time.Time{}); err != nil {
				_ = connection.Close()
				return nil, err
			}
			return connection, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func readCloudHypervisorVSockAck(reader io.Reader) error {
	const maxAckSize = 32
	ack := make([]byte, 0, maxAckSize)
	var next [1]byte
	for len(ack) < maxAckSize {
		if _, err := io.ReadFull(reader, next[:]); err != nil {
			return fmt.Errorf("read Cloud Hypervisor VSOCK acknowledgement: %w", err)
		}
		ack = append(ack, next[0])
		if next[0] == '\n' {
			fields := strings.Fields(string(ack))
			if len(fields) != 2 || fields[0] != "OK" {
				return fmt.Errorf("invalid Cloud Hypervisor VSOCK acknowledgement %q", strings.TrimSpace(string(ack)))
			}
			assignedPort, err := strconv.ParseUint(fields[1], 10, 32)
			if err != nil || assignedPort == 0 {
				return fmt.Errorf("invalid Cloud Hypervisor VSOCK assigned port %q", fields[1])
			}
			return nil
		}
	}
	return errors.New("Cloud Hypervisor VSOCK acknowledgement exceeds 32 bytes")
}

func (i *linuxInstance) ListenHost(port uint32) (net.Listener, error) {
	return net.Listen("unix", i.vsockPath+"_"+strconv.FormatUint(uint64(port), 10))
}

func stopProcesses(processes []*managedProcess) {
	for _, process := range processes {
		_ = process.stop()
	}
}
