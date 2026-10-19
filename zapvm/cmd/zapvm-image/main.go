package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"zapvm/internal/clierror"
	vmimage "zapvm/internal/image"
)

const maxKernelSize = 256 << 20

func main() {
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fallback := clierror.InvalidRequest
		if len(os.Args) > 1 {
			switch os.Args[1] {
			case "verify", "target-metadata", "tuf-repository", "install", "install-bundle", "update", "activate", "rollback", "status":
				fallback = clierror.InvalidImage
			case "extract-kernel", "manifest", "agent-manifest", "keygen", "sign", "agent-sign", "bundle", "bundle-layers":
				fallback = clierror.InvalidConfiguration
			}
		}
		os.Exit(clierror.Report(os.Stderr, err, fallback))
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("expected extract-kernel, manifest, agent-manifest, keygen, sign, agent-sign, verify, target-metadata, tuf-repository, bundle, bundle-layers, install, install-bundle, update, activate, rollback, or status")
	}
	switch args[0] {
	case "extract-kernel":
		return extractKernel(args[1:])
	case "manifest":
		return createManifest(args[1:])
	case "agent-manifest":
		return createAgentManifest(args[1:])
	case "keygen":
		return generateKeys(args[1:])
	case "sign":
		return signManifest(args[1:])
	case "agent-sign":
		return signAgentManifest(args[1:])
	case "verify":
		return verifyManifest(args[1:])
	case "target-metadata":
		return createTargetMetadata(args[1:])
	case "tuf-repository":
		return createTUFRepository(args[1:])
	case "bundle":
		return createBundle(args[1:])
	case "bundle-layers":
		return createLayerBundles(args[1:])
	case "install":
		return installImage(args[1:])
	case "install-bundle":
		return installBundle(args[1:])
	case "update":
		return updateImage(args[1:])
	case "activate":
		return activateImage(args[1:])
	case "rollback":
		return rollbackImage(args[1:])
	case "status":
		return imageStatus(args[1:])
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func extractKernel(args []string) error {
	flags := flag.NewFlagSet("extract-kernel", flag.ContinueOnError)
	arch := flags.String("arch", "", "arm64 or amd64")
	input := flags.String("input", "", "input vmlinuz")
	output := flags.String("output", "", "output bootable kernel")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *input == "" || *output == "" {
		return errors.New("input and output are required")
	}
	data, err := os.ReadFile(*input)
	if err != nil {
		return err
	}
	switch *arch {
	case "amd64":
		return os.WriteFile(*output, data, 0o755)
	case "arm64":
		image, err := extractARM64Image(data)
		if err != nil {
			return err
		}
		return os.WriteFile(*output, image, 0o755)
	default:
		return fmt.Errorf("unsupported architecture %q", *arch)
	}
}

func extractARM64Image(data []byte) ([]byte, error) {
	magic := []byte{0x1f, 0x8b, 0x08}
	for offset := 0; ; {
		index := bytes.Index(data[offset:], magic)
		if index < 0 {
			break
		}
		offset += index
		reader, err := gzip.NewReader(bytes.NewReader(data[offset:]))
		if err == nil {
			reader.Multistream(false)
			candidate, readErr := io.ReadAll(io.LimitReader(reader, maxKernelSize+1))
			_ = reader.Close()
			if readErr == nil && len(candidate) <= maxKernelSize && isARM64Image(candidate) {
				return candidate, nil
			}
		}
		offset += len(magic)
	}
	if isARM64Image(data) {
		return data, nil
	}
	return nil, errors.New("no ARM64 Linux Image found in vmlinuz")
}

func isARM64Image(data []byte) bool {
	return len(data) >= 64 && bytes.Equal(data[56:60], []byte{'A', 'R', 'M', 0x64})
}

type manifest = vmimage.Manifest
type manifestFile = vmimage.ManifestFile
type manifestLayer = vmimage.ManifestLayer

func createManifest(args []string) error {
	flags := flag.NewFlagSet("manifest", flag.ContinueOnError)
	arch := flags.String("arch", "", "image architecture")
	output := flags.String("output", "", "manifest output")
	version := flags.String("version", "0.1.0-dev", "image version")
	profile := flags.String("profile", "", "schema-3 image profile: host-runtime or agent-computer")
	baseVersion := flags.String("base-version", "", "schema-3 base layer version")
	runtimeVersion := flags.String("runtime-version", "", "schema-3 runtime layer version")
	agentVersion := flags.String("agent-version", "", "schema-3 Agent layer version")
	sessionVersion := flags.String("session-version", "", "schema-3 session layer version")
	createdAt := flags.String("created-at", "2026-08-05T00:00:00Z", "reproducible RFC3339 timestamp")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *arch == "" || *output == "" || flags.NArg() == 0 {
		return errors.New("arch, output and at least one input file are required")
	}
	if *arch != "arm64" && *arch != "amd64" {
		return fmt.Errorf("unsupported architecture %q", *arch)
	}
	if _, err := time.Parse(time.RFC3339, *createdAt); err != nil {
		return fmt.Errorf("invalid created-at: %w", err)
	}
	if *profile != "" && *profile != vmimage.ProfileHostRuntime && *profile != vmimage.ProfileAgentComputer {
		return fmt.Errorf("unsupported image profile %q", *profile)
	}
	coreLayersDeclared := *baseVersion != "" || *runtimeVersion != "" || *sessionVersion != ""
	if *profile == "" && (coreLayersDeclared || *agentVersion != "") {
		// Backward-compatible interpretation of the original four layer flags.
		*profile = vmimage.ProfileAgentComputer
	}
	if *profile != "" && (*baseVersion == "" || *runtimeVersion == "" || *sessionVersion == "") {
		return errors.New("base-version, runtime-version, and session-version are required for a layered image")
	}
	if *profile == vmimage.ProfileAgentComputer && *agentVersion == "" {
		return errors.New("agent-version is required for the agent-computer profile")
	}
	if *profile == vmimage.ProfileHostRuntime && *agentVersion != "" {
		return errors.New("host-runtime profile must not declare agent-version")
	}
	result := manifest{
		SchemaVersion: 2,
		ImageVersion:  *version,
		Architecture:  *arch,
		Protocol:      1,
		StateSchema:   3,
		CreatedAt:     *createdAt,
	}
	if *profile != "" {
		result.SchemaVersion = 3
		result.Profile = *profile
	}
	for _, path := range flags.Args() {
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		hash := sha256.New()
		size, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		result.Files = append(result.Files, manifestFile{
			Name: filepath.Base(path), Size: size, SHA256: hex.EncodeToString(hash.Sum(nil)),
		})
	}
	if result.SchemaVersion == 3 {
		layerFiles := map[string][]string{"base": {}, "runtime": {}, "agent": {}, "session": {}}
		for _, file := range result.Files {
			switch file.Name {
			case "rootfs.raw", "rootfs.vhdx":
				layerFiles["base"] = append(layerFiles["base"], file.Name)
			case "agent.raw", "agent.vhdx", "agent-provenance.json":
				layerFiles["agent"] = append(layerFiles["agent"], file.Name)
			case "state.raw", "state.vhdx":
				layerFiles["session"] = append(layerFiles["session"], file.Name)
			default:
				layerFiles["runtime"] = append(layerFiles["runtime"], file.Name)
			}
		}
		result.Layers = []manifestLayer{
			{Name: "base", Version: *baseVersion, Files: layerFiles["base"]},
			{Name: "runtime", Version: *runtimeVersion, Files: layerFiles["runtime"]},
		}
		if *profile == vmimage.ProfileAgentComputer {
			result.Layers = append(result.Layers, manifestLayer{Name: "agent", Version: *agentVersion, Files: layerFiles["agent"]})
		}
		result.Layers = append(result.Layers, manifestLayer{Name: "session", Version: *sessionVersion, Files: layerFiles["session"]})
	}
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if _, err := decodeManifest(data); err != nil {
		return fmt.Errorf("validate generated manifest: %w", err)
	}
	return os.WriteFile(*output, data, 0o644)
}
