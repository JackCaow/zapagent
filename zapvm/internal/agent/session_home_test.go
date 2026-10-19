package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPrepareSessionHomePersistsAndSeparatesSessions(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "schema-version"), []byte("3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	first, err := prepareSessionHome(root, "session-a", uint32(os.Geteuid()), uint32(os.Getegid()))
	if err != nil {
		t.Fatal(err)
	}
	again, err := prepareSessionHome(root, "session-a", uint32(os.Geteuid()), uint32(os.Getegid()))
	if err != nil {
		t.Fatal(err)
	}
	second, err := prepareSessionHome(root, "session-b", uint32(os.Geteuid()), uint32(os.Getegid()))
	if err != nil {
		t.Fatal(err)
	}
	if first != again || first == second {
		t.Fatalf("Session homes first=%q again=%q second=%q", first, again, second)
	}
	info, err := os.Stat(first)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("Session HOME mode = %o", info.Mode().Perm())
	}
}

func TestPrepareSessionHomeRejectsSymlinkRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "schema-version"), []byte("3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	if err := os.Symlink(target, filepath.Join(root, "sessions")); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareSessionHome(root, "session", uint32(os.Geteuid()), uint32(os.Getegid())); err == nil {
		t.Fatal("expected symlink Session root rejection")
	}
}

func TestPrepareComputerNixRootRequiresPrivateWorkloadOwnedDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "schema-version"), []byte("3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	nixRoot := filepath.Join(root, "computer", "nix")
	if err := os.MkdirAll(nixRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	got, err := prepareComputerNixRoot(root, uint32(os.Geteuid()), uint32(os.Getegid()))
	if err != nil || got != nixRoot {
		t.Fatalf("Computer Nix root = %q, %v", got, err)
	}
	if err := os.Chmod(nixRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareComputerNixRoot(root, uint32(os.Geteuid()), uint32(os.Getegid())); err == nil {
		t.Fatal("expected broad Computer Nix root to be rejected")
	}
}
