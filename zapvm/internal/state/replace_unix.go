//go:build !windows

package state

import "os"

func replaceFile(sourcePath, destinationPath string) error {
	return os.Rename(sourcePath, destinationPath)
}
