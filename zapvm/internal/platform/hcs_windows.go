//go:build windows

package platform

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"

	winio "github.com/Microsoft/go-winio"
	"github.com/Microsoft/go-winio/pkg/guid"
	"golang.org/x/sys/windows"
)

const (
	hcsOperationTimeout = uint32(0x80370118)
	hcsPollInterval     = 250 * time.Millisecond
)

var (
	computeCoreDLL                    = windows.NewLazySystemDLL("computecore.dll")
	procHcsCreateOperation            = computeCoreDLL.NewProc("HcsCreateOperation")
	procHcsCloseOperation             = computeCoreDLL.NewProc("HcsCloseOperation")
	procHcsWaitForOperationResult     = computeCoreDLL.NewProc("HcsWaitForOperationResult")
	procHcsCreateComputeSystem        = computeCoreDLL.NewProc("HcsCreateComputeSystem")
	procHcsCloseComputeSystem         = computeCoreDLL.NewProc("HcsCloseComputeSystem")
	procHcsStartComputeSystem         = computeCoreDLL.NewProc("HcsStartComputeSystem")
	procHcsPauseComputeSystem         = computeCoreDLL.NewProc("HcsPauseComputeSystem")
	procHcsResumeComputeSystem        = computeCoreDLL.NewProc("HcsResumeComputeSystem")
	procHcsTerminateComputeSystem     = computeCoreDLL.NewProc("HcsTerminateComputeSystem")
	procHcsGetComputeSystemProperties = computeCoreDLL.NewProc("HcsGetComputeSystemProperties")
	procHcsGrantVMAccess              = computeCoreDLL.NewProc("HcsGrantVmAccess")
	procHcsRevokeVMAccess             = computeCoreDLL.NewProc("HcsRevokeVmAccess")
)

func loadHCS() error {
	if err := computeCoreDLL.Load(); err != nil {
		return err
	}
	for _, procedure := range []*windows.LazyProc{
		procHcsCreateOperation, procHcsCloseOperation, procHcsWaitForOperationResult,
		procHcsCreateComputeSystem, procHcsCloseComputeSystem, procHcsStartComputeSystem,
		procHcsPauseComputeSystem, procHcsResumeComputeSystem, procHcsTerminateComputeSystem,
		procHcsGetComputeSystemProperties,
		procHcsGrantVMAccess, procHcsRevokeVMAccess,
	} {
		if err := procedure.Find(); err != nil {
			return err
		}
	}
	return nil
}

type hcsError struct {
	operation string
	code      uint32
	result    string
}

func (e *hcsError) Error() string {
	if e.result == "" {
		return fmt.Sprintf("HCS %s failed with HRESULT 0x%08x", e.operation, e.code)
	}
	return fmt.Sprintf("HCS %s failed with HRESULT 0x%08x: %s", e.operation, e.code, e.result)
}

func runHCSOperation(ctx context.Context, name string, invoke func(operation uintptr) uintptr) (string, error) {
	operation, _, _ := procHcsCreateOperation.Call(0, 0)
	if operation == 0 {
		return "", errors.New("HCS could not allocate an operation")
	}
	defer procHcsCloseOperation.Call(operation)
	if code := uint32(invoke(operation)); code != 0 {
		return "", &hcsError{operation: name, code: code}
	}
	for {
		var resultPointer *uint16
		result, _, _ := procHcsWaitForOperationResult.Call(
			operation, uintptr(hcsPollInterval/time.Millisecond), uintptr(unsafe.Pointer(&resultPointer)),
		)
		resultDocument := takeLocalString(resultPointer)
		code := uint32(result)
		if code == 0 {
			return resultDocument, nil
		}
		if code != hcsOperationTimeout {
			return "", &hcsError{operation: name, code: code, result: resultDocument}
		}
		select {
		case <-ctx.Done():
			// HcsCancelOperation is documented as E_NOTIMPL. Closing this tracking
			// handle and then the compute-system handle is the available cleanup.
			return "", ctx.Err()
		default:
		}
	}
}

