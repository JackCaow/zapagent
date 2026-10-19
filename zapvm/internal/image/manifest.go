package image

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"debug/elf"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	MaxManifestSize      = 1 << 20
	MaxKeyFileSize       = 64 << 10
	MaxProvenanceSize    = 64 << 10
	MaxFileSize          = int64(4 << 30)
	MaxFiles             = 126
	ProfileHostRuntime   = "host-runtime"
	ProfileAgentComputer = "agent-computer"
)

type Manifest struct {
	SchemaVersion int             `json:"schema_version"`
	Profile       string          `json:"profile,omitempty"`
	ImageVersion  string          `json:"image_version"`
	Architecture  string          `json:"architecture"`
	Protocol      int             `json:"protocol_version"`
	StateSchema   int             `json:"state_schema,omitempty"`
	CreatedAt     string          `json:"created_at"`
	Files         []ManifestFile  `json:"files"`
	Layers        []ManifestLayer `json:"layers,omitempty"`
}

type ManifestFile struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type ManifestLayer struct {
	Name    string   `json:"name"`
	Version string   `json:"version"`
	Files   []string `json:"files"`
}

type ActivationState struct {
	SchemaVersion   int    `json:"schema_version"`
	ActiveVersion   string `json:"active_version"`
	PreviousVersion string `json:"previous_version,omitempty"`
	Generation      uint64 `json:"generation"`
	UpdatedAt       string `json:"updated_at"`
}

type Resolved struct {
	Directory     string
	Manifest      Manifest
	KernelPath    string
	InitrdPath    string
	RootDiskPath  string
	StateTemplate string
	AgentDiskPath string
	VMMPath       string
	VirtioFSDPath string
	VMMVersion    string
	VirtioVersion string
}

type linuxRuntimeProvenance struct {
	SchemaVersion          int    `json:"schema_version"`
	Architecture           string `json:"architecture"`
	CloudHypervisorVersion string `json:"cloud_hypervisor_version"`
	CloudHypervisorSHA256  string `json:"cloud_hypervisor_sha256"`
	VirtioFSDVersion       string `json:"virtiofsd_version"`
	VirtioFSDCommit        string `json:"virtiofsd_commit"`
	VirtioFSDSourceSHA256  string `json:"virtiofsd_source_sha256"`
	VirtioFSDBinarySHA256  string `json:"virtiofsd_binary_sha256"`
	BuilderImage           string `json:"builder_image"`
	RustToolchain          string `json:"rust_toolchain"`
	BuilderPackages        string `json:"builder_packages"`
}

type agentProvenance struct {
	SchemaVersion  int    `json:"schema_version"`
	AgentVersion   string `json:"agent_version"`
	SourceCommit   string `json:"source_commit"`
	BuildTarget    string `json:"build_target"`
	BuilderVersion string `json:"builder_version"`
	BinarySHA256   string `json:"binary_sha256"`
}

