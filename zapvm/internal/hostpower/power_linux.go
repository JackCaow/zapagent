//go:build linux

package hostpower

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/godbus/dbus/v5"
)

const (
	login1Destination = "org.freedesktop.login1"
	login1Path        = dbus.ObjectPath("/org/freedesktop/login1")
	login1Interface   = "org.freedesktop.login1.Manager"
)

// Monitor holds a logind delay inhibitor while awake. PrepareForSleep(true)
// freezes VMs before releasing that fd; false resumes VMs and reacquires it.
func Monitor(ctx context.Context, handlers Handlers) error {
	connection, err := dbus.ConnectSystemBus()
	if err != nil {
		return fmt.Errorf("connect system bus for Host sleep events: %w", err)
	}
	defer connection.Close()
	options := []dbus.MatchOption{
		dbus.WithMatchObjectPath(login1Path),
		dbus.WithMatchInterface(login1Interface),
		dbus.WithMatchMember("PrepareForSleep"),
	}
	if err := connection.AddMatchSignal(options...); err != nil {
		return fmt.Errorf("subscribe logind PrepareForSleep: %w", err)
	}
	defer connection.RemoveMatchSignal(options...)
	signals := make(chan *dbus.Signal, 8)
	connection.Signal(signals)
	defer connection.RemoveSignal(signals)

	acquire := func() (*os.File, error) {
		var descriptor dbus.UnixFD
		call := connection.Object(login1Destination, login1Path).CallWithContext(
			ctx, login1Interface+".Inhibit", 0,
			"sleep", "zapVM", "pause virtual machines before Host sleep", "delay",
		)
		if err := call.Store(&descriptor); err != nil {
			return nil, fmt.Errorf("acquire logind sleep delay inhibitor: %w", err)
		}
		return os.NewFile(uintptr(descriptor), "logind-sleep-inhibitor"), nil
	}
	inhibitor, err := acquire()
	if err != nil {
		return err
	}
	defer func() {
		if inhibitor != nil {
			_ = inhibitor.Close()
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case signal := <-signals:
			if signal == nil || signal.Name != login1Interface+".PrepareForSleep" {
				continue
			}
			var sleeping bool
			if err := dbus.Store(signal.Body, &sleeping); err != nil {
				handlers.report(fmt.Errorf("decode logind PrepareForSleep: %w", err))
				continue
			}
			if sleeping {
				if handlers.Suspend != nil {
					handlers.report(handlers.Suspend(ctx))
				}
				if inhibitor != nil {
					handlers.report(inhibitor.Close())
					inhibitor = nil
				}
				continue
			}
			if handlers.Resume != nil {
				handlers.report(handlers.Resume(ctx))
			}
			inhibitor, err = acquire()
			if err != nil && !errors.Is(err, context.Canceled) {
				handlers.report(err)
			}
		}
	}
}
