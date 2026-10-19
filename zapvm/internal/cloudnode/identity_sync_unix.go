//go:build !windows

package cloudnode

import "os"

func syncIdentityDirectory(directory string) error {
	handle, err := os.Open(directory)
	if err != nil {
		return err
	}
	err = handle.Sync()
	closeErr := handle.Close()
	if err != nil {
		return err
	}
	return closeErr
}
