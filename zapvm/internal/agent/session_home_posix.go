//go:build darwin || linux

package agent

import (
	"os"
	"syscall"
)

func workloadDirectoryOwnershipMatches(info os.FileInfo, uid, gid uint32) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uid && stat.Gid == gid
}
