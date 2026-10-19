//go:build linux

package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

func CleanupStaleIsolation() error {
	base := filepath.Join(cgroupRoot, "zapvm")
	entries, err := os.ReadDir(base)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("scan stale cgroups: %w", err)
	}
	var cleanupErr error
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("refusing symlink in cgroup tree: %s", entry.Name()))
			continue
		}
		if !entry.IsDir() {
			continue
		}
		cleanupErr = errors.Join(cleanupErr, cleanupCgroupDirectory(filepath.Join(base, entry.Name())))
	}
	return cleanupErr
}

func cleanupCgroupDirectory(path string) error {
	entries, err := os.ReadDir(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var cleanupErr error
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("refusing symlink in cgroup tree: %s", entry.Name()))
			continue
		}
		if entry.IsDir() {
			cleanupErr = errors.Join(cleanupErr, cleanupCgroupDirectory(filepath.Join(path, entry.Name())))
		}
	}
	if err := os.WriteFile(filepath.Join(path, "cgroup.kill"), []byte("1"), 0o644); err != nil && !errors.Is(err, os.ErrNotExist) {
		cleanupErr = errors.Join(cleanupErr, err)
	}
	for attempt := 0; attempt < 50; attempt++ {
		err := os.Remove(path)
		if err == nil || errors.Is(err, os.ErrNotExist) {
			return cleanupErr
		}
		if !errors.Is(err, syscall.EBUSY) && !errors.Is(err, syscall.ENOTEMPTY) {
			return errors.Join(cleanupErr, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	return errors.Join(cleanupErr, fmt.Errorf("stale cgroup remained busy: %s", path))
}
