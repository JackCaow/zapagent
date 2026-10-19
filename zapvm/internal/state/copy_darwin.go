//go:build darwin

package state

import (
	"os"

	"golang.org/x/sys/unix"
)

func copyStateFile(sourcePath, destinationPath string) error {
	if err := unix.Clonefile(sourcePath, destinationPath, 0); err != nil {
		return copyStateFallback(sourcePath, destinationPath)
	}
	if err := os.Chmod(destinationPath, 0o600); err != nil {
		_ = os.Remove(destinationPath)
		return err
	}
	file, err := os.OpenFile(destinationPath, os.O_RDWR, 0)
	if err != nil {
		_ = os.Remove(destinationPath)
		return err
	}
	syncErr := file.Sync()
	closeErr := file.Close()
	if syncErr != nil {
		_ = os.Remove(destinationPath)
		return syncErr
	}
	if closeErr != nil {
		_ = os.Remove(destinationPath)
		return closeErr
	}
	return nil
}
