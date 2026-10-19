//go:build windows

package agent

import "os"

// The Windows Host never launches the Linux guest workload directly; the
// guest-side Linux Agent performs the UID/GID check before mounting /nix.
func workloadDirectoryOwnershipMatches(_ os.FileInfo, _, _ uint32) bool {
	return true
}
