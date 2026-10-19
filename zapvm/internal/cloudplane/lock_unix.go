//go:build !windows

package cloudplane

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func openStoreLock(root string) (*os.File, error) {
	file, err := os.OpenFile(filepath.Join(root, ".control.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("lock cloud control-plane store: %w", err)
	}
	return file, nil
}

func closeStoreLock(file *os.File) error {
	if file == nil {
		return nil
	}
	unlockErr := unix.Flock(int(file.Fd()), unix.LOCK_UN)
	return errorsJoin(unlockErr, file.Close())
}
