package image

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestResolveActiveSelectsPlatformArtifactsAndRejectsTamper(t *testing.T) {
	root, publicKey := writeInstalledFixture(t, "release-1", "arm64")
	resolved, err := ResolveActive(root, publicKey, "darwin", "arm64")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(resolved.KernelPath) != "kernel" || filepath.Base(resolved.RootDiskPath) != "rootfs.raw" || filepath.Base(resolved.StateTemplate) != "state.raw" {
		t.Fatalf("unexpected Darwin resolution: %+v", resolved)
	}
	resolved, err = ResolveActive(root, publicKey, "windows", "arm64")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(resolved.RootDiskPath) != "rootfs.vhdx" || filepath.Base(resolved.StateTemplate) != "state.vhdx" {
		t.Fatalf("unexpected Windows resolution: %+v", resolved)
	}
	resolved, err = ResolveActive(root, publicKey, "linux", "arm64")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(resolved.VMMPath) != "cloud-hypervisor" || resolved.VMMVersion != "v53.0" || resolved.VirtioVersion != "v1.14.0" {
		t.Fatalf("unexpected Linux runtime resolution: %+v", resolved)
	}
	if _, err := ResolveActive(root, publicKey, "linux", "amd64"); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("architecture mismatch was not rejected: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "release-1", "kernel"), []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveActive(root, publicKey, "linux", "arm64"); err == nil || !strings.Contains(err.Error(), "size mismatch") {
		t.Fatalf("tampered active image was not rejected: %v", err)
	}
}

func TestResolveActiveRejectsSymlinkedActivation(t *testing.T) {
	root, publicKey := writeInstalledFixture(t, "release-1", "arm64")
	activation := filepath.Join(root, "active.json")
	target := filepath.Join(root, "activation-target.json")
	if err := os.Rename(activation, target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, activation); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveActive(root, publicKey, "darwin", "arm64"); err == nil || !strings.Contains(err.Error(), "regular file") {
		t.Fatalf("symlinked activation was not rejected: %v", err)
	}
}

func TestResolveActiveRejectsWrongLinuxRuntimeArchitecture(t *testing.T) {
	root, publicKey := writeInstalledFixtureWithRuntimeArchitecture(t, "release-1", "arm64", "amd64")
	if _, err := ResolveActive(root, publicKey, "linux", "arm64"); err == nil || !strings.Contains(err.Error(), "Linux arm64 executable") {
		t.Fatalf("wrong ELF architecture was not rejected: %v", err)
	}
}

func TestResolveVersionDoesNotRequireOrMutateActivation(t *testing.T) {
	root, publicKey := writeInstalledFixture(t, "candidate-2", "arm64")
	activationPath := filepath.Join(root, "active.json")
	if err := os.Remove(activationPath); err != nil {
		t.Fatal(err)
	}
	resolved, err := ResolveVersion(root, "candidate-2", publicKey, "darwin", "arm64")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Manifest.ImageVersion != "candidate-2" {
		t.Fatalf("resolved version=%q", resolved.Manifest.ImageVersion)
	}
	if _, err := os.Lstat(activationPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("candidate resolution created activation state: %v", err)
	}
}

