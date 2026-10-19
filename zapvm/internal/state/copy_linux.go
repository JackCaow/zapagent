//go:build linux

package state

import (
	"os"

	"golang.org/x/sys/unix"
)

func copyStateFile(sourcePath, destinationPath string) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()
	destination, err := os.OpenFile(destinationPath, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if err := unix.IoctlFileClone(int(destination.Fd()), int(source.Fd())); err != nil {
		_ = destination.Close()
		_ = os.Remove(destinationPath)
		return copyStateFallback(sourcePath, destinationPath)
	}
	if err := destination.Sync(); err != nil {
		_ = destination.Close()
		_ = os.Remove(destinationPath)
		return err
	}
	if err := destination.Close(); err != nil {
		_ = os.Remove(destinationPath)
		return err
	}
	return nil
}
