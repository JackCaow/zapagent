//go:build darwin || linux

package remoteauth

import (
	"fmt"
	"os"
)

func validateOwnerOnlyDirectory(_ string, info os.FileInfo) error {
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("parent permissions %o allow group or other writes", info.Mode().Perm())
	}
	return nil
}

func validateOwnerOnlyFile(_ string, info os.FileInfo) error {
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("file permissions %o allow group or other access", info.Mode().Perm())
	}
	return nil
}

func validateAuditWritable(_ string, info os.FileInfo) error {
	if info.Mode().Perm()&0o200 == 0 {
		return fmt.Errorf("remote audit permissions %o are not owner-writable", info.Mode().Perm())
	}
	return nil
}
