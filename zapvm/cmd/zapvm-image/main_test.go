package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"zapvm/internal/agentpackage"
)

func TestIndependentAgentManifestSignAndVerify(t *testing.T) {
	directory := t.TempDir()
	for _, file := range []string{"agent.raw", "agent.vhdx"} {
		if err := os.WriteFile(filepath.Join(directory, file), []byte(file), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	provenance := `{"schema_version":1,"agent_version":"1.12.0","source_commit":"0123456789abcdef0123456789abcdef01234567","build_target":"linux-arm64","builder_version":"test","binary_sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}`
	if err := os.WriteFile(filepath.Join(directory, "agent-provenance.json"), []byte(provenance), 0o600); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(directory, "agent.json")
	if err := createAgentManifest([]string{
		"--id", "zapcode", "--version", "1.12.0", "--arch", "arm64", "--created-at", "2026-08-13T00:00:00Z", "--output", manifestPath,
		filepath.Join(directory, "agent.raw"), filepath.Join(directory, "agent.vhdx"), filepath.Join(directory, "agent-provenance.json"),
	}); err != nil {
		t.Fatal(err)
	}
	privatePath := filepath.Join(directory, "private.pem")
	publicPath := filepath.Join(directory, "public.pem")
	if err := generateKeys([]string{"--private", privatePath, "--public", publicPath}); err != nil {
		t.Fatal(err)
	}
	signaturePath := filepath.Join(directory, "agent.sig")
	if err := signAgentManifest([]string{"--manifest", manifestPath, "--private-key", privatePath, "--output", signaturePath}); err != nil {
		t.Fatal(err)
	}
	if _, _, digest, err := agentpackage.Verify(manifestPath, signaturePath, publicPath, directory); err != nil || digest == "" {
		t.Fatalf("verify independent Agent package: digest=%q err=%v", digest, err)
	}
}

func TestDecodeManifestSupportsLegacyStateSchema(t *testing.T) {
	legacy := map[string]any{
		"schema_version": 1, "image_version": "legacy", "architecture": "arm64",
		"protocol_version": 1, "created_at": "2026-08-05T00:00:00Z",
		"files": []map[string]any{{"name": "kernel", "size": 1, "sha256": strings.Repeat("0", 64)}},
	}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeManifest(data)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.StateSchema != 1 {
		t.Fatalf("legacy state schema = %d, want 1", decoded.StateSchema)
	}
}

func TestCreateManifestSchemaThreeAssignsVersionedLayers(t *testing.T) {
	directory := t.TempDir()
	inputs := make([]string, 0, 14)
	for _, name := range []string{
		"rootfs.raw", "rootfs.vhdx", "kernel", "initramfs", "cloud-hypervisor", "virtiofsd",
		"linux-runtime-provenance.json", "capabilities.json", "sbom.spdx.json", "source-offer.json",
		"agent.raw", "agent.vhdx", "agent-provenance.json", "state.raw", "state.vhdx",
	} {
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
		inputs = append(inputs, path)
	}
	output := filepath.Join(directory, "manifest.json")
	arguments := []string{
		"--arch", "arm64", "--version", "release-3", "--output", output,
		"--base-version", "base-1", "--runtime-version", "runtime-2",
		"--agent-version", "zap-3", "--session-version", "state-3",
	}
	arguments = append(arguments, inputs...)
	if err := createManifest(arguments); err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeManifest(mustRead(t, output))
	if err != nil {
		t.Fatal(err)
	}
	if decoded.SchemaVersion != 3 || len(decoded.Layers) != 4 || decoded.Layers[2].Version != "zap-3" {
		t.Fatalf("unexpected layered manifest: %+v", decoded)
	}
	if !slices.Contains(decoded.Layers[2].Files, "agent-provenance.json") {
		t.Fatalf("Agent provenance was not assigned to the Agent layer: %+v", decoded.Layers[2])
	}
}

func TestCreateManifestHostRuntimeOmitsAgentLayer(t *testing.T) {
	directory := t.TempDir()
	var inputs []string
	for _, name := range []string{
		"rootfs.raw", "rootfs.vhdx", "kernel", "initramfs", "cloud-hypervisor", "virtiofsd",
		"linux-runtime-provenance.json", "capabilities.json", "sbom.spdx.json", "source-offer.json",
		"state.raw", "state.vhdx",
	} {
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
		inputs = append(inputs, path)
	}
	output := filepath.Join(directory, "manifest.json")
	arguments := []string{
		"--profile", "host-runtime", "--arch", "arm64", "--version", "host-1", "--output", output,
		"--base-version", "base-1", "--runtime-version", "runtime-1", "--session-version", "state-3",
	}
	if err := createManifest(append(arguments, inputs...)); err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeManifest(mustRead(t, output))
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Profile != "host-runtime" || len(decoded.Layers) != 3 {
		t.Fatalf("unexpected Host manifest: %+v", decoded)
	}
	for _, layer := range decoded.Layers {
		if layer.Name == "agent" {
			t.Fatal("Host manifest unexpectedly declared an Agent layer")
		}
	}
	agentPath := filepath.Join(directory, "agent.raw")
	if err := os.WriteFile(agentPath, []byte("agent"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := createManifest(append(arguments, append(inputs, agentPath)...)); err == nil || !strings.Contains(err.Error(), "must not contain agent.raw") {
		t.Fatalf("Host manifest accepted Agent bytes: %v", err)
	}
}

func TestExtractARM64ImageFromGzipWrapper(t *testing.T) {
	image := make([]byte, 128)
	copy(image[56:60], []byte{'A', 'R', 'M', 0x64})
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(image); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	wrapper := append(bytes.Repeat([]byte{0xff}, 73), compressed.Bytes()...)
	got, err := extractARM64Image(wrapper)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, image) {
		t.Fatal("extracted image differs")
	}
}

func TestExtractARM64ImageRejectsInvalidData(t *testing.T) {
	if _, err := extractARM64Image([]byte("not a kernel")); err == nil {
		t.Fatal("invalid data unexpectedly accepted")
	}
}

func TestSignedBundleVerifyInstallAndTamperRejection(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.Mkdir(source, 0o755); err != nil {
		t.Fatal(err)
	}
	inputs := make([]string, 0, 3)
	for name, data := range map[string]string{
		"kernel": "kernel-data", "initramfs": "initramfs-data", "rootfs.raw": "rootfs-data",
	} {
		path := filepath.Join(source, name)
		if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
		inputs = append(inputs, path)
	}
	manifestPath := filepath.Join(source, "manifest.json")
	manifestArgs := []string{"--arch", "arm64", "--output", manifestPath, "--version", "test-1"}
	manifestArgs = append(manifestArgs, inputs...)
	if err := createManifest(manifestArgs); err != nil {
		t.Fatal(err)
	}
	privatePath := filepath.Join(root, "private.pem")
	publicPath := filepath.Join(root, "public.pem")
	if err := generateKeys([]string{"--private", privatePath, "--public", publicPath}); err != nil {
		t.Fatal(err)
	}
	signaturePath := filepath.Join(source, "manifest.sig")
	if err := signManifest([]string{"--manifest", manifestPath, "--private-key", privatePath, "--output", signaturePath}); err != nil {
		t.Fatal(err)
	}
	if err := verifyManifest([]string{"--manifest", manifestPath, "--signature", signaturePath, "--public-key", publicPath}); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "installed", "test-1")
	if err := installImage([]string{"--manifest", manifestPath, "--signature", signaturePath, "--public-key", publicPath, "--destination", destination}); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(destination, "rootfs.raw")); err != nil || string(data) != "rootfs-data" {
		t.Fatalf("installed rootfs=%q err=%v", data, err)
	}
	if err := installImage([]string{"--manifest", manifestPath, "--signature", signaturePath, "--public-key", publicPath, "--destination", destination}); err == nil {
		t.Fatal("installer unexpectedly replaced existing destination")
	}
	installedRoot := filepath.Dir(destination)
	if err := activateImage([]string{"--root", installedRoot, "--version", "test-1", "--public-key", publicPath}); err != nil {
		t.Fatal(err)
	}
	secondSource := filepath.Join(root, "source-2")
	if err := os.Mkdir(secondSource, 0o755); err != nil {
		t.Fatal(err)
	}
	secondInputs := make([]string, 0, 3)
	for name, data := range map[string]string{
		"kernel": "kernel-data-2", "initramfs": "initramfs-data-2", "rootfs.raw": "rootfs-data-2",
	} {
		path := filepath.Join(secondSource, name)
		if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
		secondInputs = append(secondInputs, path)
	}
	secondManifest := filepath.Join(secondSource, "manifest.json")
	secondManifestArgs := []string{"--arch", "arm64", "--output", secondManifest, "--version", "test-2"}
	secondManifestArgs = append(secondManifestArgs, secondInputs...)
	if err := createManifest(secondManifestArgs); err != nil {
		t.Fatal(err)
	}
	secondSignature := filepath.Join(secondSource, "manifest.sig")
	if err := signManifest([]string{"--manifest", secondManifest, "--private-key", privatePath, "--output", secondSignature}); err != nil {
		t.Fatal(err)
	}
	secondDestination := filepath.Join(installedRoot, "test-2")
	if err := installImage([]string{"--manifest", secondManifest, "--signature", secondSignature, "--public-key", publicPath, "--destination", secondDestination}); err != nil {
		t.Fatal(err)
	}
	if err := activateImage([]string{"--root", installedRoot, "--version", "test-2", "--public-key", publicPath}); err != nil {
		t.Fatal(err)
	}
	active, err := readActivation(installedRoot)
	if err != nil {
		t.Fatal(err)
	}
	if active.ActiveVersion != "test-2" || active.PreviousVersion != "test-1" || active.Generation != 2 {
		t.Fatalf("unexpected activation state: %+v", active)
	}
	installedKernel := filepath.Join(destination, "kernel")
	if err := os.WriteFile(installedKernel, []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := rollbackImage([]string{"--root", installedRoot, "--public-key", publicPath}); err == nil {
		t.Fatal("rollback unexpectedly accepted a tampered previous version")
	}
	unchanged, err := readActivation(installedRoot)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged != active {
		t.Fatalf("failed rollback changed activation: before=%+v after=%+v", active, unchanged)
	}
	if err := os.WriteFile(installedKernel, []byte("kernel-data"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := rollbackImage([]string{"--root", installedRoot, "--public-key", publicPath}); err != nil {
		t.Fatal(err)
	}
	rolledBack, err := readActivation(installedRoot)
	if err != nil {
		t.Fatal(err)
	}
	if rolledBack.ActiveVersion != "test-1" || rolledBack.PreviousVersion != "test-2" || rolledBack.Generation != 3 {
		t.Fatalf("unexpected rollback state: %+v", rolledBack)
	}
	if err := os.WriteFile(filepath.Join(source, "kernel"), []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verifyManifest([]string{"--manifest", manifestPath, "--signature", signaturePath, "--public-key", publicPath}); err == nil {
		t.Fatal("tampered image unexpectedly verified")
	}
}

func TestVerifyManifestFilesRejectsTraversalAndSymlink(t *testing.T) {
	directory := t.TempDir()
	if err := verifyManifestFiles(directory, manifest{Files: []manifestFile{{Name: "../escape"}}}); err == nil {
		t.Fatal("path traversal unexpectedly accepted")
	}
	target := filepath.Join(directory, "target")
	if err := os.WriteFile(target, []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(directory, "link")); err != nil {
		t.Fatal(err)
	}
	if err := verifyManifestFiles(directory, manifest{Files: []manifestFile{{Name: "link", Size: 4}}}); err == nil {
		t.Fatal("symlink unexpectedly accepted")
	}
}

func TestImageNamesAcceptXAndZeroButRejectNUL(t *testing.T) {
	if err := validateVersionName("0.1.0-linux"); err != nil {
		t.Fatalf("valid release version was rejected: %v", err)
	}
	directory := t.TempDir()
	path := filepath.Join(directory, "rootfs.vhdx")
	if err := os.WriteFile(path, []byte("vhdx"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verifyManifestFiles(directory, manifest{Files: []manifestFile{{Name: "rootfs.vhdx", Size: 4, SHA256: "9e913e127bce25e42f8ab2877eb8a480a34877b5bae008261c6e4ba59f9a7e00"}}}); err != nil {
		t.Fatalf("valid VHDX name was rejected: %v", err)
	}
	if err := validateVersionName("bad\x00version"); err == nil {
		t.Fatal("NUL-containing version was accepted")
	}
}
