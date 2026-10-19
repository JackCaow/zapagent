// Package agentpackage implements the local trust registry for independently
// signed, read-only Agent disks. Runtime images and Agent packages deliberately
// have separate manifests and trust roots so either can be updated without
// rebuilding the other.
package agentpackage

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
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	vmimage "zapvm/internal/image"
)

const (
	ManifestName    = "agent.json"
	SignatureName   = "agent.sig"
	ActivationName  = "active-agent.json"
	MaxManifestSize = 1 << 20
	MaxFileSize     = int64(4 << 30)
	MaxFiles        = 8
)

type RuntimeContract struct {
	Protocol     int
	StateSchema  int
	AgentAdapter string
}

type Manifest struct {
	SchemaVersion   int            `json:"schema_version"`
	ID              string         `json:"id"`
	Version         string         `json:"version"`
	Architecture    string         `json:"architecture"`
	CreatedAt       string         `json:"created_at"`
	RuntimeProtocol int            `json:"runtime_protocol"`
	Adapter         string         `json:"adapter"`
	MinStateSchema  int            `json:"min_state_schema"`
	MaxStateSchema  int            `json:"max_state_schema"`
	Entrypoint      string         `json:"entrypoint"`
	Files           []ManifestFile `json:"files"`
}

type ManifestFile struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type Provenance struct {
	SchemaVersion  int    `json:"schema_version"`
	AgentVersion   string `json:"agent_version"`
	SourceCommit   string `json:"source_commit"`
	BuildTarget    string `json:"build_target"`
	BuilderVersion string `json:"builder_version"`
	BinarySHA256   string `json:"binary_sha256"`
}

type Activation struct {
	SchemaVersion int    `json:"schema_version"`
	ID            string `json:"id"`
	Version       string `json:"version"`
	Generation    uint64 `json:"generation"`
	UpdatedAt     string `json:"updated_at"`
}

type Resolved struct {
	Reference  string
	Directory  string
	DiskPath   string
	Digest     string
	Manifest   Manifest
	Provenance Provenance
}

func ParseReference(value string) (string, string, error) {
	if strings.Count(value, "@") != 1 {
		return "", "", errors.New("Agent reference must be id@version")
	}
	id, version, _ := strings.Cut(value, "@")
	if !ValidID(id) {
		return "", "", errors.New("Agent ID must contain 1-128 ASCII token characters")
	}
	if err := vmimage.ValidateVersionName(version); err != nil {
		return "", "", fmt.Errorf("invalid Agent version: %w", err)
	}
	return id, version, nil
}

func ValidID(value string) bool {
	if value == "" || len(value) > 128 || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || strings.ContainsRune("._-", character) {
			continue
		}
		return false
	}
	return true
}

func DecodeManifest(data []byte) (Manifest, error) {
	var manifest Manifest
	if err := decodeStrict(data, MaxManifestSize, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode Agent manifest: %w", err)
	}
	if manifest.SchemaVersion != 1 {
		return Manifest{}, errors.New("unsupported Agent manifest schema")
	}
	if !ValidID(manifest.ID) {
		return Manifest{}, errors.New("Agent manifest contains an invalid ID")
	}
	if err := vmimage.ValidateVersionName(manifest.Version); err != nil {
		return Manifest{}, fmt.Errorf("Agent manifest version: %w", err)
	}
	if manifest.Architecture != "arm64" && manifest.Architecture != "amd64" {
		return Manifest{}, errors.New("Agent manifest contains an invalid architecture")
	}
	if _, err := time.Parse(time.RFC3339, manifest.CreatedAt); err != nil {
		return Manifest{}, fmt.Errorf("Agent manifest timestamp: %w", err)
	}
	if manifest.RuntimeProtocol < 1 || manifest.RuntimeProtocol > 65535 ||
		manifest.MinStateSchema < 1 || manifest.MaxStateSchema < manifest.MinStateSchema || manifest.MaxStateSchema > 65535 {
		return Manifest{}, errors.New("Agent compatibility range is invalid")
	}
	if manifest.Adapter != vmimage.ResidentAdapterACPV1 {
		return Manifest{}, errors.New("Agent manifest contains an unsupported Resident adapter contract")
	}
	if manifest.Entrypoint != "/opt/zapvm-agent/bin/agent" {
		return Manifest{}, errors.New("Agent entrypoint must be /opt/zapvm-agent/bin/agent")
	}
	if len(manifest.Files) != 3 || len(manifest.Files) > MaxFiles {
		return Manifest{}, errors.New("Agent manifest must contain raw, VHDX, and provenance files")
	}
	required := map[string]bool{"agent.raw": false, "agent.vhdx": false, "agent-provenance.json": false}
	for _, file := range manifest.Files {
		if _, exists := required[file.Name]; !exists || required[file.Name] {
			return Manifest{}, fmt.Errorf("Agent manifest contains unknown or duplicate file %q", file.Name)
		}
		if file.Size <= 0 || file.Size > MaxFileSize || !vmimage.ValidLowerSHA256(file.SHA256) {
			return Manifest{}, fmt.Errorf("Agent manifest file %q has invalid size or SHA-256", file.Name)
		}
		required[file.Name] = true
	}
	return manifest, nil
}

