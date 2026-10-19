//go:build windows

package state

import "golang.org/x/sys/windows"

func replaceFile(sourcePath, destinationPath string) error {
	return windows.Rename(sourcePath, destinationPath)
}
