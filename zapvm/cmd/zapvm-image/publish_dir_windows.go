//go:build windows

package main

import (
	"golang.org/x/sys/windows"
)

func publishNewDirectory(staging, destination string) error {
	from, err := windows.UTF16PtrFromString(staging)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	// Omitting MOVEFILE_REPLACE_EXISTING is the Windows no-replace contract.
	return windows.MoveFileEx(from, to, windows.MOVEFILE_WRITE_THROUGH)
}
