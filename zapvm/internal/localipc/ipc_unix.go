//go:build darwin || linux

package localipc

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type authenticatedUnixListener struct {
	*net.UnixListener
	lock      *os.File
	closeOnce sync.Once
	closeErr  error
}

func listen(endpoint string) (net.Listener, error) {
	if err := validateUnixEndpoint(endpoint); err != nil {
		return nil, err
	}
	if _, err := os.Lstat(endpoint); err == nil {
		return nil, errors.New("local IPC endpoint already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return openUnixListener(endpoint, nil)
}

func listenRecovering(endpoint string) (net.Listener, error) {
	if err := validateUnixEndpoint(endpoint); err != nil {
		return nil, err
	}
	lock, err := acquireEndpointLock(endpoint + ".lock")
	if err != nil {
		return nil, err
	}
	fail := func(err error) (net.Listener, error) {
		releaseEndpointLock(lock)
		return nil, err
	}
	if before, statErr := os.Lstat(endpoint); statErr == nil {
		if before.Mode()&os.ModeSocket == 0 || before.Mode()&os.ModeSymlink != 0 {
			return fail(errors.New("local IPC endpoint already exists and is not a socket"))
		}
		probe, dialErr := net.DialTimeout("unix", endpoint, 250*time.Millisecond)
		if dialErr == nil {
			_ = probe.Close()
			return fail(errors.New("local IPC endpoint is already active"))
		}
		if !errors.Is(dialErr, syscall.ECONNREFUSED) {
			return fail(fmt.Errorf("local IPC endpoint cannot be safely reclaimed: %w", dialErr))
		}
		current, currentErr := os.Lstat(endpoint)
		if currentErr != nil || !os.SameFile(before, current) || current.Mode()&os.ModeSocket == 0 || current.Mode()&os.ModeSymlink != 0 {
			return fail(errors.New("local IPC endpoint changed during stale recovery"))
		}
		if err := os.Remove(endpoint); err != nil {
			return fail(err)
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return fail(statErr)
	}
	listener, err := openUnixListener(endpoint, lock)
	if err != nil {
		releaseEndpointLock(lock)
		return nil, err
	}
	return listener, nil
}

func openUnixListener(endpoint string, lock *os.File) (net.Listener, error) {
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: endpoint, Net: "unix"})
	if err != nil {
		return nil, err
	}
	listener.SetUnlinkOnClose(true)
	if err := os.Chmod(endpoint, 0o600); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return &authenticatedUnixListener{UnixListener: listener, lock: lock}, nil
}

func dial(ctx context.Context, endpoint string) (net.Conn, error) {
	if endpoint == "" || !filepath.IsAbs(endpoint) || strings.IndexByte(endpoint, 0) >= 0 {
		return nil, errors.New("local IPC endpoint must be an absolute non-NUL path")
	}
	connection, err := (&net.Dialer{}).DialContext(ctx, "unix", endpoint)
	if err != nil {
		return nil, err
	}
	unixConnection, ok := connection.(*net.UnixConn)
	if !ok {
		_ = connection.Close()
		return nil, errors.New("local IPC dial did not return a Unix connection")
	}
	if err := sameUserPeer(unixConnection); err != nil {
		_ = connection.Close()
		return nil, err
	}
	return connection, nil
}

func defaultEndpoint() (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	directory := filepath.Join(cache, "zapvm")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	endpoint := filepath.Join(directory, "daemon.sock")
	if err := validateUnixEndpoint(endpoint); err != nil {
		return "", err
	}
	return endpoint, nil
}

func (listener *authenticatedUnixListener) Accept() (net.Conn, error) {
	for {
		connection, err := listener.AcceptUnix()
		if err != nil {
			return nil, err
		}
		if err := sameUserPeer(connection); err != nil {
			_ = connection.Close()
			continue
		}
		return connection, nil
	}
}

func (listener *authenticatedUnixListener) Close() error {
	listener.closeOnce.Do(func() {
		listener.closeErr = listener.UnixListener.Close()
		if listener.lock != nil {
			releaseEndpointLock(listener.lock)
		}
	})
	return listener.closeErr
}

func acquireEndpointLock(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDWR|unix.O_CREAT|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open local IPC ownership lock: %w", err)
	}
	file := os.NewFile(uintptr(fd), path)
	fail := func(err error) (*os.File, error) {
		_ = file.Close()
		return nil, err
	}
	opened, err := file.Stat()
	if err != nil {
		return fail(err)
	}
	current, err := os.Lstat(path)
	if err != nil {
		return fail(err)
	}
	stat, ok := opened.Sys().(*syscall.Stat_t)
	if !opened.Mode().IsRegular() || current.Mode()&os.ModeSymlink != 0 || !os.SameFile(opened, current) || opened.Mode().Perm() != 0o600 || !ok || int(stat.Uid) != os.Geteuid() {
		return fail(errors.New("local IPC ownership lock must be an owner-only regular file"))
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return fail(fmt.Errorf("local IPC endpoint is owned by another daemon: %w", err))
	}
	return file, nil
}

func releaseEndpointLock(file *os.File) {
	if file == nil {
		return
	}
	_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
	_ = file.Close()
}

func validateUnixEndpoint(endpoint string) error {
	if endpoint == "" || !filepath.IsAbs(endpoint) || strings.IndexByte(endpoint, 0) >= 0 || len(endpoint) > 100 {
		return errors.New("local IPC endpoint must be an absolute path no longer than 100 bytes")
	}
	parent := filepath.Dir(endpoint)
	info, err := os.Lstat(parent)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 {
		return errors.New("local IPC parent must be a real 0700 directory")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("local IPC parent must be owned by effective UID %d", os.Geteuid())
	}
	return nil
}
