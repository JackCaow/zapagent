//go:build darwin || linux

package agent

import "golang.org/x/sys/unix"

func flushState() error {
	unix.Sync()
	return nil
}
