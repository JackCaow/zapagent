package workspacepolicy

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const MaxProtectedPaths = 16

const protectedPlaceholderName = ".zapvm-protected-path-placeholder"

var protectedPlaceholderContents = []byte("zapvm-protected-path-placeholder-v1\n")

// ProtectedPathsLease tracks system-created placeholders for protected paths
// that did not exist before a workload started. The placeholders give the
// launcher real mountpoints to bind read-only, so a workload cannot create or
// replace a reserved path merely because the Host workspace omitted it.
type ProtectedPathsLease struct {
	created []string
}

// ValidateProtectedPaths accepts Guest workspace-relative POSIX paths only.
// The Host and Guest may use different native separators, so the wire format
// is deliberately independent of the Host operating system.
func ValidateProtectedPaths(values []string) error {
	if len(values) > MaxProtectedPaths {
		return fmt.Errorf("protected workspace paths exceed limit %d", MaxProtectedPaths)
	}
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value == "" || len(value) > 4096 || !utf8.ValidString(value) || strings.IndexByte(value, 0) >= 0 {
			return errors.New("protected workspace path is empty, oversized, invalid UTF-8, or contains NUL")
		}
		if strings.Contains(value, "\\") || path.IsAbs(value) || value == "." || path.Clean(value) != value || strings.HasPrefix(value, "../") {
			return fmt.Errorf("protected workspace path %q must be a clean relative POSIX path", value)
		}
		if _, exists := seen[value]; exists {
			return fmt.Errorf("protected workspace path %q is repeated", value)
		}
		seen[value] = struct{}{}
	}
	return nil
}

// ResolveProtectedPaths fails closed unless every component already exists
// beneath root and is not a symlink. The launcher repeats this validation in
// its private mount namespace immediately before installing read-only binds.
func ResolveProtectedPaths(root string, values []string) ([]string, error) {
	if err := ValidateProtectedPaths(values); err != nil {
		return nil, err
	}
	rootPath, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	rootInfo, err := os.Lstat(rootPath)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("workspace root must be an existing real directory")
	}
	resolved := make([]string, 0, len(values))
	for _, value := range values {
		current := rootPath
		for _, component := range strings.Split(value, "/") {
			current = filepath.Join(current, component)
			info, err := os.Lstat(current)
			if err != nil {
				return nil, fmt.Errorf("protected workspace path %q is unavailable: %w", value, err)
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return nil, fmt.Errorf("protected workspace path %q contains a symlink", value)
			}
		}
		info, err := os.Lstat(current)
		if err != nil || (!info.IsDir() && !info.Mode().IsRegular()) {
			return nil, fmt.Errorf("protected workspace path %q must resolve to a regular file or directory", value)
		}
		resolved = append(resolved, current)
	}
	return resolved, nil
}

// ReserveProtectedPaths creates private, recognizable directory placeholders
// for missing leaf paths and returns a lease that removes them after the
// workload mount namespace exits. Missing intermediate components remain an
// error because their intended file/directory shape is ambiguous.
//
// Callers must serialize leases for the same workspace until Cleanup returns.
// This prevents one workload from mistaking another workload's placeholder for
// a durable workspace path.
func ReserveProtectedPaths(root string, values []string) (*ProtectedPathsLease, error) {
	if err := ValidateProtectedPaths(values); err != nil {
		return nil, err
	}
	rootPath, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	rootInfo, err := os.Lstat(rootPath)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("workspace root must be an existing real directory")
	}

	lease := &ProtectedPathsLease{}
	cleanupOnError := true
	defer func() {
		if cleanupOnError {
			_ = lease.Cleanup()
		}
	}()

	for _, value := range values {
		components := strings.Split(value, "/")
		current := rootPath
		for index, component := range components {
			current = filepath.Join(current, component)
			info, statErr := os.Lstat(current)
			if statErr == nil {
				if info.Mode()&os.ModeSymlink != 0 {
					return nil, fmt.Errorf("protected workspace path %q contains a symlink", value)
				}
				if index == len(components)-1 && isProtectedPlaceholder(current) {
					lease.created = append(lease.created, current)
				}
				continue
			}
			if !errors.Is(statErr, os.ErrNotExist) {
				return nil, fmt.Errorf("protected workspace path %q is unavailable: %w", value, statErr)
			}
			if index != len(components)-1 {
				return nil, fmt.Errorf("protected workspace path %q has a missing parent", value)
			}
			if err := createProtectedPlaceholder(current); err != nil {
				return nil, fmt.Errorf("reserve protected workspace path %q: %w", value, err)
			}
			lease.created = append(lease.created, current)
		}
	}
	if _, err := ResolveProtectedPaths(rootPath, values); err != nil {
		return nil, err
	}
	cleanupOnError = false
	return lease, nil
}

// Cleanup removes only placeholders that still have the exact marker and no
// other contents. Unexpected workspace changes fail closed and are preserved.
func (lease *ProtectedPathsLease) Cleanup() error {
	if lease == nil {
		return nil
	}
	var cleanupErr error
	for index := len(lease.created) - 1; index >= 0; index-- {
		target := lease.created[index]
		if err := cleanupProtectedPlaceholder(target); err != nil && cleanupErr == nil {
			cleanupErr = err
		}
	}
	lease.created = nil
	return cleanupErr
}

func createProtectedPlaceholder(target string) error {
	if err := os.Mkdir(target, 0o700); err != nil {
		return err
	}
	marker := filepath.Join(target, protectedPlaceholderName)
	if err := os.WriteFile(marker, protectedPlaceholderContents, 0o400); err != nil {
		_ = os.Remove(target)
		return err
	}
	if err := os.Chmod(target, 0o500); err != nil {
		_ = os.Remove(marker)
		_ = os.Remove(target)
		return err
	}
	return nil
}

func isProtectedPlaceholder(target string) bool {
	info, err := os.Lstat(target)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o500 {
		return false
	}
	entries, err := os.ReadDir(target)
	if err != nil || len(entries) != 1 || entries[0].Name() != protectedPlaceholderName {
		return false
	}
	markerInfo, err := entries[0].Info()
	if err != nil || !markerInfo.Mode().IsRegular() || markerInfo.Mode()&os.ModeSymlink != 0 {
		return false
	}
	contents, err := os.ReadFile(filepath.Join(target, protectedPlaceholderName))
	return err == nil && string(contents) == string(protectedPlaceholderContents)
}

func cleanupProtectedPlaceholder(target string) error {
	if !isProtectedPlaceholder(target) {
		return fmt.Errorf("protected workspace placeholder %q changed unexpectedly", filepath.Base(target))
	}
	if err := os.Chmod(target, 0o700); err != nil {
		return err
	}
	marker := filepath.Join(target, protectedPlaceholderName)
	if err := os.Remove(marker); err != nil {
		_ = os.Chmod(target, 0o500)
		return err
	}
	if err := os.Remove(target); err != nil {
		_ = os.WriteFile(marker, protectedPlaceholderContents, 0o400)
		_ = os.Chmod(target, 0o500)
		return err
	}
	return nil
}
