//go:build !windows

package cloudplane

import "os"

func protectRoot(path string) error { return os.Chmod(path, 0o700) }

func replaceStateFile(source, destination string) error { return os.Rename(source, destination) }
