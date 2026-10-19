package artifactcollector

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"zapvm/internal/daemonrpc"
)

type testClock struct{ now time.Time }

func (clock *testClock) Now() time.Time { return clock.now }

func TestCollectorSnapshotsRedeemsExpiresAndReleases(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 8, 4, 0, 0, 0, time.UTC)}
	root := t.TempDir()
	collector, err := Open(filepath.Join(root, "spool"), Options{
		TTL: time.Minute, Now: clock.Now, Random: bytes.NewReader(bytes.Repeat([]byte{0x31}, 128)),
		MaxFileSize: 1024, MaxTotalSize: 4096,
	})
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "workspace")
	output, _ := daemonrpc.ArtifactOutputPath("task-a")
	if err := os.MkdirAll(filepath.Join(workspace, filepath.FromSlash(output), "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, filepath.FromSlash(output), "report.txt"), []byte("hello artifact\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, filepath.FromSlash(output), "nested", "result.json"), []byte(`{"ok":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	collection, err := collector.Collect(workspace, "task-a")
	if err != nil || len(collection.Artifacts) != 2 || len(collection.Capability) != 43 {
		t.Fatalf("collection = %#v, %v", collection, err)
	}
	if collection.Artifacts[0].Path != "nested/result.json" || collection.Artifacts[1].Path != "report.txt" {
		t.Fatalf("Artifact order = %#v", collection.Artifacts)
	}
	file, metadata, err := collector.OpenArtifact(collection.Capability, collection.Artifacts[1].ID)
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(file)
	_ = file.Close()
	if readErr != nil || string(data) != "hello artifact\n" || metadata.SHA256 != collection.Artifacts[1].SHA256 {
		t.Fatalf("redeemed Artifact = %q %#v, %v", data, metadata, readErr)
	}
	clock.now = clock.now.Add(time.Minute + time.Second)
	if _, _, err := collector.OpenArtifact(collection.Capability, collection.Artifacts[0].ID); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired capability error = %v", err)
	}
	second, err := collector.Collect(workspace, "task-a")
	if err != nil {
		t.Fatal(err)
	}
	if err := collector.Release(second.Capability); err != nil {
		t.Fatal(err)
	}
	if _, _, err := collector.OpenArtifact(second.Capability, second.Artifacts[0].ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("released capability error = %v", err)
	}
}

func TestCollectorRejectsLinksProtectedPathsAndLimitsAtomically(t *testing.T) {
	root := t.TempDir()
	collector, err := Open(filepath.Join(root, "spool"), Options{
		TTL: time.Minute, Random: bytes.NewReader(bytes.Repeat([]byte{0x42}, 128)), MaxFiles: 2, MaxFileSize: 16, MaxTotalSize: 32,
	})
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "workspace")
	output, _ := daemonrpc.ArtifactOutputPath("task-b")
	directory := filepath.Join(workspace, filepath.FromSlash(output))
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "secret")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(directory, "linked")); err != nil {
		t.Fatal(err)
	}
	if _, err := collector.Collect(workspace, "task-b"); err == nil || !strings.Contains(err.Error(), "link") {
		t.Fatalf("link collection error = %v", err)
	}
	if err := os.Remove(filepath.Join(directory, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(directory, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, ".git", "config"), []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := collector.Collect(workspace, "task-b"); err == nil || !strings.Contains(err.Error(), "protected") {
		t.Fatalf("protected collection error = %v", err)
	}
	if err := os.RemoveAll(filepath.Join(directory, ".git")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "too-large.bin"), bytes.Repeat([]byte{1}, 17), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := collector.Collect(workspace, "task-b"); err == nil || !strings.Contains(err.Error(), "size limit") {
		t.Fatalf("oversized collection error = %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(root, "spool"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed collection left spool entries %#v, %v", entries, err)
	}
}
