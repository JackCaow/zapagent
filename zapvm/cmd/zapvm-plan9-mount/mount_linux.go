//go:build linux

package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"

	"github.com/mdlayher/vsock"
	"golang.org/x/sys/unix"
)

func mountPlan9(config mountConfig) error {
	if os.Geteuid() != 0 {
		return errors.New("Plan9 mount requires root")
	}
	if err := os.MkdirAll(config.target, 0o700); err != nil {
		return err
	}
	deadline := time.Now().Add(5 * time.Second)
	var connection *vsock.Conn
	var err error
	for {
		connection, err = vsock.Dial(vsock.Host, config.port, nil)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("dial Host Plan9 VSOCK port %d: %w", config.port, err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	defer connection.Close()

	raw, err := connection.SyscallConn()
	if err != nil {
		return err
	}
	duplicate := -1
	var duplicateErr error
	if err := raw.Control(func(fd uintptr) {
		duplicate, duplicateErr = unix.Dup(int(fd))
	}); err != nil {
		return err
	}
	if duplicateErr != nil {
		return duplicateErr
	}
	defer unix.Close(duplicate)
	if err := unix.SetsockoptInt(duplicate, syscall.SOL_SOCKET, syscall.SO_RCVBUF, 65536); err != nil {
		return err
	}
	if err := unix.SetsockoptInt(duplicate, syscall.SOL_SOCKET, syscall.SO_SNDBUF, 65536); err != nil {
		return err
	}
	mountFlags := uintptr(unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC)
	if config.executable {
		mountFlags &^= unix.MS_NOEXEC
	}
	if config.readOnly {
		mountFlags |= unix.MS_RDONLY
	}
	if err := unix.Mount(config.target, config.target, "9p", mountFlags, plan9MountData(duplicate, config.share)); err != nil {
		return fmt.Errorf("mount Plan9 share %q at %s: %w", config.share, config.target, err)
	}
	return nil
}