func TestDecodeManifestSchemaThreeEnforcesLayerContract(t *testing.T) {
	files := []ManifestFile{}
	for _, name := range []string{
		"rootfs.raw", "rootfs.vhdx", "kernel", "initramfs", "cloud-hypervisor", "virtiofsd",
		"linux-runtime-provenance.json", "capabilities.json", "sbom.spdx.json", "source-offer.json",
		"agent.raw", "agent.vhdx", "agent-provenance.json", "state.raw", "state.vhdx",
	} {
		files = append(files, ManifestFile{Name: name, Size: 1, SHA256: strings.Repeat("a", 64)})
	}
	manifest := Manifest{
		SchemaVersion: 3, ImageVersion: "release-3", Architecture: "arm64", Protocol: 1, StateSchema: 3,
		CreatedAt: "2026-08-05T00:00:00Z", Files: files,
		Layers: []ManifestLayer{
			{Name: "base", Version: "base-1", Files: []string{"rootfs.raw", "rootfs.vhdx"}},
			{Name: "runtime", Version: "runtime-2", Files: []string{
				"kernel", "initramfs", "cloud-hypervisor", "virtiofsd",
				"linux-runtime-provenance.json", "capabilities.json", "sbom.spdx.json", "source-offer.json",
			}},
			{Name: "agent", Version: "zap-3", Files: []string{"agent.raw", "agent.vhdx", "agent-provenance.json"}},
			{Name: "session", Version: "state-3", Files: []string{"state.raw", "state.vhdx"}},
		},
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeManifest(data)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Layers[2].Version != "zap-3" {
		t.Fatalf("layer versions were not preserved: %+v", decoded.Layers)
	}
	manifest.Layers[2].Files = []string{"rootfs.raw", "agent.raw", "agent.vhdx", "agent-provenance.json"}
	data, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeManifest(data); err == nil || !strings.Contains(err.Error(), "belongs to both") {
		t.Fatalf("cross-layer duplicate was not rejected: %v", err)
	}
	manifest.Layers[2].Files = []string{"agent.raw", "agent.vhdx", "agent-provenance.json", "capabilities.json"}
	manifest.Layers[1].Files = []string{
		"kernel", "initramfs", "cloud-hypervisor", "virtiofsd",
		"linux-runtime-provenance.json", "sbom.spdx.json", "source-offer.json",
	}
	data, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeManifest(data); err == nil || !strings.Contains(err.Error(), "capabilities.json in the runtime layer") {
		t.Fatalf("misclassified runtime artifact was not rejected: %v", err)
	}
	manifest.Layers[2].Files = []string{"agent.raw", "agent.vhdx"}
	manifest.Layers[1].Files = []string{
		"kernel", "initramfs", "cloud-hypervisor", "virtiofsd",
		"linux-runtime-provenance.json", "capabilities.json", "sbom.spdx.json", "source-offer.json", "agent-provenance.json",
	}
	data, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeManifest(data); err == nil || !strings.Contains(err.Error(), "agent-provenance.json in the agent layer") {
		t.Fatalf("misclassified Agent provenance was not rejected: %v", err)
	}
}

func TestDecodeManifestHostRuntimeHasNoAgentLayer(t *testing.T) {
	var files []ManifestFile
	for _, name := range []string{
		"rootfs.raw", "rootfs.vhdx", "kernel", "initramfs", "cloud-hypervisor", "virtiofsd",
		"linux-runtime-provenance.json", "capabilities.json", "sbom.spdx.json", "source-offer.json",
		"state.raw", "state.vhdx",
	} {
		files = append(files, ManifestFile{Name: name, Size: 1, SHA256: strings.Repeat("a", 64)})
	}
	manifest := Manifest{
		SchemaVersion: 3, Profile: ProfileHostRuntime, ImageVersion: "host-1", Architecture: "arm64",
		Protocol: 1, StateSchema: 3, CreatedAt: "2026-08-05T00:00:00Z", Files: files,
		Layers: []ManifestLayer{
			{Name: "base", Version: "base-1", Files: []string{"rootfs.raw", "rootfs.vhdx"}},
			{Name: "runtime", Version: "runtime-1", Files: []string{
				"kernel", "initramfs", "cloud-hypervisor", "virtiofsd", "linux-runtime-provenance.json",
				"capabilities.json", "sbom.spdx.json", "source-offer.json",
			}},
			{Name: "session", Version: "state-3", Files: []string{"state.raw", "state.vhdx"}},
		},
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeManifest(data)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Profile != ProfileHostRuntime || len(decoded.Layers) != 3 {
		t.Fatalf("unexpected Host manifest: %+v", decoded)
	}
	manifest.Files = append(manifest.Files, ManifestFile{Name: "agent.raw", Size: 1, SHA256: strings.Repeat("b", 64)})
	manifest.Layers[1].Files = append(manifest.Layers[1].Files, "agent.raw")
	data, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeManifest(data); err == nil || !strings.Contains(err.Error(), "must not contain agent.raw") {
		t.Fatalf("Host manifest accepted Agent disk: %v", err)
	}
}

func TestReadAgentProvenanceRequiresExactBuildIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-provenance.json")
	valid := agentProvenance{
		SchemaVersion: 1, AgentVersion: "1.12.0", SourceCommit: strings.Repeat("a", 40),
		BuildTarget: "bun-linux-x64-musl-baseline", BuilderVersion: "1.3.0",
		BinarySHA256: strings.Repeat("b", 64),
	}
	write := func(value any) {
		t.Helper()
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(valid)
	if _, err := readAgentProvenance(path, "1.12.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := readAgentProvenance(path, "1.12.1"); err == nil || !strings.Contains(err.Error(), "signed Agent layer") {
		t.Fatalf("version mismatch was not rejected: %v", err)
	}
	invalidCommit := valid
	invalidCommit.SourceCommit = strings.Repeat("A", 40)
	write(invalidCommit)
	if _, err := readAgentProvenance(path, "1.12.0"); err == nil || !strings.Contains(err.Error(), "invalid build identity") {
		t.Fatalf("invalid source commit was not rejected: %v", err)
	}
	write(map[string]any{
		"schema_version": 1, "agent_version": "1.12.0", "source_commit": strings.Repeat("a", 40),
		"build_target": "bun-linux-x64-musl", "builder_version": "1.3.0",
		"binary_sha256": strings.Repeat("b", 64), "unexpected": true,
	})
	if _, err := readAgentProvenance(path, "1.12.0"); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("unknown provenance field was not rejected: %v", err)
	}
}

func TestReadAgentProvenanceRequiresHonestUnavailableIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-provenance.json")
	provenance := agentProvenance{
		SchemaVersion: 1, AgentVersion: "unavailable", SourceCommit: "unavailable",
		BuildTarget: "unavailable", BuilderVersion: "unavailable", BinarySHA256: strings.Repeat("c", 64),
	}
	data, err := json.Marshal(provenance)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readAgentProvenance(path, "unavailable"); err != nil {
		t.Fatal(err)
	}
	provenance.SourceCommit = strings.Repeat("d", 40)
	data, err = json.Marshal(provenance)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readAgentProvenance(path, "unavailable"); err == nil || !strings.Contains(err.Error(), "must not claim") {
		t.Fatalf("dishonest unavailable provenance was not rejected: %v", err)
	}
}

