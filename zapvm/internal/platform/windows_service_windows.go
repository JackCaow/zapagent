//go:build windows

package platform

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	windowsServiceName        = "zapvm"
	windowsServiceDisplayName = "zapVM Virtual Machine Service"
	windowsServicePipe        = `\\.\pipe\zapvm-service-v1`
	// SYSTEM and administrators retain full access. Authenticated local users
	// may exchange requests, but every request is authorized again by
	// impersonating the named-pipe client. 0x12019b is generic read/write with
	// FILE_CREATE_PIPE_INSTANCE (the FILE_APPEND_DATA bit) removed.
	windowsServicePipeSDDL                 = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x12019b;;;AU)"
	windowsServiceFaultInstallConfirmation = "I_UNDERSTAND_THIS_SERVICE_WILL_TERMINATE_ITSELF"
)

var advapi32DLL = windows.NewLazySystemDLL("advapi32.dll")
var procImpersonateNamedPipeClient = advapi32DLL.NewProc("ImpersonateNamedPipeClient")

func WindowsServiceCommand(args []string) error {
	if len(args) == 0 {
		return errors.New("service requires install, upgrade, rollback, uninstall, start, stop, status, or _run")
	}
	switch args[0] {
	case "install":
		if len(args) != 1 {
			return errors.New("service install accepts no arguments")
		}
		return installWindowsService()
	case "upgrade":
		if len(args) != 1 {
			return errors.New("service upgrade accepts no arguments")
		}
		return upgradeWindowsService()
	case "rollback":
		if len(args) != 1 {
			return errors.New("service rollback accepts no arguments")
		}
		return rollbackWindowsService()
	case "uninstall":
		if len(args) != 1 {
			return errors.New("service uninstall accepts no arguments")
		}
		return uninstallWindowsService()
	case "start":
		if len(args) != 1 {
			return errors.New("service start accepts no arguments")
		}
		return controlWindowsService(true)
	case "stop":
		if len(args) != 1 {
			return errors.New("service stop accepts no arguments")
		}
		return controlWindowsService(false)
	case "status":
		if len(args) != 1 {
			return errors.New("service status accepts no arguments")
		}
		return statusWindowsService()
	case "_run":
		if len(args) != 1 {
			return errors.New("service _run accepts no arguments")
		}
		return svc.Run(windowsServiceName, newWindowsService())
	default:
		return fmt.Errorf("unknown service command %q", args[0])
	}
}

func windowsServiceExecutablePath() (string, error) {
	programFiles := os.Getenv("ProgramFiles")
	if programFiles == "" {
		return "", errors.New("ProgramFiles is not set")
	}
	return filepath.Join(programFiles, "zapVM", "zapvm-service.exe"), nil
}

func installWindowsService() error {
	if err := validateWindowsServiceFaultBinaryInstall(); err != nil {
		return err
	}
	source, err := os.Executable()
	if err != nil {
		return err
	}
	source, err = filepath.EvalSymlinks(source)
	if err != nil {
		return err
	}
	destination, err := windowsServiceExecutablePath()
	if err != nil {
		return err
	}
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to Service Control Manager (administrator required): %w", err)
	}
	defer manager.Disconnect()
	if existing, openErr := manager.OpenService(windowsServiceName); openErr == nil {
		existing.Close()
		return fmt.Errorf("service %s is already installed", windowsServiceName)
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	if err := secureWindowsServiceDirectory(filepath.Dir(destination)); err != nil {
		return fmt.Errorf("secure service installation directory: %w", err)
	}
	if !strings.EqualFold(source, destination) {
		if _, err := os.Lstat(destination); err == nil {
			return fmt.Errorf("refusing to replace existing unregistered service binary %s", destination)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := copyWindowsServiceBinary(source, destination); err != nil {
			return err
		}
	}
	if err := secureWindowsServiceFile(destination); err != nil {
		if !strings.EqualFold(source, destination) {
			_ = os.Remove(destination)
		}
		return fmt.Errorf("secure service binary: %w", err)
	}
	service, err := manager.CreateService(windowsServiceName, destination, mgr.Config{
		DisplayName: windowsServiceDisplayName,
		Description: "Owns privileged HCS VM lifecycle and ACL operations for zapVM clients.",
		StartType:   mgr.StartManual, ErrorControl: mgr.ErrorNormal,
		Dependencies: []string{"vmcompute"},
		SidType:      windows.SERVICE_SID_TYPE_UNRESTRICTED,
	}, "service", "_run")
	if err != nil {
		if !strings.EqualFold(source, destination) {
			_ = os.Remove(destination)
		}
		return err
	}
	defer service.Close()
	if err := eventlog.InstallAsEventCreate(windowsServiceName, eventlog.Error|eventlog.Warning|eventlog.Info); err != nil {
		_ = service.Delete()
		if !strings.EqualFold(source, destination) {
			_ = os.Remove(destination)
		}
		return fmt.Errorf("install Windows Event Log source: %w", err)
	}
	if err := service.Start(); err != nil {
		_ = service.Delete()
		_ = eventlog.Remove(windowsServiceName)
		if !strings.EqualFold(source, destination) {
			_ = os.Remove(destination)
		}
		return fmt.Errorf("start newly installed service: %w", err)
	}
	return waitWindowsServiceState(service, svc.Running, 15*time.Second)
}

func validateWindowsServiceFaultBinaryInstall() error {
	if windowsServiceFaultInjectionEnabled &&
		os.Getenv("ZAPVM_ACCEPTANCE_ALLOW_FAULT_SERVICE") != windowsServiceFaultInstallConfirmation {
		return fmt.Errorf("acceptance fault-enabled service install requires ZAPVM_ACCEPTANCE_ALLOW_FAULT_SERVICE=%s", windowsServiceFaultInstallConfirmation)
	}
	return nil
}

func secureWindowsServiceDirectory(path string) error {
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err != nil {
		return err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil)
}

func secureWindowsServiceFile(path string) error {
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;SY)(A;;FA;;;BA)")
	if err != nil {
		return err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil)
}

