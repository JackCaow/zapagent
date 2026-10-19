package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCredentialLeasePermissionsAndCleanup(t *testing.T) {
	root := t.TempDir()
	lease, err := prepareCredentialLease(root, map[string][]byte{
		"api-token":  []byte("secret"),
		"binary.key": {0, 1, 2, 3},
	}, uint32(os.Geteuid()), uint32(os.Getegid()))
	if err != nil {
		t.Fatal(err)
	}
	directory := lease.path
	info, err := os.Stat(directory)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o555 {
		t.Fatalf("lease directory mode = %o", info.Mode().Perm())
	}
	for _, id := range []string{"api-token", "binary.key"} {
		info, err := os.Stat(filepath.Join(directory, id))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o400 {
			t.Fatalf("credential %s mode = %o", id, info.Mode().Perm())
		}
	}
	if err := lease.Cleanup(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(directory); !os.IsNotExist(err) {
		t.Fatalf("credential lease still exists: %v", err)
	}
}
