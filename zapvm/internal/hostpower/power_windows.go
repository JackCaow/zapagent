//go:build windows

package hostpower

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	deviceNotifyCallback  = 2
	pbtAPMSuspend         = 0x0004
	pbtAPMResumeSuspend   = 0x0007
	pbtAPMResumeAutomatic = 0x0012
)

type deviceNotifySubscribeParameters struct {
	callback uintptr
	context  uintptr
}

var (
	powrprofDLL              = windows.NewLazySystemDLL("powrprof.dll")
	procPowerRegister        = powrprofDLL.NewProc("PowerRegisterSuspendResumeNotification")
	procPowerUnregister      = powrprofDLL.NewProc("PowerUnregisterSuspendResumeNotification")
	windowsPowerCallback     = syscall.NewCallback(handleWindowsPowerEvent)
	windowsPowerMonitors     sync.Map
	windowsPowerMonitorIndex atomic.Uint64
)

func handleWindowsPowerEvent(contextValue, eventType, _ uintptr) uintptr {
	value, ok := windowsPowerMonitors.Load(uint64(contextValue))
	if !ok {
		return uintptr(windows.ERROR_INVALID_HANDLE)
	}
	monitor := value.(*windowsPowerMonitor)
	switch eventType {
	case pbtAPMSuspend:
		if monitor.handlers.Suspend != nil {
			monitor.handlers.report(monitor.handlers.Suspend(monitor.ctx))
		}
	case pbtAPMResumeAutomatic:
		if monitor.handlers.Resume != nil {
			monitor.handlers.report(monitor.handlers.Resume(monitor.ctx))
		}
	case pbtAPMResumeSuspend:
		// Automatic resume is always delivered; ignore the later user-resume
		// duplicate so pool ownership cannot be released twice.
	}
	return 0
}

type windowsPowerMonitor struct {
	ctx      context.Context
	handlers Handlers
}

func Monitor(ctx context.Context, handlers Handlers) error {
	if err := powrprofDLL.Load(); err != nil {
		return fmt.Errorf("load powrprof for Host sleep events: %w", err)
	}
	if err := procPowerRegister.Find(); err != nil {
		return err
	}
	if err := procPowerUnregister.Find(); err != nil {
		return err
	}
	id := windowsPowerMonitorIndex.Add(1)
	windowsPowerMonitors.Store(id, &windowsPowerMonitor{ctx: ctx, handlers: handlers})
	defer windowsPowerMonitors.Delete(id)
	parameters := deviceNotifySubscribeParameters{callback: windowsPowerCallback, context: uintptr(id)}
	var registration windows.Handle
	result, _, _ := procPowerRegister.Call(
		deviceNotifyCallback, uintptr(unsafe.Pointer(&parameters)), uintptr(unsafe.Pointer(&registration)),
	)
	if result != 0 {
		return fmt.Errorf("register Windows suspend/resume callback: %w", windows.Errno(result))
	}
	<-ctx.Done()
	result, _, _ = procPowerUnregister.Call(uintptr(registration))
	if result != 0 {
		return fmt.Errorf("unregister Windows suspend/resume callback: %w", windows.Errno(result))
	}
	return nil
}
