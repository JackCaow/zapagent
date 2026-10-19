//go:build windows

package platform

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsPathPinAllowsExclusiveDataOpenAndDeniesReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.vhdx")
	if err := os.WriteFile(path, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	canonical, pin, err := openAndCanonicalizeWindowsClientPath(path, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".replaced"); err == nil {
		t.Fatal("path replacement succeeded while the non-delete-sharing pin was live")
	}
	pointer, err := windows.UTF16PtrFromString(canonical)
	if err != nil {
		t.Fatal(err)
	}
	if exclusive, err := windows.CreateFile(pointer, windows.FILE_GENERIC_READ|windows.FILE_GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0); err == nil {
		windows.CloseHandle(exclusive)
		t.Fatal("exclusive HCS-style data open unexpectedly succeeded before path pins were released")
	}
	windows.CloseHandle(pin)
	exclusive, err := windows.CreateFile(pointer, windows.FILE_GENERIC_READ|windows.FILE_GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("exclusive HCS-style data open failed after path pins were released: %v", err)
	}
	windows.CloseHandle(exclusive)
}
