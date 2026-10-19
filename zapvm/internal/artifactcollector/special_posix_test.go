//go:build darwin || linux

package artifactcollector

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"zapvm/internal/daemonrpc"
)

func TestCollectorRejectsSpecialFile(t *testing.T) {
	root := t.TempDir()
	collector, err := Open(filepath.Join(root, "spool"), Options{
		TTL: time.Minute, Random: bytes.NewReader(bytes.Repeat([]byte{0x53}, 64)), MaxFileSize: 1024, MaxTotalSize: 2048,
	})
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "workspace")
	output, _ := daemonrpc.ArtifactOutputPath("task-special")
	directory := filepath.Join(workspace, filepath.FromSlash(output))
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(directory, "pipe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := collector.Collect(workspace, "task-special"); err == nil || !strings.Contains(err.Error(), "special") {
		t.Fatalf("special file collection error = %v", err)
	}
}
