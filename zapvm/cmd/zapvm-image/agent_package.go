package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"time"

	"zapvm/internal/agentpackage"
)

func createAgentManifest(args []string) error {
	flags := flag.NewFlagSet("agent-manifest", flag.ContinueOnError)
	id := flags.String("id", "", "stable Agent package ID")
	version := flags.String("version", "", "Agent package version")
	architecture := flags.String("arch", "", "arm64 or amd64")
	createdAt := flags.String("created-at", "", "RFC3339 reproducible creation time")
	runtimeProtocol := flags.Int("runtime-protocol", 1, "required zapVM guest Runtime protocol")
	minStateSchema := flags.Int("min-state-schema", 3, "minimum compatible Session state schema")
	maxStateSchema := flags.Int("max-state-schema", 3, "maximum compatible Session state schema")
	output := flags.String("output", "", "new agent.json output")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 3 || *id == "" || *version == "" || *architecture == "" || *createdAt == "" || *output == "" {
		return errors.New("agent-manifest requires id, version, arch, created-at, output, and exactly agent.raw, agent.vhdx, agent-provenance.json")
	}
	if _, err := time.Parse(time.RFC3339, *createdAt); err != nil {
		return err
	}
	manifest := agentpackage.Manifest{
		SchemaVersion: 1, ID: *id, Version: *version, Architecture: *architecture, CreatedAt: *createdAt,
		RuntimeProtocol: *runtimeProtocol, Adapter: "acp-resident-v1", MinStateSchema: *minStateSchema, MaxStateSchema: *maxStateSchema,
		Entrypoint: "/opt/zapvm-agent/bin/agent",
	}
	wanted := []string{"agent.raw", "agent.vhdx", "agent-provenance.json"}
	for index, path := range flags.Args() {
		if filepath.Base(path) != wanted[index] {
			return errors.New("Agent package files must be ordered agent.raw, agent.vhdx, agent-provenance.json")
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			_ = file.Close()
			return errors.New("Agent package input must be a regular file")
		}
		hash := sha256.New()
		size, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if err := errors.Join(copyErr, closeErr); err != nil {
			return err
		}
		manifest.Files = append(manifest.Files, agentpackage.ManifestFile{Name: wanted[index], Size: size, SHA256: hex.EncodeToString(hash.Sum(nil))})
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if _, err := agentpackage.DecodeManifest(data); err != nil {
		return err
	}
	return writeExclusive(*output, data, 0o644)
}

func signAgentManifest(args []string) error {
	flags := flag.NewFlagSet("agent-sign", flag.ContinueOnError)
	manifestPath := flags.String("manifest", "", "agent.json path")
	privatePath := flags.String("private-key", "", "PKCS#8 PEM private key")
	outputPath := flags.String("output", "", "new raw Ed25519 agent.sig path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *manifestPath == "" || *privatePath == "" || *outputPath == "" {
		return errors.New("agent-sign requires manifest, private-key, and output")
	}
	data, err := readBoundedRegular(*manifestPath, agentpackage.MaxManifestSize)
	if err != nil {
		return err
	}
	if _, err := agentpackage.DecodeManifest(data); err != nil {
		return err
	}
	key, err := loadPrivateKey(*privatePath)
	if err != nil {
		return err
	}
	return writeExclusive(*outputPath, ed25519.Sign(key, data), 0o644)
}
