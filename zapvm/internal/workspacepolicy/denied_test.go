package workspacepolicy

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestValidateDeniedPatterns(t *testing.T) {
	if err := ValidateDeniedPatterns([]string{"**/.env", "**/.env.*", "private/token"}); err != nil {
		t.Fatal(err)
	}
	for _, patterns := range [][]string{{""}, {"."}, {"*"}, {"/absolute"}, {"../escape"}, {`windows\path`}, {"bad/**suffix"}, {"a", "a"}} {
		if err := ValidateDeniedPatterns(patterns); err == nil {
			t.Fatalf("invalid denied patterns accepted: %#v", patterns)
		}
	}
}

func TestResolveDeniedPathsExpandsWorkspacePatterns(t *testing.T) {
	root := t.TempDir()
	for name, contents := range map[string]string{
		".env": "root", "src/.env.local": "nested", "src/ok.txt": "ok", "private/token": "secret",
	} {
		target := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	resolved, err := ResolveDeniedPaths(root, []string{"**/.env", "**/.env.*", "private"})
	if err != nil {
		t.Fatal(err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(resolvedRoot, ".env"), filepath.Join(resolvedRoot, "private"), filepath.Join(resolvedRoot, "src", ".env.local")}
	if !reflect.DeepEqual(resolved, want) {
		t.Fatalf("resolved=%#v want=%#v", resolved, want)
	}
}

func TestResolveDeniedPathsRejectsSymlinkAlias(t *testing.T) {
	root := t.TempDir()
	secret := filepath.Join(root, ".env")
	if err := os.WriteFile(secret, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveDeniedPaths(root, []string{"**/.env"}); err == nil || !strings.Contains(err.Error(), "aliases a denied path") {
		t.Fatalf("unexpected symlink result: %v", err)
	}
}
