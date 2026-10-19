package workspacefs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestExplorerListsAndReadsWithoutProtectedOrSymlinkTraversal(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "README.md"), []byte("hello workspace\n"))
	mustWrite(t, filepath.Join(root, "src", "main.go"), []byte("package main\n"))
	mustWrite(t, filepath.Join(root, ".git", "config"), []byte("secret config"))
	mustWrite(t, filepath.Join(root, ".zapcode", "settings.json"), []byte("secret settings"))
	if err := os.Mkdir(filepath.Join(root, "empty"), 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.txt")
	mustWrite(t, outside, []byte("outside secret"))
	symlinksAvailable := os.Symlink(outside, filepath.Join(root, "outside-link")) == nil
	if symlinksAvailable {
		_ = os.Symlink(filepath.Join(root, "README.md"), filepath.Join(root, "inside-link"))
	}

	explorer, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	listing, err := explorer.List("")
	if err != nil {
		t.Fatal(err)
	}
	if listing.Path != "" || listing.Truncated || len(listing.Entries) < 3 {
		t.Fatalf("root listing = %#v", listing)
	}
	encodedNames := make([]string, 0, len(listing.Entries))
	for _, entry := range listing.Entries {
		encodedNames = append(encodedNames, entry.Name+":"+entry.Type)
	}
	joined := strings.Join(encodedNames, ",")
	if strings.Contains(joined, ".git") || strings.Contains(joined, ".zapcode") || !strings.Contains(joined, "README.md:file") || !strings.Contains(joined, "src:directory") {
		t.Fatalf("unexpected root entries: %s", joined)
	}
	empty, err := explorer.List("empty")
	if err != nil || len(empty.Entries) != 0 {
		t.Fatalf("empty listing = %#v, %v", empty, err)
	}
	file, err := explorer.Read("README.md")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("hello workspace\n"))
	if string(file.Data) != "hello workspace\n" || file.SHA256 != hex.EncodeToString(digest[:]) || file.ContentType != "text/plain; charset=utf-8" {
		t.Fatalf("file = %#v", file)
	}

	for _, unsafe := range []string{"", "/etc/passwd", "../outside", "src/../README.md", `src\main.go`, ".git/config", ".GIT/config", ".zapcode/settings.json"} {
		if _, err := explorer.Read(unsafe); err == nil {
			t.Fatalf("unsafe read %q was accepted", unsafe)
		}
	}
	if symlinksAvailable {
		for _, link := range []string{"outside-link", "inside-link"} {
			if _, err := explorer.Read(link); err == nil {
				t.Fatalf("symlink read %q was accepted", link)
			}
		}
	}
}

func TestExplorerRejectsOversizedAndNonRegularContent(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "oversized.bin"), bytes.Repeat([]byte{'x'}, MaxContent+1))
	if err := os.Mkdir(filepath.Join(root, "directory"), 0o700); err != nil {
		t.Fatal(err)
	}
	explorer, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := explorer.Read("oversized.bin"); err == nil {
		t.Fatal("oversized file was accepted")
	}
	if _, err := explorer.Read("directory"); err == nil {
		t.Fatal("directory was accepted as a file")
	}
}

func TestExplorerWritesBoundedTextWithoutProtectedOrSymlinkTraversal(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0o700); err != nil {
		t.Fatal(err)
	}
	explorer, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := explorer.WriteText("src/generated.txt", []byte("generated\n")); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(root, "src", "generated.txt"))
	if err != nil || string(content) != "generated\n" {
		t.Fatalf("content = %q, %v", content, err)
	}
	for _, unsafe := range []string{".git/config", "../outside", "/tmp/outside", "src/../outside", `src\outside`, "src/binary"} {
		data := []byte("text")
		if unsafe == "src/binary" {
			data = []byte{'a', 0, 'b'}
		}
		if err := explorer.WriteText(unsafe, data); err == nil {
			t.Fatalf("unsafe write %q was accepted", unsafe)
		}
	}
	out := filepath.Join(t.TempDir(), "outside")
	mustWrite(t, out, []byte("secret"))
	if os.Symlink(out, filepath.Join(root, "linked")) == nil {
		if err := explorer.WriteText("linked", []byte("overwrite")); err == nil {
			t.Fatal("symlink write was accepted")
		}
	}
}

func TestExplorerProducesBoundedGitDiff(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is unavailable")
	}
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "tracked.txt"), []byte("before\n"))
	mustWrite(t, filepath.Join(root, "other.txt"), []byte("stable\n"))
	git(t, root, "init")
	git(t, root, "config", "user.email", "test@example.invalid")
	git(t, root, "config", "user.name", "zapVM Test")
	git(t, root, "add", "tracked.txt", "other.txt")
	git(t, root, "commit", "-m", "initial")
	mustWrite(t, filepath.Join(root, "tracked.txt"), []byte("after\n"))

	explorer, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	diff, err := explorer.GitDiff(context.Background(), "tracked.txt")
	if err != nil {
		t.Fatal(err)
	}
	text := string(diff.Data)
	if diff.Path != "tracked.txt" || diff.Size != int64(len(diff.Data)) || !strings.Contains(text, "-before") || !strings.Contains(text, "+after") || strings.Contains(text, "other.txt") {
		t.Fatalf("diff = %#v\n%s", diff, text)
	}
	if _, err := explorer.GitDiff(context.Background(), ".git/config"); err == nil {
		t.Fatal("protected Git metadata diff was accepted")
	}
}

func mustWrite(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func git(t *testing.T, root string, arguments ...string) {
	t.Helper()
	command := exec.Command("git", arguments...)
	command.Dir = root
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", arguments, err, output)
	}
}

func TestExplorerCompilesForSupportedPlatforms(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		t.Skip("workspace explorer is only shipped on supported Host platforms")
	}
}