func Verify(manifestPath, signaturePath, publicKeyPath, baseDirectory string) (Manifest, Provenance, string, error) {
	data, err := vmimage.ReadBoundedRegular(manifestPath, MaxManifestSize)
	if err != nil {
		return Manifest{}, Provenance{}, "", err
	}
	manifest, err := DecodeManifest(data)
	if err != nil {
		return Manifest{}, Provenance{}, "", err
	}
	signature, err := vmimage.ReadBoundedRegular(signaturePath, ed25519.SignatureSize)
	if err != nil {
		return Manifest{}, Provenance{}, "", err
	}
	key, err := vmimage.LoadPublicKey(publicKeyPath)
	if err != nil {
		return Manifest{}, Provenance{}, "", err
	}
	if len(signature) != ed25519.SignatureSize || !ed25519.Verify(key, data, signature) {
		return Manifest{}, Provenance{}, "", errors.New("Agent manifest signature verification failed")
	}
	for _, expected := range manifest.Files {
		if err := verifyRegularFile(filepath.Join(baseDirectory, expected.Name), expected); err != nil {
			return Manifest{}, Provenance{}, "", err
		}
	}
	provenanceData, err := vmimage.ReadBoundedRegular(filepath.Join(baseDirectory, "agent-provenance.json"), vmimage.MaxProvenanceSize)
	if err != nil {
		return Manifest{}, Provenance{}, "", fmt.Errorf("read Agent provenance: %w", err)
	}
	var provenance Provenance
	if err := decodeStrict(provenanceData, vmimage.MaxProvenanceSize, &provenance); err != nil {
		return Manifest{}, Provenance{}, "", fmt.Errorf("decode Agent provenance: %w", err)
	}
	if provenance.SchemaVersion != 1 || provenance.AgentVersion != manifest.Version ||
		!validLowerHex(provenance.SourceCommit, 40) || !vmimage.ValidLowerSHA256(provenance.BinarySHA256) ||
		!validSimpleToken(provenance.BuildTarget) || !validSimpleToken(provenance.BuilderVersion) {
		return Manifest{}, Provenance{}, "", errors.New("Agent provenance does not match the signed manifest")
	}
	digest := sha256.Sum256(data)
	return manifest, provenance, hex.EncodeToString(digest[:]), nil
}

