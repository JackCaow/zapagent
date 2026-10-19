package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path"
	"path/filepath"
)

func createTargetMetadata(args []string) error {
	flags := flag.NewFlagSet("target-metadata", flag.ContinueOnError)
	manifestPath := flags.String("manifest", "", "signed image manifest JSON path")
	signaturePath := flags.String("signature", "", "raw Ed25519 manifest signature")
	publicKeyPath := flags.String("public-key", "", "trusted PKIX PEM manifest public key")
	releaseSequence := flags.Uint64("release-sequence", 0, "monotonic channel/architecture release sequence")
	layerTargetIndex := flags.String("layer-target-index", "", "optional bundle-layers index for schema 3 independent targets")
	layerTargetPrefix := flags.String("layer-target-prefix", "", "TUF target prefix for independent layer archives")
	outputPath := flags.String("output", "", "new TUF target custom metadata JSON path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *manifestPath == "" || *signaturePath == "" || *publicKeyPath == "" || *releaseSequence == 0 || *outputPath == "" {
		return errors.New("target-metadata requires manifest, signature, public-key, release-sequence, and output")
	}
	if (*layerTargetIndex == "") != (*layerTargetPrefix == "") {
		return errors.New("layer-target-index and layer-target-prefix must be provided together")
	}
	imageManifest, err := verifyBundle(*manifestPath, *signaturePath, *publicKeyPath, filepath.Dir(*manifestPath))
	if err != nil {
		return fmt.Errorf("verify target manifest: %w", err)
	}
	manifestData, err := readBoundedRegular(*manifestPath, maxManifestSize)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(manifestData)
	custom := updateTargetCustom{
		SchemaVersion: 1, ReleaseSequence: *releaseSequence,
		ImageVersion: imageManifest.ImageVersion, Architecture: imageManifest.Architecture,
		ManifestSHA256: hex.EncodeToString(digest[:]),
	}
	if imageManifest.SchemaVersion == 3 {
		custom.SchemaVersion = 2
		layers := updateTargetLayers{}
		for _, layer := range imageManifest.Layers {
			switch layer.Name {
			case "base":
				layers.Base = layer.Version
			case "runtime":
				layers.Runtime = layer.Version
			case "agent":
				layers.Agent = layer.Version
			case "session":
				layers.Session = layer.Version
			}
		}
		custom.Layers = &layers
		if *layerTargetIndex != "" {
			index, err := readLayerBundleIndex(*layerTargetIndex, imageManifest)
			if err != nil {
				return fmt.Errorf("validate layer target index: %w", err)
			}
			prefix := path.Clean(*layerTargetPrefix)
			if prefix == "." || prefix == "/" || path.IsAbs(prefix) || len(prefix) > 180 || prefix == ".." || len(prefix) >= 3 && prefix[:3] == "../" {
				return errors.New("layer target prefix must be a safe relative TUF path")
			}
			custom.SchemaVersion = 3
			targets := updateLayerTargets{
				Base: path.Join(prefix, index.Layers["base"].Path), Runtime: path.Join(prefix, index.Layers["runtime"].Path),
				Session: path.Join(prefix, index.Layers["session"].Path),
			}
			if agent, exists := index.Layers["agent"]; exists {
				targets.Agent = path.Join(prefix, agent.Path)
			}
			custom.LayerTargets = &targets
		}
	}
	data, err := json.MarshalIndent(custom, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	raw := json.RawMessage(data)
	if _, err := decodeUpdateTargetCustom(&raw); err != nil {
		return fmt.Errorf("validate generated target metadata: %w", err)
	}
	return writeNewSyncedFile(*outputPath, data, 0o644)
}

func writeNewSyncedFile(path string, data []byte, mode os.FileMode) error {
	if path == "" || filepath.Base(path) == "." {
		return errors.New("output path must name a new file")
	}
	parent := filepath.Dir(path)
	info, err := os.Lstat(parent)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("output parent must be a real directory")
	}
	if _, err := os.Lstat(path); err == nil {
		return errors.New("output already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	file, err := os.CreateTemp(parent, ".zapvm-target-metadata-")
	if err != nil {
		return err
	}
	temporaryPath := file.Name()
	committed := false
	defer func() {
		_ = file.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := file.Chmod(mode); err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Link(temporaryPath, path); err != nil {
		return err
	}
	if err := os.Remove(temporaryPath); err != nil {
		_ = os.Remove(path)
		return err
	}
	committed = true
	return syncDirectory(parent)
}