func takeLocalString(pointer *uint16) string {
	if pointer == nil {
		return ""
	}
	result := windows.UTF16PtrToString(pointer)
	_, _ = windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(pointer))))
	return result
}

func hcsCreateSystem(ctx context.Context, id, configuration string) (windows.Handle, error) {
	idUTF16, err := windows.UTF16PtrFromString(id)
	if err != nil {
		return 0, err
	}
	configUTF16, err := windows.UTF16PtrFromString(configuration)
	if err != nil {
		return 0, err
	}
	var system windows.Handle
	_, err = runHCSOperation(ctx, "create", func(operation uintptr) uintptr {
		result, _, _ := procHcsCreateComputeSystem.Call(
			uintptr(unsafe.Pointer(idUTF16)), uintptr(unsafe.Pointer(configUTF16)), operation, 0,
			uintptr(unsafe.Pointer(&system)),
		)
		return result
	})
	if err != nil {
		if system != 0 {
			procHcsCloseComputeSystem.Call(uintptr(system))
		}
		return 0, err
	}
	return system, nil
}

func hcsStartSystem(ctx context.Context, system windows.Handle) error {
	_, err := runHCSOperation(ctx, "start", func(operation uintptr) uintptr {
		result, _, _ := procHcsStartComputeSystem.Call(uintptr(system), operation, 0)
		return result
	})
	return err
}

func hcsTerminateSystem(ctx context.Context, system windows.Handle) error {
	_, err := runHCSOperation(ctx, "terminate", func(operation uintptr) uintptr {
		result, _, _ := procHcsTerminateComputeSystem.Call(uintptr(system), operation, 0)
		return result
	})
	return err
}

func hcsPauseSystem(ctx context.Context, system windows.Handle) error {
	_, err := runHCSOperation(ctx, "pause", func(operation uintptr) uintptr {
		result, _, _ := procHcsPauseComputeSystem.Call(uintptr(system), operation, 0)
		return result
	})
	return err
}

func hcsResumeSystem(ctx context.Context, system windows.Handle) error {
	_, err := runHCSOperation(ctx, "resume", func(operation uintptr) uintptr {
		result, _, _ := procHcsResumeComputeSystem.Call(uintptr(system), operation, 0)
		return result
	})
	return err
}

func hcsSystemProperties(ctx context.Context, system windows.Handle) (string, error) {
	query, err := windows.UTF16PtrFromString(`{}`)
	if err != nil {
		return "", err
	}
	return runHCSOperation(ctx, "get properties", func(operation uintptr) uintptr {
		result, _, _ := procHcsGetComputeSystemProperties.Call(uintptr(system), operation, uintptr(unsafe.Pointer(query)))
		return result
	})
}

func hcsGrantVMAccess(vmID, path string) error {
	return hcsChangeVMAccess(procHcsGrantVMAccess, "grant VM access", vmID, path)
}

func hcsRevokeVMAccess(vmID, path string) error {
	return hcsChangeVMAccess(procHcsRevokeVMAccess, "revoke VM access", vmID, path)
}

func hcsChangeVMAccess(procedure *windows.LazyProc, operation, vmID, path string) error {
	idUTF16, err := windows.UTF16PtrFromString(vmID)
	if err != nil {
		return err
	}
	pathUTF16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	result, _, _ := procedure.Call(uintptr(unsafe.Pointer(idUTF16)), uintptr(unsafe.Pointer(pathUTF16)))
	if code := uint32(result); code != 0 {
		return &hcsError{operation: operation, code: code, result: path}
	}
	return nil
}