func copyWindowsServiceBinary(source, destination string) (returnErr error) {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	temporary := destination + fmt.Sprintf(".tmp-%d", os.Getpid())
	output, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o755)
	if err != nil {
		return err
	}
	closed := false
	defer func() {
		if !closed {
			closeErr := output.Close()
			returnErr = errors.Join(returnErr, closeErr)
		}
		if returnErr != nil {
			_ = os.Remove(temporary)
		}
	}()
	if _, err := io.Copy(output, input); err != nil {
		return err
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	closed = true
	if err := os.Rename(temporary, destination); err != nil {
		return err
	}
	return nil
}

func replaceWindowsServiceBinary(source, destination string) error {
	staged := destination + fmt.Sprintf(".replace-%d-%d", os.Getpid(), time.Now().UnixNano())
	if err := copyWindowsServiceBinary(source, staged); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(staged)
		}
	}()
	from, err := windows.UTF16PtrFromString(staged)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	if err := windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH); err != nil {
		return err
	}
	committed = true
	return secureWindowsServiceFile(destination)
}

func windowsServiceBinaryHash(path string) ([sha256.Size]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return [sha256.Size]byte{}, err
	}
	var result [sha256.Size]byte
	copy(result[:], hash.Sum(nil))
	return result, nil
}

func validateWindowsServiceRegistration(service *mgr.Service, destination string) error {
	configuration, err := service.Config()
	if err != nil {
		return err
	}
	arguments, err := windows.DecomposeCommandLine(configuration.BinaryPathName)
	if err != nil {
		return fmt.Errorf("parse registered service command line: %w", err)
	}
	if len(arguments) != 3 || !strings.EqualFold(filepath.Clean(arguments[0]), filepath.Clean(destination)) || arguments[1] != "service" || arguments[2] != "_run" {
		return errors.New("refusing service operation: registered command line is not the zapVM service contract")
	}
	if configuration.ServiceType&windows.SERVICE_WIN32_OWN_PROCESS == 0 || configuration.StartType != mgr.StartManual || configuration.SidType != windows.SERVICE_SID_TYPE_UNRESTRICTED {
		return errors.New("refusing service operation: registered service type/start/SID configuration changed")
	}
	if configuration.ServiceStartName != "" && !strings.EqualFold(configuration.ServiceStartName, "LocalSystem") {
		return errors.New("refusing service operation: registered service is not LocalSystem")
	}
	foundVMCompute := false
	for _, dependency := range configuration.Dependencies {
		if strings.EqualFold(dependency, "vmcompute") {
			foundVMCompute = true
			break
		}
	}
	if !foundVMCompute {
		return errors.New("refusing service operation: vmcompute dependency is missing")
	}
	info, err := os.Lstat(destination)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("registered service binary is not a regular file")
	}
	resolved, err := filepath.EvalSymlinks(destination)
	if err != nil || !strings.EqualFold(filepath.Clean(resolved), filepath.Clean(destination)) {
		return errors.New("registered service binary resolves outside its protected path")
	}
	return nil
}

