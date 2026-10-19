//go:build darwin || linux

package workspacefs

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func writePinned(root string, segments []string, data []byte) error {
	flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_DIRECTORY
	fd, err := unix.Open(root, flags, 0)
	if err != nil {
		return err
	}
	current := os.NewFile(uintptr(fd), root)
	if current == nil {
		_ = unix.Close(fd)
		return errors.New("open workspace root")
	}
	defer func() { _ = current.Close() }()
	for _, segment := range segments[:len(segments)-1] {
		nextFD, openErr := unix.Openat(int(current.Fd()), segment, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_DIRECTORY, 0)
		if openErr != nil {
			return openErr
		}
		_ = current.Close()
		current = os.NewFile(uintptr(nextFD), segment)
		if current == nil {
			_ = unix.Close(nextFD)
			return errors.New("open workspace component")
		}
	}
	fileFD, err := unix.Openat(int(current.Fd()), segments[len(segments)-1], unix.O_WRONLY|unix.O_CREAT|unix.O_TRUNC|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0o600)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fileFD), segments[len(segments)-1])
	if file == nil {
		_ = unix.Close(fileFD)
		return errors.New("open workspace file")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("workspace object type is not allowed")
	}
	if _, err := file.Write(data); err != nil {
		return err
	}
	return file.Sync()
}

func openPinned(root string, segments []string, directory bool) (*os.File, error) {
	flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_DIRECTORY
	fd, err := unix.Open(root, flags, 0)
	if err != nil {
		return nil, err
	}
	current := os.NewFile(uintptr(fd), root)
	if current == nil {
		_ = unix.Close(fd)
		return nil, errors.New("open workspace root")
	}
	for index, segment := range segments {
		componentFlags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW
		if index < len(segments)-1 || directory {
			componentFlags |= unix.O_DIRECTORY
		}
		nextFD, openErr := unix.Openat(int(current.Fd()), segment, componentFlags, 0)
		_ = current.Close()
		if openErr != nil {
			return nil, openErr
		}
		current = os.NewFile(uintptr(nextFD), segment)
		if current == nil {
			_ = unix.Close(nextFD)
			return nil, errors.New("open workspace component")
		}
	}
	info, err := current.Stat()
	if err != nil || (directory && !info.IsDir()) || (!directory && !info.Mode().IsRegular()) {
		_ = current.Close()
		return nil, errors.New("workspace object type is not allowed")
	}
	return current, nil
}