func startWindowsHCS(ctx context.Context, spec Spec, journal *hcsGrantJournal, networkManager *hcnManager, beforeStart func()) (*windowsInstance, error) {
	if err := loadHCS(); err != nil {
		return nil, err
	}
	vmID := deterministicVMID(spec.ID)
	networkCleanup := func() error { return nil }
	var attachment *hcsNetworkAttachment
	if spec.Network == NetworkUnrestricted {
		if networkManager == nil {
			return nil, errors.New("HCN manager is required for unrestricted Windows networking")
		}
		var err error
		attachment, networkCleanup, err = networkManager.CreateEndpoint(vmID, spec.ID)
		if err != nil {
			return nil, err
		}
	}
	var console *hcsConsoleCapture
	if spec.Console {
		var err error
		console, err = newHCSConsoleCapture(vmID)
		if err != nil {
			return nil, errors.Join(err, networkCleanup())
		}
	}
	consoleCleanup := func() error {
		if console == nil {
			return nil
		}
		return console.Close()
	}
	consolePipe := ""
	if console != nil {
		consolePipe = console.pipePath
	}
	_, configuration, err := buildHCSConfigWithDevices(spec, attachment, consolePipe)
	if err != nil {
		return nil, errors.Join(err, consoleCleanup(), networkCleanup())
	}
	grantCandidates := []string{
		spec.KernelPath, spec.InitrdPath, spec.RootDiskPath, spec.StateDiskPath, spec.AgentDiskPath,
		spec.BootSharePath, spec.WorkspacePath,
	}
	grants := make([]string, 0, len(grantCandidates))
	seen := make(map[string]struct{}, len(grantCandidates))
	for _, path := range grantCandidates {
		if path == "" {
			continue
		}
		key := strings.ToLower(filepath.Clean(path))
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		grants = append(grants, path)
	}
	if journal == nil {
		return nil, errors.Join(errors.New("HCS grant journal is required"), consoleCleanup(), networkCleanup())
	}
	granted := make([]string, 0, len(grants))
	cleanupGrants := func() error {
		var cleanupErr error
		for index := len(granted) - 1; index >= 0; index-- {
			cleanupErr = errors.Join(cleanupErr, journal.RevokeGrant(vmID, granted[index]))
		}
		if cleanupErr == nil {
			cleanupErr = journal.Complete(vmID)
		}
		return cleanupErr
	}
	if err := journal.Prepare(vmID); err != nil {
		return nil, errors.Join(err, consoleCleanup(), networkCleanup())
	}
	if err := windowsServiceFaultPoint("after-journal-prepare", -1); err != nil {
		return nil, errors.Join(err, cleanupGrants(), consoleCleanup(), networkCleanup())
	}
	for index, path := range grants {
		if err := journal.BeginGrant(vmID, path); err != nil {
			cleanupErr := cleanupGrants()
			return nil, errors.Join(fmt.Errorf("prepare HCS VM access grant for %s: %w", path, err), cleanupErr, consoleCleanup(), networkCleanup())
		}
		if err := windowsServiceFaultPoint("after-grant-intent", index); err != nil {
			cleanupErr := cleanupGrants()
			return nil, errors.Join(err, cleanupErr, consoleCleanup(), networkCleanup())
		}
		if err := hcsGrantVMAccess(vmID, path); err != nil {
			cleanupErr := cleanupGrants()
			return nil, errors.Join(fmt.Errorf("grant HCS VM access to %s: %w", path, err), cleanupErr, consoleCleanup(), networkCleanup())
		}
		granted = append(granted, path)
		if err := windowsServiceFaultPoint("after-grant-call", index); err != nil {
			cleanupErr := cleanupGrants()
			return nil, errors.Join(err, cleanupErr, consoleCleanup(), networkCleanup())
		}
		if err := journal.CommitGrant(vmID, path); err != nil {
			cleanupErr := cleanupGrants()
			return nil, errors.Join(fmt.Errorf("commit HCS VM access grant for %s: %w", path, err), cleanupErr, consoleCleanup(), networkCleanup())
		}
		if err := windowsServiceFaultPoint("after-grant", index); err != nil {
			cleanupErr := cleanupGrants()
			return nil, errors.Join(err, cleanupErr, consoleCleanup(), networkCleanup())
		}
	}
	system, err := hcsCreateSystem(ctx, vmID, configuration)
	if err != nil {
		return nil, errors.Join(err, cleanupGrants(), consoleCleanup(), networkCleanup())
	}
	cleanupSystem := func() error {
		terminateCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		terminateErr := hcsTerminateSystem(terminateCtx, system)
		procHcsCloseComputeSystem.Call(uintptr(system))
		return errors.Join(terminateErr, cleanupGrants(), consoleCleanup(), networkCleanup())
	}
	if err := windowsServiceFaultPoint("after-hcs-create", -1); err != nil {
		return nil, errors.Join(err, cleanupSystem())
	}
	// HCS validates and captures the configuration during Create, but opens
	// VHD(X) attachments exclusively during Start. Keep caller-authorized paths
	// pinned through Create, then release them at the narrow required boundary.
	if beforeStart != nil {
		beforeStart()
	}
	if err := hcsStartSystem(ctx, system); err != nil {
		return nil, errors.Join(err, cleanupSystem())
	}
	if err := windowsServiceFaultPoint("after-hcs-start", -1); err != nil {
		return nil, errors.Join(err, cleanupSystem())
	}
	instance := &windowsInstance{
		id: spec.ID, vmID: vmID, system: system, grants: granted, journal: journal,
		networkCleanup: networkCleanup, console: console,
		stopped: make(chan struct{}), lifecycle: newLifecycleState(StateRunning),
		agentTransport: newWindowsAgentTransport(vmID),
	}
	go instance.watch()
	return instance, nil
}

