//go:build windows

package main

func currentHostIdentity() (uint32, uint32) {
	return 1000, 1000
}
