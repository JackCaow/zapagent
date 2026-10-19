package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	vmimage "zapvm/internal/image"
	"zapvm/internal/state"
)

func TestDiagnoseWritesExclusiveRedactedSnapshot(t *testing.T) {
	directory := t.TempDir()
	template := filepath.Join(directory, "template.raw")
	if err := os.WriteFile(template, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	disk := filepath.Join(directory, "managed.raw")
	if err := state.CreateFromTemplate(template, disk, "raw"); err != nil {
		t.Fatal(err)
	}
	handle, err := state.OpenForVM(disk, "sensitive-vm-id")
	if err != nil {
		t.Fatal(err)
	}
	if err := handle.MarkClean(state.CurrentStateSchema); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(directory, "manifest.json")
	manifest := vmimage.Manifest{
		SchemaVersion: 2, ImageVersion: "test", Architecture: "arm64", Protocol: 1,
		StateSchema: 2, CreatedAt: "2026-08-05T00:00:00Z",
		Files: []vmimage.ManifestFile{{Name: "kernel", Size: 1, SHA256: strings.Repeat("0", 64)}},
	}
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, manifestData, 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(directory, "diagnostic.json")
	if err := runDiagnose([]string{"--output", output, "--state-disk", disk, "--manifest", manifestPath}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), directory) || strings.Contains(string(data), "sensitive-vm-id") {
		t.Fatalf("diagnostic leaked a path or VM identifier: %s", data)
	}
	info, err := os.Stat(output)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("diagnostic mode = %o, want 600", info.Mode().Perm())
	}
	var snapshot diagnosticSnapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.States) != 1 || snapshot.States[0].Metadata == nil || snapshot.States[0].Metadata.LastVMID != "" {
		t.Fatalf("unexpected state diagnostic: %+v", snapshot.States)
	}
	if len(snapshot.Images) != 1 || snapshot.Images[0].StateSchema != 2 || snapshot.Images[0].FileCount != 1 {
		t.Fatalf("unexpected image diagnostic: %+v", snapshot.Images)
	}
	if err := runDiagnose([]string{"--output", output}); err == nil {
		t.Fatal("diagnose overwrote an existing output")
	}
}

func TestDiagnosticManifestRejectsSchemaOneWithStateSchemaTwo(t *testing.T) {
	manifest := vmimage.Manifest{
		SchemaVersion: 1, StateSchema: 2, ImageVersion: "bad", Architecture: "arm64", Protocol: 1,
		CreatedAt: "2026-08-05T00:00:00Z",
		Files:     []vmimage.ManifestFile{{Name: "kernel", Size: 1, SHA256: strings.Repeat("0", 64)}},
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := vmimage.DecodeManifest(data); err == nil {
		t.Fatal("schema 1 manifest with explicit state schema 2 was accepted")
	}
}

func TestDiagnoseDefaultNeverCollectsEnvironmentOrWorkspaceContents(t *testing.T) {
	const canary = "ZAPVM_DIAGNOSTIC_SECRET_CANARY_7f44f60b"
	t.Setenv("ZAPVM_DIAGNOSTIC_SECRET", canary)
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace-sensitive-name")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "private.txt"), []byte(canary), 0o600); err != nil {
		t.Fatal(err)
	}
	missingState := filepath.Join(workspace, canary+".raw")
	output := filepath.Join(root, "diagnostic.json")
	if err := runDiagnose([]string{"--output", output, "--state-disk", missingState}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, forbidden := range []string{canary, workspace, "private.txt", "workspace-sensitive-name", "ZAPVM_DIAGNOSTIC_SECRET"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("default diagnostic collected forbidden value %q: %s", forbidden, text)
		}
	}
	if !strings.Contains(text, `"path_id"`) || !strings.Contains(text, `"error"`) {
		t.Fatalf("redacted failure lost useful diagnostic structure: %s", text)
	}
}
