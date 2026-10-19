package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func prepareSessionHome(stateRoot, sessionID string, uid, gid uint32) (string, error) {
	if stateRoot == "" {
		return "", nil
	}
	schema, err := os.ReadFile(filepath.Join(stateRoot, "schema-version"))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(string(schema)) != "3" {
		return "", errors.New("unsupported state schema for Session HOME")
	}
	if sessionID == "" {
		sessionID = "default"
	}
	sessionsRoot := filepath.Join(stateRoot, "sessions")
	if err := ensureRealDirectory(sessionsRoot, 0o711); err != nil {
		return "", fmt.Errorf("prepare Session root: %w", err)
	}
	sessionRoot := filepath.Join(sessionsRoot, safeIdentifier(sessionID))
	if err := ensureRealDirectory(sessionRoot, 0o711); err != nil {
		return "", fmt.Errorf("prepare Session directory: %w", err)
	}
	home := filepath.Join(sessionRoot, "home")
	if err := ensureRealDirectory(home, 0o700); err != nil {
		return "", fmt.Errorf("prepare Session HOME: %w", err)
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(home, int(uid), int(gid)); err != nil {
			return "", fmt.Errorf("assign Session HOME: %w", err)
		}
	}
	if err := os.Chmod(home, 0o700); err != nil {
		return "", err
	}
	return home, nil
}

func prepareComputerNixRoot(stateRoot string, uid, gid uint32) (string, error) {
	if stateRoot == "" {
		return "", nil
	}
	schema, err := os.ReadFile(filepath.Join(stateRoot, "schema-version"))
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(string(schema)) != "3" {
		return "", errors.New("unsupported state schema for Computer tool storage")
	}
	computerRoot := filepath.Join(stateRoot, "computer")
	if err := validateRealDirectory(computerRoot); err != nil {
		return "", fmt.Errorf("validate Computer state root: %w", err)
	}
	nixRoot := filepath.Join(computerRoot, "nix")
	if err := validateWorkloadDirectory(nixRoot, uid, gid); err != nil {
		return "", fmt.Errorf("validate Computer Nix root: %w", err)
	}
	return nixRoot, nil
}

func validateRealDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("path is not a real directory")
	}
	return nil
}

func validateWorkloadDirectory(path string, uid, gid uint32) error {
	if err := validateRealDirectory(path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("directory is accessible by group or others")
	}
	if !workloadDirectoryOwnershipMatches(info, uid, gid) {
		return errors.New("directory ownership does not match workload identity")
	}
	return nil
}

func ensureRealDirectory(path string, mode os.FileMode) error {
	if err := os.Mkdir(path, mode); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("path is not a real directory")
	}
	return os.Chmod(path, mode)
}

func safeIdentifier(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}