func stopWindowsServiceHandle(service *mgr.Service) error {
	deadline := time.Now().Add(20 * time.Second)
	for {
		status, err := service.Query()
		if err != nil {
			return err
		}
		switch status.State {
		case svc.Stopped:
			return nil
		case svc.Running, svc.Paused:
			if _, err := service.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
				return err
			}
		case svc.StartPending, svc.PausePending, svc.ContinuePending, svc.StopPending:
			// Wait for SCM to reach a controllable or stopped state.
		default:
			return fmt.Errorf("refusing to stop service from unknown state %d", status.State)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("service did not stop from state %d before timeout", status.State)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func startAndPingWindowsService(service *mgr.Service) error {
	status, err := service.Query()
	if err != nil {
		return err
	}
	if status.State != svc.Running {
		if status.State != svc.Stopped {
			return fmt.Errorf("refusing to start service from transitional state %d", status.State)
		}
		if err := service.Start(); err != nil {
			return err
		}
		if err := waitWindowsServiceState(service, svc.Running, 15*time.Second); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = callWindowsService(ctx, windowsServiceRequest{Version: windowsServiceProtocolVersion, Operation: windowsServiceOpPing})
	return err
}

func upgradeWindowsService() error {
	if err := validateWindowsServiceFaultBinaryInstall(); err != nil {
		return err
	}
	source, err := os.Executable()
	if err != nil {
		return err
	}
	source, err = filepath.EvalSymlinks(source)
	if err != nil {
		return err
	}
	destination, err := windowsServiceExecutablePath()
	if err != nil {
		return err
	}
	if strings.EqualFold(filepath.Clean(source), filepath.Clean(destination)) {
		return errors.New("run service upgrade from the new zapvm executable outside the service installation directory")
	}
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to Service Control Manager (administrator required): %w", err)
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(windowsServiceName)
	if err != nil {
		return err
	}
	defer service.Close()
	if err := validateWindowsServiceRegistration(service, destination); err != nil {
		return err
	}
	sourceHash, err := windowsServiceBinaryHash(source)
	if err != nil {
		return err
	}
	destinationHash, err := windowsServiceBinaryHash(destination)
	if err != nil {
		return err
	}
	if bytes.Equal(sourceHash[:], destinationHash[:]) {
		return startAndPingWindowsService(service)
	}
	rollbackPath := destination + ".rollback"
	if info, statErr := os.Lstat(rollbackPath); statErr == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("refusing unsafe existing service rollback file")
		}
		if err := startAndPingWindowsService(service); err != nil {
			return fmt.Errorf("existing service rollback is retained because current service is unhealthy: %w", err)
		}
		if err := os.Remove(rollbackPath); err != nil {
			return fmt.Errorf("rotate previous service rollback: %w", err)
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}
	if err := copyWindowsServiceBinary(destination, rollbackPath); err != nil {
		return fmt.Errorf("create service rollback binary: %w", err)
	}
	if err := secureWindowsServiceFile(rollbackPath); err != nil {
		return err
	}
	if err := stopWindowsServiceHandle(service); err != nil {
		return err
	}
	upgradeErr := replaceWindowsServiceBinary(source, destination)
	if upgradeErr == nil {
		upgradeErr = startAndPingWindowsService(service)
	}
	if upgradeErr == nil {
		fmt.Printf("service=%s upgraded rollback=%s\n", windowsServiceName, rollbackPath)
		return nil
	}
	_ = stopWindowsServiceHandle(service)
	restoreErr := replaceWindowsServiceBinary(rollbackPath, destination)
	if restoreErr == nil {
		restoreErr = startAndPingWindowsService(service)
	}
	if restoreErr != nil {
		return errors.Join(fmt.Errorf("service upgrade failed: %w", upgradeErr), fmt.Errorf("automatic rollback failed: %w", restoreErr))
	}
	return fmt.Errorf("service upgrade failed; previous binary was restored: %w", upgradeErr)
}

func rollbackWindowsService() error {
	destination, err := windowsServiceExecutablePath()
	if err != nil {
		return err
	}
	rollbackPath := destination + ".rollback"
	info, err := os.Lstat(rollbackPath)
	if err != nil {
		return fmt.Errorf("service rollback binary is unavailable: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("service rollback path is not a regular file")
	}
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to Service Control Manager (administrator required): %w", err)
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(windowsServiceName)
	if err != nil {
		return err
	}
	defer service.Close()
	if err := validateWindowsServiceRegistration(service, destination); err != nil {
		return err
	}
	if err := stopWindowsServiceHandle(service); err != nil {
		return err
	}
	currentCopy := destination + fmt.Sprintf(".pre-rollback-%d-%d", os.Getpid(), time.Now().UnixNano())
	if err := copyWindowsServiceBinary(destination, currentCopy); err != nil {
		return err
	}
	if err := secureWindowsServiceFile(currentCopy); err != nil {
		return err
	}
	rollbackErr := replaceWindowsServiceBinary(rollbackPath, destination)
	if rollbackErr == nil {
		rollbackErr = startAndPingWindowsService(service)
	}
	if rollbackErr != nil {
		_ = stopWindowsServiceHandle(service)
		restoreErr := replaceWindowsServiceBinary(currentCopy, destination)
		if restoreErr == nil {
			restoreErr = startAndPingWindowsService(service)
		}
		if restoreErr != nil {
			return errors.Join(fmt.Errorf("service rollback failed: %w", rollbackErr), fmt.Errorf("restore current service failed: %w", restoreErr))
		}
		_ = os.Remove(currentCopy)
		return fmt.Errorf("service rollback failed; current binary was restored: %w", rollbackErr)
	}
	if err := os.Remove(rollbackPath); err != nil {
		return fmt.Errorf("rollback succeeded but remove consumed rollback binary: %w", err)
	}
	if err := os.Remove(currentCopy); err != nil {
		return fmt.Errorf("rollback succeeded but remove replaced service copy: %w", err)
	}
	fmt.Printf("service=%s rollback=complete\n", windowsServiceName)
	return nil
}

func uninstallWindowsService() (returnErr error) {
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to Service Control Manager (administrator required): %w", err)
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(windowsServiceName)
	if err != nil {
		return fmt.Errorf("service %s is not installed: %w", windowsServiceName, err)
	}
	defer service.Close()
	status, queryErr := service.Query()
	if queryErr == nil && status.State != svc.Stopped {
		_, stopErr := service.Control(svc.Stop)
		if stopErr != nil && !errors.Is(stopErr, windows.ERROR_SERVICE_NOT_ACTIVE) {
			return stopErr
		}
		if err := waitWindowsServiceState(service, svc.Stopped, 20*time.Second); err != nil {
			return err
		}
	}
	if err := service.Delete(); err != nil {
		return err
	}
	if err := eventlog.Remove(windowsServiceName); err != nil {
		returnErr = errors.Join(returnErr, fmt.Errorf("remove Windows Event Log source: %w", err))
	}
	destination, pathErr := windowsServiceExecutablePath()
	if pathErr == nil {
		if removeErr := os.Remove(destination); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			returnErr = errors.Join(returnErr, fmt.Errorf("service deleted but remove service binary: %w", removeErr))
		}
		if removeErr := os.Remove(destination + ".rollback"); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			returnErr = errors.Join(returnErr, fmt.Errorf("service deleted but remove rollback binary: %w", removeErr))
		}
		_ = os.Remove(filepath.Dir(destination))
	}
	return returnErr
}

func controlWindowsService(start bool) error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(windowsServiceName)
	if err != nil {
		return err
	}
	defer service.Close()
	if start {
		status, err := service.Query()
		if err == nil && status.State == svc.Running {
			return nil
		}
		if err := service.Start(); err != nil {
			return err
		}
		return waitWindowsServiceState(service, svc.Running, 15*time.Second)
	}
	status, err := service.Query()
	if err == nil && status.State == svc.Stopped {
		return nil
	}
	if _, err := service.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
		return err
	}
	return waitWindowsServiceState(service, svc.Stopped, 20*time.Second)
}

