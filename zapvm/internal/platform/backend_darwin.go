//go:build darwin

package platform

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"

	"github.com/Code-Hex/vz/v3"
)

type darwinBackend struct{}

func newBackend() Backend { return &darwinBackend{} }

func (*darwinBackend) Name() string { return "apple-virtualization" }

func (b *darwinBackend) Doctor(ctx context.Context) DoctorReport {
	report := baseReport(b.Name())
	if runtime.GOARCH == "arm64" || runtime.GOARCH == "amd64" {
		report.Checks = append(report.Checks, Check{"host-architecture", CheckPass, runtime.GOARCH})
	} else {
		report.Checks = append(report.Checks, Check{"host-architecture", CheckFail, "Virtualization.framework backend supports arm64 or amd64"})
	}

	exe, err := os.Executable()
	if err != nil {
		report.Checks = append(report.Checks, Check{"virtualization-entitlement", CheckWarn, err.Error()})
		return report
	}
	out, err := exec.CommandContext(ctx, "codesign", "-d", "--entitlements", ":-", exe).CombinedOutput()
	if err != nil || !strings.Contains(string(out), "com.apple.security.virtualization") {
		report.Checks = append(report.Checks, Check{"virtualization-entitlement", CheckWarn, "binary is not signed with com.apple.security.virtualization; go run is expected to warn"})
	} else {
		report.Checks = append(report.Checks, Check{"virtualization-entitlement", CheckPass, "present"})
	}
	return report
}