func Install(root, manifestPath, signaturePath, publicKeyPath string) (Resolved, error) {
	if err := ensureRegistryRoot(root); err != nil {
		return Resolved{}, err
	}
	baseDirectory := filepath.Dir(manifestPath)
	manifest, _, packageDigest, err := Verify(manifestPath, signaturePath, publicKeyPath, baseDirectory)
	if err != nil {
		return Resolved{}, err
	}
	destination := filepath.Join(root, manifest.ID, manifest.Version)
	if _, err := os.Lstat(destination); err == nil {
		existing, resolveErr := Resolve(root, manifest.ID+"@"+manifest.Version, publicKeyPath, runtime.GOOS, runtime.GOARCH, RuntimeContract{
			Protocol: manifest.RuntimeProtocol, StateSchema: manifest.MinStateSchema, AgentAdapter: manifest.Adapter,
		})
		if resolveErr != nil {
			return Resolved{}, resolveErr
		}
		if existing.Digest != packageDigest {
			return Resolved{}, errors.New("Agent registry already contains different bytes for this id@version")
		}
		return existing, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return Resolved{}, err
	}
	parent := filepath.Dir(destination)
	if err := ensureRealDirectory(parent); err != nil {
		return Resolved{}, fmt.Errorf("prepare Agent ID directory: %w", err)
	}
	staging, err := os.MkdirTemp(parent, ".agent-install-")
	if err != nil {
		return Resolved{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(staging)
		}
	}()
	for _, source := range []string{ManifestName, SignatureName, "agent.raw", "agent.vhdx", "agent-provenance.json"} {
		from := filepath.Join(baseDirectory, source)
		if source == ManifestName {
			from = manifestPath
		} else if source == SignatureName {
			from = signaturePath
		}
		if err := copyRegular(from, filepath.Join(staging, source)); err != nil {
			return Resolved{}, err
		}
	}
	if _, _, _, err := Verify(filepath.Join(staging, ManifestName), filepath.Join(staging, SignatureName), publicKeyPath, staging); err != nil {
		return Resolved{}, fmt.Errorf("verify staged Agent package: %w", err)
	}
	if err := os.Rename(staging, destination); err != nil {
		return Resolved{}, err
	}
	committed = true
	return Resolve(root, manifest.ID+"@"+manifest.Version, publicKeyPath, runtime.GOOS, runtime.GOARCH, RuntimeContract{
		Protocol: manifest.RuntimeProtocol, StateSchema: manifest.MinStateSchema, AgentAdapter: manifest.Adapter,
	})
}

func Resolve(root, reference, publicKeyPath, hostOS, hostArchitecture string, runtimeContract RuntimeContract) (Resolved, error) {
	return resolve(root, reference, publicKeyPath, hostOS, hostArchitecture, runtimeContract, true)
}

func resolve(root, reference, publicKeyPath, hostOS, hostArchitecture string, runtimeContract RuntimeContract, enforceCompatibility bool) (Resolved, error) {
	if err := ensureExistingRegistryRoot(root); err != nil {
		return Resolved{}, err
	}
	id, version, err := ParseReference(reference)
	if err != nil {
		return Resolved{}, err
	}
	directory := filepath.Join(root, id, version)
	manifest, provenance, digest, err := Verify(filepath.Join(directory, ManifestName), filepath.Join(directory, SignatureName), publicKeyPath, directory)
	if err != nil {
		return Resolved{}, err
	}
	if manifest.ID != id || manifest.Version != version {
		return Resolved{}, errors.New("Agent manifest identity does not match its registry path")
	}
	if manifest.Architecture != hostArchitecture {
		return Resolved{}, fmt.Errorf("Agent architecture %q does not match Host %q", manifest.Architecture, hostArchitecture)
	}
	if enforceCompatibility && (manifest.RuntimeProtocol != runtimeContract.Protocol || runtimeContract.StateSchema < manifest.MinStateSchema ||
		runtimeContract.StateSchema > manifest.MaxStateSchema || manifest.Adapter != runtimeContract.AgentAdapter) {
		return Resolved{}, errors.New("Agent package is incompatible with the selected Runtime image")
	}
	diskName := "agent.raw"
	if hostOS == "windows" {
		diskName = "agent.vhdx"
	} else if hostOS != "darwin" && hostOS != "linux" {
		return Resolved{}, fmt.Errorf("unsupported Host OS %q", hostOS)
	}
	return Resolved{Reference: reference, Directory: directory, DiskPath: filepath.Join(directory, diskName), Digest: digest, Manifest: manifest, Provenance: provenance}, nil
}

func List(root, publicKeyPath, hostOS, hostArchitecture string) ([]Resolved, error) {
	if !filepath.IsAbs(root) {
		return nil, errors.New("Agent registry root must be absolute")
	}
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var result []Resolved
	for _, idEntry := range entries {
		if !idEntry.IsDir() || !ValidID(idEntry.Name()) {
			continue
		}
		versions, err := os.ReadDir(filepath.Join(root, idEntry.Name()))
		if err != nil {
			return nil, err
		}
		for _, versionEntry := range versions {
			if !versionEntry.IsDir() {
				continue
			}
			reference := idEntry.Name() + "@" + versionEntry.Name()
			resolved, err := resolve(root, reference, publicKeyPath, hostOS, hostArchitecture, RuntimeContract{}, false)
			if err != nil {
				return nil, fmt.Errorf("verify installed Agent %s: %w", reference, err)
			}
			result = append(result, resolved)
		}
	}
	sort.Slice(result, func(left, right int) bool { return result[left].Reference < result[right].Reference })
	return result, nil
}

