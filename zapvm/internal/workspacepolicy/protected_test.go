package workspacepolicy

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestValidateProtectedPaths(t *testing.T) {
	if err := ValidateProtectedPaths([]string{".git", ".zapcode/settings.json"}); err != nil {
		t.Fatal(err)
	}
	for _, values := range [][]string{
		{""}, {"."}, {"/absolute"}, {"../escape"}, {"nested/../escape"}, {`windows\path`}, {".git", ".git"},
	} {
		if err := ValidateProtectedPaths(values); err == nil {
			t.Fatalf("invalid paths accepted: %#v", values)
		}
	}
}

func TestResolveProtectedPathsRejectsMissingAndSymlinks(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	resolved, err := ResolveProtectedPaths(root, []string{".git"})
	if err != nil || len(resolved) != 1 || resolved[0] != filepath.Join(root, ".git") {
		t.Fatalf("resolved=%#v err=%v", resolved, err)
	}
	if _, err := ResolveProtectedPaths(root, []string{".zapcode"}); err == nil {
		t.Fatal("missing protected path was accepted")
	}
	if err := os.Symlink(filepath.Join(root, ".git"), filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveProtectedPaths(root, []string{"linked"}); err == nil {
		t.Fatal("symlinked protected path was accepted")
	}
}

func TestReserveProtectedPathsCreatesAndCleansMissingLeaf(t *testing.T) {
	root := t.TempDir()
	lease, err := ReserveProtectedPaths(root, []string{".git", ".zapcode"})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".git", ".zapcode"} {
		path := filepath.Join(root, name)
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode().Perm() != 0o500 {
			t.Fatalf("placeholder %s info=%v err=%v", name, info, err)
		}
	}
	if _, err := ResolveProtectedPaths(root, []string{".git", ".zapcode"}); err != nil {
		t.Fatal(err)
	}
	if err := lease.Cleanup(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".git", ".zapcode"} {
		if _, err := os.Lstat(filepath.Join(root, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("placeholder %s remains after cleanup: %v", name, err)
		}
	}
}

func TestReserveProtectedPathsPreservesExistingAndRejectsMissingParent(t *testing.T) {
	root := t.TempDir()
	existing := filepath.Join(root, ".git")
	if err := os.Mkdir(existing, 0o700); err != nil {
		t.Fatal(err)
	}
	lease, err := ReserveProtectedPaths(root, []string{".git"})
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Cleanup(); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(existing); err != nil || !info.IsDir() {
		t.Fatalf("existing protected path was removed: info=%v err=%v", info, err)
	}
	if _, err := ReserveProtectedPaths(root, []string{"missing/settings.json"}); err == nil {
		t.Fatal("missing protected parent was accepted")
	}
}

func TestProtectedPathsLeaseFailsClosedOnUnexpectedContents(t *testing.T) {
	root := t.TempDir()
	lease, err := ReserveProtectedPaths(root, []string{".zapcode"})
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, ".zapcode")
	if err := os.Chmod(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "unexpected"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(target, 0o500); err != nil {
		t.Fatal(err)
	}
	if err := lease.Cleanup(); err == nil {
		t.Fatal("changed placeholder was removed")
	}
	if _, err := os.Stat(filepath.Join(target, "unexpected")); err != nil {
		t.Fatalf("unexpected content was not preserved: %v", err)
	}
	if err := os.Chmod(target, 0o700); err != nil {
		t.Fatal(err)
	}
}
