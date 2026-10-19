package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

const (
	maxBundleEntries       = 128
	maxBundleFileSize      = int64(4 << 30)
	maxBundleExtractedSize = int64(8 << 30)
)

func createBundle(args []string) error {
	flags := flag.NewFlagSet("bundle", flag.ContinueOnError)
	manifestPath := flags.String("manifest", "", "signed manifest JSON path")
	signaturePath := flags.String("signature", "", "raw Ed25519 manifest signature")
	publicKeyPath := flags.String("public-key", "", "trusted PKIX PEM manifest public key")
	outputPath := flags.String("output", "", "new .bundle.tar.zst or .bundle.tar.gz output")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *manifestPath == "" || *signaturePath == "" || *publicKeyPath == "" || *outputPath == "" {
		return errors.New("bundle requires manifest, signature, public-key, and output")
	}
	baseDirectory := filepath.Dir(*manifestPath)
	imageManifest, err := verifyBundle(*manifestPath, *signaturePath, *publicKeyPath, baseDirectory)
	if err != nil {
		return fmt.Errorf("verify bundle input: %w", err)
	}
	absoluteOutput, err := filepath.Abs(*outputPath)
	if err != nil {
		return err
	}
	return writeBundleArchive(absoluteOutput, baseDirectory, *manifestPath, *signaturePath, imageManifest)
}

func installBundle(args []string) error {
	flags := flag.NewFlagSet("install-bundle", flag.ContinueOnError)
	bundlePath := flags.String("bundle", "", "signed image .bundle.tar.zst or .bundle.tar.gz path")
	publicKeyPath := flags.String("public-key", "", "trusted PKIX PEM manifest public key")
	root := flags.String("root", "", "absolute installed image versions root")
	architecture := flags.String("arch", "", "expected arm64 or amd64 architecture")
	activate := flags.Bool("activate", true, "atomically activate the imported version")
	smokeBinary := flags.String("smoke-binary", "", "absolute zapvm binary used to boot-check the staged image")
	skipSmoke := flags.Bool("skip-smoke", false, "emergency only: activate without booting the staged image")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *bundlePath == "" || *publicKeyPath == "" || *root == "" || *architecture == "" {
		return errors.New("install-bundle requires bundle, public-key, root, and arch")
	}
	if !filepath.IsAbs(*root) {
		return errors.New("image root must be absolute")
	}
	if *architecture != "arm64" && *architecture != "amd64" {
		return fmt.Errorf("unsupported architecture %q", *architecture)
	}
	if _, err := loadPublicKey(*publicKeyPath); err != nil {
		return fmt.Errorf("read manifest public key: %w", err)
	}
	lock, err := acquireImageUpdateLock(*root)
	if err != nil {
		return fmt.Errorf("acquire image import lock: %w", err)
	}
	defer lock.Close()
	importRoot := filepath.Join(*root, ".zapvm-import")
	if err := secureUpdateDirectory(importRoot); err != nil {
		return fmt.Errorf("secure image import directory: %w", err)
	}
	extracted, _, err := extractBundleArchive(*bundlePath, importRoot)
	if err != nil {
		return fmt.Errorf("extract image bundle: %w", err)
	}
	defer os.RemoveAll(extracted)
	manifestPath := filepath.Join(extracted, "manifest.json")
	signaturePath := filepath.Join(extracted, "manifest.sig")
	imageManifest, err := verifyBundle(manifestPath, signaturePath, *publicKeyPath, extracted)
	if err != nil {
		return fmt.Errorf("verify image bundle: %w", err)
	}
	if imageManifest.Architecture != *architecture {
		return fmt.Errorf("signed image architecture %q does not match expected %q", imageManifest.Architecture, *architecture)
	}
	destination := filepath.Join(*root, imageManifest.ImageVersion)
	if _, err := os.Lstat(destination); errors.Is(err, os.ErrNotExist) {
		if err := installImage([]string{
			"--manifest", manifestPath,
			"--signature", signaturePath,
			"--public-key", *publicKeyPath,
			"--destination", destination,
		}); err != nil {
			return fmt.Errorf("install image bundle: %w", err)
		}
	} else if err != nil {
		return err
	} else {
		installedManifest, err := verifyInstalledVersion(*root, imageManifest.ImageVersion, *publicKeyPath)
		if err != nil {
			return fmt.Errorf("verify existing image version: %w", err)
		}
		if installedManifest.Architecture != *architecture {
			return errors.New("existing image architecture conflicts with bundle")
		}
		incomingData, err := readBoundedRegular(manifestPath, maxManifestSize)
		if err != nil {
			return err
		}
		installedData, err := readBoundedRegular(filepath.Join(destination, "manifest.json"), maxManifestSize)
		if err != nil {
			return err
		}
		if !bytes.Equal(installedData, incomingData) {
			return errors.New("existing image version conflicts with bundle manifest")
		}
	}
	if *activate {
		if err := smokeInstalledImage(*root, imageManifest.ImageVersion, *publicKeyPath, *smokeBinary, *skipSmoke); err != nil {
			return fmt.Errorf("smoke imported image: %w", err)
		}
		if err := activateInstalledImage(*root, imageManifest.ImageVersion, *publicKeyPath); err != nil {
			return fmt.Errorf("activate imported image: %w", err)
		}
	}
	fmt.Printf("installed bundle %s/%s (active=%t)\n", imageManifest.ImageVersion, imageManifest.Architecture, *activate)
	return nil
}