func statusWindowsService() error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(windowsServiceName)
	if err != nil {
		return err
	}
	defer service.Close()
	status, err := service.Query()
	if err != nil {
		return err
	}
	fmt.Printf("service=%s state=%d pid=%d\n", windowsServiceName, status.State, status.ProcessId)
	return nil
}

func waitWindowsServiceState(service *mgr.Service, wanted svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		status, err := service.Query()
		if err != nil {
			return err
		}
		if status.State == wanted {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("service state is %d, want %d", status.State, wanted)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

type windowsService struct {
	listener net.Listener
	stop     chan struct{}
	stopOnce sync.Once
	ctx      context.Context
	cancel   context.CancelFunc
	startWG  sync.WaitGroup

	mu           sync.Mutex
	shuttingDown bool
	vms          map[string]*windowsServiceVM
	starting     map[string]string
	journal      *hcsGrantJournal
	network      *hcnManager
}

type windowsServiceVM struct {
	ownerSID     string
	ownerPID     uint32
	ownerProcess windows.Handle
	instance     *windowsInstance
}

func newWindowsService() *windowsService {
	ctx, cancel := context.WithCancel(context.Background())
	return &windowsService{
		stop: make(chan struct{}), ctx: ctx, cancel: cancel, vms: make(map[string]*windowsServiceVM),
		starting: make(map[string]string), network: newHCNManager(),
	}
}

func (service *windowsService) Execute(_ []string, requests <-chan svc.ChangeRequest, statuses chan<- svc.Status) (bool, uint32) {
	statuses <- svc.Status{State: svc.StartPending}
	logger, _ := eventlog.Open(windowsServiceName)
	if logger != nil {
		defer logger.Close()
	}
	journal, err := openHCSGrantJournal()
	if err != nil {
		if logger != nil {
			_ = logger.Error(1, "open HCS grant recovery journal: "+err.Error())
		}
		return true, 2
	}
	if err := journal.Recover(); err != nil {
		if logger != nil {
			_ = logger.Error(2, "recover stale HCS grants: "+err.Error())
		}
		return true, 3
	}
	service.journal = journal
	listener, err := winio.ListenPipe(windowsServicePipe, &winio.PipeConfig{
		SecurityDescriptor: windowsServicePipeSDDL,
		InputBufferSize:    64 * 1024, OutputBufferSize: 64 * 1024,
	})
	if err != nil {
		if logger != nil {
			_ = logger.Error(3, "listen on zapVM service pipe: "+err.Error())
		}
		return true, 1
	}
	service.listener = listener
	go service.serve()
	accepted := svc.AcceptStop | svc.AcceptShutdown
	statuses <- svc.Status{State: svc.Running, Accepts: accepted}
	if logger != nil {
		_ = logger.Info(1, "zapVM service started")
	}
	for request := range requests {
		switch request.Cmd {
		case svc.Interrogate:
			statuses <- request.CurrentStatus
		case svc.Stop, svc.Shutdown:
			statuses <- svc.Status{State: svc.StopPending}
			if err := service.shutdown(); err != nil && logger != nil {
				_ = logger.Error(4, "zapVM service shutdown cleanup: "+err.Error())
			}
			if logger != nil {
				_ = logger.Info(2, "zapVM service stopped")
			}
			return false, 0
		}
	}
	if err := service.shutdown(); err != nil && logger != nil {
		_ = logger.Error(4, "zapVM service shutdown cleanup: "+err.Error())
	}
	return false, 0
}

func (service *windowsService) serve() {
	for {
		connection, err := service.listener.Accept()
		if err != nil {
			select {
			case <-service.stop:
				return
			default:
				continue
			}
		}
		go service.handleConnection(connection)
	}
}

func (service *windowsService) handleConnection(connection net.Conn) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(30 * time.Second))
	var request windowsServiceRequest
	if err := readWindowsServiceFrame(connection, &request); err != nil {
		_ = writeWindowsServiceFrame(connection, windowsServiceFailure(err))
		return
	}
	if err := request.validate(); err != nil {
		_ = writeWindowsServiceFrame(connection, windowsServiceFailure(err))
		return
	}
	owner, lockedSpec, release, err := authorizeWindowsServiceRequest(connection, request)
	if err != nil {
		_ = writeWindowsServiceFrame(connection, windowsServiceFailure(err))
		return
	}
	defer release()
	if lockedSpec != nil {
		request.Spec = lockedSpec
	}
	response := service.dispatch(owner, request)
	_ = writeWindowsServiceFrame(connection, response)
}

