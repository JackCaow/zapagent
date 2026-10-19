//go:build windows

package agent

import "os"

func credentialRootOwnedByRoot(os.FileInfo) bool {
	return true
}
