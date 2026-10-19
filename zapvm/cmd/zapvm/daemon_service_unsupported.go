//go:build !windows

package main

import "errors"

func runDaemonService([]string) error {
	return errors.New("daemon service-run is only available on Windows")
}
