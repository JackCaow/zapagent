//go:build windows

package workspacefs

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

func writePinned(root string, segments []string, data []byte) error {
	current := root
	for _, segment := range segments[:len(segments)-1] {
		current = filepath.Join(current, segment)
		if err := rejectWindowsReparsePoint(current, true); err != nil {
			return err
		}
	}
	target := filepath.Join(current, segments[len(segments)-1])
	if info, err := os.Lstat(target); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("workspace object type is not allowed")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
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
	current := root
	for index, segment := range segments {
		current = filepath.Join(current, segment)
		if err := rejectWindowsReparsePoint(current, index < len(segments)-1 || directory); err != nil {
			return nil, err
		}
	}

	pathPointer, err := windows.UTF16PtrFromString(current)
	if err != nil {
		return nil, errors.New("invalid workspace path")
	}
	handle, err := windows.CreateFile(
		pathPointer,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS,
		0,
	)
	if err != nil {
		return nil, err
	}
	opened := os.NewFile(uintptr(handle), current)
	if opened == nil {
		_ = windows.CloseHandle(handle)
		return nil, errors.New("open workspace path")
	}
	info, err := opened.Stat()
	if err != nil || info.Mode()&os.ModeSymlink != 0 || directory != info.IsDir() || !directory && !info.Mode().IsRegular() {
		_ = opened.Close()
		return nil, errors.New("workspace object type is not allowed")
	}
	var handleInfo windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &handleInfo); err != nil || handleInfo.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		_ = opened.Close()
		return nil, errors.New("workspace path contains a reparse point")
	}
	return opened, nil
}

func rejectWindowsReparsePoint(value string, requireDirectory bool) error {
	pointer, err := windows.UTF16PtrFromString(value)
	if err != nil {
		return errors.New("invalid workspace path")
	}
	handle, err := windows.CreateFile(
		pointer,
		windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS,
		0,
	)
	if err != nil {
		return errors.New("workspace path is unavailable")
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return errors.New("inspect workspace path")
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("workspace path contains a reparse point")
	}
	if requireDirectory && info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return errors.New("workspace path component is not a directory")
	}
	return nil
}