func Activate(root, reference, publicKeyPath, hostOS, hostArchitecture string, runtimeContract RuntimeContract) (Activation, error) {
	if err := ensureExistingRegistryRoot(root); err != nil {
		return Activation{}, err
	}
	resolved, err := Resolve(root, reference, publicKeyPath, hostOS, hostArchitecture, runtimeContract)
	if err != nil {
		return Activation{}, err
	}
	current, readErr := ReadActivation(root)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return Activation{}, fmt.Errorf("read current Agent activation: %w", readErr)
	}
	if current.ID+"@"+current.Version == resolved.Reference {
		return current, nil
	}
	next := Activation{SchemaVersion: 1, ID: resolved.Manifest.ID, Version: resolved.Manifest.Version, Generation: current.Generation + 1, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if err := writeAtomicJSON(root, ActivationName, next); err != nil {
		return Activation{}, err
	}
	return next, nil
}

func ReadActivation(root string) (Activation, error) {
	if err := ensureExistingRegistryRoot(root); err != nil {
		return Activation{}, err
	}
	data, err := vmimage.ReadBoundedRegular(filepath.Join(root, ActivationName), MaxManifestSize)
	if err != nil {
		return Activation{}, err
	}
	var activation Activation
	if err := decodeStrict(data, MaxManifestSize, &activation); err != nil {
		return Activation{}, err
	}
	if activation.SchemaVersion != 1 || activation.Generation == 0 || !ValidID(activation.ID) {
		return Activation{}, errors.New("invalid active Agent state")
	}
	if err := vmimage.ValidateVersionName(activation.Version); err != nil {
		return Activation{}, err
	}
	if _, err := time.Parse(time.RFC3339Nano, activation.UpdatedAt); err != nil {
		return Activation{}, err
	}
	return activation, nil
}

func ResolveActive(root, publicKeyPath, hostOS, hostArchitecture string, runtimeContract RuntimeContract) (Resolved, error) {
	activation, err := ReadActivation(root)
	if err != nil {
		return Resolved{}, err
	}
	return Resolve(root, activation.ID+"@"+activation.Version, publicKeyPath, hostOS, hostArchitecture, runtimeContract)
}

func ValidateRegistry(root, publicKeyPath, hostOS, hostArchitecture string) ([]Resolved, error) {
	if err := ensureExistingRegistryRoot(root); err != nil {
		return nil, err
	}
	if _, err := vmimage.LoadPublicKey(publicKeyPath); err != nil {
		return nil, fmt.Errorf("load Agent public key: %w", err)
	}
	return List(root, publicKeyPath, hostOS, hostArchitecture)
}

func decodeStrict(data []byte, limit int64, destination any) error {
	if len(data) == 0 || int64(len(data)) > limit {
		return errors.New("JSON file is empty or exceeds its size limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("JSON file contains trailing data")
	}
	return nil
}

func verifyRegularFile(path string, expected ManifestFile) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() != expected.Size {
		return fmt.Errorf("Agent file %q is not regular or has a size mismatch", expected.Name)
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	hash := sha256.New()
	_, copyErr := io.Copy(hash, file)
	closeErr := file.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
		return fmt.Errorf("Agent file %q hash mismatch", expected.Name)
	}
	return nil
}

func copyRegular(source, destination string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("Agent package source must contain regular files only")
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	return errors.Join(copyErr, closeErr)
}

func writeAtomicJSON(root, name string, value any) error {
	if err := ensureRegistryRoot(root); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temporary, err := os.CreateTemp(root, ".agent-activation-")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o644); err != nil {
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, filepath.Join(root, name)); err != nil {
		return err
	}
	committed = true
	return nil
}

func ensureRegistryRoot(root string) error {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return errors.New("Agent registry root must be an absolute clean path")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	return ensureExistingRegistryRoot(root)
}

func ensureExistingRegistryRoot(root string) error {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return errors.New("Agent registry root must be an absolute clean path")
	}
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("Agent registry root must be a real directory")
	}
	return nil
}

func ensureRealDirectory(path string) error {
	if err := os.Mkdir(path, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("path is not a real directory")
	}
	return nil
}

func validLowerHex(value string, size int) bool {
	if len(value) != size || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func validSimpleToken(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || strings.ContainsRune("._+-", character) {
			continue
		}
		return false
	}
	return true
}
