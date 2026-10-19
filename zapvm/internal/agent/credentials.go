package agent

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"zapvm/internal/credential"
)

const (
	guestCredentialRoot      = "/run/zapvm/credentials"
	guestCredentialDirectory = "/run/zapvm-credentials"
)

type credentialLease struct {
	path string
}

func prepareCredentialRoot(isolate bool) (string, error) {
	if !isolate || runtime.GOOS != "linux" {
		return "", nil
	}
	if err := os.MkdirAll(guestCredentialRoot, 0o700); err != nil {
		return "", fmt.Errorf("create credential root: %w", err)
	}
	info, err := os.Lstat(guestCredentialRoot)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("credential root must be a real directory")
	}
	if info.Mode().Perm() != 0o700 {
		return "", fmt.Errorf("credential root mode %o must be 700", info.Mode().Perm())
	}
	if !credentialRootOwnedByRoot(info) {
		return "", errors.New("credential root must be owned by root")
	}
	entries, err := os.ReadDir(guestCredentialRoot)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "request-") {
			return "", fmt.Errorf("unexpected entry in credential root: %s", entry.Name())
		}
		lease := &credentialLease{path: filepath.Join(guestCredentialRoot, entry.Name())}
		if err := lease.Cleanup(); err != nil {
			return "", fmt.Errorf("clean stale credential lease: %w", err)
		}
	}
	return guestCredentialRoot, nil
}

func prepareCredentialLease(root string, values map[string][]byte, uid, gid uint32) (*credentialLease, error) {
	if len(values) == 0 {
		return nil, nil
	}
	if len(values) > credential.MaxCredentials {
		return nil, fmt.Errorf("at most %d credentials are allowed", credential.MaxCredentials)
	}
	total := 0
	ids := make([]string, 0, len(values))
	for id, value := range values {
		if !credential.ValidID(id) || len(value) == 0 || len(value) > credential.MaxValueSize {
			return nil, errors.New("invalid credential ID or value size")
		}
		total += len(value)
		if total > credential.MaxTotalSize {
			return nil, errors.New("credential values exceed total size limit")
		}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	pattern := "zapvm-agent-credential-"
	if root != "" {
		pattern = "request-"
	}
	directory, err := os.MkdirTemp(root, pattern)
	if err != nil {
		return nil, err
	}
	lease := &credentialLease{path: directory}
	failed := true
	defer func() {
		if failed {
			_ = lease.Cleanup()
		}
	}()
	if err := os.Chmod(directory, 0o700); err != nil {
		return nil, err
	}
	for _, id := range ids {
		path := filepath.Join(directory, id)
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return nil, err
		}
		if _, err := file.Write(values[id]); err != nil {
			_ = file.Close()
			return nil, err
		}
		if err := file.Close(); err != nil {
			return nil, err
		}
		if uint32(os.Geteuid()) != uid || uint32(os.Getegid()) != gid {
			if err := os.Chown(path, int(uid), int(gid)); err != nil {
				return nil, err
			}
		}
		if err := os.Chmod(path, 0o400); err != nil {
			return nil, err
		}
	}
	if err := os.Chmod(directory, 0o555); err != nil {
		return nil, err
	}
	failed = false
	return lease, nil
}

func (lease *credentialLease) exposedPath(isolate bool) string {
	if lease == nil {
		return ""
	}
	if isolate && runtime.GOOS == "linux" {
		return guestCredentialDirectory
	}
	return lease.path
}

func (lease *credentialLease) Cleanup() error {
	if lease == nil || lease.path == "" {
		return nil
	}
	if err := os.Chmod(lease.path, 0o700); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	entries, readErr := os.ReadDir(lease.path)
	var cleanupErr error
	for _, entry := range entries {
		path := filepath.Join(lease.path, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			cleanupErr = errors.Join(cleanupErr, err)
			continue
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			cleanupErr = errors.Join(cleanupErr, errors.New("credential lease contains a non-regular file"))
			continue
		}
		if err := os.Chmod(path, 0o600); err != nil {
			cleanupErr = errors.Join(cleanupErr, err)
			continue
		}
		file, err := os.OpenFile(path, os.O_WRONLY, 0)
		if err == nil {
			_, err = io.CopyN(file, zeroReader{}, info.Size())
			err = errors.Join(err, file.Close())
		}
		cleanupErr = errors.Join(cleanupErr, err, os.Remove(path))
	}
	cleanupErr = errors.Join(readErr, cleanupErr, os.Remove(lease.path))
	lease.path = ""
	return cleanupErr
}

type zeroReader struct{}

func (zeroReader) Read(buffer []byte) (int, error) {
	clear(buffer)
	return len(buffer), nil
}
