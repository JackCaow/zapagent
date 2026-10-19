package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"runtime"
	"strings"

	vmimage "zapvm/internal/image"
)

func runCapabilities(args []string) error {
	flags := flag.NewFlagSet("capabilities", flag.ContinueOnError)
	defaultImageRoot, defaultImagePublicKey := configuredImageDefaults()
	imageRoot := flags.String("image-root", defaultImageRoot, "installed signed image root")
	publicKey := flags.String("image-public-key", defaultImagePublicKey, "Ed25519 image public key")
	jsonOutput := flags.Bool("json", false, "emit JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *imageRoot == "" || *publicKey == "" {
		return errors.New("capabilities requires --image-root and --image-public-key")
	}
	capabilities, err := vmimage.ReadActiveCapabilities(*imageRoot, *publicKey, runtime.GOARCH)
	if err != nil {
		return err
	}
	if *jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(capabilities)
	}
	fmt.Printf("rootfs: %s\n", capabilities.RootFSMode)
	fmt.Printf("workspace: %s\n", capabilities.WorkspaceMode)
	fmt.Printf("protected workspace paths: %s\n", strings.Join(capabilities.ProtectedWorkspacePaths, ", "))
	fmt.Printf("temporary storage: %s-scoped, executable=%t\n", capabilities.TemporaryStorageScope, capabilities.TemporaryStorageExecutable)
	fmt.Printf("runtime package management: %s\n", capabilities.RuntimePackageManagement)
	fmt.Printf("commands: %s\n", strings.Join(capabilities.Commands, ", "))
	fmt.Printf("network modes: %s\n", strings.Join(capabilities.NetworkModes, ", "))
	return nil
}
