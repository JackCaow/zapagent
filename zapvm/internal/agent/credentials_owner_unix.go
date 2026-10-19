//go:build darwin || linux

package agent

import (
	"os"
	"syscall"
)

func credentialRootOwnedByRoot(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == 0 && stat.Gid == 0
}
