package hostpolicy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceAllowsOrdinaryProject(t *testing.T) {
	home := t.TempDir()
	project := filepath.Join(home, "workspace", "project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	resolved, err := validateWorkspace(project, home, "darwin")
	if err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(project)
	if err != nil {
		t.Fatal(err)
	}
	if resolved != want {
		t.Fatalf("resolved = %q, want %q", resolved, want)
	}
}

func TestWorkspaceRejectsSensitivePathAndSymlinkTarget(t *testing.T) {
	home := t.TempDir()
	secret := filepath.Join(home, ".ssh")
	if err := os.Mkdir(secret, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := validateWorkspace(secret, home, "darwin"); err == nil || !strings.Contains(err.Error(), "protected") {
		t.Fatalf("unexpected sensitive path error: %v", err)
	}
	link := filepath.Join(home, "workspace-link")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatal(err)
	}
	if _, err := validateWorkspace(link, home, "darwin"); err == nil || !strings.Contains(err.Error(), "protected") {
		t.Fatalf("unexpected symlink target error: %v", err)
	}
}

func TestWorkspaceRejectsFilesystemRoot(t *testing.T) {
	if _, err := validateWorkspace(string(filepath.Separator), t.TempDir(), "linux"); err == nil || !strings.Contains(err.Error(), "root") {
		t.Fatalf("unexpected root error: %v", err)
	}
}

func TestPathWithinBoundary(t *testing.T) {
	if pathWithin("/tmp/credential-copy", "/tmp/credential", false) {
		t.Fatal("prefix-only path was treated as descendant")
	}
	if !pathWithin("/tmp/credential/child", "/tmp/credential", false) {
		t.Fatal("real child was not detected")
	}
}
