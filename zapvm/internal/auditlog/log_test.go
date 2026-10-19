package auditlog

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestLogPersistsRedactedHashChainAcrossRuns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lifecycle.jsonl")
	first, err := Open(path, "sensitive-workspace-vm")
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Append("run_requested", "preflight"); err != nil {
		t.Fatal(err)
	}
	if err := first.Append("vm_started", "starting"); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := Open(path, "sensitive-workspace-vm")
	if err != nil {
		t.Fatal(err)
	}
	if err := second.Append("run_completed", "stopped"); err != nil {
		t.Fatal(err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte("sensitive-workspace-vm")) {
		t.Fatalf("audit log leaked VM ID: %s", data)
	}
	if lines := bytes.Count(data, []byte{'\n'}); lines != 3 {
		t.Fatalf("record lines = %d, want 3", lines)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("audit mode = %o", info.Mode().Perm())
	}
	verification, err := Open(path, "verification-run")
	if err != nil {
		t.Fatal(err)
	}
	if err := verification.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestLogRejectsTamperingAndSymlink(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "lifecycle.jsonl")
	log, err := Open(path, "vm")
	if err != nil {
		t.Fatal(err)
	}
	if err := log.Append("vm_started", "starting"); err != nil {
		t.Fatal(err)
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = bytes.Replace(data, []byte("vm_started"), []byte("vm_stopped"), 1)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(path, "vm"); err == nil || !strings.Contains(err.Error(), "invalid hash") {
		t.Fatalf("tampered log error = %v", err)
	}
	target := filepath.Join(directory, "target")
	if err := os.WriteFile(target, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(directory, "link")
	if err := os.Symlink(target, symlink); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(symlink, "vm"); err == nil {
		t.Fatal("audit symlink was accepted")
	}
}

func TestLogRejectsPartialAndUnknownRecords(t *testing.T) {
	directory := t.TempDir()
	partial := filepath.Join(directory, "partial.jsonl")
	if err := os.WriteFile(partial, []byte(`{"schema_version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(partial, "vm"); err == nil || !strings.Contains(err.Error(), "partial record") {
		t.Fatalf("partial log error = %v", err)
	}
	unknown := filepath.Join(directory, "unknown.jsonl")
	if err := os.WriteFile(unknown, []byte("{\"schema_version\":1,\"unknown\":true}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(unknown, "vm"); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("unknown-field log error = %v", err)
	}
}

func TestConcurrentLogsSerializeChainUpdates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lifecycle.jsonl")
	left, err := Open(path, "left")
	if err != nil {
		t.Fatal(err)
	}
	right, err := Open(path, "right")
	if err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	for _, log := range []*Log{left, right} {
		log := log
		wait.Add(1)
		go func() {
			defer wait.Done()
			for index := 0; index < 20; index++ {
				if err := log.Append("heartbeat_ok", "running"); err != nil {
					t.Errorf("append: %v", err)
					return
				}
			}
		}()
	}
	wait.Wait()
	if err := left.Close(); err != nil {
		t.Fatal(err)
	}
	if err := right.Close(); err != nil {
		t.Fatal(err)
	}
	verification, err := Open(path, "verification")
	if err != nil {
		t.Fatal(err)
	}
	if err := verification.Close(); err != nil {
		t.Fatal(err)
	}
}
