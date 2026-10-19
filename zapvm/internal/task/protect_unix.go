//go:build !windows

package task

import "os"

func protectStoreRoot(string) error { return nil }

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