func (b *darwinBackend) Start(ctx context.Context, spec Spec, console io.Writer) (Instance, error) {
	spec.SetDefaults()
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	bootOptions := make([]vz.LinuxBootLoaderOption, 0, 2)
	if spec.InitrdPath != "" {
		bootOptions = append(bootOptions, vz.WithInitrd(spec.InitrdPath))
	}
	if spec.KernelCmdline != "" {
		bootOptions = append(bootOptions, vz.WithCommandLine(spec.KernelCmdline))
	}
	bootLoader, err := vz.NewLinuxBootLoader(spec.KernelPath, bootOptions...)
	if err != nil {
		return nil, fmt.Errorf("create Linux boot loader: %w", err)
	}
	config, err := vz.NewVirtualMachineConfiguration(bootLoader, spec.CPUCount, spec.MemoryBytes)
	if err != nil {
		return nil, fmt.Errorf("create VM configuration: %w", err)
	}

	rootAttachment, err := vz.NewDiskImageStorageDeviceAttachment(spec.RootDiskPath, true)
	if err != nil {
		return nil, fmt.Errorf("attach root disk: %w", err)
	}
	rootDevice, err := vz.NewVirtioBlockDeviceConfiguration(rootAttachment)
	if err != nil {
		return nil, fmt.Errorf("configure root disk: %w", err)
	}
	storage := []vz.StorageDeviceConfiguration{rootDevice}
	if spec.StateDiskPath != "" {
		stateAttachment, attachErr := vz.NewDiskImageStorageDeviceAttachment(spec.StateDiskPath, false)
		if attachErr != nil {
			return nil, fmt.Errorf("attach state disk: %w", attachErr)
		}
		stateDevice, configErr := vz.NewVirtioBlockDeviceConfiguration(stateAttachment)
		if configErr != nil {
			return nil, fmt.Errorf("configure state disk: %w", configErr)
		}
		storage = append(storage, stateDevice)
	}
	if spec.AgentDiskPath != "" {
		agentAttachment, attachErr := vz.NewDiskImageStorageDeviceAttachment(spec.AgentDiskPath, true)
		if attachErr != nil {
			return nil, fmt.Errorf("attach Agent disk: %w", attachErr)
		}
		agentDevice, configErr := vz.NewVirtioBlockDeviceConfiguration(agentAttachment)
		if configErr != nil {
			return nil, fmt.Errorf("configure Agent disk: %w", configErr)
		}
		storage = append(storage, agentDevice)
	}
	config.SetStorageDevicesVirtualMachineConfiguration(storage)

	entropy, err := vz.NewVirtioEntropyDeviceConfiguration()
	if err != nil {
		return nil, fmt.Errorf("configure entropy device: %w", err)
	}
	config.SetEntropyDevicesVirtualMachineConfiguration([]*vz.VirtioEntropyDeviceConfiguration{entropy})
	balloon, err := vz.NewVirtioTraditionalMemoryBalloonDeviceConfiguration()
	if err != nil {
		return nil, fmt.Errorf("configure memory balloon device: %w", err)
	}
	config.SetMemoryBalloonDevicesVirtualMachineConfiguration([]vz.MemoryBalloonDeviceConfiguration{balloon})
	socket, err := vz.NewVirtioSocketDeviceConfiguration()
	if err != nil {
		return nil, fmt.Errorf("configure socket device: %w", err)
	}
	config.SetSocketDevicesVirtualMachineConfiguration([]vz.SocketDeviceConfiguration{socket})
	fileSystems := make([]vz.DirectorySharingDeviceConfiguration, 0, 2)
	if spec.BootSharePath != "" {
		sharedDirectory, shareErr := vz.NewSharedDirectory(spec.BootSharePath, true)
		if shareErr != nil {
			return nil, fmt.Errorf("create boot share: %w", shareErr)
		}
		share, shareErr := vz.NewSingleDirectoryShare(sharedDirectory)
		if shareErr != nil {
			return nil, fmt.Errorf("configure boot share: %w", shareErr)
		}
		fileSystem, shareErr := vz.NewVirtioFileSystemDeviceConfiguration("zapvm_boot")
		if shareErr != nil {
			return nil, fmt.Errorf("configure boot virtiofs: %w", shareErr)
		}
		fileSystem.SetDirectoryShare(share)
		fileSystems = append(fileSystems, fileSystem)
	}
	if spec.WorkspacePath != "" {
		sharedDirectory, shareErr := vz.NewSharedDirectory(spec.WorkspacePath, spec.WorkspaceReadOnly)
		if shareErr != nil {
			return nil, fmt.Errorf("create workspace share: %w", shareErr)
		}
		share, shareErr := vz.NewSingleDirectoryShare(sharedDirectory)
		if shareErr != nil {
			return nil, fmt.Errorf("configure workspace share: %w", shareErr)
		}
		fileSystem, shareErr := vz.NewVirtioFileSystemDeviceConfiguration("zapvm_workspace")
		if shareErr != nil {
			return nil, fmt.Errorf("configure workspace virtiofs: %w", shareErr)
		}
		fileSystem.SetDirectoryShare(share)
		fileSystems = append(fileSystems, fileSystem)
	}
	if len(fileSystems) > 0 {
		config.SetDirectorySharingDevicesVirtualMachineConfiguration(fileSystems)
	}

	var consoleInput *os.File
	{
		// Guest init expects hvc0 even when console output is disabled. Keep the
		// device attached and discard output rather than changing the boot shape.
		outFile, ok := console.(*os.File)
		if spec.Console && !ok {
			return nil, errorsNotImplemented("darwin console output currently requires an *os.File")
		}
		// The daemon worker owns stdin for its JSONL execution protocol. Giving
		// that same descriptor to the Guest serial port races the protocol reader
		// and lets the Guest login console consume command bytes. Console input is
		// not part of the Backend API, so attach an inert, independently owned file
		// while retaining console output for boot diagnostics.
		consoleInput, err = os.OpenFile(os.DevNull, os.O_RDWR, 0)
		if err != nil {
			return nil, fmt.Errorf("open inert serial console input: %w", err)
		}
		if !spec.Console {
			outFile = consoleInput
		}
		attachment, attachErr := vz.NewFileHandleSerialPortAttachment(consoleInput, outFile)
		if attachErr != nil {
			_ = consoleInput.Close()
			return nil, fmt.Errorf("attach serial console: %w", attachErr)
		}
		serial, serialErr := vz.NewVirtioConsoleDeviceSerialPortConfiguration(attachment)
		if serialErr != nil {
			_ = consoleInput.Close()
			return nil, fmt.Errorf("configure serial console: %w", serialErr)
		}
		config.SetSerialPortsVirtualMachineConfiguration([]*vz.VirtioConsoleDeviceSerialPortConfiguration{serial})
	}

	if spec.Network == NetworkUnrestricted {
		attachment, attachErr := vz.NewNATNetworkDeviceAttachment()
		if attachErr != nil {
			return nil, fmt.Errorf("attach NAT network: %w", attachErr)
		}
		network, networkErr := vz.NewVirtioNetworkDeviceConfiguration(attachment)
		if networkErr != nil {
			return nil, fmt.Errorf("configure NAT network: %w", networkErr)
		}
		config.SetNetworkDevicesVirtualMachineConfiguration([]*vz.VirtioNetworkDeviceConfiguration{network})
	}

	valid, err := config.Validate()
	if err != nil {
		if consoleInput != nil {
			_ = consoleInput.Close()
		}
		return nil, fmt.Errorf("validate VM configuration: %w", err)
	}
	if !valid {
		if consoleInput != nil {
			_ = consoleInput.Close()
		}
		return nil, fmt.Errorf("validate VM configuration: invalid without detail")
	}
	machine, err := vz.NewVirtualMachine(config)
	if err != nil {
		if consoleInput != nil {
			_ = consoleInput.Close()
		}
		return nil, fmt.Errorf("create VM: %w", err)
	}
	instance := &darwinInstance{
		id: spec.ID, machine: machine, stopped: make(chan struct{}),
		lifecycle: newLifecycleState(StateStarting), consoleInput: consoleInput,
	}
	go instance.watch()
	if err := machine.Start(); err != nil {
		instance.finish(lifecycleFailed, fmt.Errorf("start VM: %w", err))
		return nil, fmt.Errorf("start VM: %w", err)
	}
	instance.lifecycle.Apply(lifecycleReady)
	return instance, nil
}