func writeBundleArchive(outputPath, baseDirectory, manifestPath, signaturePath string, imageManifest manifest) error {
	if _, err := os.Lstat(outputPath); err == nil {
		return errors.New("bundle output already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	parent := filepath.Dir(outputPath)
	info, err := os.Lstat(parent)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("bundle output parent must be a real directory")
	}
	temporary, err := os.CreateTemp(parent, ".zapvm-bundle-")
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
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	compressionWriter, err := newBundleCompressionWriter(temporary, outputPath)
	if err != nil {
		return err
	}
	tarWriter := tar.NewWriter(compressionWriter)
	files := append([]manifestFile(nil), imageManifest.Files...)
	sort.Slice(files, func(left, right int) bool { return files[left].Name < files[right].Name })
	writersOpen := true
	defer func() {
		if writersOpen {
			_ = tarWriter.Close()
			_ = compressionWriter.Close()
		}
	}()
	for _, file := range files {
		if err := writeBundleFile(tarWriter, filepath.Join(baseDirectory, file.Name), file.Name, file.Size); err != nil {
			_ = tarWriter.Close()
			_ = compressionWriter.Close()
			return err
		}
	}
	for _, input := range []struct {
		path string
		name string
	}{{manifestPath, "manifest.json"}, {signaturePath, "manifest.sig"}} {
		info, err := os.Lstat(input.path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("%s is not a regular file", input.name)
		}
		if err := writeBundleFile(tarWriter, input.path, input.name, info.Size()); err != nil {
			return err
		}
	}
	if err := tarWriter.Close(); err != nil {
		return err
	}
	if err := compressionWriter.Close(); err != nil {
		return err
	}
	writersOpen = false
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Link(temporaryPath, outputPath); err != nil {
		return err
	}
	if err := os.Remove(temporaryPath); err != nil {
		_ = os.Remove(outputPath)
		return err
	}
	committed = true
	return nil
}

func newBundleCompressionWriter(output io.Writer, outputPath string) (io.WriteCloser, error) {
	lowerPath := strings.ToLower(outputPath)
	if strings.HasSuffix(lowerPath, ".tar.zst") || strings.HasSuffix(lowerPath, ".tar.zstd") {
		return zstd.NewWriter(output,
			zstd.WithEncoderLevel(zstd.SpeedFastest),
			zstd.WithEncoderConcurrency(1),
			zstd.WithWindowSize(8<<20),
		)
	}
	if !strings.HasSuffix(lowerPath, ".tar.gz") && !strings.HasSuffix(lowerPath, ".tgz") {
		return nil, errors.New("bundle output must end in .tar.zst, .tar.zstd, .tar.gz, or .tgz")
	}
	writer, err := gzip.NewWriterLevel(output, gzip.BestSpeed)
	if err != nil {
		return nil, err
	}
	writer.Header.ModTime = time.Unix(0, 0).UTC()
	writer.Header.OS = 255
	return writer, nil
}

func writeBundleFile(writer *tar.Writer, path, name string, expectedSize int64) error {
	if name == "" || filepath.Base(name) != name || strings.ContainsAny(name, `/\\`) || strings.IndexByte(name, 0) >= 0 {
		return fmt.Errorf("unsafe bundle file name %q", name)
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != expectedSize || info.Size() < 0 || info.Size() > maxBundleFileSize {
		return fmt.Errorf("bundle input %q is not a bounded regular file with the expected size", name)
	}
	header := &tar.Header{Name: name, Mode: 0o644, Size: info.Size(), ModTime: time.Unix(0, 0).UTC(), Typeflag: tar.TypeReg}
	if err := writer.WriteHeader(header); err != nil {
		return err
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	_, copyErr := io.CopyN(writer, file, info.Size())
	closeErr := file.Close()
	return errors.Join(copyErr, closeErr)
}

func extractBundleArchive(bundlePath, parent string) (string, manifest, error) {
	var imageManifest manifest
	info, err := os.Lstat(bundlePath)
	if err != nil {
		return "", imageManifest, err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 {
		return "", imageManifest, errors.New("update bundle must be a non-empty regular file")
	}
	directory, err := os.MkdirTemp(parent, ".zapvm-extract-")
	if err != nil {
		return "", imageManifest, err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		_ = os.RemoveAll(directory)
		return "", imageManifest, err
	}
	failed := true
	defer func() {
		if failed {
			_ = os.RemoveAll(directory)
		}
	}()
	file, err := os.Open(bundlePath)
	if err != nil {
		return "", imageManifest, err
	}
	defer file.Close()
	buffered := bufio.NewReader(file)
	compressionReader, err := newBundleCompressionReader(buffered)
	if err != nil {
		return "", imageManifest, err
	}
	defer compressionReader.Close()
	tarReader := tar.NewReader(compressionReader)
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
		if entries >= maxBundleEntries {
			return "", imageManifest, errors.New("update bundle contains too many entries")
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			return "", imageManifest, fmt.Errorf("update bundle entry %q is not a regular file", header.Name)
		}
		if header.Name == "" || filepath.Base(header.Name) != header.Name || strings.ContainsAny(header.Name, `/\\`) || strings.IndexByte(header.Name, 0) >= 0 {
			return "", imageManifest, fmt.Errorf("unsafe update bundle entry %q", header.Name)
		}
		if _, exists := seen[header.Name]; exists {
			return "", imageManifest, fmt.Errorf("duplicate update bundle entry %q", header.Name)
		}
		seen[header.Name] = struct{}{}
		if header.Size < 0 || header.Size > maxBundleFileSize || total > maxBundleExtractedSize-header.Size {
			return "", imageManifest, errors.New("update bundle exceeds extracted size limits")
		}
		total += header.Size
		output, err := os.OpenFile(filepath.Join(directory, header.Name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return "", imageManifest, err
		}
		copyErr := copySparse(output, io.LimitReader(tarReader, header.Size), header.Size)
		syncErr := output.Sync()
		closeErr := output.Close()
		if err := errors.Join(copyErr, syncErr, closeErr); err != nil {
			return "", imageManifest, err
		}
	}
	manifestData, err := readBoundedRegular(filepath.Join(directory, "manifest.json"), maxManifestSize)
	if err != nil {
		return "", imageManifest, errors.New("update bundle is missing manifest.json")
	}
	imageManifest, err = decodeManifest(manifestData)
	if err != nil {
		return "", imageManifest, err
	}
	expected := map[string]struct{}{"manifest.json": {}, "manifest.sig": {}}
	for _, entry := range imageManifest.Files {
		expected[entry.Name] = struct{}{}
	}
	if len(expected) != len(seen) {
		return "", imageManifest, errors.New("update bundle content does not exactly match its manifest")
	}
	for name := range expected {
		if _, exists := seen[name]; !exists {
			return "", imageManifest, fmt.Errorf("update bundle is missing %q", name)
		}
	}
	failed = false
	return directory, imageManifest, nil
}

func newBundleCompressionReader(input *bufio.Reader) (io.ReadCloser, error) {
	magic, err := input.Peek(4)
	if err != nil {
		return nil, errors.New("update bundle is truncated")
	}
	if bytes.Equal(magic[:2], []byte{0x1f, 0x8b}) {
		return gzip.NewReader(input)
	}
	if bytes.Equal(magic, []byte{0x28, 0xb5, 0x2f, 0xfd}) {
		decoder, err := zstd.NewReader(input,
			zstd.WithDecoderConcurrency(1),
			zstd.WithDecoderMaxMemory(uint64(maxBundleExtractedSize)),
		)
		if err != nil {
			return nil, err
		}
		return decoder.IOReadCloser(), nil
	}
	return nil, errors.New("unsupported update bundle compression")
}
