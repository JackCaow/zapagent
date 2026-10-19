//go:build !linux

package main

import "errors"

func runLinuxVMMSupervisor([]string) error {
	return errors.New("Linux VMM supervisor is unavailable on this platform")
}
