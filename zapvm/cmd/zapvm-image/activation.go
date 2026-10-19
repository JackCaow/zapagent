package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	vmimage "zapvm/internal/image"
)

type activationState = vmimage.ActivationState

func activateImage(args []string) error {
	flags := flag.NewFlagSet("activate", flag.ContinueOnError)
	root := flags.String("root", "", "absolute installed image versions root")
	version := flags.String("version", "", "installed version to activate")
	publicKey := flags.String("public-key", "", "trusted PKIX PEM public key")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || *version == "" || *publicKey == "" {
		return errors.New("root, version, and public-key are required")
	}
	if !filepath.IsAbs(*root) {
		return errors.New("image root must be absolute")
	}
	if err := validateVersionName(*version); err != nil {
		return err
	}
	lock, err := acquireImageUpdateLock(*root)
	if err != nil {
		return err
	}
	defer lock.Close()
	return activateInstalledImage(*root, *version, *publicKey)
}

func activateInstalledImage(root, version, publicKey string) error {
	if _, err := verifyInstalledVersion(root, version, publicKey); err != nil {
		return fmt.Errorf("verify activation target: %w", err)
	}
	current, err := readActivationOptional(root)
	if err != nil {
		return err
	}
	if current.ActiveVersion == version {
		return nil
	}
	next := activationState{
		SchemaVersion:   1,
		ActiveVersion:   version,
		PreviousVersion: current.ActiveVersion,
		Generation:      current.Generation + 1,
		UpdatedAt:       time.Now().UTC().Format(time.RFC3339Nano),
	}
	return writeActivation(root, next)
}

func rollbackImage(args []string) error {
	flags := flag.NewFlagSet("rollback", flag.ContinueOnError)
	root := flags.String("root", "", "absolute installed image versions root")
	publicKey := flags.String("public-key", "", "trusted PKIX PEM public key")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || *publicKey == "" {
		return errors.New("root and public-key are required")
	}
	if !filepath.IsAbs(*root) {
		return errors.New("image root must be absolute")
	}
	lock, err := acquireImageUpdateLock(*root)
	if err != nil {
		return err
	}
	defer lock.Close()
	return rollbackInstalledImage(*root, *publicKey)
}

func rollbackInstalledImage(root, publicKey string) error {
	current, err := readActivation(root)
	if err != nil {
		return err
	}
	if current.PreviousVersion == "" {
		return errors.New("no previous image version is available")
	}
	if _, err := verifyInstalledVersion(root, current.PreviousVersion, publicKey); err != nil {
		return fmt.Errorf("verify rollback target: %w", err)
	}
	next := activationState{
		SchemaVersion:   1,
		ActiveVersion:   current.PreviousVersion,
		PreviousVersion: current.ActiveVersion,
		Generation:      current.Generation + 1,
		UpdatedAt:       time.Now().UTC().Format(time.RFC3339Nano),
	}
	return writeActivation(root, next)
}

func imageStatus(args []string) error {
	flags := flag.NewFlagSet("status", flag.ContinueOnError)
	root := flags.String("root", "", "absolute installed image versions root")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || !filepath.IsAbs(*root) {
		return errors.New("absolute image root is required")
	}
	state, err := readActivation(*root)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(state)
}

func verifyInstalledVersion(root, version, publicKey string) (manifest, error) {
	return vmimage.VerifyInstalledVersion(root, version, publicKey)
}

func validateVersionName(version string) error {
	return vmimage.ValidateVersionName(version)
}

func readActivationOptional(root string) (activationState, error) {
	state, err := readActivation(root)
	if errors.Is(err, os.ErrNotExist) {
		return activationState{SchemaVersion: 1}, nil
	}
	return state, err
}

func readActivation(root string) (activationState, error) {
	return vmimage.ReadActivation(root)
}

func writeActivation(root string, state activationState) error {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temporary, err := os.CreateTemp(root, ".zapvm-active-")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o644); err != nil {
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
	if err := replacePath(temporaryPath, filepath.Join(root, "active.json")); err != nil {
		return err
	}
	return syncDirectory(root)
}
