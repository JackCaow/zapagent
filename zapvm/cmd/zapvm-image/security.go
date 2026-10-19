package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	vmimage "zapvm/internal/image"
)

const (
	maxManifestSize = vmimage.MaxManifestSize
	maxKeyFileSize  = vmimage.MaxKeyFileSize
)

func generateKeys(args []string) error {
	flags := flag.NewFlagSet("keygen", flag.ContinueOnError)
	privatePath := flags.String("private", "", "new PKCS#8 PEM private key path")
	publicPath := flags.String("public", "", "new PKIX PEM public key path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *privatePath == "" || *publicPath == "" {
		return errors.New("private and public output paths are required")
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return err
	}
	publicDER, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return err
	}
	if err := writeExclusive(*privatePath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}), 0o600); err != nil {
		return fmt.Errorf("write private key: %w", err)
	}
	if err := writeExclusive(*publicPath, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER}), 0o644); err != nil {
		_ = os.Remove(*privatePath)
		return fmt.Errorf("write public key: %w", err)
	}
	return nil
}

func signManifest(args []string) error {
	flags := flag.NewFlagSet("sign", flag.ContinueOnError)
	manifestPath := flags.String("manifest", "", "manifest JSON path")
	privatePath := flags.String("private-key", "", "PKCS#8 PEM private key")
	outputPath := flags.String("output", "", "new raw Ed25519 signature path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *manifestPath == "" || *privatePath == "" || *outputPath == "" {
		return errors.New("manifest, private-key and output are required")
	}
	data, err := readBoundedRegular(*manifestPath, maxManifestSize)
	if err != nil {
		return err
	}
	if _, err := decodeManifest(data); err != nil {
		return err
	}
	key, err := loadPrivateKey(*privatePath)
	if err != nil {
		return err
	}
	return writeExclusive(*outputPath, ed25519.Sign(key, data), 0o644)
}

func verifyManifest(args []string) error {
	flags := flag.NewFlagSet("verify", flag.ContinueOnError)
	manifestPath := flags.String("manifest", "", "manifest JSON path")
	signaturePath := flags.String("signature", "", "raw Ed25519 signature path")
	publicPath := flags.String("public-key", "", "PKIX PEM public key")
	baseDir := flags.String("base-dir", "", "directory containing manifest files")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *manifestPath == "" || *signaturePath == "" || *publicPath == "" {
		return errors.New("manifest, signature and public-key are required")
	}
	if *baseDir == "" {
		*baseDir = filepath.Dir(*manifestPath)
	}
	_, err := verifyBundle(*manifestPath, *signaturePath, *publicPath, *baseDir)
	return err
}

func installImage(args []string) error {
	flags := flag.NewFlagSet("install", flag.ContinueOnError)
	manifestPath := flags.String("manifest", "", "signed source manifest JSON path")
	signaturePath := flags.String("signature", "", "source raw Ed25519 signature path")
	publicPath := flags.String("public-key", "", "trusted PKIX PEM public key")
	destination := flags.String("destination", "", "new absolute version directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *manifestPath == "" || *signaturePath == "" || *publicPath == "" || *destination == "" {
		return errors.New("manifest, signature, public-key and destination are required")
	}
	if !filepath.IsAbs(*destination) {
		return errors.New("destination must be absolute")
	}
	if _, err := os.Lstat(*destination); err == nil {
		return errors.New("destination already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	sourceDir := filepath.Dir(*manifestPath)
	imageManifest, err := verifyBundle(*manifestPath, *signaturePath, *publicPath, sourceDir)
	if err != nil {
		return fmt.Errorf("verify source image: %w", err)
	}
	parent := filepath.Dir(*destination)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(parent, ".zapvm-install-")
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(staging)
		}
	}()
	for _, file := range imageManifest.Files {
		mode := os.FileMode(0o644)
		if file.Name == "cloud-hypervisor" || file.Name == "virtiofsd" {
			mode = 0o755
		}
		if err := copyRegular(filepath.Join(sourceDir, file.Name), filepath.Join(staging, file.Name), mode); err != nil {
			return err
		}
	}
	if err := copyRegular(*manifestPath, filepath.Join(staging, "manifest.json"), 0o644); err != nil {
		return err
	}
	if err := copyRegular(*signaturePath, filepath.Join(staging, "manifest.sig"), 0o644); err != nil {
		return err
	}
	if _, err := verifyBundle(filepath.Join(staging, "manifest.json"), filepath.Join(staging, "manifest.sig"), *publicPath, staging); err != nil {
		return fmt.Errorf("verify staged image: %w", err)
	}
	if err := syncDirectory(staging); err != nil {
		return err
	}
	if err := os.Rename(staging, *destination); err != nil {
		return err
	}
	committed = true
	return syncDirectory(parent)
}

func verifyBundle(manifestPath, signaturePath, publicPath, baseDir string) (manifest, error) {
	return vmimage.VerifyBundle(manifestPath, signaturePath, publicPath, baseDir)
}

func decodeManifest(data []byte) (manifest, error) {
	return vmimage.DecodeManifest(data)
}

func verifyManifestFiles(baseDir string, imageManifest manifest) error {
	return vmimage.VerifyManifestFiles(baseDir, imageManifest)
}

func loadPrivateKey(path string) (ed25519.PrivateKey, error) {
	data, err := readBoundedRegular(path, maxKeyFileSize)
	if err != nil {
		return nil, err
	}
	block, rest := pem.Decode(data)
	if block == nil || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, errors.New("invalid private key PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("private key is not Ed25519")
	}
	return key, nil
}

func loadPublicKey(path string) (ed25519.PublicKey, error) {
	return vmimage.LoadPublicKey(path)
}

func writeExclusive(path string, data []byte, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}

func copyRegular(source, destination string, mode os.FileMode) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("source %s is not a regular file", source)
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if err := copySparse(output, input, info.Size()); err != nil {
		_ = output.Close()
		return err
	}
	if err := output.Sync(); err != nil {
		_ = output.Close()
		return err
	}
	return output.Close()
}

func copySparse(output *os.File, input io.Reader, size int64) error {
	const blockSize = 1 << 20
	buffer := make([]byte, blockSize)
	remaining := size
	for remaining > 0 {
		want := int64(len(buffer))
		if remaining < want {
			want = remaining
		}
		block := buffer[:int(want)]
		if _, err := io.ReadFull(input, block); err != nil {
			return err
		}
		allZero := true
		for _, value := range block {
			if value != 0 {
				allZero = false
				break
			}
		}
		if allZero {
			if _, err := output.Seek(want, io.SeekCurrent); err != nil {
				return err
			}
		} else if _, err := output.Write(block); err != nil {
			return err
		}
		remaining -= want
	}
	return output.Truncate(size)
}

func readBoundedRegular(path string, maximum int64) ([]byte, error) {
	return vmimage.ReadBoundedRegular(path, maximum)
}
