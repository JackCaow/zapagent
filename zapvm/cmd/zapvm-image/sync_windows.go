//go:build windows

package main

import "golang.org/x/sys/windows"

// Windows does not expose portable directory fsync through os.File. Each file
// is flushed before Rename; the platform installer will add MoveFileEx flags.
func syncDirectory(string) error { return nil }

func replacePath(sourcePath, destinationPath string) error {
	return windows.Rename(sourcePath, destinationPath)
}