type windowsInstance struct {
	id             string
	vmID           string
	system         windows.Handle
	grants         []string
	journal        *hcsGrantJournal
	networkCleanup func() error
	console        *hcsConsoleCapture
	stopped        chan struct{}
	stopOnce       sync.Once
	opMu           sync.Mutex
	lifecycle      *lifecycleState
	agentTransport *windowsAgentTransport

	mu  sync.RWMutex
	err error
}

func (i *windowsInstance) ID() string { return i.id }

func (i *windowsInstance) State() State {
	return i.lifecycle.State()
}

func (i *windowsInstance) Wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-i.stopped:
		i.mu.RLock()
		defer i.mu.RUnlock()
		return i.err
	}
}

func (i *windowsInstance) DialAgent(ctx context.Context, port uint32) (io.ReadWriteCloser, error) {
	return i.agentTransport.Accept(ctx, port)
}

func (i *windowsInstance) ListenHost(port uint32) (net.Listener, error) {
	vmID, err := guid.FromString(i.vmID)
	if err != nil {
		return nil, err
	}
	return winio.ListenHvsock(&winio.HvsockAddr{VMID: vmID, ServiceID: winio.VsockServiceID(port)})
}

func (i *windowsInstance) Pause(ctx context.Context) (returnErr error) {
	i.opMu.Lock()
	defer i.opMu.Unlock()
	state := i.State()
	if state == StatePaused {
		return nil
	}
	if _, state, accepted := i.lifecycle.Apply(lifecyclePauseRequested); !accepted || state != StatePausing {
		return fmt.Errorf("cannot pause Windows HCS VM from state %s", state)
	}
	defer func() {
		if returnErr != nil {
			i.lifecycle.Apply(lifecyclePauseRejected)
		}
	}()
	if err := hcsPauseSystem(ctx, i.system); err != nil {
		return err
	}
	if _, state, accepted := i.lifecycle.Apply(lifecyclePaused); !accepted || state != StatePaused {
		return fmt.Errorf("Windows HCS pause completed after lifecycle reached %s", state)
	}
	return nil
}

func (i *windowsInstance) Resume(ctx context.Context) (returnErr error) {
	i.opMu.Lock()
	defer i.opMu.Unlock()
	state := i.State()
	if state == StateRunning {
		return nil
	}
	if _, state, accepted := i.lifecycle.Apply(lifecycleResumeRequested); !accepted || state != StateResuming {
		return fmt.Errorf("cannot resume Windows HCS VM from state %s", state)
	}
	defer func() {
		if returnErr != nil {
			i.lifecycle.Apply(lifecycleResumeRejected)
		}
	}()
	if err := hcsResumeSystem(ctx, i.system); err != nil {
		return err
	}
	if _, state, accepted := i.lifecycle.Apply(lifecycleReady); !accepted || state != StateRunning {
		return fmt.Errorf("Windows HCS resume completed after lifecycle reached %s", state)
	}
	return nil
}

