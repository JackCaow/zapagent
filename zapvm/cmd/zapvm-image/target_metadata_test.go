package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCreateTargetMetadataFromVerifiedLayeredManifest(t *testing.T) {
	root := t.TempDir()
	_, publicKey, manifestPath, signaturePath := makeSignedLayeredImageFixture(t, root, "3.0.0-layered", "arm64")
	output := filepath.Join(root, "target-custom.json")
	arguments := []string{
		"--manifest", manifestPath,
		"--signature", signaturePath,
		"--public-key", publicKey,
		"--release-sequence", "42",
		"--output", output,
	}
	if err := createTargetMetadata(arguments); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	var custom updateTargetCustom
	if err := json.Unmarshal(data, &custom); err != nil {
		t.Fatal(err)
	}
	want := updateTargetLayers{Base: "alpine-3.23.5-r1", Runtime: "3.0.0", Agent: "1.12.0", Session: "3"}
	if custom.SchemaVersion != 2 || custom.ReleaseSequence != 42 || custom.ImageVersion != "3.0.0-layered" || custom.Layers == nil || *custom.Layers != want {
		t.Fatalf("unexpected generated target metadata: %+v", custom)
	}
	if err := createTargetMetadata(arguments); err == nil {
		t.Fatal("target metadata overwrote an existing output")
	}
}

func TestCreateTargetMetadataRejectsTamperedManifest(t *testing.T) {
	root := t.TempDir()
	_, publicKey, manifestPath, signaturePath := makeSignedLayeredImageFixture(t, root, "3.0.0-layered", "arm64")
	if err := os.WriteFile(manifestPath, append(mustRead(t, manifestPath), ' '), 0o644); err != nil {
		t.Fatal(err)
	}
	err := createTargetMetadata([]string{
		"--manifest", manifestPath,
		"--signature", signaturePath,
		"--public-key", publicKey,
		"--release-sequence", "42",
		"--output", filepath.Join(root, "target-custom.json"),
	})
	if err == nil {
		t.Fatal("tampered manifest produced TUF target metadata")
	}
}