func DecodeManifest(data []byte) (Manifest, error) {
	var result Manifest
	if len(data) == 0 || len(data) > MaxManifestSize {
		return Manifest{}, errors.New("manifest is empty or exceeds its size limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return Manifest{}, fmt.Errorf("decode manifest: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Manifest{}, errors.New("manifest contains trailing data")
	}
	if result.Protocol != 1 {
		return Manifest{}, errors.New("unsupported image manifest schema or protocol")
	}
	switch result.SchemaVersion {
	case 1:
		if result.Profile != "" || result.StateSchema != 0 || len(result.Layers) != 0 {
			return Manifest{}, errors.New("manifest schema 1 must not declare state_schema")
		}
		result.StateSchema = 1
	case 2:
		if result.Profile != "" {
			return Manifest{}, errors.New("manifest schema 2 must not declare a profile")
		}
		if result.StateSchema < 1 || result.StateSchema > 3 {
			return Manifest{}, errors.New("unsupported image state schema")
		}
		if len(result.Layers) != 0 {
			return Manifest{}, errors.New("manifest schema 2 must not declare layers")
		}
	case 3:
		if result.StateSchema < 1 || result.StateSchema > 3 {
			return Manifest{}, errors.New("unsupported image state schema")
		}
		// Schema-3 manifests published before profiles existed were always the
		// four-layer Agent Computer composition. Preserve that interpretation.
		if result.Profile == "" {
			result.Profile = ProfileAgentComputer
		}
		if result.Profile != ProfileHostRuntime && result.Profile != ProfileAgentComputer {
			return Manifest{}, errors.New("unsupported image profile")
		}
	default:
		return Manifest{}, errors.New("unsupported image manifest schema or protocol")
	}
	if err := ValidateVersionName(result.ImageVersion); err != nil {
		return Manifest{}, err
	}
	if result.Architecture != "arm64" && result.Architecture != "amd64" {
		return Manifest{}, errors.New("invalid image architecture")
	}
	if _, err := time.Parse(time.RFC3339, result.CreatedAt); err != nil {
		return Manifest{}, fmt.Errorf("invalid manifest timestamp: %w", err)
	}
	if len(result.Files) == 0 || len(result.Files) > MaxFiles {
		return Manifest{}, errors.New("manifest contains an invalid number of files")
	}
	if err := validateManifestFileRecords(result.Files); err != nil {
		return Manifest{}, err
	}
	if result.SchemaVersion == 3 {
		if err := validateManifestLayers(result.Profile, result.Layers, result.Files); err != nil {
			return Manifest{}, err
		}
	}
	return result, nil
}

func validateManifestLayers(profile string, layers []ManifestLayer, files []ManifestFile) error {
	wantedLayers := map[string]struct{}{"base": {}, "runtime": {}, "session": {}}
	if profile == ProfileAgentComputer {
		wantedLayers["agent"] = struct{}{}
	}
	if len(layers) != len(wantedLayers) {
		if profile == ProfileHostRuntime {
			return errors.New("host-runtime manifest requires exactly base, runtime, and session layers")
		}
		return errors.New("agent-computer manifest requires exactly base, runtime, agent, and session layers")
	}
	knownFiles := make(map[string]struct{}, len(files))
	for _, file := range files {
		knownFiles[file.Name] = struct{}{}
	}
	if profile == ProfileHostRuntime {
		for _, name := range []string{"agent.raw", "agent.vhdx", "agent-provenance.json"} {
			if _, exists := knownFiles[name]; exists {
				return fmt.Errorf("host-runtime manifest must not contain %s", name)
			}
		}
	}
	assigned := make(map[string]string, len(files))
	for _, layer := range layers {
		if _, exists := wantedLayers[layer.Name]; !exists {
			return fmt.Errorf("unknown or duplicate manifest layer %q", layer.Name)
		}
		delete(wantedLayers, layer.Name)
		if err := ValidateVersionName(layer.Version); err != nil {
			return fmt.Errorf("invalid %s layer version: %w", layer.Name, err)
		}
		if len(layer.Files) == 0 || len(layer.Files) > len(files) {
			return fmt.Errorf("manifest layer %q has an invalid file set", layer.Name)
		}
		for _, name := range layer.Files {
			if _, exists := knownFiles[name]; !exists {
				return fmt.Errorf("manifest layer %q references unknown file %q", layer.Name, name)
			}
			if previous, exists := assigned[name]; exists {
				return fmt.Errorf("manifest file %q belongs to both %s and %s layers", name, previous, layer.Name)
			}
			assigned[name] = layer.Name
		}
	}
	if len(wantedLayers) != 0 || len(assigned) != len(files) {
		return errors.New("manifest layers must assign every signed file exactly once")
	}
	required := map[string]string{
		"rootfs.raw": "base", "rootfs.vhdx": "base",
		"kernel": "runtime", "initramfs": "runtime",
		"cloud-hypervisor": "runtime", "virtiofsd": "runtime",
		"linux-runtime-provenance.json": "runtime",
		"capabilities.json":             "runtime", "sbom.spdx.json": "runtime",
		"source-offer.json": "runtime",
		"state.raw":         "session", "state.vhdx": "session",
	}
	if profile == ProfileAgentComputer {
		required["agent.raw"] = "agent"
		required["agent.vhdx"] = "agent"
		if _, exists := knownFiles["agent-provenance.json"]; exists {
			required["agent-provenance.json"] = "agent"
		}
	}
	for name, layer := range required {
		if assigned[name] != layer {
			return fmt.Errorf("manifest schema 3 requires %s in the %s layer", name, layer)
		}
	}
	return nil
}

func validateManifestFileRecords(files []ManifestFile) error {
	seen := make(map[string]struct{}, len(files))
	for _, file := range files {
		if file.Name == "" || file.Name == "." || filepath.Base(file.Name) != file.Name || strings.ContainsAny(file.Name, `/\`) || strings.IndexByte(file.Name, 0) >= 0 {
			return fmt.Errorf("unsafe manifest file name %q", file.Name)
		}
		if file.Name == "manifest.json" || file.Name == "manifest.sig" {
			return fmt.Errorf("manifest file name %q is reserved", file.Name)
		}
		if _, exists := seen[file.Name]; exists {
			return fmt.Errorf("duplicate manifest file %q", file.Name)
		}
		seen[file.Name] = struct{}{}
		if file.Size < 0 || file.Size > MaxFileSize || !ValidLowerSHA256(file.SHA256) {
			return fmt.Errorf("manifest file %q has invalid size or SHA-256", file.Name)
		}
	}
	return nil
}

func VerifyBundle(manifestPath, signaturePath, publicPath, baseDirectory string) (Manifest, error) {
	data, err := ReadBoundedRegular(manifestPath, MaxManifestSize)
	if err != nil {
		return Manifest{}, err
	}
	signature, err := ReadBoundedRegular(signaturePath, ed25519.SignatureSize)
	if err != nil {
		return Manifest{}, err
	}
	if len(signature) != ed25519.SignatureSize {
		return Manifest{}, fmt.Errorf("signature size is %d, want %d", len(signature), ed25519.SignatureSize)
	}
	key, err := LoadPublicKey(publicPath)
	if err != nil {
		return Manifest{}, err
	}
	if !ed25519.Verify(key, data, signature) {
		return Manifest{}, errors.New("manifest signature verification failed")
	}
	manifest, err := DecodeManifest(data)
	if err != nil {
		return Manifest{}, err
	}
	if err := VerifyManifestFiles(baseDirectory, manifest); err != nil {
		return Manifest{}, err
	}
	if err := ValidateSupplyChainMetadata(baseDirectory, manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func VerifyManifestFiles(baseDirectory string, manifest Manifest) error {
	if len(manifest.Files) == 0 || len(manifest.Files) > MaxFiles {
		return errors.New("manifest contains an invalid number of files")
	}
	if err := validateManifestFileRecords(manifest.Files); err != nil {
		return err
	}
	for _, expected := range manifest.Files {
		path := filepath.Join(baseDirectory, expected.Name)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() != expected.Size {
			return fmt.Errorf("image file %q is not regular or has a size mismatch", expected.Name)
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		openedInfo, statErr := file.Stat()
		if statErr != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(info, openedInfo) || openedInfo.Size() != info.Size() {
			_ = file.Close()
			return fmt.Errorf("image file %q changed while opening", expected.Name)
		}
		hash := sha256.New()
		_, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if err := errors.Join(copyErr, closeErr); err != nil {
			return err
		}
		if hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
			return fmt.Errorf("image file %q hash mismatch", expected.Name)
		}
	}
	return nil
}

func VerifyInstalledVersion(root, version, publicKey string) (Manifest, error) {
	if err := ValidateVersionName(version); err != nil {
		return Manifest{}, err
	}
	directory := filepath.Join(root, version)
	info, err := os.Lstat(directory)
	if err != nil {
		return Manifest{}, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return Manifest{}, errors.New("installed version is not a real directory")
	}
	manifest, err := VerifyBundle(filepath.Join(directory, "manifest.json"), filepath.Join(directory, "manifest.sig"), publicKey, directory)
	if err != nil {
		return Manifest{}, err
	}
	if manifest.ImageVersion != version {
		return Manifest{}, fmt.Errorf("manifest version %q does not match directory %q", manifest.ImageVersion, version)
	}
	return manifest, nil
}

func ReadActivation(root string) (ActivationState, error) {
	data, err := ReadBoundedRegular(filepath.Join(root, "active.json"), MaxManifestSize)
	if err != nil {
		return ActivationState{}, err
	}
	var state ActivationState
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return ActivationState{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ActivationState{}, errors.New("activation state contains trailing data")
	}
	if state.SchemaVersion != 1 || state.ActiveVersion == "" || state.Generation == 0 {
		return ActivationState{}, errors.New("invalid activation state")
	}
	if err := ValidateVersionName(state.ActiveVersion); err != nil {
		return ActivationState{}, err
	}
	if state.PreviousVersion != "" {
		if err := ValidateVersionName(state.PreviousVersion); err != nil {
			return ActivationState{}, err
		}
	}
	if _, err := time.Parse(time.RFC3339Nano, state.UpdatedAt); err != nil {
		return ActivationState{}, fmt.Errorf("invalid activation timestamp: %w", err)
	}
	return state, nil
}

func ResolveActive(root, publicKey, hostOS, hostArchitecture string) (Resolved, error) {
	if !filepath.IsAbs(root) {
		return Resolved{}, errors.New("image root must be absolute")
	}
	state, err := ReadActivation(root)
	if err != nil {
		return Resolved{}, fmt.Errorf("read active image: %w", err)
	}
	resolved, err := ResolveVersion(root, state.ActiveVersion, publicKey, hostOS, hostArchitecture)
	if err != nil {
		return Resolved{}, fmt.Errorf("verify active image: %w", err)
	}
	return resolved, nil
}

// ResolveVersion verifies and resolves one installed image without consulting
// active.json. Update tooling uses this to boot a staged candidate before an
// atomic activation; ordinary callers should continue to use ResolveActive.
func ResolveVersion(root, version, publicKey, hostOS, hostArchitecture string) (Resolved, error) {
	if !filepath.IsAbs(root) {
		return Resolved{}, errors.New("image root must be absolute")
	}
	manifest, err := VerifyInstalledVersion(root, version, publicKey)
	if err != nil {
		return Resolved{}, err
	}
	if manifest.Architecture != hostArchitecture {
		return Resolved{}, fmt.Errorf("image architecture %q does not match Host %q", manifest.Architecture, hostArchitecture)
	}
	directory := filepath.Join(root, version)
	if manifest.SchemaVersion >= 3 && manifest.Profile == ProfileAgentComputer {
		agentLayerVersion := ""
		hasProvenance := false
		for _, layer := range manifest.Layers {
			if layer.Name == "agent" {
				agentLayerVersion = layer.Version
			}
			for _, name := range layer.Files {
				if name == "agent-provenance.json" {
					hasProvenance = true
				}
			}
		}
		if hasProvenance {
			if _, err := readAgentProvenance(filepath.Join(directory, "agent-provenance.json"), agentLayerVersion); err != nil {
				return Resolved{}, err
			}
		}
	}
	required := map[string]string{"kernel": "", "initramfs": ""}
	switch hostOS {
	case "windows":
		required["rootfs.vhdx"] = ""
		required["state.vhdx"] = ""
		if manifest.SchemaVersion >= 3 && manifest.Profile == ProfileAgentComputer {
			required["agent.vhdx"] = ""
		}
	case "darwin", "linux":
		required["rootfs.raw"] = ""
		required["state.raw"] = ""
		if manifest.SchemaVersion >= 3 && manifest.Profile == ProfileAgentComputer {
			required["agent.raw"] = ""
		}
		if hostOS == "linux" {
			required["cloud-hypervisor"] = ""
			required["virtiofsd"] = ""
			required["linux-runtime-provenance.json"] = ""
		}
	default:
		return Resolved{}, fmt.Errorf("unsupported Host OS %q", hostOS)
	}
	for _, file := range manifest.Files {
		if _, exists := required[file.Name]; exists {
			required[file.Name] = filepath.Join(directory, file.Name)
		}
	}
	for name, path := range required {
		if path == "" {
			return Resolved{}, fmt.Errorf("image is missing required %s artifact", name)
		}
	}
	rootName, stateName := "rootfs.raw", "state.raw"
	if hostOS == "windows" {
		rootName, stateName = "rootfs.vhdx", "state.vhdx"
	}
	resolved := Resolved{
		Directory: directory, Manifest: manifest,
		KernelPath: required["kernel"], InitrdPath: required["initramfs"],
		RootDiskPath: required[rootName], StateTemplate: required[stateName],
	}
	if manifest.SchemaVersion >= 3 && manifest.Profile == ProfileAgentComputer {
		agentName := "agent.raw"
		if hostOS == "windows" {
			agentName = "agent.vhdx"
		}
		resolved.AgentDiskPath = required[agentName]
	}
	if hostOS == "linux" {
		resolved.VMMPath = required["cloud-hypervisor"]
		resolved.VirtioFSDPath = required["virtiofsd"]
		for _, path := range []string{resolved.VMMPath, resolved.VirtioFSDPath} {
			info, err := os.Stat(path)
			if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
				return Resolved{}, fmt.Errorf("signed Linux runtime %s is not executable", filepath.Base(path))
			}
		}
		if err := validateLinuxELF(resolved.VMMPath, hostArchitecture, "Cloud Hypervisor", true); err != nil {
			return Resolved{}, err
		}
		if err := validateLinuxELF(resolved.VirtioFSDPath, hostArchitecture, "virtiofsd", true); err != nil {
			return Resolved{}, err
		}
		provenance, err := readLinuxRuntimeProvenance(required["linux-runtime-provenance.json"], hostArchitecture)
		if err != nil {
			return Resolved{}, err
		}
		manifestHashes := make(map[string]string, len(manifest.Files))
		for _, file := range manifest.Files {
			manifestHashes[file.Name] = file.SHA256
		}
		if provenance.CloudHypervisorSHA256 != manifestHashes["cloud-hypervisor"] || provenance.VirtioFSDBinarySHA256 != manifestHashes["virtiofsd"] {
			return Resolved{}, errors.New("Linux runtime provenance does not match signed binary hashes")
		}
		resolved.VMMVersion = provenance.CloudHypervisorVersion
		resolved.VirtioVersion = provenance.VirtioFSDVersion
	}
	return resolved, nil
}

func readAgentProvenance(path, expectedVersion string) (agentProvenance, error) {
	data, err := ReadBoundedRegular(path, MaxProvenanceSize)
	if err != nil {
		return agentProvenance{}, fmt.Errorf("read Agent provenance: %w", err)
	}
	var provenance agentProvenance
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&provenance); err != nil {
		return agentProvenance{}, fmt.Errorf("decode Agent provenance: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return agentProvenance{}, errors.New("Agent provenance contains trailing data")
	}
	if provenance.SchemaVersion != 1 || provenance.AgentVersion != expectedVersion || !ValidLowerSHA256(provenance.BinarySHA256) {
		return agentProvenance{}, errors.New("Agent provenance does not match the signed Agent layer")
	}
	if provenance.AgentVersion == "unavailable" {
		if provenance.SourceCommit != "unavailable" || provenance.BuildTarget != "unavailable" || provenance.BuilderVersion != "unavailable" {
			return agentProvenance{}, errors.New("unavailable Agent provenance must not claim build identity")
		}
		return provenance, nil
	}
	if !validLowerHex(provenance.SourceCommit, 40) || !validProvenanceToken(provenance.BuildTarget) || !validProvenanceToken(provenance.BuilderVersion) {
		return agentProvenance{}, errors.New("Agent provenance contains an invalid build identity")
	}
	return provenance, nil
}

func validLowerHex(value string, size int) bool {
	if len(value) != size || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func validProvenanceToken(value string) bool {
	if value == "" || value == "unavailable" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || strings.ContainsRune("._+-", character) {
			continue
		}
		return false
	}
	return true
}

func validateLinuxELF(path, architecture, name string, requireStatic bool) error {
	file, err := elf.Open(path)
	if err != nil {
		return fmt.Errorf("inspect signed %s ELF: %w", name, err)
	}
	defer file.Close()
	wantMachine := elf.EM_AARCH64
	if architecture == "amd64" {
		wantMachine = elf.EM_X86_64
	}
	if file.Class != elf.ELFCLASS64 || file.Data != elf.ELFDATA2LSB || file.Machine != wantMachine ||
		(file.Type != elf.ET_EXEC && file.Type != elf.ET_DYN) {
		return fmt.Errorf("signed %s is not a 64-bit little-endian Linux %s executable", name, architecture)
	}
	if requireStatic {
		for _, program := range file.Progs {
			if program.Type == elf.PT_INTERP {
				return fmt.Errorf("signed %s unexpectedly requires a dynamic interpreter", name)
			}
		}
	}
	return nil
}

func readLinuxRuntimeProvenance(path, architecture string) (linuxRuntimeProvenance, error) {
	data, err := ReadBoundedRegular(path, 64<<10)
	if err != nil {
		return linuxRuntimeProvenance{}, err
	}
	var provenance linuxRuntimeProvenance
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&provenance); err != nil {
		return linuxRuntimeProvenance{}, fmt.Errorf("decode Linux runtime provenance: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return linuxRuntimeProvenance{}, errors.New("Linux runtime provenance contains trailing data")
	}
	if provenance.SchemaVersion != 1 || provenance.Architecture != architecture ||
		provenance.CloudHypervisorVersion == "" || provenance.VirtioFSDVersion == "" ||
		len(provenance.VirtioFSDCommit) != 40 || provenance.BuilderImage == "" ||
		provenance.RustToolchain == "" || provenance.BuilderPackages == "" ||
		!ValidLowerSHA256(provenance.CloudHypervisorSHA256) ||
		!ValidLowerSHA256(provenance.VirtioFSDSourceSHA256) ||
		!ValidLowerSHA256(provenance.VirtioFSDBinarySHA256) {
		return linuxRuntimeProvenance{}, errors.New("invalid Linux runtime provenance")
	}
	if _, err := hex.DecodeString(provenance.VirtioFSDCommit); err != nil {
		return linuxRuntimeProvenance{}, errors.New("invalid Linux runtime commit")
	}
	return provenance, nil
}

func LoadPublicKey(path string) (ed25519.PublicKey, error) {
	data, err := ReadBoundedRegular(path, MaxKeyFileSize)
	if err != nil {
		return nil, err
	}
	block, rest := pem.Decode(data)
	if block == nil || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, errors.New("invalid public key PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("public key is not Ed25519")
	}
	return key, nil
}

func ReadBoundedRegular(path string, maximum int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > maximum {
		return nil, fmt.Errorf("%s is not a regular file within the %d byte limit", filepath.Base(path), maximum)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !openedInfo.Mode().IsRegular() || !os.SameFile(info, openedInfo) || openedInfo.Size() != info.Size() {
		return nil, errors.New("file changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != info.Size() {
		return nil, errors.New("file size changed while reading")
	}
	return data, nil
}

func ValidateVersionName(version string) error {
	if version == "" || version == "." || filepath.Base(version) != version || strings.ContainsAny(version, `/\`) || strings.IndexByte(version, 0) >= 0 {
		return fmt.Errorf("unsafe image version %q", version)
	}
	return nil
}

func ValidLowerSHA256(value string) bool {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