type windowsServiceCaller struct {
	SID          string
	PID          uint32
	Process      windows.Handle
	releasePaths func()
}

func authorizeWindowsServiceRequest(connection net.Conn, request windowsServiceRequest) (windowsServiceCaller, *Spec, func(), error) {
	handleProvider, ok := connection.(interface{ Fd() uintptr })
	if !ok {
		return windowsServiceCaller{}, nil, func() {}, errors.New("named-pipe connection does not expose a Windows handle")
	}
	pipe := windows.Handle(handleProvider.Fd())
	var clientPID uint32
	if err := windows.GetNamedPipeClientProcessId(pipe, &clientPID); err != nil || clientPID == 0 {
		return windowsServiceCaller{}, nil, func() {}, errors.New("reject non-local or unidentified named-pipe client")
	}
	clientProcess, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, clientPID)
	if err != nil {
		return windowsServiceCaller{}, nil, func() {}, fmt.Errorf("open named-pipe client process %d: %w", clientPID, err)
	}
	keepClientProcess := false
	defer func() {
		if !keepClientProcess {
			windows.CloseHandle(clientProcess)
		}
	}()
	var processToken windows.Token
	if err := windows.OpenProcessToken(clientProcess, windows.TOKEN_QUERY, &processToken); err != nil {
		return windowsServiceCaller{}, nil, func() {}, fmt.Errorf("open named-pipe client process token: %w", err)
	}
	processUser, err := processToken.GetTokenUser()
	processToken.Close()
	if err != nil {
		return windowsServiceCaller{}, nil, func() {}, fmt.Errorf("read named-pipe client process token: %w", err)
	}
	processSID := processUser.User.Sid.String()
	runtime.LockOSThread()
	unlockThread := true
	defer func() {
		if unlockThread {
			runtime.UnlockOSThread()
		}
	}()
	result, _, callErr := procImpersonateNamedPipeClient.Call(uintptr(pipe))
	if result == 0 {
		return windowsServiceCaller{}, nil, func() {}, fmt.Errorf("impersonate named-pipe client: %w", callErr)
	}
	var token windows.Token
	if err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY, false, &token); err != nil {
		if revertErr := windows.RevertToSelf(); revertErr != nil {
			unlockThread = false
			return windowsServiceCaller{}, nil, func() {}, errors.Join(err, fmt.Errorf("revert named-pipe impersonation: %w", revertErr))
		}
		return windowsServiceCaller{}, nil, func() {}, err
	}
	user, err := token.GetTokenUser()
	token.Close()
	if err != nil {
		if revertErr := windows.RevertToSelf(); revertErr != nil {
			unlockThread = false
			return windowsServiceCaller{}, nil, func() {}, errors.Join(err, fmt.Errorf("revert named-pipe impersonation: %w", revertErr))
		}
		return windowsServiceCaller{}, nil, func() {}, err
	}
	caller := windowsServiceCaller{SID: user.User.Sid.String(), PID: clientPID, Process: clientProcess}
	if !strings.EqualFold(caller.SID, processSID) {
		if revertErr := windows.RevertToSelf(); revertErr != nil {
			unlockThread = false
			return windowsServiceCaller{}, nil, func() {}, fmt.Errorf("pipe/process SID mismatch and revert impersonation failed: %w", revertErr)
		}
		return windowsServiceCaller{}, nil, func() {}, errors.New("named-pipe impersonation SID does not match the fixed client process")
	}
	var lockedSpec *Spec
	var handles []windows.Handle
	if request.Operation == windowsServiceOpStart {
		copy := *request.Spec
		lockedSpec, handles, err = lockWindowsClientPaths(copy)
	}
	if revertErr := windows.RevertToSelf(); revertErr != nil {
		// Do not return this OS thread to the Go scheduler while it might retain
		// a client token. The handler goroutine exits immediately after reporting
		// the error, which causes the runtime to tear down the locked thread.
		unlockThread = false
		for _, handle := range handles {
			windows.CloseHandle(handle)
		}
		return windowsServiceCaller{}, nil, func() {}, fmt.Errorf("revert named-pipe impersonation: %w", revertErr)
	}
	if err != nil {
		for _, handle := range handles {
			windows.CloseHandle(handle)
		}
		return windowsServiceCaller{}, nil, func() {}, err
	}
	var releasePathsOnce sync.Once
	releasePaths := func() {
		releasePathsOnce.Do(func() {
			for _, handle := range handles {
				windows.CloseHandle(handle)
			}
		})
	}
	caller.releasePaths = releasePaths
	release := func() {
		releasePaths()
		windows.CloseHandle(clientProcess)
	}
	keepClientProcess = true
	return caller, lockedSpec, release, nil
}