func (i *windowsInstance) Stop(ctx context.Context) (returnErr error) {
	i.opMu.Lock()
	defer i.opMu.Unlock()
	state := i.State()
	if state == StateStopped || state == StateFailed {
		return nil
	}
	if _, state, accepted := i.lifecycle.Apply(lifecycleStopRequested); !accepted || state != StateStopping {
		return fmt.Errorf("cannot request Windows HCS VM stop from state %s", state)
	}
	defer func() {
		if returnErr != nil {
			i.lifecycle.Apply(lifecycleStopRejected)
		}
	}()
	if err := hcsTerminateSystem(ctx, i.system); err != nil {
		return err
	}
	i.finish(nil)
	return nil
}

func (i *windowsInstance) watch() {
	ticker := time.NewTicker(hcsPollInterval)
	defer ticker.Stop()
	failures := 0
	for range ticker.C {
		// Serialize property queries with pause, resume, and stop. In particular,
		// HcsCloseComputeSystem must not race an in-flight properties operation:
		// the Windows service owns the raw HCS handle and closes it during finish.
		i.opMu.Lock()
		state := i.State()
		if state == StateStopped || state == StateFailed {
			i.opMu.Unlock()
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		document, err := hcsSystemProperties(ctx, i.system)
		cancel()
		if err != nil {
			failures++
			if failures >= 20 {
				i.finish(fmt.Errorf("poll HCS VM state: %w", err))
				i.opMu.Unlock()
				return
			}
			i.opMu.Unlock()
			continue
		}
		stopped, parseErr := parseHCSStopped(document)
		if parseErr != nil {
			failures++
			if failures >= 20 {
				i.finish(fmt.Errorf("parse HCS VM state: %w", parseErr))
				i.opMu.Unlock()
				return
			}
			i.opMu.Unlock()
			continue
		}
		failures = 0
		if stopped {
			i.finish(nil)
			i.opMu.Unlock()
			return
		}
		i.opMu.Unlock()
	}
}

func (i *windowsInstance) finish(runErr error) {
	i.stopOnce.Do(func() {
		if i.agentTransport != nil {
			runErr = errors.Join(runErr, i.agentTransport.Close())
		}
		procHcsCloseComputeSystem.Call(uintptr(i.system))
		if i.console != nil {
			runErr = errors.Join(runErr, i.console.Close())
		}
		revokeFailed := false
		for index := len(i.grants) - 1; index >= 0; index-- {
			if i.journal == nil {
				revokeFailed = true
				runErr = errors.Join(runErr, errors.New("HCS grant journal is unavailable during VM cleanup"))
				break
			}
			if err := i.journal.RevokeGrant(i.vmID, i.grants[index]); err != nil {
				revokeFailed = true
				runErr = errors.Join(runErr, err)
			}
		}
		if !revokeFailed && i.journal != nil {
			runErr = errors.Join(runErr, i.journal.Complete(i.vmID))
		}
		if i.networkCleanup != nil {
			runErr = errors.Join(runErr, i.networkCleanup())
		}
		if runErr != nil {
			i.lifecycle.Apply(lifecycleFailed)
		} else {
			before, state, _ := i.lifecycle.Apply(lifecycleExited)
			if state == StateFailed {
				runErr = fmt.Errorf("Windows HCS VM exited without a Host stop request from state %s", before)
			}
		}
		i.mu.Lock()
		i.err = runErr
		i.mu.Unlock()
		close(i.stopped)
	})
}

type windowsServiceInstance struct {
	id             string
	vmID           string
	stopped        chan struct{}
	once           sync.Once
	opMu           sync.Mutex
	lifecycle      *lifecycleState
	agentTransport *windowsAgentTransport

	mu  sync.RWMutex
	err error
}

func newWindowsServiceInstance(id, vmID string) *windowsServiceInstance {
	return &windowsServiceInstance{
		id: id, vmID: vmID, stopped: make(chan struct{}), lifecycle: newLifecycleState(StateRunning),
		agentTransport: newWindowsAgentTransport(vmID),
	}
}

func (i *windowsServiceInstance) ID() string { return i.id }

func (i *windowsServiceInstance) State() State {
	return i.lifecycle.State()
}

func (i *windowsServiceInstance) Wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-i.stopped:
		i.mu.RLock()
		defer i.mu.RUnlock()
		return i.err
	}
}

