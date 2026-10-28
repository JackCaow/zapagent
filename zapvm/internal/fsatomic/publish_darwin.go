//go:build darwin

package fsatomic

import "golang.org/x/sys/unix"

func publish(source, destination string) error {
	return unix.RenamexNp(source, destination, unix.RENAME_EXCL)
}