type windowsPathRequirement struct {
	name      string
	path      *string
	directory bool
	write     bool
}

func lockWindowsClientPaths(spec Spec) (*Spec, []windows.Handle, error) {
	spec.SetDefaults()
	if err := spec.Validate(); err != nil {
		return nil, nil, err
	}
	if spec.InitrdPath == "" {
		return nil, nil, errors.New("Windows HCS direct-kernel boot requires an initrd")
	}
	for name, path := range map[string]string{"root disk": spec.RootDiskPath, "state disk": spec.StateDiskPath, "Agent disk": spec.AgentDiskPath} {
		if path == "" {
			continue
		}
		extension := strings.ToLower(filepath.Ext(path))
		if extension != ".vhd" && extension != ".vhdx" {
			return nil, nil, fmt.Errorf("%s must be VHD or VHDX for HCS", name)
		}
	}
	requirements := []windowsPathRequirement{
		{name: "kernel", path: &spec.KernelPath},
		{name: "initrd", path: &spec.InitrdPath},
		{name: "root disk", path: &spec.RootDiskPath},
		{name: "state disk", path: &spec.StateDiskPath, write: true},
		{name: "Agent disk", path: &spec.AgentDiskPath},
		{name: "boot share", path: &spec.BootSharePath, directory: true},
		{name: "workspace", path: &spec.WorkspacePath, directory: true, write: !spec.WorkspaceReadOnly},
	}
	handles := make([]windows.Handle, 0, len(requirements))
	cleanup := func() {
		for _, handle := range handles {
			windows.CloseHandle(handle)
		}
	}
	for _, requirement := range requirements {
		if *requirement.path == "" {
			continue
		}
		canonical, handle, err := openAndCanonicalizeWindowsClientPath(*requirement.path, requirement.directory, requirement.write)
		if err != nil {
			cleanup()
			return nil, nil, fmt.Errorf("authorize %s: %w", requirement.name, err)
		}
		*requirement.path = canonical
		handles = append(handles, handle)
	}
	return &spec, handles, nil
}