func (i *windowsServiceInstance) DialAgent(ctx context.Context, port uint32) (io.ReadWriteCloser, error) {
	return i.agentTransport.Accept(ctx, port)
}

type windowsAgentAccept struct {
	connection net.Conn
	err        error
}

type windowsAgentTransport struct {
	vmID      string
	port      uint32
	once      sync.Once
	listener  net.Listener
	results   chan windowsAgentAccept
	startErr  error
	closeOnce sync.Once
}

func newWindowsAgentTransport(vmID string) *windowsAgentTransport {
	return &windowsAgentTransport{vmID: vmID, results: make(chan windowsAgentAccept, 16)}
}

func (transport *windowsAgentTransport) start(port uint32) {
	vmID, err := guid.FromString(transport.vmID)
	if err != nil {
		transport.startErr = err
		return
	}
	transport.port = port
	transport.listener, transport.startErr = winio.ListenHvsock(&winio.HvsockAddr{
		VMID: vmID, ServiceID: winio.VsockServiceID(port),
	})
	if transport.startErr != nil {
		return
	}
	go func() {
		for {
			connection, acceptErr := transport.listener.Accept()
			transport.results <- windowsAgentAccept{connection: connection, err: acceptErr}
			if acceptErr != nil {
				return
			}
		}
	}()
}

func (transport *windowsAgentTransport) Accept(ctx context.Context, port uint32) (io.ReadWriteCloser, error) {
	transport.once.Do(func() { transport.start(port) })
	if transport.startErr != nil {
		return nil, transport.startErr
	}
	if transport.port != port {
		return nil, fmt.Errorf("Windows Agent transport already listens on port %d", transport.port)
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result := <-transport.results:
		return result.connection, result.err
	}
}

func (transport *windowsAgentTransport) Close() error {
	var err error
	transport.closeOnce.Do(func() {
		if transport.listener != nil {
			err = transport.listener.Close()
		}
	})
	return err
}

func (i *windowsServiceInstance) ListenHost(port uint32) (net.Listener, error) {
	vmID, err := guid.FromString(i.vmID)
	if err != nil {
		return nil, err
	}
	return winio.ListenHvsock(&winio.HvsockAddr{VMID: vmID, ServiceID: winio.VsockServiceID(port)})
}

func (i *windowsServiceInstance) Pause(ctx context.Context) (returnErr error) {
	i.opMu.Lock()
	defer i.opMu.Unlock()
	state := i.State()
	if state == StatePaused {
		return nil
	}
	if _, state, accepted := i.lifecycle.Apply(lifecyclePauseRequested); !accepted || state != StatePausing {
		return fmt.Errorf("cannot pause Windows service VM from state %s", state)
	}
	defer func() {
		if returnErr != nil {
			i.lifecycle.Apply(lifecyclePauseRejected)
		}
	}()
	response, err := callWindowsService(ctx, windowsServiceRequest{
		Version: windowsServiceProtocolVersion, Operation: windowsServiceOpPause, VMID: i.vmID,
	})
	if err != nil {
		return err
	}
	if response.State != StatePaused {
		return fmt.Errorf("Windows service pause returned state %s", response.State)
	}
	if _, state, accepted := i.lifecycle.Apply(lifecyclePaused); !accepted || state != StatePaused {
		return fmt.Errorf("Windows service pause completed after lifecycle reached %s", state)
	}
	return nil
}

