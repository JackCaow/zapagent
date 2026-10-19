package main

import (
	"bytes"
	"crypto"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

const maxTUFCustomMetadataSize = 64 << 10

type tufRepositoryInput struct {
	role       string
	privateKey ed25519.PrivateKey
}

func createTUFRepository(args []string) error {
	flags := flag.NewFlagSet("tuf-repository", flag.ContinueOnError)
	layerDirectory := flags.String("layer-target-dir", "", "directory produced by bundle-layers")
	customPath := flags.String("custom-metadata", "", "schema 3 custom metadata produced by target-metadata")
	rootKeyPath := flags.String("root-private-key", "", "PKCS#8 PEM TUF root private key")
	targetsKeyPath := flags.String("targets-private-key", "", "PKCS#8 PEM TUF targets private key")
	snapshotKeyPath := flags.String("snapshot-private-key", "", "PKCS#8 PEM TUF snapshot private key")
	timestampKeyPath := flags.String("timestamp-private-key", "", "PKCS#8 PEM TUF timestamp private key")
	channel := flags.String("channel", "", "release channel")
	architecture := flags.String("arch", "", "arm64 or amd64")
	metadataVersion := flags.Int64("metadata-version", 1, "positive targets/snapshot/timestamp metadata version")
	rootVersion := flags.Int64("root-version", 1, "positive root metadata version")
	rootExpires := flags.String("root-expires", "", "root expiry in RFC3339 form")
	targetsExpires := flags.String("targets-expires", "", "targets expiry in RFC3339 form")
	snapshotExpires := flags.String("snapshot-expires", "", "snapshot expiry in RFC3339 form")
	timestampExpires := flags.String("timestamp-expires", "", "timestamp expiry in RFC3339 form")
	outputDirectory := flags.String("output-dir", "", "new repository directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *layerDirectory == "" || *customPath == "" || *rootKeyPath == "" ||
		*targetsKeyPath == "" || *snapshotKeyPath == "" || *timestampKeyPath == "" ||
		*channel == "" || *architecture == "" || *rootExpires == "" || *targetsExpires == "" ||
		*snapshotExpires == "" || *timestampExpires == "" || *outputDirectory == "" {
		return errors.New("tuf-repository requires layer-target-dir, custom-metadata, four role private keys, channel, arch, four expiries, and output-dir")
	}
	if !updateChannelPattern.MatchString(*channel) {
		return fmt.Errorf("unsafe update channel %q", *channel)
	}
	switch *channel {
	case "stable", "production", "prod":
		return errors.New("single-process TUF repository generation is restricted to development, RC, and staging channels; stable publication requires separated production roles")
	}
	if *architecture != "arm64" && *architecture != "amd64" {
		return fmt.Errorf("unsupported architecture %q", *architecture)
	}
	if *metadataVersion < 1 || *rootVersion < 1 {
		return errors.New("TUF metadata versions must be positive")
	}
	expires, err := parseTUFExpiries(*rootExpires, *targetsExpires, *snapshotExpires, *timestampExpires)
	if err != nil {
		return err
	}

	layerRoot, err := realDirectory(*layerDirectory)
	if err != nil {
		return fmt.Errorf("layer target directory: %w", err)
	}
	customData, err := readBoundedRegular(*customPath, maxTUFCustomMetadataSize)
	if err != nil {
		return fmt.Errorf("read custom metadata: %w", err)
	}
	customRaw := json.RawMessage(customData)
	custom, err := decodeUpdateTargetCustom(&customRaw)
	if err != nil {
		return fmt.Errorf("validate custom metadata: %w", err)
	}
	if custom.SchemaVersion != 3 || custom.Architecture != *architecture || custom.LayerTargets == nil {
		return errors.New("TUF repository publication requires matching schema 3 independent-layer metadata")
	}
	index, err := readTUFPublicationIndex(filepath.Join(layerRoot, "layer-targets.json"), *architecture, custom)
	if err != nil {
		return err
	}

	roles := []tufRepositoryInput{
		{role: metadata.ROOT}, {role: metadata.TARGETS}, {role: metadata.SNAPSHOT}, {role: metadata.TIMESTAMP},
	}
	keyPaths := []string{*rootKeyPath, *targetsKeyPath, *snapshotKeyPath, *timestampKeyPath}
	keyIDs := make(map[string]string, len(roles))
	for position := range roles {
		key, err := loadPrivateKey(keyPaths[position])
		if err != nil {
			return fmt.Errorf("load %s key: %w", roles[position].role, err)
		}
		roles[position].privateKey = key
		tufKey, err := metadata.KeyFromPublicKey(key.Public())
		if err != nil {
			return err
		}
		keyID, err := tufKey.ID()
		if err != nil {
			return err
		}
		if previousRole, exists := keyIDs[keyID]; exists {
			return fmt.Errorf("TUF roles %s and %s must use different keys", previousRole, roles[position].role)
		}
		keyIDs[keyID] = roles[position].role
	}

	absoluteOutput, err := filepath.Abs(*outputDirectory)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(absoluteOutput); err == nil {
		return errors.New("TUF repository output directory already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	parent, err := realDirectory(filepath.Dir(absoluteOutput))
	if err != nil {
		return fmt.Errorf("TUF repository output parent: %w", err)
	}
	staging, err := os.MkdirTemp(parent, ".zapvm-tuf-repository-")
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(staging)
		}
	}()
	if err := os.Chmod(staging, 0o700); err != nil {
		return err
	}
	metadataDirectory := filepath.Join(staging, "metadata")
	targetDirectory := filepath.Join(staging, "targets")
	if err := os.MkdirAll(metadataDirectory, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(targetDirectory, 0o700); err != nil {
		return err
	}

	rootMetadata := metadata.Root(expires.root)
	rootMetadata.Signed.Version = *rootVersion
	targetsMetadata := metadata.Targets(expires.targets)
	targetsMetadata.Signed.Version = *metadataVersion
	snapshotMetadata := metadata.Snapshot(expires.snapshot)
	snapshotMetadata.Signed.Version = *metadataVersion
	timestampMetadata := metadata.Timestamp(expires.timestamp)
	timestampMetadata.Signed.Version = *metadataVersion
	for _, role := range roles {
		tufKey, err := metadata.KeyFromPublicKey(role.privateKey.Public())
		if err != nil {
			return err
		}
		if err := rootMetadata.Signed.AddKey(tufKey, role.role); err != nil {
			return err
		}
	}

	targetInputs := make(map[string]string, 5)
	compositionTarget := filepath.ToSlash(filepath.Join("channels", *channel, *architecture+".composition.tar.zst"))
	targetInputs[compositionTarget] = filepath.Join(layerRoot, index.Composition.Path)
	for layer, target := range index.Layers {
		targetPath := layerTargetForName(*custom.LayerTargets, layer)
		if targetPath == "" || filepath.Base(targetPath) != target.Path {
			return fmt.Errorf("custom metadata path does not match %s layer archive", layer)
		}
		targetInputs[targetPath] = filepath.Join(layerRoot, target.Path)
	}
	targetPaths := make([]string, 0, len(targetInputs))
	for targetPath := range targetInputs {
		targetPaths = append(targetPaths, targetPath)
	}
	sort.Strings(targetPaths)
	for _, targetPath := range targetPaths {
		payload, err := readBoundedRegular(targetInputs[targetPath], maxUpdateTargetSize)
		if err != nil {
			return fmt.Errorf("read TUF target %s: %w", targetPath, err)
		}
		targetInfo, err := metadata.TargetFile().FromBytes(targetPath, payload, "sha256", "sha512")
		if err != nil {
			return err
		}
		if targetPath == compositionTarget {
			raw := json.RawMessage(append([]byte(nil), customData...))
			targetInfo.Custom = &raw
		}
		var indexed layerBundleIndexTarget
		if targetPath == compositionTarget {
			indexed = index.Composition
		} else {
			for layerName, layerTarget := range index.Layers {
				if layerTargetForName(*custom.LayerTargets, layerName) == targetPath {
					indexed = layerTarget
					break
				}
			}
		}
		if err := verifyPublicationPayload(indexed, payload); err != nil {
			return fmt.Errorf("verify indexed TUF target %s: %w", targetPath, err)
		}
		targetsMetadata.Signed.Targets[targetPath] = targetInfo
		if err := writeConsistentTarget(targetDirectory, targetPath, targetInfo, payload); err != nil {
			return err
		}
	}
	if err := signTUFMetadata(targetsMetadata, roles[1].privateKey); err != nil {
		return err
	}
	targetsData, err := targetsMetadata.ToBytes(false)
	if err != nil {
		return err
	}
	snapshotMetadata.Signed.Meta["targets.json"] = tufMetaFile(*metadataVersion, targetsData)
	if err := signTUFMetadata(snapshotMetadata, roles[2].privateKey); err != nil {
		return err
	}
	snapshotData, err := snapshotMetadata.ToBytes(false)
	if err != nil {
		return err
	}
	timestampMetadata.Signed.Meta["snapshot.json"] = tufMetaFile(*metadataVersion, snapshotData)
	if err := signTUFMetadata(timestampMetadata, roles[3].privateKey); err != nil {
		return err
	}
	timestampData, err := timestampMetadata.ToBytes(false)
	if err != nil {
		return err
	}
	if err := signTUFMetadata(rootMetadata, roles[0].privateKey); err != nil {
		return err
	}
	rootData, err := rootMetadata.ToBytes(false)
	if err != nil {
		return err
	}
	metadataFiles := map[string][]byte{
		fmt.Sprintf("%d.root.json", *rootVersion):         rootData,
		fmt.Sprintf("%d.targets.json", *metadataVersion):  targetsData,
		fmt.Sprintf("%d.snapshot.json", *metadataVersion): snapshotData,
		"timestamp.json": timestampData,
	}
	for name, data := range metadataFiles {
		if err := writeNewSyncedFile(filepath.Join(metadataDirectory, name), data, 0o644); err != nil {
			return err
		}
	}
	if err := syncDirectory(targetDirectory); err != nil {
		return err
	}
	if err := syncDirectory(metadataDirectory); err != nil {
		return err
	}
	if err := preparePublishedRepository(staging); err != nil {
		return err
	}
	if err := syncDirectory(staging); err != nil {
		return err
	}
	if err := publishNewDirectory(staging, absoluteOutput); err != nil {
		if _, destinationErr := os.Lstat(absoluteOutput); destinationErr == nil {
			return errors.New("TUF repository output directory already exists")
		}
		return err
	}
	if err := syncDirectory(parent); err != nil {
		return err
	}
	committed = true
	fmt.Printf("created TUF repository channel=%s arch=%s image=%s sequence=%d output=%s\n", *channel, *architecture, custom.ImageVersion, custom.ReleaseSequence, absoluteOutput)
	return nil
}

type tufExpirySet struct {
	root, targets, snapshot, timestamp time.Time
}

func parseTUFExpiries(root, targets, snapshot, timestamp string) (tufExpirySet, error) {
	values := []string{root, targets, snapshot, timestamp}
	parsed := make([]time.Time, len(values))
	for position, value := range values {
		candidate, err := time.Parse(time.RFC3339, value)
		if err != nil || candidate.Format(time.RFC3339) != value {
			return tufExpirySet{}, fmt.Errorf("TUF expiry %q must be canonical RFC3339 UTC", value)
		}
		if candidate.Location() != time.UTC {
			return tufExpirySet{}, fmt.Errorf("TUF expiry %q must use UTC Z", value)
		}
		parsed[position] = candidate
	}
	if !parsed[3].Before(parsed[2]) || !parsed[2].Before(parsed[1]) || !parsed[1].Before(parsed[0]) {
		return tufExpirySet{}, errors.New("TUF expiries must satisfy timestamp < snapshot < targets < root")
	}
	if !time.Now().UTC().Before(parsed[3]) {
		return tufExpirySet{}, errors.New("TUF timestamp metadata must expire in the future")
	}
	return tufExpirySet{root: parsed[0], targets: parsed[1], snapshot: parsed[2], timestamp: parsed[3]}, nil
}

func realDirectory(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("must be a real directory")
	}
	return absolute, nil
}

func readTUFPublicationIndex(path, architecture string, custom updateTargetCustom) (layerBundleIndex, error) {
	data, err := readBoundedRegular(path, maxManifestSize)
	if err != nil {
		return layerBundleIndex{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var index layerBundleIndex
	if err := decoder.Decode(&index); err != nil {
		return layerBundleIndex{}, fmt.Errorf("decode layer target index: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return layerBundleIndex{}, errors.New("layer target index contains trailing data")
	}
	if index.SchemaVersion != 1 || index.Architecture != architecture || index.ImageVersion != custom.ImageVersion {
		return layerBundleIndex{}, errors.New("layer target index identity does not match custom metadata")
	}
	expectedLayerNames := []string{"base", "runtime", "session"}
	if custom.Layers.Agent != "" {
		expectedLayerNames = []string{"base", "runtime", "agent", "session"}
	}
	if len(index.Layers) != len(expectedLayerNames) {
		return layerBundleIndex{}, errors.New("layer target index does not match the signed layer vector")
	}
	for _, name := range expectedLayerNames {
		target, exists := index.Layers[name]
		if !exists || target.Version != layerVersionForName(*custom.Layers, name) {
			return layerBundleIndex{}, fmt.Errorf("layer target index has an invalid %s version", name)
		}
		if err := validatePublicationTarget(target); err != nil {
			return layerBundleIndex{}, fmt.Errorf("validate %s layer target: %w", name, err)
		}
	}
	if err := validatePublicationTarget(index.Composition); err != nil {
		return layerBundleIndex{}, fmt.Errorf("validate composition target: %w", err)
	}
	return index, nil
}

func validatePublicationTarget(target layerBundleIndexTarget) error {
	if target.Path == "" || filepath.Base(target.Path) != target.Path || target.Size <= 0 || len(target.SHA256) != 64 {
		return errors.New("invalid target identity")
	}
	if _, err := hex.DecodeString(target.SHA256); err != nil {
		return errors.New("invalid target SHA-256")
	}
	return nil
}

func verifyPublicationPayload(target layerBundleIndexTarget, payload []byte) error {
	if err := validatePublicationTarget(target); err != nil {
		return err
	}
	if int64(len(payload)) != target.Size {
		return fmt.Errorf("size mismatch: got %d, want %d", len(payload), target.Size)
	}
	digest := sha256.Sum256(payload)
	if hex.EncodeToString(digest[:]) != target.SHA256 {
		return errors.New("SHA-256 mismatch")
	}
	return nil
}

func layerVersionForName(layers updateTargetLayers, name string) string {
	switch name {
	case "base":
		return layers.Base
	case "runtime":
		return layers.Runtime
	case "agent":
		return layers.Agent
	case "session":
		return layers.Session
	default:
		return ""
	}
}

func layerTargetForName(targets updateLayerTargets, name string) string {
	switch name {
	case "base":
		return targets.Base
	case "runtime":
		return targets.Runtime
	case "agent":
		return targets.Agent
	case "session":
		return targets.Session
	default:
		return ""
	}
}

func writeConsistentTarget(root, targetPath string, info *metadata.TargetFiles, payload []byte) error {
	digest, exists := info.Hashes["sha256"]
	if !exists || len(digest) != sha256.Size {
		return errors.New("TUF target is missing SHA-256")
	}
	directory := filepath.Join(root, filepath.FromSlash(filepath.Dir(targetPath)))
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	name := hex.EncodeToString(digest) + "." + filepath.Base(targetPath)
	return writeNewSyncedFile(filepath.Join(directory, name), payload, 0o644)
}

func preparePublishedRepository(root string) error {
	directories := make([]string, 0, 8)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			directories = append(directories, path)
		}
		return nil
	})
	if err != nil {
		return err
	}
	// Sync children before parents so every nested directory entry is durable,
	// then make the completed public repository traversable without exposing it
	// while it is still under construction.
	for position := len(directories) - 1; position >= 0; position-- {
		if err := os.Chmod(directories[position], 0o755); err != nil {
			return err
		}
		if err := syncDirectory(directories[position]); err != nil {
			return err
		}
	}
	return nil
}

func tufMetaFile(version int64, data []byte) *metadata.MetaFiles {
	digest := sha256.Sum256(data)
	return &metadata.MetaFiles{Version: version, Length: int64(len(data)), Hashes: metadata.Hashes{"sha256": digest[:]}}
}

func signTUFMetadata[T metadata.Roles](value *metadata.Metadata[T], privateKey ed25519.PrivateKey) error {
	signer, err := signature.LoadSigner(privateKey, crypto.Hash(0))
	if err != nil {
		return err
	}
	_, err = value.Sign(signer)
	return err
}
