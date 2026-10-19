//go:build !windows

package main

import (
	"errors"

	"zapvm/internal/cloudnode"
)

func runWindowsNodeService(cloudnode.Config, string) error {
	return errors.New("zapvm-node --service-run is only available on Windows")
}