func openAndCanonicalizeWindowsClientPath(path string, directory, write bool) (string, windows.Handle, error) {
	if !filepath.IsAbs(path) || strings.HasPrefix(path, `\\`) {
		return "", 0, errors.New("path must be an absolute local-volume path")
	}
	pointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", 0, err
	}
	access := uint32(windows.FILE_GENERIC_READ)
	if write {
		access |= windows.FILE_GENERIC_WRITE
	}
	flags := uint32(windows.FILE_ATTRIBUTE_NORMAL)
	if directory {
		flags |= windows.FILE_FLAG_BACKUP_SEMANTICS
	}
	handle, err := windows.CreateFile(pointer, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, flags, 0)
	if err != nil {
		return "", 0, err
	}
	var information windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &information); err != nil {
		windows.CloseHandle(handle)
		return "", 0, err
	}
	isDirectory := information.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0
	if isDirectory != directory {
		windows.CloseHandle(handle)
		if directory {
			return "", 0, errors.New("path is not a directory")
		}
		return "", 0, errors.New("path is not a regular file")
	}
	buffer := make([]uint16, 32768)
	length, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
	if err != nil || length == 0 || length >= uint32(len(buffer)) {
		windows.CloseHandle(handle)
		if err == nil {
			err = errors.New("canonical path exceeds Windows maximum")
		}
		return "", 0, err
	}
	canonical := windows.UTF16ToString(buffer[:length])
	canonical = strings.TrimPrefix(canonical, `\\?\`)
	if strings.HasPrefix(strings.ToUpper(canonical), `UNC\`) || strings.HasPrefix(canonical, `\\`) || !filepath.IsAbs(canonical) {
		windows.CloseHandle(handle)
		return "", 0, errors.New("canonical path is not on a local volume")
	}
	return canonical, handle, nil
}

func windowsServiceFailure(err error) windowsServiceResponse {
	return windowsServiceResponse{Version: windowsServiceProtocolVersion, OK: false, Error: err.Error()}
}

func (service *windowsService) dispatch(caller windowsServiceCaller, request windowsServiceRequest) windowsServiceResponse {
	switch request.Operation {
	case windowsServiceOpPing:
		return windowsServiceResponse{Version: windowsServiceProtocolVersion, OK: true}
	case windowsServiceOpStart:
		return service.start(caller, *request.Spec)
	case windowsServiceOpStop:
		return service.stopVM(caller, request.VMID)
	case windowsServiceOpPause:
		return service.pauseVM(caller, request.VMID)
	case windowsServiceOpResume:
		return service.resumeVM(caller, request.VMID)
	case windowsServiceOpQuery:
		return service.query(caller, request.VMID)
	default:
		return windowsServiceFailure(errors.New("invalid operation after validation"))
	}
}

func (service *windowsService) start(caller windowsServiceCaller, spec Spec) windowsServiceResponse {
	if spec.CPUCount > 64 {
		return windowsServiceFailure(errors.New("Windows service limits each VM to 64 vCPUs"))
	}
	if spec.MemoryBytes > 128*1024*MiB {
		return windowsServiceFailure(errors.New("Windows service limits each VM to 128 GiB"))
	}
	vmID := deterministicVMID(spec.ID)
	service.mu.Lock()
	if service.shuttingDown {
		service.mu.Unlock()
		return windowsServiceFailure(errors.New("Windows service is shutting down"))
	}
	if service.starting[vmID] != "" {
		service.mu.Unlock()
		return windowsServiceFailure(fmt.Errorf("VM %s is already starting", spec.ID))
	}
	if existing := service.vms[vmID]; existing != nil && existing.instance.State() != StateStopped && existing.instance.State() != StateFailed {
		service.mu.Unlock()
		return windowsServiceFailure(fmt.Errorf("VM %s is already owned by an active client", spec.ID))
	}
	active, owned := len(service.starting), 0
	for _, owner := range service.starting {
		if strings.EqualFold(owner, caller.SID) {
			owned++
		}
	}
	for _, entry := range service.vms {
		state := entry.instance.State()
		if state != StateStopped && state != StateFailed {
			active++
			if strings.EqualFold(entry.ownerSID, caller.SID) {
				owned++
			}
		}
	}
	if active >= 4 || owned >= 2 {
		service.mu.Unlock()
		return windowsServiceFailure(errors.New("Windows service VM concurrency limit reached (4 system-wide, 2 per user)"))
	}
	service.starting[vmID] = caller.SID
	service.startWG.Add(1)
	service.mu.Unlock()
	defer func() {
		service.mu.Lock()
		delete(service.starting, vmID)
		service.mu.Unlock()
		service.startWG.Done()
	}()
	var process windows.Handle
	if err := windows.DuplicateHandle(windows.CurrentProcess(), caller.Process, windows.CurrentProcess(), &process, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return windowsServiceFailure(fmt.Errorf("duplicate fixed client process %d: %w", caller.PID, err))
	}
	startCtx, startCancel := context.WithTimeout(service.ctx, 30*time.Second)
	instance, err := startWindowsHCS(startCtx, spec, service.journal, service.network, caller.releasePaths)
	startCancel()
	if err != nil {
		windows.CloseHandle(process)
		return windowsServiceFailure(err)
	}
	entry := &windowsServiceVM{ownerSID: caller.SID, ownerPID: caller.PID, ownerProcess: process, instance: instance}
	service.mu.Lock()
	service.vms[vmID] = entry
	service.mu.Unlock()
	go service.watchOwner(vmID, entry)
	return windowsServiceResponse{Version: windowsServiceProtocolVersion, OK: true, VMID: vmID, ID: spec.ID, State: StateRunning}
}

func (service *windowsService) ownedVM(caller windowsServiceCaller, vmID string) (*windowsServiceVM, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	entry := service.vms[vmID]
	if entry == nil {
		return nil, errors.New("VM is not managed by the zapVM service")
	}
	if !strings.EqualFold(entry.ownerSID, caller.SID) {
		return nil, errors.New("VM is owned by another Windows user")
	}
	return entry, nil
}

func (service *windowsService) stopVM(caller windowsServiceCaller, vmID string) windowsServiceResponse {
	entry, err := service.ownedVM(caller, vmID)
	if err != nil {
		return windowsServiceFailure(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	err = entry.instance.Stop(ctx)
	cancel()
	if err != nil {
		return windowsServiceFailure(err)
	}
	return windowsServiceResponse{Version: windowsServiceProtocolVersion, OK: true, VMID: vmID, ID: entry.instance.ID(), State: entry.instance.State()}
}

func (service *windowsService) pauseVM(caller windowsServiceCaller, vmID string) windowsServiceResponse {
	entry, err := service.ownedVM(caller, vmID)
	if err != nil {
		return windowsServiceFailure(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	err = entry.instance.Pause(ctx)
	cancel()
	if err != nil {
		return windowsServiceFailure(err)
	}
	return windowsServiceResponse{Version: windowsServiceProtocolVersion, OK: true, VMID: vmID, ID: entry.instance.ID(), State: entry.instance.State()}
}

func (service *windowsService) resumeVM(caller windowsServiceCaller, vmID string) windowsServiceResponse {
	entry, err := service.ownedVM(caller, vmID)
	if err != nil {
		return windowsServiceFailure(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	err = entry.instance.Resume(ctx)
	cancel()
	if err != nil {
		return windowsServiceFailure(err)
	}
	return windowsServiceResponse{Version: windowsServiceProtocolVersion, OK: true, VMID: vmID, ID: entry.instance.ID(), State: entry.instance.State()}
}

func (service *windowsService) query(caller windowsServiceCaller, vmID string) windowsServiceResponse {
	entry, err := service.ownedVM(caller, vmID)
	if err != nil {
		return windowsServiceFailure(err)
	}
	return windowsServiceResponse{Version: windowsServiceProtocolVersion, OK: true, VMID: vmID, ID: entry.instance.ID(), State: entry.instance.State()}
}

func (service *windowsService) watchOwner(vmID string, entry *windowsServiceVM) {
	ownerExited := false
	for {
		result, err := windows.WaitForSingleObject(entry.ownerProcess, 250)
		if err != nil || result == uint32(windows.WAIT_OBJECT_0) {
			ownerExited = true
			break
		}
		state := entry.instance.State()
		if state == StateStopped || state == StateFailed {
			break
		}
	}
	windows.CloseHandle(entry.ownerProcess)
	service.mu.Lock()
	current := service.vms[vmID]
	service.mu.Unlock()
	if current != entry {
		return
	}
	if ownerExited {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_ = entry.instance.Stop(ctx)
		cancel()
	}
	service.mu.Lock()
	if service.vms[vmID] == entry {
		delete(service.vms, vmID)
	}
	service.mu.Unlock()
}

func (service *windowsService) shutdown() error {
	var shutdownErr error
	service.stopOnce.Do(func() {
		service.mu.Lock()
		service.shuttingDown = true
		service.mu.Unlock()
		service.cancel()
		close(service.stop)
		if service.listener != nil {
			shutdownErr = errors.Join(shutdownErr, service.listener.Close())
		}
		service.startWG.Wait()
		service.mu.Lock()
		entries := make([]*windowsServiceVM, 0, len(service.vms))
		for _, entry := range service.vms {
			entries = append(entries, entry)
		}
		service.mu.Unlock()
		for _, entry := range entries {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			shutdownErr = errors.Join(shutdownErr, entry.instance.Stop(ctx))
			cancel()
		}
		if service.network != nil {
			shutdownErr = errors.Join(shutdownErr, service.network.Close())
		}
	})
	return shutdownErr
}

func callWindowsService(ctx context.Context, request windowsServiceRequest) (windowsServiceResponse, error) {
	// go-winio's DialPipeContext intentionally opens the pipe with the
	// anonymous impersonation level. The service must impersonate its client
	// to compare the pipe token with the already-fixed client process token and
	// to open start-request paths under that identity, so anonymous is both
	// unusable and fail-closed. Request only local impersonation; delegation is
	// unnecessary and would grant a broader token capability than this protocol
	// needs.
	connection, err := winio.DialPipeAccessImpLevel(
		ctx,
		windowsServicePipe,
		uint32(windows.GENERIC_READ|windows.GENERIC_WRITE),
		winio.PipeImpLevelImpersonation,
	)
	if err != nil {
		return windowsServiceResponse{}, fmt.Errorf("connect zapVM Windows service (run `zapvm service install` as administrator): %w", err)
	}
	defer connection.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	if err := writeWindowsServiceFrame(connection, request); err != nil {
		return windowsServiceResponse{}, err
	}
	var response windowsServiceResponse
	if err := readWindowsServiceFrame(connection, &response); err != nil {
		return windowsServiceResponse{}, err
	}
	if err := response.validateFor(request); err != nil {
		return windowsServiceResponse{}, err
	}
	return response, nil
}
