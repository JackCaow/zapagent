package remoteauth

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestAuditLogPersistsAndDetectsTampering(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remote.jsonl")
	log, err := OpenAudit(path, "host-a")
	if err != nil {
		t.Fatal(err)
	}
	event := AuditEvent{
		RequestID: "request-a", Principal: testPrincipal, TenantID: "acme", ProjectID: "weather",
		Action: "computer.inspect", ComputerID: "computer-a", Decision: "allow", Outcome: "authorized",
	}
	if err := log.Append(event); err != nil {
		t.Fatal(err)
	}
	event.Outcome = "success"
	if err := log.Append(event); err != nil {
		t.Fatal(err)
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenAudit(path, "host-a")
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	tampered := bytes.Replace(data, []byte(`"outcome":"success"`), []byte(`"outcome":"failure"`), 1)
	if bytes.Equal(data, tampered) {
		t.Fatal("test did not alter the audit record")
	}
	if err := os.WriteFile(path, tampered, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenAudit(path, "host-a"); err == nil {
		t.Fatal("expected tampered audit chain to be rejected")
	}
}

func TestAuditLogRejectsSensitiveFreeFormFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remote.jsonl")
	log, err := OpenAudit(path, "host-a")
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	event := AuditEvent{
		RequestID: "request-a", Principal: testPrincipal, TenantID: "acme", ProjectID: "weather",
		Action: "computer.inspect;cat-token", ComputerID: "computer-a", Decision: "allow", Outcome: "success",
	}
	if err := log.Append(event); err == nil {
		t.Fatal("expected unknown audit action rejection")
	}
}

func TestValidateAuditTargetDoesNotCreateLog(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remote.jsonl")
	if err := ValidateAuditTarget(path, "host-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("audit validation created or changed its target: %v", err)
	}
}

func TestValidateAuditTargetRejectsExistingBroadFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows authority is validated through its DACL, not POSIX mode bits")
	}
	path := filepath.Join(t.TempDir(), "remote.jsonl")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAuditTarget(path, "host-a"); err == nil {
		t.Fatal("expected broad existing audit file to be rejected")
	}
}