type darwinInstance struct {
	id           string
	machine      *vz.VirtualMachine
	stopped      chan struct{}
	once         sync.Once
	opMu         sync.Mutex
	lifecycle    *lifecycleState
	errMu        sync.RWMutex
	err          error
	consoleInput *os.File
}

func (i *darwinInstance) ID() string { return i.id }

func (i *darwinInstance) State() State {
	return i.lifecycle.State()
}

func (i *darwinInstance) watch() {
	for state := range i.machine.StateChangedNotify() {
		switch state {
		case vz.VirtualMachineStateRunning:
			i.lifecycle.Apply(lifecycleReady)
		case vz.VirtualMachineStatePausing:
			i.lifecycle.Apply(lifecyclePauseRequested)
		case vz.VirtualMachineStatePaused:
			i.lifecycle.Apply(lifecyclePaused)
		case vz.VirtualMachineStateResuming:
			i.lifecycle.Apply(lifecycleResumeRequested)
		case vz.VirtualMachineStateError:
			i.finish(lifecycleFailed, errors.New("VM entered error state"))
			return
		case vz.VirtualMachineStateStopped:
			i.finish(lifecycleExited, nil)
			return
		}
	}
	i.finish(lifecycleFailed, errors.New("Virtualization.framework state notification stream closed before VM termination"))
}

func (i *darwinInstance) finish(event lifecycleEvent, runErr error) {
	i.once.Do(func() {
		before, state, _ := i.lifecycle.Apply(event)
		if event == lifecycleExited && state == StateFailed && runErr == nil {
			runErr = fmt.Errorf("VM exited without a Host stop request from state %s", before)
		}
		i.errMu.Lock()
		i.err = runErr
		i.errMu.Unlock()
		if i.consoleInput != nil {
			_ = i.consoleInput.Close()
		}
		close(i.stopped)
	})
}

func (i *darwinInstance) Wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-i.stopped:
		i.errMu.RLock()
		defer i.errMu.RUnlock()
		return i.err
	}
}

