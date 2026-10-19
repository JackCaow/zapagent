//go:build darwin || linux

package remoteauth

import (
	"os"

	"golang.org/x/sys/unix"
)

func lockAuditFile(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_EX)
}

func unlockAuditFile(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_UN)
}
