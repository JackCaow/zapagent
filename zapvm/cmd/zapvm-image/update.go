package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"hash"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/config"
	"github.com/theupdateframework/go-tuf/v2/metadata/updater"
	vmimage "zapvm/internal/image"
)

const (
	maxTrustedRootSize  = 512 << 10
	maxUpdateTargetSize = int64(4 << 30)
	maxUpdateLedgerSize = 1 << 20
	updateHTTPTimeout   = 30 * time.Minute
	maxSmokeOutputSize  = 1 << 20
)

var updateChannelPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`)

type updateTargetCustom struct {
	SchemaVersion   int                 `json:"schema_version"`
	ReleaseSequence uint64              `json:"release_sequence"`
	ImageVersion    string              `json:"image_version"`
	Architecture    string              `json:"architecture"`
	ManifestSHA256  string              `json:"manifest_sha256"`
	Layers          *updateTargetLayers `json:"layers,omitempty"`
	LayerTargets    *updateLayerTargets `json:"layer_targets,omitempty"`
}

// updateTargetLayers is the release's immutable component version vector. It
// lets operators and clients determine the update impact from signed TUF
// metadata before downloading a multi-gigabyte bundle. The inner manifest is
// still authoritative for file membership and must match this vector exactly.
type updateTargetLayers struct {
	Base    string `json:"base"`
	Runtime string `json:"runtime"`
	Agent   string `json:"agent,omitempty"`
	Session string `json:"session"`
}

type updateLayerTargets struct {
	Base    string `json:"base"`
	Runtime string `json:"runtime"`
	Agent   string `json:"agent,omitempty"`
	Session string `json:"session"`
}

type updateLedger struct {
	SchemaVersion int                          `json:"schema_version"`
	Entries       map[string]updateLedgerEntry `json:"entries"`
}

type updateLedgerEntry struct {
	ReleaseSequence uint64              `json:"release_sequence"`
	ImageVersion    string              `json:"image_version"`
	ManifestSHA256  string              `json:"manifest_sha256"`
	TargetSHA256    string              `json:"target_sha256"`
	Layers          *updateTargetLayers `json:"layers,omitempty"`
	LayerTargets    *updateLayerTargets `json:"layer_targets,omitempty"`
	AppliedAt       string              `json:"applied_at"`
}

func updateImage(args []string) error {
	flags := flag.NewFlagSet("update", flag.ContinueOnError)
	root := flags.String("root", "", "absolute installed image versions root")
	trustedRootPath := flags.String("trusted-root", "", "pinned TUF root.json")
	publicKeyPath := flags.String("manifest-public-key", "", "trusted PKIX PEM manifest public key")
	metadataURL := flags.String("metadata-url", "", "TUF metadata base URL")
	targetsURL := flags.String("targets-url", "", "TUF targets base URL")
	channel := flags.String("channel", "stable", "release channel")
	architecture := flags.String("arch", "", "arm64 or amd64")
	bundleFormat := flags.String("bundle-format", "auto", "auto, tar.zst, or tar.gz")
	smokeBinary := flags.String("smoke-binary", "", "absolute zapvm binary used to boot-check the staged image")
	skipSmoke := flags.Bool("skip-smoke", false, "emergency only: activate without booting the staged image")
	allowHTTPLoopback := flags.Bool("allow-http-loopback", false, "allow plain HTTP only to loopback hosts")
	tlsCAPath := flags.String("tls-ca", "", "optional absolute PEM CA bundle for the update origin")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *root == "" || *trustedRootPath == "" || *publicKeyPath == "" || *metadataURL == "" || *targetsURL == "" || *architecture == "" {
		return errors.New("update requires root, trusted-root, manifest-public-key, metadata-url, targets-url, channel, and arch")
	}
	if !filepath.IsAbs(*root) {
		return errors.New("image root must be absolute")
	}
	if !updateChannelPattern.MatchString(*channel) {
		return fmt.Errorf("unsafe update channel %q", *channel)
	}
	if *architecture != "arm64" && *architecture != "amd64" {
		return fmt.Errorf("unsupported architecture %q", *architecture)
	}
	if *bundleFormat != "auto" && *bundleFormat != "tar.zst" && *bundleFormat != "tar.gz" {
		return fmt.Errorf("unsupported bundle format %q", *bundleFormat)
	}
	metadataBase, err := validateUpdateBaseURL(*metadataURL, *allowHTTPLoopback)
	if err != nil {
		return fmt.Errorf("metadata URL: %w", err)
	}
	targetsBase, err := validateUpdateBaseURL(*targetsURL, *allowHTTPLoopback)
	if err != nil {
		return fmt.Errorf("targets URL: %w", err)
	}
	trustedRoot, err := readBoundedRegular(*trustedRootPath, maxTrustedRootSize)
	if err != nil {
		return fmt.Errorf("read trusted root: %w", err)
	}
	if _, err := loadPublicKey(*publicKeyPath); err != nil {
		return fmt.Errorf("read manifest public key: %w", err)
	}
	if *tlsCAPath != "" && !filepath.IsAbs(*tlsCAPath) {
		return errors.New("TLS CA path must be absolute")
	}
	if err := ensureImageRoot(*root); err != nil {
		return err
	}
	cacheRoot := filepath.Join(*root, ".zapvm-update")
	lock, err := acquireImageUpdateLock(*root)
	if err != nil {
		return fmt.Errorf("acquire update lock: %w", err)
	}
	defer lock.Close()
	metadataDirectory := filepath.Join(cacheRoot, "metadata")
	targetDirectory := filepath.Join(cacheRoot, "targets")
	for _, directory := range []string{metadataDirectory, targetDirectory} {
		if err := secureUpdateDirectory(directory); err != nil {
			return fmt.Errorf("secure update cache directory: %w", err)
		}
	}
	client, err := newUpdateHTTPClientWithCA(*allowHTTPLoopback, *tlsCAPath)
	if err != nil {
		return fmt.Errorf("configure update TLS trust: %w", err)
	}
	configuration, err := config.New(metadataBase.String(), trustedRoot)
	if err != nil {
		return err
	}
	configuration.LocalMetadataDir = metadataDirectory
	configuration.LocalTargetsDir = targetDirectory
	configuration.RemoteTargetsURL = targetsBase.String()
	configuration.MaxRootRotations = 64
	configuration.MaxDelegations = 16
	configuration.RootMaxLength = maxTrustedRootSize
	configuration.TimestampMaxLength = 64 << 10
	configuration.SnapshotMaxLength = 2 << 20
	configuration.TargetsMaxLength = 4 << 20
	configuration.PrefixTargetsWithHash = true
	if err := configuration.SetDefaultFetcherHTTPClient(client); err != nil {
		return err
	}
	tufUpdater, err := updater.New(configuration)
	if err != nil {
		return fmt.Errorf("initialize TUF updater: %w", err)
	}
	if err := tufUpdater.Refresh(); err != nil {
		return fmt.Errorf("refresh TUF metadata: %w", err)
	}
	if !tufUpdater.GetTrustedMetadataSet().Root.Signed.ConsistentSnapshot {
		return errors.New("TUF repository must enable consistent snapshots")
	}
	targetInfo, err := resolveUpdateTarget(tufUpdater, *channel, *architecture, *bundleFormat)
	if err != nil {
		return err
	}
	custom, err := decodeUpdateTargetCustom(targetInfo.Custom)
	if err != nil {
		return err
	}
	if custom.Architecture != *architecture {
		return errors.New("TUF target architecture does not match requested architecture")
	}
	ledgerPath := filepath.Join(cacheRoot, "ledger.json")
	ledger, err := readUpdateLedgerOptional(ledgerPath)
	if err != nil {
		return err
	}
	ledgerKey := *channel + "/" + *architecture
	previous, exists := ledger.Entries[ledgerKey]
	if exists {
		if custom.ReleaseSequence < previous.ReleaseSequence {
			return fmt.Errorf("release sequence rollback: got %d, trusted %d", custom.ReleaseSequence, previous.ReleaseSequence)
		}
		if custom.ReleaseSequence == previous.ReleaseSequence &&
			(custom.ImageVersion != previous.ImageVersion || custom.ManifestSHA256 != previous.ManifestSHA256) {
			return errors.New("release sequence equivocation detected")
		}
		if custom.ReleaseSequence == previous.ReleaseSequence && (!equalUpdateLayerVectors(custom.Layers, previous.Layers) || !equalUpdateLayerTargets(custom.LayerTargets, previous.LayerTargets)) {
			return errors.New("release layer vector equivocation detected")
		}
	}
	targetSHA256, err := requiredTargetSHA256(targetInfo)
	if err != nil {
		return err
	}
	if exists && custom.ReleaseSequence == previous.ReleaseSequence && targetSHA256 != previous.TargetSHA256 {
		return errors.New("release target equivocation detected")
	}

	bundlePath, err := downloadUpdateTarget(client, targetsBase, targetInfo, targetSHA256, targetDirectory)
	if err != nil {
		return err
	}
	extracted, retainedTargets, err := extractUpdateTargetSet(tufUpdater, client, targetsBase, custom, bundlePath, targetDirectory, *publicKeyPath)
	if err != nil {
		return err
	}
	defer os.RemoveAll(extracted)
	manifestPath := filepath.Join(extracted, "manifest.json")
	signaturePath := filepath.Join(extracted, "manifest.sig")
	imageManifest, err := verifyBundle(manifestPath, signaturePath, *publicKeyPath, extracted)
	if err != nil {
		return fmt.Errorf("verify update bundle: %w", err)
	}
	if imageManifest.ImageVersion != custom.ImageVersion || imageManifest.Architecture != custom.Architecture {
		return errors.New("signed manifest identity does not match TUF target metadata")
	}
	if err := verifyUpdateLayerVector(custom, imageManifest); err != nil {
		return err
	}
	manifestData, err := readBoundedRegular(manifestPath, maxManifestSize)
	if err != nil {
		return err
	}
	manifestDigest := sha256.Sum256(manifestData)
	if hex.EncodeToString(manifestDigest[:]) != custom.ManifestSHA256 {
		return errors.New("signed manifest hash does not match TUF target metadata")
	}

	destination := filepath.Join(*root, custom.ImageVersion)
	if _, err := os.Lstat(destination); errors.Is(err, os.ErrNotExist) {
		if err := installImage([]string{"--manifest", manifestPath, "--signature", signaturePath, "--public-key", *publicKeyPath, "--destination", destination}); err != nil {
			return fmt.Errorf("install update: %w", err)
		}
	} else if err != nil {
		return err
	} else {
		installedManifest, err := verifyInstalledVersion(*root, custom.ImageVersion, *publicKeyPath)
		if err != nil {
			return fmt.Errorf("verify existing update version: %w", err)
		}
		if installedManifest.Architecture != custom.Architecture {
			return errors.New("existing installed image architecture mismatch")
		}
		installedData, err := readBoundedRegular(filepath.Join(destination, "manifest.json"), maxManifestSize)
		if err != nil {
			return err
		}
		installedDigest := sha256.Sum256(installedData)
		if hex.EncodeToString(installedDigest[:]) != custom.ManifestSHA256 {
			return errors.New("existing installed image conflicts with update target")
		}
	}
	if err := smokeInstalledImage(*root, custom.ImageVersion, *publicKeyPath, *smokeBinary, *skipSmoke); err != nil {
		return fmt.Errorf("smoke staged update: %w", err)
	}
	if err := activateInstalledImage(*root, custom.ImageVersion, *publicKeyPath); err != nil {
		return fmt.Errorf("activate update: %w", err)
	}
	ledger.Entries[ledgerKey] = updateLedgerEntry{
		ReleaseSequence: custom.ReleaseSequence,
		ImageVersion:    custom.ImageVersion,
		ManifestSHA256:  custom.ManifestSHA256,
		TargetSHA256:    targetSHA256,
		Layers:          custom.Layers,
		LayerTargets:    custom.LayerTargets,
		AppliedAt:       time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err := writeUpdateLedger(ledgerPath, ledger); err != nil {
		return fmt.Errorf("commit update ledger: %w", err)
	}
	if err := pruneUpdateTargetCacheSet(targetDirectory, retainedTargets, 20); err != nil {
		fmt.Fprintf(os.Stderr, "warning: prune update warm cache: %v\n", err)
	}
	fmt.Printf("updated %s/%s to %s (sequence %d)\n", *channel, *architecture, custom.ImageVersion, custom.ReleaseSequence)
	return nil
}

func equalUpdateLayerVectors(left, right *updateTargetLayers) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func equalUpdateLayerTargets(left, right *updateLayerTargets) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func pruneUpdateTargetCache(directory, keepPath string, limit int) error {
	return pruneUpdateTargetCacheSet(directory, []string{keepPath}, limit)
}

func pruneUpdateTargetCacheSet(directory string, keepPaths []string, limit int) error {
	if limit < 1 {
		return errors.New("update cache retention limit must be positive")
	}
	keep := make(map[string]struct{}, len(keepPaths))
	for _, path := range keepPaths {
		keep[path] = struct{}{}
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	type candidate struct {
		path    string
		modTime time.Time
	}
	files := make([]candidate, 0, len(entries))
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
			continue
		}
		digest, _, found := strings.Cut(entry.Name(), ".")
		if !found || !validLowerSHA256(digest) || (!strings.HasSuffix(entry.Name(), ".tar.zst") && !strings.HasSuffix(entry.Name(), ".tar.gz")) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		files = append(files, candidate{path: filepath.Join(directory, entry.Name()), modTime: info.ModTime()})
	}
	if len(files) <= limit {
		return nil
	}
	sort.Slice(files, func(left, right int) bool {
		if files[left].modTime.Equal(files[right].modTime) {
			return files[left].path < files[right].path
		}
		return files[left].modTime.Before(files[right].modTime)
	})
	removed := false
	for len(files) > limit {
		index := 0
		for index < len(files) {
			if _, preserved := keep[files[index].path]; !preserved {
				break
			}
			index++
		}
		if index == len(files) {
			break
		}
		if err := os.Remove(files[index].path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		files = append(files[:index], files[index+1:]...)
		removed = true
	}
	if removed {
		return syncDirectory(directory)
	}
	return nil
}

func smokeInstalledImage(root, version, publicKey, smokeBinary string, skip bool) error {
	if skip {
		fmt.Fprintln(os.Stderr, "warning: staged image smoke was explicitly skipped")
		return nil
	}
	if smokeBinary == "" {
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		name := "zapvm"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		smokeBinary = filepath.Join(filepath.Dir(executable), name)
	}
	if !filepath.IsAbs(smokeBinary) {
		return errors.New("smoke binary path must be absolute")
	}
	info, err := os.Lstat(smokeBinary)
	if err != nil {
		return fmt.Errorf("locate zapvm smoke binary: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || (runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0) {
		return errors.New("smoke binary must be a regular executable file")
	}
	command := exec.Command(smokeBinary,
		"image-smoke",
		"--image-root", root,
		"--image-public-key", publicKey,
		"--image-version", version,
	)
	output := &boundedSmokeOutput{maximum: maxSmokeOutputSize}
	command.Stdout = output
	command.Stderr = output
	err = command.Run()
	if err != nil {
		return fmt.Errorf("candidate boot validation failed: %w: %s", err, strings.TrimSpace(output.String()))
	}
	if !bytes.Contains(output.data, []byte("ZAPVM_IMAGE_SMOKE_OK")) {
		return errors.New("candidate boot validation did not emit its success marker")
	}
	return nil
}

type boundedSmokeOutput struct {
	data      []byte
	maximum   int
	truncated bool
}

func (output *boundedSmokeOutput) Write(data []byte) (int, error) {
	written := len(data)
	remaining := output.maximum - len(output.data)
	if remaining > 0 {
		if len(data) > remaining {
			output.data = append(output.data, data[:remaining]...)
			output.truncated = true
		} else {
			output.data = append(output.data, data...)
		}
	} else if len(data) > 0 {
		output.truncated = true
	}
	return written, nil
}

func (output *boundedSmokeOutput) String() string {
	if output.truncated {
		return string(output.data) + "\n[smoke output truncated]"
	}
	return string(output.data)
}

func resolveUpdateTarget(tufUpdater *updater.Updater, channel, architecture, bundleFormat string) (*metadata.TargetFiles, error) {
	formats := []string{bundleFormat}
	if bundleFormat == "auto" {
		formats = []string{"tar.zst", "tar.gz"}
	}
	var failures []error
	for _, format := range formats {
		for _, kind := range []string{"composition", "bundle"} {
			targetPath := fmt.Sprintf("channels/%s/%s.%s.%s", channel, architecture, kind, format)
			targetInfo, err := tufUpdater.GetTargetInfo(targetPath)
			if err != nil {
				failures = append(failures, err)
				continue
			}
			if targetInfo != nil && targetInfo.Path == targetPath {
				return targetInfo, nil
			}
		}
	}
	if len(failures) > 0 && bundleFormat != "auto" {
		return nil, fmt.Errorf("resolve TUF target: %w", failures[0])
	}
	return nil, errors.New("TUF update target was not found")
}

func extractUpdateTargetSet(tufUpdater *updater.Updater, client *http.Client, targetsBase *url.URL, custom updateTargetCustom, compositionPath, targetDirectory, publicKeyPath string) (string, []string, error) {
	if custom.LayerTargets == nil {
		extracted, _, err := extractBundleArchive(compositionPath, targetDirectory)
		if err != nil {
			return "", nil, fmt.Errorf("extract update bundle: %w", err)
		}
		return extracted, []string{compositionPath}, nil
	}
	extracted, imageManifest, err := extractCompositionArchive(compositionPath, targetDirectory)
	if err != nil {
		return "", nil, fmt.Errorf("extract update composition: %w", err)
	}
	failed := true
	defer func() {
		if failed {
			_ = os.RemoveAll(extracted)
		}
	}()
	if imageManifest.ImageVersion != custom.ImageVersion || imageManifest.Architecture != custom.Architecture {
		return "", nil, errors.New("signed composition identity does not match TUF target metadata")
	}
	if err := verifyUpdateLayerVector(custom, imageManifest); err != nil {
		return "", nil, err
	}
	manifestData, err := readBoundedRegular(filepath.Join(extracted, "manifest.json"), maxManifestSize)
	if err != nil {
		return "", nil, err
	}
	manifestDigest := sha256.Sum256(manifestData)
	if hex.EncodeToString(manifestDigest[:]) != custom.ManifestSHA256 {
		return "", nil, errors.New("signed composition manifest hash does not match TUF target metadata")
	}
	signature, err := readBoundedRegular(filepath.Join(extracted, "manifest.sig"), ed25519.SignatureSize)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return "", nil, errors.New("composition contains an invalid manifest signature")
	}
	publicKey, err := loadPublicKey(publicKeyPath)
	if err != nil || !ed25519.Verify(publicKey, manifestData, signature) {
		return "", nil, errors.New("composition manifest signature verification failed")
	}
	files := make(map[string]manifestFile, len(imageManifest.Files))
	for _, file := range imageManifest.Files {
		files[file.Name] = file
	}
	paths := map[string]string{
		"base": custom.LayerTargets.Base, "runtime": custom.LayerTargets.Runtime,
		"agent": custom.LayerTargets.Agent, "session": custom.LayerTargets.Session,
	}
	retained := []string{compositionPath}
	for _, layer := range imageManifest.Layers {
		targetPath := paths[layer.Name]
		targetInfo, err := tufUpdater.GetTargetInfo(targetPath)
		if err != nil {
			return "", nil, fmt.Errorf("resolve TUF %s layer target: %w", layer.Name, err)
		}
		if targetInfo == nil || targetInfo.Path != targetPath {
			return "", nil, fmt.Errorf("resolve TUF %s layer target: target was not found", layer.Name)
		}
		digest, err := requiredTargetSHA256(targetInfo)
		if err != nil {
			return "", nil, fmt.Errorf("validate TUF %s layer target: %w", layer.Name, err)
		}
		archive, err := downloadUpdateTarget(client, targetsBase, targetInfo, digest, targetDirectory)
		if err != nil {
			return "", nil, fmt.Errorf("download %s layer target: %w", layer.Name, err)
		}
		retained = append(retained, archive)
		if err := extractLayerArchive(archive, extracted, layer, files); err != nil {
			return "", nil, fmt.Errorf("extract %s layer target: %w", layer.Name, err)
		}
	}
	failed = false
	return extracted, retained, nil
}

func acquireImageUpdateLock(root string) (*updateLock, error) {
	if err := ensureImageRoot(root); err != nil {
		return nil, err
	}
	cacheRoot := filepath.Join(root, ".zapvm-update")
	if err := secureUpdateDirectory(cacheRoot); err != nil {
		return nil, fmt.Errorf("secure update cache: %w", err)
	}
	return openUpdateLock(filepath.Join(cacheRoot, "update.lock"))
}

func ensureImageRoot(root string) error {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("image root must be a real directory")
	}
	return nil
}

func decodeUpdateTargetCustom(raw *json.RawMessage) (updateTargetCustom, error) {
	if raw == nil || len(*raw) == 0 || len(*raw) > 16<<10 {
		return updateTargetCustom{}, errors.New("TUF target is missing bounded custom metadata")
	}
	var custom updateTargetCustom
	decoder := json.NewDecoder(bytes.NewReader(*raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&custom); err != nil {
		return updateTargetCustom{}, fmt.Errorf("decode TUF target custom metadata: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return updateTargetCustom{}, errors.New("TUF target custom metadata contains trailing data")
	}
	if (custom.SchemaVersion != 1 && custom.SchemaVersion != 2 && custom.SchemaVersion != 3) || custom.ReleaseSequence == 0 {
		return updateTargetCustom{}, errors.New("unsupported TUF target custom metadata")
	}
	if err := validateVersionName(custom.ImageVersion); err != nil {
		return updateTargetCustom{}, err
	}
	if custom.Architecture != "arm64" && custom.Architecture != "amd64" {
		return updateTargetCustom{}, errors.New("invalid TUF target architecture")
	}
	if len(custom.ManifestSHA256) != sha256.Size*2 || strings.ToLower(custom.ManifestSHA256) != custom.ManifestSHA256 {
		return updateTargetCustom{}, errors.New("invalid manifest SHA-256 in TUF target metadata")
	}
	if _, err := hex.DecodeString(custom.ManifestSHA256); err != nil {
		return updateTargetCustom{}, errors.New("invalid manifest SHA-256 in TUF target metadata")
	}
	if custom.SchemaVersion == 1 {
		if custom.Layers != nil || custom.LayerTargets != nil {
			return updateTargetCustom{}, errors.New("TUF target custom metadata schema 1 must not declare layers")
		}
		return custom, nil
	}
	if custom.Layers == nil {
		return updateTargetCustom{}, errors.New("TUF target custom metadata schema 2 requires a layer version vector")
	}
	if err := validateUpdateLayerVector(*custom.Layers); err != nil {
		return updateTargetCustom{}, err
	}
	if custom.SchemaVersion == 2 {
		if custom.LayerTargets != nil {
			return updateTargetCustom{}, errors.New("TUF target custom metadata schema 2 must not declare layer targets")
		}
		return custom, nil
	}
	if custom.LayerTargets == nil {
		return updateTargetCustom{}, errors.New("TUF target custom metadata schema 3 requires layer targets")
	}
	if err := validateUpdateLayerTargets(*custom.LayerTargets); err != nil {
		return updateTargetCustom{}, err
	}
	if (custom.Layers.Agent == "") != (custom.LayerTargets.Agent == "") {
		return updateTargetCustom{}, errors.New("Agent layer version and target must either both be present or both be absent")
	}
	return custom, nil
}

func validateUpdateLayerTargets(targets updateLayerTargets) error {
	seen := make(map[string]struct{}, 4)
	for _, item := range []struct{ name, path string }{
		{name: "base", path: targets.Base}, {name: "runtime", path: targets.Runtime},
		{name: "agent", path: targets.Agent}, {name: "session", path: targets.Session},
	} {
		if item.name == "agent" && item.path == "" {
			continue
		}
		if item.path == "" || len(item.path) > 240 || strings.HasPrefix(item.path, "/") || strings.Contains(item.path, "\\") || strings.Contains(item.path, "..") || !strings.HasSuffix(item.path, ".layer.tar.zst") {
			return fmt.Errorf("invalid %s layer target path", item.name)
		}
		if _, exists := seen[item.path]; exists {
			return errors.New("layer target paths must be unique")
		}
		seen[item.path] = struct{}{}
	}
	return nil
}

func validateUpdateLayerVector(layers updateTargetLayers) error {
	for _, layer := range []struct{ name, value string }{
		{name: "base", value: layers.Base},
		{name: "runtime", value: layers.Runtime},
		{name: "agent", value: layers.Agent},
		{name: "session", value: layers.Session},
	} {
		if layer.name == "agent" && layer.value == "" {
			continue
		}
		if err := validateVersionName(layer.value); err != nil {
			return fmt.Errorf("invalid %s layer version in TUF target metadata: %w", layer.name, err)
		}
	}
	return nil
}

func verifyUpdateLayerVector(custom updateTargetCustom, imageManifest manifest) error {
	if imageManifest.SchemaVersion < 3 {
		if custom.Layers != nil {
			return errors.New("legacy image manifest must not be published with a layer version vector")
		}
		return nil
	}
	if (custom.SchemaVersion != 2 && custom.SchemaVersion != 3) || custom.Layers == nil {
		return errors.New("schema 3 image requires TUF target custom metadata schema 2 or 3 with a layer version vector")
	}
	want := *custom.Layers
	got := updateTargetLayers{}
	for _, layer := range imageManifest.Layers {
		switch layer.Name {
		case "base":
			got.Base = layer.Version
		case "runtime":
			got.Runtime = layer.Version
		case "agent":
			got.Agent = layer.Version
		case "session":
			got.Session = layer.Version
		}
	}
	if got != want {
		return fmt.Errorf("signed layer version vector does not match TUF target metadata: got %+v, want %+v", got, want)
	}
	return nil
}

func validateUpdateBaseURL(value string, allowHTTPLoopback bool) (*url.URL, error) {
	parsed, err := url.Parse(value)
	if err != nil {
		return nil, err
	}
	if parsed.User != nil || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("URL must have an authority and no credentials, query, or fragment")
	}
	if parsed.Scheme == "https" {
		return parsed, nil
	}
	if parsed.Scheme != "http" || !allowHTTPLoopback || !isLoopbackHost(parsed.Hostname()) {
		return nil, errors.New("HTTPS is required (HTTP is limited to explicitly enabled loopback testing)")
	}
	return parsed, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func newUpdateHTTPClient(allowHTTPLoopback bool) *http.Client {
	client, err := newUpdateHTTPClientWithCA(allowHTTPLoopback, "")
	if err != nil {
		panic(err)
	}
	return client
}

func newUpdateHTTPClientWithCA(allowHTTPLoopback bool, caPath string) (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DisableCompression = true
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if caPath != "" {
		data, err := readBoundedRegular(caPath, 1<<20)
		if err != nil {
			return nil, err
		}
		roots, err := x509.SystemCertPool()
		if err != nil || roots == nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(data) {
			return nil, errors.New("TLS CA bundle contains no certificates")
		}
		tlsConfig.RootCAs = roots
	}
	transport.TLSClientConfig = tlsConfig
	transport.DialContext = (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.TLSHandshakeTimeout = 15 * time.Second
	transport.ResponseHeaderTimeout = 30 * time.Second
	client := &http.Client{Transport: transport, Timeout: updateHTTPTimeout}
	client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many update redirects")
		}
		if len(via) == 0 {
			return nil
		}
		origin := via[0].URL
		if !strings.EqualFold(request.URL.Host, origin.Host) {
			return errors.New("cross-origin update redirect rejected")
		}
		if request.URL.Scheme == "https" {
			return nil
		}
		if request.URL.Scheme == "http" && allowHTTPLoopback && isLoopbackHost(request.URL.Hostname()) {
			return nil
		}
		return errors.New("insecure update redirect rejected")
	}
	return client, nil
}

func requiredTargetSHA256(target *metadata.TargetFiles) (string, error) {
	if target.Length <= 0 || target.Length > maxUpdateTargetSize {
		return "", errors.New("TUF update target has an invalid length")
	}
	digest, exists := target.Hashes["sha256"]
	if !exists || len(digest) != sha256.Size {
		return "", errors.New("TUF update target must have a SHA-256 hash")
	}
	for algorithm, value := range target.Hashes {
		switch algorithm {
		case "sha256":
			if len(value) != sha256.Size {
				return "", errors.New("invalid TUF SHA-256 target hash")
			}
		case "sha512":
			if len(value) != sha512.Size {
				return "", errors.New("invalid TUF SHA-512 target hash")
			}
		default:
			return "", fmt.Errorf("unsupported TUF target hash algorithm %q", algorithm)
		}
	}
	return hex.EncodeToString(digest), nil
}

func downloadUpdateTarget(client *http.Client, base *url.URL, target *metadata.TargetFiles, sha256Hex, directory string) (string, error) {
	remotePath := target.Path
	baseName := filepath.Base(remotePath)
	directoryName, found := strings.CutSuffix(remotePath, "/"+baseName)
	prefixedName := sha256Hex + "." + baseName
	cachedPath := filepath.Join(directory, prefixedName)
	if err := verifyCachedUpdateTarget(cachedPath, target); err == nil {
		return cachedPath, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		if removeErr := os.Remove(cachedPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return "", fmt.Errorf("remove invalid cached update target: %w", removeErr)
		}
	}
	if found {
		remotePath = directoryName + "/" + prefixedName
	} else {
		remotePath = prefixedName
	}
	remoteURL, err := url.JoinPath(base.String(), remotePath)
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, remoteURL, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept-Encoding", "identity")
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("download update target: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download update target: HTTP %d", response.StatusCode)
	}
	if encoding := strings.TrimSpace(response.Header.Get("Content-Encoding")); encoding != "" && !strings.EqualFold(encoding, "identity") {
		return "", errors.New("compressed HTTP update response rejected")
	}
	if response.ContentLength >= 0 && response.ContentLength != target.Length {
		return "", errors.New("update target Content-Length mismatch")
	}
	temporary, err := os.CreateTemp(directory, ".zapvm-target-")
	if err != nil {
		return "", err
	}
	temporaryPath := temporary.Name()
	succeeded := false
	defer func() {
		_ = temporary.Close()
		if !succeeded {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return "", err
	}
	hashers := make(map[string]hash.Hash, len(target.Hashes))
	writers := []io.Writer{temporary}
	for algorithm := range target.Hashes {
		switch algorithm {
		case "sha256":
			hashers[algorithm] = sha256.New()
		case "sha512":
			hashers[algorithm] = sha512.New()
		default:
			return "", fmt.Errorf("unsupported TUF target hash algorithm %q", algorithm)
		}
		writers = append(writers, hashers[algorithm])
	}
	written, err := io.Copy(io.MultiWriter(writers...), io.LimitReader(response.Body, target.Length+1))
	if err != nil {
		return "", err
	}
	if written != target.Length {
		return "", errors.New("downloaded update target length mismatch")
	}
	for algorithm, expected := range target.Hashes {
		if !bytes.Equal(hashers[algorithm].Sum(nil), expected) {
			return "", fmt.Errorf("downloaded update target %s mismatch", algorithm)
		}
	}
	if err := temporary.Sync(); err != nil {
		return "", err
	}
	if err := temporary.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(temporaryPath, cachedPath); err != nil {
		return "", err
	}
	if err := syncDirectory(directory); err != nil {
		_ = os.Remove(cachedPath)
		return "", err
	}
	succeeded = true
	return cachedPath, nil
}

func verifyCachedUpdateTarget(path string, target *metadata.TargetFiles) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != target.Length {
		return errors.New("cached update target is not a regular file with the trusted length")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) || opened.Size() != info.Size() {
		return errors.New("cached update target changed while opening")
	}
	hashers := make(map[string]hash.Hash, len(target.Hashes))
	writers := make([]io.Writer, 0, len(target.Hashes))
	for algorithm := range target.Hashes {
		switch algorithm {
		case "sha256":
			hashers[algorithm] = sha256.New()
		case "sha512":
			hashers[algorithm] = sha512.New()
		default:
			return fmt.Errorf("unsupported TUF target hash algorithm %q", algorithm)
		}
		writers = append(writers, hashers[algorithm])
	}
	written, err := io.Copy(io.MultiWriter(writers...), file)
	if err != nil || written != target.Length {
		return errors.New("cached update target length mismatch")
	}
	for algorithm, expected := range target.Hashes {
		if !bytes.Equal(hashers[algorithm].Sum(nil), expected) {
			return fmt.Errorf("cached update target %s mismatch", algorithm)
		}
	}
	return nil
}

func readUpdateLedgerOptional(path string) (updateLedger, error) {
	data, err := readBoundedRegular(path, maxUpdateLedgerSize)
	if errors.Is(err, os.ErrNotExist) {
		return updateLedger{SchemaVersion: 1, Entries: make(map[string]updateLedgerEntry)}, nil
	}
	if err != nil {
		return updateLedger{}, err
	}
	var ledger updateLedger
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&ledger); err != nil {
		return updateLedger{}, fmt.Errorf("decode update ledger: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return updateLedger{}, errors.New("update ledger contains trailing data")
	}
	if ledger.SchemaVersion != 1 || ledger.Entries == nil || len(ledger.Entries) > 128 {
		return updateLedger{}, errors.New("invalid update ledger")
	}
	for key, entry := range ledger.Entries {
		parts := strings.Split(key, "/")
		if len(parts) != 2 || !updateChannelPattern.MatchString(parts[0]) || (parts[1] != "arm64" && parts[1] != "amd64") || entry.ReleaseSequence == 0 {
			return updateLedger{}, errors.New("invalid update ledger entry")
		}
		if err := validateVersionName(entry.ImageVersion); err != nil {
			return updateLedger{}, err
		}
		if !validLowerSHA256(entry.ManifestSHA256) || !validLowerSHA256(entry.TargetSHA256) {
			return updateLedger{}, errors.New("invalid update ledger digest")
		}
		if entry.Layers != nil {
			if err := validateUpdateLayerVector(*entry.Layers); err != nil {
				return updateLedger{}, fmt.Errorf("invalid update ledger layer vector: %w", err)
			}
		}
		if entry.LayerTargets != nil {
			if entry.Layers == nil {
				return updateLedger{}, errors.New("update ledger layer targets require a layer vector")
			}
			if err := validateUpdateLayerTargets(*entry.LayerTargets); err != nil {
				return updateLedger{}, fmt.Errorf("invalid update ledger layer targets: %w", err)
			}
		}
		if _, err := time.Parse(time.RFC3339Nano, entry.AppliedAt); err != nil {
			return updateLedger{}, errors.New("invalid update ledger timestamp")
		}
	}
	return ledger, nil
}

func validLowerSHA256(value string) bool {
	return vmimage.ValidLowerSHA256(value)
}

func writeUpdateLedger(path string, ledger updateLedger) error {
	data, err := json.MarshalIndent(ledger, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if len(data) > maxUpdateLedgerSize {
		return errors.New("update ledger exceeds size limit")
	}
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".zapvm-ledger-")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := replacePath(temporaryPath, path); err != nil {
		return err
	}
	return syncDirectory(directory)
}
