package state

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestCreateOpenAndCleanState(t *testing.T) {
	directory := t.TempDir()
	template := filepath.Join(directory, "template.raw")
	content := bytes.Repeat([]byte("state-template"), 1024)
	if err := os.WriteFile(template, content, 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(directory, "vm-state.raw")
	if err := CreateFromTemplate(template, output, "raw"); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Fatal("state disk differs from template")
	}
	created, err := Inspect(output)
	if err != nil {
		t.Fatal(err)
	}
	if created.SchemaVersion != CurrentMetadataSchema || created.StateSchema != CurrentStateSchema {
		t.Fatalf("unexpected created schemas: %+v", created)
	}
	handle, err := OpenForVM(output, "vm-one")
	if err != nil {
		t.Fatal(err)
	}
	if handle.PreviousDirty() {
		t.Fatal("new state disk was reported dirty")
	}
	if handle.Metadata().CleanShutdown || handle.Metadata().Generation != 1 {
		t.Fatalf("unexpected attached metadata: %+v", handle.Metadata())
	}
	if _, err := OpenForVM(output, "vm-two"); err == nil {
		t.Fatal("expected concurrent state attachment to fail")
	}
	if err := handle.MarkClean(CurrentStateSchema); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenForVM(output, "vm-two")
	if err != nil {
		t.Fatal(err)
	}
	if reopened.PreviousDirty() {
		t.Fatal("clean shutdown was not persisted")
	}
	if reopened.Metadata().Generation != 2 {
		t.Fatalf("generation = %d, want 2", reopened.Metadata().Generation)
	}
	if err := reopened.CloseDirty(); err != nil {
		t.Fatal(err)
	}
	dirty, err := OpenForVM(output, "vm-three")
	if err != nil {
		t.Fatal(err)
	}
	if !dirty.PreviousDirty() {
		t.Fatal("unclean shutdown was not detected")
	}
	if err := dirty.CloseDirty(); err != nil {
		t.Fatal(err)
	}
}

func TestLegacyMetadataIsNormalizedAndCommittedAfterCleanMigration(t *testing.T) {
	directory := t.TempDir()
	template := filepath.Join(directory, "template.raw")
	if err := os.WriteFile(template, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(directory, "legacy.raw")
	if err := CreateFromTemplateSchema(template, output, "raw", 1); err != nil {
		t.Fatal(err)
	}
	metadata, err := Inspect(output)
	if err != nil {
		t.Fatal(err)
	}
	metadata.SchemaVersion = 1
	metadata.StateSchema = 0
	if err := writeMetadata(MetadataPath(output), metadata); err != nil {
		t.Fatal(err)
	}
	handle, err := OpenForVM(output, "migration-vm")
	if err != nil {
		t.Fatal(err)
	}
	if handle.Metadata().SchemaVersion != CurrentMetadataSchema || handle.Metadata().StateSchema != 1 {
		t.Fatalf("legacy metadata was not normalized safely: %+v", handle.Metadata())
	}
	if err := handle.MarkClean(CurrentStateSchema); err != nil {
		t.Fatal(err)
	}
	committed, err := Inspect(output)
	if err != nil {
		t.Fatal(err)
	}
	if committed.SchemaVersion != CurrentMetadataSchema || committed.StateSchema != CurrentStateSchema || !committed.CleanShutdown {
		t.Fatalf("clean migration was not committed: %+v", committed)
	}
}

func TestMarkCleanRejectsStateSchemaDowngrade(t *testing.T) {
	directory := t.TempDir()
	template := filepath.Join(directory, "template.raw")
	if err := os.WriteFile(template, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(directory, "state.raw")
	if err := CreateFromTemplate(template, output, "raw"); err != nil {
		t.Fatal(err)
	}
	handle, err := OpenForVM(output, "vm")
	if err != nil {
		t.Fatal(err)
	}
	if err := handle.MarkClean(1); err == nil {
		t.Fatal("state schema downgrade was accepted")
	}
	if err := handle.Restore(); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreAfterFailedStart(t *testing.T) {
	directory := t.TempDir()
	template := filepath.Join(directory, "template.raw")
	if err := os.WriteFile(template, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(directory, "state.raw")
	if err := CreateFromTemplate(template, output, "raw"); err != nil {
		t.Fatal(err)
	}
	handle, err := OpenForVM(output, "failed-vm")
	if err != nil {
		t.Fatal(err)
	}
	if err := handle.Restore(); err != nil {
		t.Fatal(err)
	}
	again, err := OpenForVM(output, "next-vm")
	if err != nil {
		t.Fatal(err)
	}
	if again.PreviousDirty() || again.Metadata().Generation != 1 {
		t.Fatalf("failed start metadata was not restored: %+v", again.Metadata())
	}
	_ = again.CloseDirty()
}

func TestCreateRejectsOverwriteAndSymlink(t *testing.T) {
	directory := t.TempDir()
	template := filepath.Join(directory, "template.raw")
	if err := os.WriteFile(template, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(directory, "state.raw")
	if err := os.WriteFile(output, []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := CreateFromTemplate(template, output, "raw"); err == nil {
		t.Fatal("expected overwrite rejection")
	}
	link := filepath.Join(directory, "link.raw")
	if err := os.Symlink(template, link); err != nil {
		t.Fatal(err)
	}
	if err := CreateFromTemplate(link, filepath.Join(directory, "other.raw"), "raw"); err == nil {
		t.Fatal("expected symlink template rejection")
	}
	if _, err := os.Stat(MetadataPath(output)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unexpected metadata after failed create: %v", err)
	}
}

func TestCreateRawStateWithSparseComputerCapacity(t *testing.T) {
	directory := t.TempDir()
	template := filepath.Join(directory, "template.raw")
	if err := os.WriteFile(template, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(directory, "computer.raw")
	const capacity = int64(64 << 20)
	if err := CreateFromTemplateSchemaCapacity(template, output, "raw", CurrentStateSchema, capacity); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(output)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != capacity {
		t.Fatalf("state capacity = %d, want %d", info.Size(), capacity)
	}
	file, err := os.Open(output)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	prefix := make([]byte, len("state"))
	if _, err := io.ReadFull(file, prefix); err != nil {
		t.Fatal(err)
	}
	if string(prefix) != "state" {
		t.Fatalf("state prefix = %q", prefix)
	}
}
