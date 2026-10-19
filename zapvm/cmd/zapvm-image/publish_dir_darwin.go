//go:build darwin

package main

import "golang.org/x/sys/unix"

func publishNewDirectory(staging, destination string) error {
	return unix.RenamexNp(staging, destination, unix.RENAME_EXCL)
}
