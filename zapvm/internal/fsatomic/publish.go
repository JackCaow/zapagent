// Package fsatomic provides filesystem operations independent of VM policy.
package fsatomic

import (
	"errors"
	"os"
	"path/filepath"
)

// PublishDirectory installs a directory only if destination does not exist.
// Both names must already be on the same filesystem. There is no copy fallback.
// The caller MUST exclusively own the source and both parent directories for
// the whole call. Lstat and the rename are separate operations: this function
// does not defend against parent or source replacement by another writer.
// In particular, no-replace is not proof of path identity or containment.
func PublishDirectory(source, destination string) error {
	if !filepath.IsAbs(source) || !filepath.IsAbs(destination) || filepath.Clean(source) != source || filepath.Clean(destination) != destination || source == destination {
		return errors.New("source and destination must be distinct clean absolute paths")
	}
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("source must be a real directory")
	}
	return publish(source, destination)
}
