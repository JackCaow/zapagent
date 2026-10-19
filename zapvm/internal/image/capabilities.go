package image

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

const (
	CapabilitiesFileName = "capabilities.json"
	MaxCapabilitiesSize  = 64 << 10
	ResidentAdapterACPV1 = "acp-resident-v1"
)

var capabilityTokenPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)
var protectedPathPattern = regexp.MustCompile(`^\.[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)

// Capabilities is a signed, image-specific contract for Agent orchestrators.
// It intentionally describes stable behavior and command presence rather than
// distro package versions, which remain available in the signed SBOM.
type Capabilities struct {
	SchemaVersion              int                        `json:"schema_version"`
	ImageProfile               string                     `json:"image_profile,omitempty"`
	RootFSMode                 string                     `json:"rootfs_mode"`
	WorkspaceMode              string                     `json:"workspace_mode"`
	ProtectedWorkspacePaths    []string                   `json:"protected_workspace_paths"`
	TemporaryStorageScope      string                     `json:"temporary_storage_scope"`
	TemporaryStorageExecutable bool                       `json:"temporary_storage_executable"`
	RuntimePackageManagement   string                     `json:"runtime_package_management"`
	AgentAdapter               *AgentAdapterCapabilities  `json:"agent_adapter,omitempty"`
	ResidentAgent              *ResidentAgentCapabilities `json:"resident_agent,omitempty"`
	Commands                   []string                   `json:"commands"`
	NetworkModes               []string                   `json:"network_modes"`
}

// AgentAdapter describes the Runtime-owned Resident process contract. Its
// presence does not imply that a compatible Agent package is installed.
type AgentAdapterCapabilities struct {
	Contract     string `json:"contract"`
	Entrypoint   string `json:"entrypoint"`
	OutputFormat string `json:"output_format"`
}

type ResidentAgentCapabilities struct {
	Available    bool   `json:"available"`
	Version      string `json:"version"`
	Entrypoint   string `json:"entrypoint"`
	OutputFormat string `json:"output_format"`
}

func DecodeCapabilities(data []byte) (Capabilities, error) {
	var result Capabilities
	if len(data) == 0 || len(data) > MaxCapabilitiesSize {
		return Capabilities{}, errors.New("capabilities file is empty or exceeds its size limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return Capabilities{}, fmt.Errorf("decode capabilities: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Capabilities{}, errors.New("capabilities file contains trailing data")
	}
	if result.SchemaVersion != 1 || result.RootFSMode != "read-only" ||
		result.WorkspaceMode != "read-write-executable" ||
		result.TemporaryStorageScope != "request" || !result.TemporaryStorageExecutable ||
		(result.RuntimePackageManagement != "image-build-only" && result.RuntimePackageManagement != "persistent-rootless") {
		return Capabilities{}, errors.New("capabilities file has an unsupported execution contract")
	}
	if result.ImageProfile == "" {
		result.ImageProfile = ProfileAgentComputer
	}
	if result.ImageProfile != ProfileHostRuntime && result.ImageProfile != ProfileAgentComputer {
		return Capabilities{}, errors.New("capabilities file has an unsupported image profile")
	}
	if result.ImageProfile == ProfileHostRuntime && result.ResidentAgent != nil {
		return Capabilities{}, errors.New("host-runtime capabilities must not declare a resident Agent")
	}
	// Images built before the independently signed Agent layer did not carry an
	// explicit adapter contract. Keep those images bootable for their bundled
	// Agent, but leave Contract empty so they cannot accept a pluggable package.
	if result.AgentAdapter != nil && ((result.AgentAdapter.Contract != "" && result.AgentAdapter.Contract != ResidentAdapterACPV1) ||
		result.AgentAdapter.Entrypoint != "/usr/local/sbin/zapvm-resident-agent" || result.AgentAdapter.OutputFormat != "stream-json") {
		return Capabilities{}, errors.New("capabilities file has an invalid Agent adapter contract")
	}
	if result.ResidentAgent != nil && (result.ResidentAgent.Version == "" || result.ResidentAgent.Entrypoint == "" || result.ResidentAgent.OutputFormat == "") {
		return Capabilities{}, errors.New("capabilities file has an invalid resident Agent contract")
	}
	if err := validateCapabilityTokens("protected workspace path", result.ProtectedWorkspacePaths, 16, protectedPathPattern); err != nil {
		return Capabilities{}, err
	}
	if err := validateCapabilityTokens("command", result.Commands, 128, capabilityTokenPattern); err != nil {
		return Capabilities{}, err
	}
	if len(result.NetworkModes) == 0 || len(result.NetworkModes) > 3 {
		return Capabilities{}, errors.New("capabilities file has invalid network modes")
	}
	allowedNetworkModes := map[string]bool{"off": true, "restricted": true, "unrestricted": true}
	seenNetworkModes := make(map[string]bool, len(result.NetworkModes))
	for _, mode := range result.NetworkModes {
		if !allowedNetworkModes[mode] || seenNetworkModes[mode] {
			return Capabilities{}, errors.New("capabilities file has invalid network modes")
		}
		seenNetworkModes[mode] = true
	}
	return result, nil
}

// ReadVersionCapabilities verifies the signed capabilities contract for one
// installed Runtime version. Callers selecting an independently signed Agent
// must use this instead of inferring adapter support from protocol numbers.
func ReadVersionCapabilities(root, version, publicKey, hostArchitecture string) (Capabilities, error) {
	if !filepath.IsAbs(root) {
		return Capabilities{}, errors.New("image root must be absolute")
	}
	manifest, err := VerifyInstalledVersion(root, version, publicKey)
	if err != nil {
		return Capabilities{}, err
	}
	if manifest.Architecture != hostArchitecture {
		return Capabilities{}, errors.New("installed image identity does not match this Host")
	}
	return readVerifiedCapabilities(filepath.Join(root, version), manifest)
}

// ReadResolvedCapabilities verifies the small capabilities artifact against a
// manifest from a previously verified Resolved image. This avoids hashing the
// multi-gigabyte VM disks a second time on every Agent selection or daemon
// startup.
func ReadResolvedCapabilities(resolved Resolved) (Capabilities, error) {
	if !filepath.IsAbs(resolved.Directory) {
		return Capabilities{}, errors.New("resolved image directory must be absolute")
	}
	return readVerifiedCapabilities(resolved.Directory, resolved.Manifest)
}

func validateCapabilityTokens(label string, values []string, limit int, pattern *regexp.Regexp) error {
	if len(values) == 0 || len(values) > limit {
		return fmt.Errorf("capabilities file has an invalid number of %s entries", label)
	}
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if !pattern.MatchString(value) || seen[value] {
			return fmt.Errorf("capabilities file has an invalid or repeated %s", label)
		}
		seen[value] = true
	}
	return nil
}

// ReadActiveCapabilities verifies the active pointer, manifest signature and
// the capabilities file's signed size/hash without hashing multi-gigabyte VM
// disks. Full artifact verification still occurs before every VM start.
func ReadActiveCapabilities(root, publicKey, hostArchitecture string) (Capabilities, error) {
	if !filepath.IsAbs(root) {
		return Capabilities{}, errors.New("image root must be absolute")
	}
	activation, err := ReadActivation(root)
	if err != nil {
		return Capabilities{}, fmt.Errorf("read active image: %w", err)
	}
	directory := filepath.Join(root, activation.ActiveVersion)
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return Capabilities{}, errors.New("installed version is not a real directory")
	}
	manifestData, err := ReadBoundedRegular(filepath.Join(directory, "manifest.json"), MaxManifestSize)
	if err != nil {
		return Capabilities{}, err
	}
	signature, err := ReadBoundedRegular(filepath.Join(directory, "manifest.sig"), ed25519.SignatureSize)
	if err != nil {
		return Capabilities{}, err
	}
	key, err := LoadPublicKey(publicKey)
	if err != nil {
		return Capabilities{}, err
	}
	if len(signature) != ed25519.SignatureSize || !ed25519.Verify(key, manifestData, signature) {
		return Capabilities{}, errors.New("manifest signature verification failed")
	}
	manifest, err := DecodeManifest(manifestData)
	if err != nil {
		return Capabilities{}, err
	}
	if manifest.ImageVersion != activation.ActiveVersion || manifest.Architecture != hostArchitecture {
		return Capabilities{}, errors.New("active image identity does not match this Host")
	}
	return readVerifiedCapabilities(directory, manifest)
}

func readVerifiedCapabilities(directory string, manifest Manifest) (Capabilities, error) {
	var expected *ManifestFile
	for index := range manifest.Files {
		if manifest.Files[index].Name == CapabilitiesFileName {
			expected = &manifest.Files[index]
			break
		}
	}
	if expected == nil || expected.Size <= 0 || expected.Size > MaxCapabilitiesSize {
		return Capabilities{}, errors.New("active image has no signed capabilities file")
	}
	data, err := ReadBoundedRegular(filepath.Join(directory, CapabilitiesFileName), MaxCapabilitiesSize)
	if err != nil {
		return Capabilities{}, err
	}
	digest := sha256.Sum256(data)
	if int64(len(data)) != expected.Size || hex.EncodeToString(digest[:]) != expected.SHA256 {
		return Capabilities{}, errors.New("active image capabilities hash mismatch")
	}
	capabilities, err := DecodeCapabilities(data)
	if err != nil {
		return Capabilities{}, err
	}
	if manifest.SchemaVersion == 3 && capabilities.ImageProfile != manifest.Profile {
		return Capabilities{}, errors.New("active image capabilities profile does not match its manifest")
	}
	return capabilities, nil
}
