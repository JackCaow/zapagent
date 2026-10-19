//go:build darwin

package hostpower

/*
#cgo LDFLAGS: -framework IOKit -framework CoreFoundation
#include <stdint.h>
#include <IOKit/IOMessage.h>

typedef struct zapvm_power_monitor zapvm_power_monitor;
zapvm_power_monitor *zapvm_power_create(uintptr_t handle);
void zapvm_power_run(zapvm_power_monitor *monitor);
void zapvm_power_stop(zapvm_power_monitor *monitor);
void zapvm_power_destroy(zapvm_power_monitor *monitor);
*/
import "C"

import (
	"context"
	"errors"
	"runtime"
	"runtime/cgo"
)

type darwinPowerMonitor struct {
	ctx      context.Context
	handlers Handlers
}

//export zapvmPowerCallback
func zapvmPowerCallback(handle C.uintptr_t, messageType C.uint32_t) {
	monitor := cgo.Handle(handle).Value().(*darwinPowerMonitor)
	switch messageType {
	case C.kIOMessageSystemWillSleep:
		if monitor.handlers.Suspend != nil {
			monitor.handlers.report(monitor.handlers.Suspend(monitor.ctx))
		}
	case C.kIOMessageSystemHasPoweredOn:
		if monitor.handlers.Resume != nil {
			monitor.handlers.report(monitor.handlers.Resume(monitor.ctx))
		}
	}
}

func Monitor(ctx context.Context, handlers Handlers) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	handle := cgo.NewHandle(&darwinPowerMonitor{ctx: ctx, handlers: handlers})
	defer handle.Delete()
	monitor := C.zapvm_power_create(C.uintptr_t(handle))
	if monitor == nil {
		return errors.New("register IOKit Host sleep notifications")
	}
	stopDone := make(chan struct{})
	go func() {
		<-ctx.Done()
		C.zapvm_power_stop(monitor)
		close(stopDone)
	}()
	C.zapvm_power_run(monitor)
	<-stopDone
	C.zapvm_power_destroy(monitor)
	return nil
}
