package main

import (
	"archive/tar"
	"bufio"
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
	"strings"
)

// layerBundleIndex is an unsigned publication aid. The signed image manifest
// remains authoritative; release tooling uses this index only to add the
// generated, content-checked archives as individual TUF targets.
type layerBundleIndex struct {
	SchemaVersion int                               `json:"schema_version"`
	ImageVersion  string                            `json:"image_version"`
	Architecture  string                            `json:"architecture"`
	Composition   layerBundleIndexTarget            `json:"composition"`
	Layers        map[string]layerBundleIndexTarget `json:"layers"`
}

type layerBundleIndexTarget struct {
	Version string `json:"version,omitempty"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
}

func createLayerBundles(args []string) error {
	flags := flag.NewFlagSet("bundle-layers", flag.ContinueOnError)
	manifestPath := flags.String("manifest", "", "signed schema 3 manifest JSON path")
	signaturePath := flags.String("signature", "", "raw Ed25519 manifest signature")
	publicKeyPath := flags.String("public-key", "", "trusted PKIX PEM manifest public key")
	outputDirectory := flags.String("output-dir", "", "new empty output directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *manifestPath == "" || *signaturePath == "" || *publicKeyPath == "" || *outputDirectory == "" {
		return errors.New("bundle-layers requires manifest, signature, public-key, and output-dir")
	}
	baseDirectory := filepath.Dir(*manifestPath)
	imageManifest, err := verifyBundle(*manifestPath, *signaturePath, *publicKeyPath, baseDirectory)
	if err != nil {
		return fmt.Errorf("verify layer bundle input: %w", err)
	}
	if imageManifest.SchemaVersion != 3 {
		return errors.New("bundle-layers requires a schema 3 manifest")
	}
	absoluteOutput, err := filepath.Abs(*outputDirectory)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(absoluteOutput); err == nil {
		return errors.New("layer bundle output directory already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	parent := filepath.Dir(absoluteOutput)
	parentInfo, err := os.Lstat(parent)
	if err != nil || !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("layer bundle output parent must be a real directory")
	}
	staging, err := os.MkdirTemp(parent, ".zapvm-layer-bundles-")
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

	index := layerBundleIndex{
		SchemaVersion: 1,
		ImageVersion:  imageManifest.ImageVersion,
		Architecture:  imageManifest.Architecture,
		Layers:        make(map[string]layerBundleIndexTarget, len(imageManifest.Layers)),
	}
	compositionName := imageManifest.Architecture + ".composition.tar.zst"
	compositionPath := filepath.Join(staging, compositionName)
	if err := writeSelectedBundleArchive(compositionPath, []bundleArchiveInput{
		{Path: *manifestPath, Name: "manifest.json"},
		{Path: *signaturePath, Name: "manifest.sig"},
	}); err != nil {
		return err
	}
	index.Composition, err = inspectLayerBundleTarget(compositionPath, compositionName, "")
	if err != nil {
		return err
	}

	filesByName := make(map[string]manifestFile, len(imageManifest.Files))
	for _, file := range imageManifest.Files {
		filesByName[file.Name] = file
	}
	for _, layer := range imageManifest.Layers {
		name := fmt.Sprintf("%s.%s-%s.layer.tar.zst", imageManifest.Architecture, layer.Name, layer.Version)
		inputs := make([]bundleArchiveInput, 0, len(layer.Files))
		for _, fileName := range layer.Files {
			file := filesByName[fileName]
			inputs = append(inputs, bundleArchiveInput{Path: filepath.Join(baseDirectory, file.Name), Name: file.Name, ExpectedSize: file.Size})
		}
		path := filepath.Join(staging, name)
		if err := writeSelectedBundleArchive(path, inputs); err != nil {
			return err
		}
		target, err := inspectLayerBundleTarget(path, name, layer.Version)
		if err != nil {
			return err
		}
		index.Layers[layer.Name] = target
	}
	indexData, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		return err
	}
	indexData = append(indexData, '\n')
	if err := os.WriteFile(filepath.Join(staging, "layer-targets.json"), indexData, 0o600); err != nil {
		return err
	}
	if err := syncDirectory(staging); err != nil {
		return err
	}
	if err := os.Rename(staging, absoluteOutput); err != nil {
		return err
	}
	if err := syncDirectory(parent); err != nil {
		return err
	}
	committed = true
	return nil
}

type bundleArchiveInput struct {
	Path         string
	Name         string
	ExpectedSize int64
}

func writeSelectedBundleArchive(outputPath string, inputs []bundleArchiveInput) error {
	if len(inputs) == 0 || len(inputs) > maxBundleEntries {
		return errors.New("layer archive has an invalid input set")
	}
	sort.Slice(inputs, func(i, j int) bool { return inputs[i].Name < inputs[j].Name })
	output, err := os.OpenFile(outputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	succeeded := false
	defer func() {
		_ = output.Close()
		if !succeeded {
			_ = os.Remove(outputPath)
		}
	}()
	compressor, err := newBundleCompressionWriter(output, outputPath)
	if err != nil {
		return err
	}
	tarWriter := tar.NewWriter(compressor)
	writersOpen := true
	defer func() {
		if writersOpen {
			_ = tarWriter.Close()
			_ = compressor.Close()
		}
	}()
	seen := make(map[string]struct{}, len(inputs))
	for _, input := range inputs {
		if _, exists := seen[input.Name]; exists {
			return fmt.Errorf("duplicate layer archive input %q", input.Name)
		}
		seen[input.Name] = struct{}{}
		expected := input.ExpectedSize
		if expected == 0 {
			info, err := os.Lstat(input.Path)
			if err != nil {
				return err
			}
			expected = info.Size()
		}
		if err := writeBundleFile(tarWriter, input.Path, input.Name, expected); err != nil {
			return err
		}
	}
	if err := tarWriter.Close(); err != nil {
		return err
	}
	if err := compressor.Close(); err != nil {
		return err
	}
	writersOpen = false
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	succeeded = true
	return nil
}

func inspectLayerBundleTarget(path, targetPath, version string) (layerBundleIndexTarget, error) {
	file, err := os.Open(path)
	if err != nil {
		return layerBundleIndexTarget{}, err
	}
	hasher := sha256.New()
	size, copyErr := io.Copy(hasher, file)
	closeErr := file.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		return layerBundleIndexTarget{}, err
	}
	return layerBundleIndexTarget{Version: version, Path: targetPath, Size: size, SHA256: hex.EncodeToString(hasher.Sum(nil))}, nil
}

func readLayerBundleIndex(indexPath string, imageManifest manifest) (layerBundleIndex, error) {
	data, err := readBoundedRegular(indexPath, maxManifestSize)
	if err != nil {
		return layerBundleIndex{}, err
	}
	var index layerBundleIndex
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&index); err != nil {
		return layerBundleIndex{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return layerBundleIndex{}, errors.New("layer target index contains trailing data")
	}
	if index.SchemaVersion != 1 || index.ImageVersion != imageManifest.ImageVersion || index.Architecture != imageManifest.Architecture || len(index.Layers) != len(imageManifest.Layers) {
		return layerBundleIndex{}, errors.New("layer target index identity does not match signed manifest")
	}
	indexDirectory := filepath.Dir(indexPath)
	versions := make(map[string]string, 4)
	for _, layer := range imageManifest.Layers {
		versions[layer.Name] = layer.Version
	}
	for _, layer := range imageManifest.Layers {
		name := layer.Name
		target, exists := index.Layers[name]
		if !exists || target.Version != versions[name] || target.Path == "" || filepath.Base(target.Path) != target.Path || strings.ContainsAny(target.Path, `/\\`) || !strings.HasSuffix(target.Path, ".layer.tar.zst") || target.Size <= 0 || !validLowerSHA256(target.SHA256) {
			return layerBundleIndex{}, fmt.Errorf("invalid %s layer target index entry", name)
		}
		actual, err := inspectLayerBundleTarget(filepath.Join(indexDirectory, target.Path), target.Path, target.Version)
		if err != nil || actual != target {
			return layerBundleIndex{}, fmt.Errorf("%s layer target does not match its index", name)
		}
	}
	return index, nil
}

func extractCompositionArchive(archivePath, parent string) (string, manifest, error) {
	return extractSelectedBundleArchive(archivePath, parent, nil, true)
}

func extractLayerArchive(archivePath, destination string, layer manifestLayer, files map[string]manifestFile) error {
	expected := make(map[string]manifestFile, len(layer.Files))
	for _, name := range layer.Files {
		file, exists := files[name]
		if !exists {
			return fmt.Errorf("layer %q references unknown file %q", layer.Name, name)
		}
		expected[name] = file
	}
	extracted, _, err := extractSelectedBundleArchive(archivePath, filepath.Dir(destination), expected, false)
	if err != nil {
		return err
	}
	defer os.RemoveAll(extracted)
	for name := range expected {
		if err := os.Rename(filepath.Join(extracted, name), filepath.Join(destination, name)); err != nil {
			return err
		}
	}
	return syncDirectory(destination)
}

func extractSelectedBundleArchive(archivePath, parent string, expected map[string]manifestFile, composition bool) (string, manifest, error) {
	var imageManifest manifest
	info, err := os.Lstat(archivePath)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
		return "", imageManifest, errors.New("layer target must be a non-empty regular file")
	}
	directory, err := os.MkdirTemp(parent, ".zapvm-layer-extract-")
	if err != nil {
		return "", imageManifest, err
	}
	failed := true
	defer func() {
		if failed {
			_ = os.RemoveAll(directory)
		}
	}()
	input, err := os.Open(archivePath)
	if err != nil {
		return "", imageManifest, err
	}
	defer input.Close()
	reader, err := newBundleCompressionReader(bufio.NewReader(input))
	if err != nil {
		return "", imageManifest, err
	}
	defer reader.Close()
	tarReader := tar.NewReader(reader)
	seen := make(map[string]struct{})
	var total int64
	for entries := 0; ; entries++ {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", imageManifest, err
		}
		if entries >= maxBundleEntries || (header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA) || header.Name == "" || filepath.Base(header.Name) != header.Name || strings.ContainsAny(header.Name, `/\\`) {
			return "", imageManifest, fmt.Errorf("unsafe layer target entry %q", header.Name)
		}
		if _, exists := seen[header.Name]; exists {
			return "", imageManifest, fmt.Errorf("duplicate layer target entry %q", header.Name)
		}
		seen[header.Name] = struct{}{}
		if header.Size < 0 || header.Size > maxBundleFileSize || total > maxBundleExtractedSize-header.Size {
			return "", imageManifest, errors.New("layer target exceeds extracted size limits")
		}
		total += header.Size
		if !composition {
			file, exists := expected[header.Name]
			if !exists || file.Size != header.Size {
				return "", imageManifest, fmt.Errorf("layer target contains unexpected file %q", header.Name)
			}
		}
		output, err := os.OpenFile(filepath.Join(directory, header.Name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return "", imageManifest, err
		}
		hasher := sha256.New()
		copyErr := error(nil)
		if composition {
			copyErr = copySparse(output, io.LimitReader(tarReader, header.Size), header.Size)
		} else {
			_, copyErr = io.CopyN(io.MultiWriter(output, hasher), tarReader, header.Size)
		}
		syncErr := output.Sync()
		closeErr := output.Close()
		if err := errors.Join(copyErr, syncErr, closeErr); err != nil {
			return "", imageManifest, err
		}
		if !composition && hex.EncodeToString(hasher.Sum(nil)) != expected[header.Name].SHA256 {
			return "", imageManifest, fmt.Errorf("layer target file %q hash mismatch", header.Name)
		}
	}
	if composition {
		if len(seen) != 2 {
			return "", imageManifest, errors.New("composition target must contain only manifest.json and manifest.sig")
		}
		for _, name := range []string{"manifest.json", "manifest.sig"} {
			if _, exists := seen[name]; !exists {
				return "", imageManifest, fmt.Errorf("composition target is missing %q", name)
			}
		}
		data, err := readBoundedRegular(filepath.Join(directory, "manifest.json"), maxManifestSize)
		if err != nil {
			return "", imageManifest, err
		}
		imageManifest, err = decodeManifest(data)
		if err != nil || imageManifest.SchemaVersion != 3 {
			return "", imageManifest, errors.New("composition target requires a schema 3 manifest")
		}
	} else if len(seen) != len(expected) {
		return "", imageManifest, errors.New("layer target content does not exactly match its signed layer")
	}
	failed = false
	return directory, imageManifest, nil
}
