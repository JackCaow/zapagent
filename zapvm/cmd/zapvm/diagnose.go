package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	vmimage "zapvm/internal/image"
	"zapvm/internal/platform"
	"zapvm/internal/state"
)

const diagnosticMaxInput = 1 << 20

type diagnosticSnapshot struct {
	SchemaVersion int                   `json:"schema_version"`
	CreatedAt     string                `json:"created_at"`
	Version       string                `json:"zapvm_version"`
	OS            string                `json:"os"`
	Arch          string                `json:"arch"`
	Doctor        platform.DoctorReport `json:"doctor"`
	States        []diagnosticState     `json:"states,omitempty"`
	Images        []diagnosticImage     `json:"images,omitempty"`
}

type diagnosticState struct {
	PathID   string          `json:"path_id"`
	Path     string          `json:"path,omitempty"`
	Metadata *state.Metadata `json:"metadata,omitempty"`
	Error    string          `json:"error,omitempty"`
}

type diagnosticImage struct {
	PathID          string `json:"path_id"`
	Path            string `json:"path,omitempty"`
	SHA256          string `json:"sha256,omitempty"`
	SchemaVersion   int    `json:"schema_version,omitempty"`
	ImageVersion    string `json:"image_version,omitempty"`
	Architecture    string `json:"architecture,omitempty"`
	ProtocolVersion int    `json:"protocol_version,omitempty"`
	StateSchema     int    `json:"state_schema,omitempty"`
	FileCount       int    `json:"file_count,omitempty"`
	Error           string `json:"error,omitempty"`
}

func runDiagnose(args []string) error {
	flags := flag.NewFlagSet("diagnose", flag.ContinueOnError)
	output := flags.String("output", "", "new diagnostic JSON path")
	includePaths := flags.Bool("include-paths", false, "include local paths (off by default)")
	includeIdentifiers := flags.Bool("include-identifiers", false, "include VM identifiers from state metadata")
	var stateDisks, manifests []string
	flags.Func("state-disk", "managed state disk to inspect; repeatable", func(value string) error {
		stateDisks = append(stateDisks, value)
		return nil
	})
	flags.Func("manifest", "image manifest to summarize; repeatable", func(value string) error {
		manifests = append(manifests, value)
		return nil
	})
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *output == "" || flags.NArg() != 0 {
		return errors.New("diagnose requires --output and accepts no positional arguments")
	}
	if len(stateDisks) > 32 || len(manifests) > 32 {
		return errors.New("diagnose accepts at most 32 state disks and 32 manifests")
	}
	absoluteOutput, err := filepath.Abs(*output)
	if err != nil {
		return err
	}
	snapshot := diagnosticSnapshot{
		SchemaVersion: 1,
		CreatedAt:     time.Now().UTC().Format(time.RFC3339Nano),
		Version:       version,
		OS:            runtime.GOOS,
		Arch:          runtime.GOARCH,
		Doctor:        redactDoctorReport(platform.Current().Doctor(context.Background())),
	}
	for _, path := range stateDisks {
		entry := diagnosticStateForPath(path, *includePaths, *includeIdentifiers)
		snapshot.States = append(snapshot.States, entry)
	}
	for _, path := range manifests {
		entry := diagnosticImageForPath(path, *includePaths)
		snapshot.Images = append(snapshot.Images, entry)
	}
	if err := writeDiagnosticSnapshot(absoluteOutput, snapshot); err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, absoluteOutput)
	return nil
}

func diagnosticStateForPath(path string, includePath, includeIdentifiers bool) diagnosticState {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return diagnosticState{PathID: diagnosticPathID(path), Error: "resolve path: " + redactDiagnosticError(err, path)}
	}
	entry := diagnosticState{PathID: diagnosticPathID(absolute)}
	if includePath {
		entry.Path = absolute
	}
	metadata, err := state.Inspect(absolute)
	if err != nil {
		entry.Error = redactDiagnosticError(err, absolute)
		return entry
	}
	if !includeIdentifiers {
		metadata.LastVMID = ""
	}
	entry.Metadata = &metadata
	return entry
}

func diagnosticImageForPath(path string, includePath bool) diagnosticImage {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return diagnosticImage{PathID: diagnosticPathID(path), Error: "resolve path: " + redactDiagnosticError(err, path)}
	}
	entry := diagnosticImage{PathID: diagnosticPathID(absolute)}
	if includePath {
		entry.Path = absolute
	}
	data, err := readDiagnosticRegularFile(absolute)
	if err != nil {
		entry.Error = redactDiagnosticError(err, absolute)
		return entry
	}
	hash := sha256.Sum256(data)
	entry.SHA256 = hex.EncodeToString(hash[:])
	manifest, err := vmimage.DecodeManifest(data)
	if err != nil {
		entry.Error = err.Error()
		return entry
	}
	entry.SchemaVersion = manifest.SchemaVersion
	entry.ImageVersion = manifest.ImageVersion
	entry.Architecture = manifest.Architecture
	entry.ProtocolVersion = manifest.Protocol
	entry.StateSchema = manifest.StateSchema
	entry.FileCount = len(manifest.Files)
	return entry
}

func readDiagnosticRegularFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("input is not a regular file")
	}
	if info.Size() <= 0 || info.Size() > diagnosticMaxInput {
		return nil, fmt.Errorf("input size %d is outside 1-%d bytes", info.Size(), diagnosticMaxInput)
	}
	return os.ReadFile(path)
}

func writeDiagnosticSnapshot(path string, snapshot diagnosticSnapshot) error {
	if len(path) > 32767 || strings.IndexByte(path, 0) >= 0 {
		return errors.New("diagnostic output path is too long or contains NUL")
	}
	if _, err := os.Lstat(path); err == nil {
		return errors.New("diagnostic output already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	parent := filepath.Dir(path)
	info, err := os.Lstat(parent)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("diagnostic output parent must be a real directory")
	}
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temporary, err := os.CreateTemp(parent, ".zapvm-diagnostic-")
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
	if _, err := temporary.Write(data); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
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
	return nil
}

func diagnosticPathID(path string) string {
	hash := sha256.Sum256([]byte(path))
	return hex.EncodeToString(hash[:8])
}

func redactDiagnosticError(err error, path string) string {
	message := err.Error()
	if path != "" {
		message = strings.ReplaceAll(message, path, "<path>")
	}
	return redactHostText(message)
}

func redactDoctorReport(report platform.DoctorReport) platform.DoctorReport {
	for index := range report.Checks {
		report.Checks[index].Detail = redactHostText(report.Checks[index].Detail)
	}
	return report
}

func redactHostText(value string) string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		value = strings.ReplaceAll(value, home, "<home>")
	}
	return value
}
