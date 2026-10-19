//go:build !windows

package main

import "os"

func currentHostIdentity() (uint32, uint32) {
	return uint32(os.Getuid()), uint32(os.Getgid())
}
