//go:build darwin

package localipc

import (
	"fmt"
	"net"
	"os"

	"golang.org/x/sys/unix"
)

func sameUserPeer(connection *net.UnixConn) error {
	raw, err := connection.SyscallConn()
	if err != nil {
		return err
	}
	var credential *unix.Xucred
	var socketErr error
	if err := raw.Control(func(fd uintptr) {
		credential, socketErr = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
	}); err != nil {
		return err
	}
	if socketErr != nil {
		return socketErr
	}
	if credential == nil || credential.Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("local IPC peer UID mismatch")
	}
	return nil
}