func (i *darwinInstance) Pause(ctx context.Context) (returnErr error) {
	i.opMu.Lock()
	defer i.opMu.Unlock()
	state := i.State()
	if state == StatePaused {
		return nil
	}
	if _, state, accepted := i.lifecycle.Apply(lifecyclePauseRequested); !accepted || state != StatePausing {
		return fmt.Errorf("cannot pause macOS VM from state %s", state)
	}
	defer func() {
		if returnErr != nil {
			i.lifecycle.Apply(lifecyclePauseRejected)
		}
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	if !i.machine.CanPause() {
		return fmt.Errorf("VM cannot be paused from framework state %s", i.machine.State())
	}
	if err := i.machine.Pause(); err != nil {
		return fmt.Errorf("pause macOS VM: %w", err)
	}
	if _, state, accepted := i.lifecycle.Apply(lifecyclePaused); !accepted || state != StatePaused {
		return fmt.Errorf("macOS VM pause completed after lifecycle reached %s", state)
	}
	return nil
}

func (i *darwinInstance) Resume(ctx context.Context) (returnErr error) {
	i.opMu.Lock()
	defer i.opMu.Unlock()
	state := i.State()
	if state == StateRunning {
		return nil
	}
	if _, state, accepted := i.lifecycle.Apply(lifecycleResumeRequested); !accepted || state != StateResuming {
		return fmt.Errorf("cannot resume macOS VM from state %s", state)
	}
	defer func() {
		if returnErr != nil {
			i.lifecycle.Apply(lifecycleResumeRejected)
		}
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	if !i.machine.CanResume() {
		return fmt.Errorf("VM cannot be resumed from framework state %s", i.machine.State())
	}
	if err := i.machine.Resume(); err != nil {
		return fmt.Errorf("resume macOS VM: %w", err)
	}
	if _, state, accepted := i.lifecycle.Apply(lifecycleReady); !accepted || state != StateRunning {
		return fmt.Errorf("macOS VM resume completed after lifecycle reached %s", state)
	}
	return nil
}

func (i *darwinInstance) Stop(ctx context.Context) (returnErr error) {
	i.opMu.Lock()
	defer i.opMu.Unlock()
	state := i.State()
	if state == StateStopped || state == StateFailed {
		return nil
	}
	if _, state, accepted := i.lifecycle.Apply(lifecycleStopRequested); !accepted || state != StateStopping {
		return fmt.Errorf("cannot request macOS VM stop from state %s", state)
	}
	defer func() {
		if returnErr != nil {
			i.lifecycle.Apply(lifecycleStopRejected)
		}
	}()
	if i.machine.CanRequestStop() {
		if requested, err := i.machine.RequestStop(); err == nil && requested {
			select {
			case <-i.stopped:
				return nil
			case <-ctx.Done():
			}
		}
	}
	if !i.machine.CanStop() {
		return fmt.Errorf("VM cannot be stopped from framework state %s", i.machine.State())
	}
	return i.machine.Stop()
}

func (i *darwinInstance) DialAgent(ctx context.Context, port uint32) (io.ReadWriteCloser, error) {
	devices := i.machine.SocketDevices()
	if len(devices) != 1 {
		return nil, fmt.Errorf("expected one Virtio socket device, got %d", len(devices))
	}
	// Callers already retry transient connection failures while the Guest agent
	// starts. An unconditional delay here penalizes every command on an already
	// healthy VM, so attempt the vsock connection immediately.
	result := make(chan struct {
		connection io.ReadWriteCloser
		err        error
	}, 1)
	go func() {
		connection, err := devices[0].Connect(port)
		result <- struct {
			connection io.ReadWriteCloser
			err        error
		}{connection, err}
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case attempt := <-result:
		return attempt.connection, attempt.err
	}
}

func (i *darwinInstance) ListenHost(port uint32) (net.Listener, error) {
	devices := i.machine.SocketDevices()
	if len(devices) != 1 {
		return nil, fmt.Errorf("expected one Virtio socket device, got %d", len(devices))
	}
	return devices[0].Listen(port)
}

func errorsNotImplemented(feature string) error {
	return fmt.Errorf("not implemented: %s", feature)
}