func TestValidateLinuxELFRejectsDynamicInterpreter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime")
	data := minimalELF("arm64")
	binary.LittleEndian.PutUint64(data[32:40], uint64(len(data)))
	binary.LittleEndian.PutUint16(data[54:56], 56)
	binary.LittleEndian.PutUint16(data[56:58], 1)
	program := make([]byte, 56)
	binary.LittleEndian.PutUint32(program[:4], uint32(3)) // PT_INTERP
	data = append(data, program...)
	if err := os.WriteFile(path, data, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := validateLinuxELF(path, "arm64", "runtime", true); err == nil || !strings.Contains(err.Error(), "dynamic interpreter") {
		t.Fatalf("dynamic runtime was not rejected: %v", err)
	}
	if err := validateLinuxELF(path, "arm64", "runtime", false); err != nil {
		t.Fatalf("optional dynamic runtime was rejected: %v", err)
	}
}

func writeInstalledFixture(t *testing.T, version, architecture string) (string, string) {
	return writeInstalledFixtureWithRuntimeArchitecture(t, version, architecture, architecture)
}

func writeInstalledFixtureWithRuntimeArchitecture(t *testing.T, version, architecture, runtimeArchitecture string) (string, string) {
	t.Helper()
	root := t.TempDir()
	directory := filepath.Join(root, version)
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{
		SchemaVersion: 2, ImageVersion: version, Architecture: architecture,
		Protocol: 1, StateSchema: 2, CreatedAt: "2026-08-05T00:00:00Z",
	}
	runtimeHashes := make(map[string]string)
	for _, name := range []string{"kernel", "initramfs", "rootfs.raw", "rootfs.vhdx", "state.raw", "state.vhdx", "cloud-hypervisor", "virtiofsd"} {
		data := []byte(name + "-data")
		mode := os.FileMode(0o644)
		if name == "cloud-hypervisor" || name == "virtiofsd" {
			mode = 0o755
			data = minimalELF(runtimeArchitecture)
		}
		if err := os.WriteFile(filepath.Join(directory, name), data, mode); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(data)
		digestString := hex.EncodeToString(digest[:])
		runtimeHashes[name] = digestString
		manifest.Files = append(manifest.Files, ManifestFile{Name: name, Size: int64(len(data)), SHA256: digestString})
	}
	provenance := linuxRuntimeProvenance{
		SchemaVersion: 1, Architecture: architecture,
		CloudHypervisorVersion: "v53.0", CloudHypervisorSHA256: runtimeHashes["cloud-hypervisor"],
		VirtioFSDVersion: "v1.14.0", VirtioFSDCommit: strings.Repeat("a", 40),
		VirtioFSDSourceSHA256: strings.Repeat("b", 64), VirtioFSDBinarySHA256: runtimeHashes["virtiofsd"],
		BuilderImage: "rust@example", RustToolchain: "rustc test", BuilderPackages: "libseccomp=test",
	}
	provenanceData, err := json.Marshal(provenance)
	if err != nil {
		t.Fatal(err)
	}
	provenanceName := "linux-runtime-provenance.json"
	if err := os.WriteFile(filepath.Join(directory, provenanceName), provenanceData, 0o644); err != nil {
		t.Fatal(err)
	}
	provenanceDigest := sha256.Sum256(provenanceData)
	manifest.Files = append(manifest.Files, ManifestFile{Name: provenanceName, Size: int64(len(provenanceData)), SHA256: hex.EncodeToString(provenanceDigest[:])})
	capabilitiesData := []byte(`{"schema_version":1,"rootfs_mode":"read-only","workspace_mode":"read-write-executable","protected_workspace_paths":[".git",".zapcode"],"temporary_storage_scope":"request","temporary_storage_executable":true,"runtime_package_management":"image-build-only","commands":["bash","python3"],"network_modes":["off","restricted","unrestricted"]}`)
	if err := os.WriteFile(filepath.Join(directory, CapabilitiesFileName), capabilitiesData, 0o644); err != nil {
		t.Fatal(err)
	}
	capabilitiesDigest := sha256.Sum256(capabilitiesData)
	manifest.Files = append(manifest.Files, ManifestFile{Name: CapabilitiesFileName, Size: int64(len(capabilitiesData)), SHA256: hex.EncodeToString(capabilitiesDigest[:])})
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "manifest.json"), manifestData, 0o644); err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "manifest.sig"), ed25519.Sign(private, manifestData), 0o644); err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	publicPath := filepath.Join(root, "image-public.pem")
	if err := os.WriteFile(publicPath, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER}), 0o644); err != nil {
		t.Fatal(err)
	}
	activation := ActivationState{
		SchemaVersion: 1, ActiveVersion: version, Generation: 1,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	activationData, err := json.Marshal(activation)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "active.json"), activationData, 0o644); err != nil {
		t.Fatal(err)
	}
	return root, publicPath
}

func minimalELF(architecture string) []byte {
	header := make([]byte, 64)
	copy(header[:4], []byte{0x7f, 'E', 'L', 'F'})
	header[4] = byte(2)                                     // ELFCLASS64
	header[5] = byte(1)                                     // ELFDATA2LSB
	header[6] = byte(1)                                     // EV_CURRENT
	binary.LittleEndian.PutUint16(header[16:18], uint16(2)) // ET_EXEC
	machine := uint16(183)                                  // EM_AARCH64
	if architecture == "amd64" {
		machine = 62 // EM_X86_64
	}
	binary.LittleEndian.PutUint16(header[18:20], machine)
	binary.LittleEndian.PutUint32(header[20:24], uint32(1)) // EV_CURRENT
	binary.LittleEndian.PutUint16(header[52:54], uint16(len(header)))
	return header
}
