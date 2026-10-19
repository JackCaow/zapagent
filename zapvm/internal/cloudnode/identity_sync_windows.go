//go:build windows

package cloudnode

// Windows does not expose a portable directory fsync through os.File. The
// owner-only versioned files are flushed before the atomic manifest rename;
// the Host installer must place identity_directory on a protected local NTFS
// volume rather than a network filesystem.
func syncIdentityDirectory(string) error { return nil }