func (i *windowsServiceInstance) Resume(ctx context.Context) (returnErr error) {
	i.opMu.Lock()
	defer i.opMu.Unlock()
	state := i.State()
	if state == StateRunning {
		return nil
	}
	if _, state, accepted := i.lifecycle.Apply(lifecycleResumeRequested); !accepted || state != StateResuming {
		return fmt.Errorf("cannot resume Windows service VM from state %s", state)
	}
	defer func() {
		if returnErr != nil {
			i.lifecycle.Apply(lifecycleResumeRejected)
		}
	}()
	response, err := callWindowsService(ctx, windowsServiceRequest{
		Version: windowsServiceProtocolVersion, Operation: windowsServiceOpResume, VMID: i.vmID,
	})
	if err != nil {
		return err
	}
	if response.State != StateRunning {
		return fmt.Errorf("Windows service resume returned state %s", response.State)
	}
	if _, state, accepted := i.lifecycle.Apply(lifecycleReady); !accepted || state != StateRunning {
		return fmt.Errorf("Windows service resume completed after lifecycle reached %s", state)
	}
	return nil
}

func (i *windowsServiceInstance) Stop(ctx context.Context) (returnErr error) {
	i.opMu.Lock()
	defer i.opMu.Unlock()
	state := i.State()
	if state == StateStopped || state == StateFailed {
		return nil
	}
	if _, state, accepted := i.lifecycle.Apply(lifecycleStopRequested); !accepted || state != StateStopping {
		return fmt.Errorf("cannot request Windows service VM stop from state %s", state)
	}
	defer func() {
		if returnErr != nil {
			i.lifecycle.Apply(lifecycleStopRejected)
		}
	}()
	response, err := callWindowsService(ctx, windowsServiceRequest{
		Version: windowsServiceProtocolVersion, Operation: windowsServiceOpStop, VMID: i.vmID,
	})
	if err != nil {
		return err
	}
	i.finish(response.State, nil)
	return nil
}

func (i *windowsServiceInstance) watch() {
	ticker := time.NewTicker(hcsPollInterval)
	defer ticker.Stop()
	failures := 0
	for range ticker.C {
		// Avoid racing a terminal stop request with a query on another pipe
		// connection. This also ensures no new query is issued after Stop closes
		// the Host-side HCS handle.
		i.opMu.Lock()
		state := i.State()
		if state == StateStopped || state == StateFailed {
			i.opMu.Unlock()
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		response, err := callWindowsService(ctx, windowsServiceRequest{
			Version: windowsServiceProtocolVersion, Operation: windowsServiceOpQuery, VMID: i.vmID,
		})
		cancel()
		if err != nil {
			failures++
			if failures >= 20 {
				i.finish(StateFailed, fmt.Errorf("poll zapVM Windows service: %w", err))
				i.opMu.Unlock()
				return
			}
			i.opMu.Unlock()
			continue
		}
		failures = 0
		if response.State == StateStopped || response.State == StateFailed {
			i.finish(response.State, nil)
			i.opMu.Unlock()
			return
		}
		i.opMu.Unlock()
	}
}

func (i *windowsServiceInstance) finish(state State, runErr error) {
	i.once.Do(func() {
		if i.agentTransport != nil {
			runErr = errors.Join(runErr, i.agentTransport.Close())
		}
		switch {
		case runErr != nil || state == StateFailed:
			i.lifecycle.Apply(lifecycleFailed)
			if runErr == nil {
				runErr = errors.New("zapVM Windows service reported a failed VM")
			}
		case state == StateStopped:
			before, finalState, _ := i.lifecycle.Apply(lifecycleExited)
			if finalState == StateFailed {
				runErr = fmt.Errorf("Windows service VM exited without a Host stop request from state %s", before)
			}
		default:
			i.lifecycle.Apply(lifecycleFailed)
			runErr = fmt.Errorf("zapVM Windows service returned invalid terminal state %s", state)
		}
		i.mu.Lock()
		i.err = runErr
		i.mu.Unlock()
		close(i.stopped)
	})
}
