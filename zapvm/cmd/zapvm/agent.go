package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"zapvm/internal/agentpackage"
	vmimage "zapvm/internal/image"
)

const (
	agentRootEnvironment      = "ZAPVM_AGENT_ROOT"
	agentPublicKeyEnvironment = "ZAPVM_AGENT_PUBLIC_KEY"
)

func runAgent(args []string) error {
	if len(args) == 0 {
		return errors.New("agent requires install, list, use, or status")
	}
	switch args[0] {
	case "install":
		return runAgentInstall(args[1:])
	case "list":
		return runAgentList(args[1:])
	case "use":
		return runAgentUse(args[1:])
	case "status":
		return runAgentStatus(args[1:])
	default:
		return fmt.Errorf("unknown agent command %q", args[0])
	}
}

func agentDefaults() (string, string) {
	root := strings.TrimSpace(os.Getenv(agentRootEnvironment))
	publicKey := strings.TrimSpace(os.Getenv(agentPublicKeyEnvironment))
	if imageRoot, _ := configuredImageDefaults(); imageRoot != "" {
		base := filepath.Dir(imageRoot)
		if root == "" {
			root = filepath.Join(base, "agents")
		}
		if publicKey == "" {
			publicKey = filepath.Join(base, "agent-public.pem")
		}
	}
	return root, publicKey
}

func runAgentInstall(args []string) error {
	flags := flag.NewFlagSet("agent install", flag.ContinueOnError)
	rootDefault, publicKeyDefault := agentDefaults()
	root := flags.String("root", rootDefault, "absolute local Agent registry root")
	publicKey := flags.String("public-key", publicKeyDefault, "trusted Ed25519 Agent signing public key")
	manifest := flags.String("manifest", "", "signed agent.json path")
	signature := flags.String("signature", "", "raw Ed25519 agent.sig path")
	activate := flags.Bool("activate", false, "make the installed Agent the default")
	smokeTimeout := flags.Duration("smoke-timeout", 2*time.Minute, "candidate Agent VM smoke timeout")
	defaultImageRoot, defaultImagePublicKey := configuredImageDefaults()
	imageRoot := flags.String("image-root", defaultImageRoot, "installed Runtime image root (required with --activate)")
	imagePublicKey := flags.String("image-public-key", defaultImagePublicKey, "trusted Runtime image public key (required with --activate)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *root == "" || *publicKey == "" || *manifest == "" || *signature == "" {
		return errors.New("agent install requires root, public-key, manifest, and signature")
	}
	resolved, err := agentpackage.Install(*root, *manifest, *signature, *publicKey)
	if err != nil {
		return err
	}
	if *activate {
		if *imageRoot == "" || *imagePublicKey == "" {
			return errors.New("agent install --activate requires configured Runtime image root and public key")
		}
		selected, err := vmimage.ResolveActive(*imageRoot, *imagePublicKey, runtime.GOOS, runtime.GOARCH)
		if err != nil {
			return err
		}
		contract, err := runtimeAgentContract(selected)
		if err != nil {
			return err
		}
		if err := smokeAgentCandidate(*root, *publicKey, resolved.Reference, *imageRoot, *imagePublicKey, selected, *smokeTimeout); err != nil {
			return err
		}
		if _, err := agentpackage.Activate(*root, resolved.Reference, *publicKey, runtime.GOOS, runtime.GOARCH, contract); err != nil {
			return err
		}
	}
	return printAgentResolved(resolved, *activate)
}

func runAgentList(args []string) error {
	flags := flag.NewFlagSet("agent list", flag.ContinueOnError)
	rootDefault, publicKeyDefault := agentDefaults()
	root := flags.String("root", rootDefault, "absolute local Agent registry root")
	publicKey := flags.String("public-key", publicKeyDefault, "trusted Ed25519 Agent signing public key")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *root == "" || *publicKey == "" {
		return errors.New("agent list requires root and public-key")
	}
	installed, err := agentpackage.List(*root, *publicKey, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}
	activeReference := ""
	if active, err := agentpackage.ReadActivation(*root); err == nil {
		activeReference = active.ID + "@" + active.Version
	}
	result := make([]map[string]any, 0, len(installed))
	for _, item := range installed {
		result = append(result, map[string]any{"reference": item.Reference, "architecture": item.Manifest.Architecture, "active": item.Reference == activeReference, "digest": item.Digest})
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

func runAgentUse(args []string) error {
	flags := flag.NewFlagSet("agent use", flag.ContinueOnError)
	rootDefault, publicKeyDefault := agentDefaults()
	root := flags.String("root", rootDefault, "absolute local Agent registry root")
	publicKey := flags.String("public-key", publicKeyDefault, "trusted Ed25519 Agent signing public key")
	defaultImageRoot, defaultImagePublicKey := configuredImageDefaults()
	imageRoot := flags.String("image-root", defaultImageRoot, "installed Runtime image root")
	imagePublicKey := flags.String("image-public-key", defaultImagePublicKey, "trusted Runtime image public key")
	smokeTimeout := flags.Duration("smoke-timeout", 2*time.Minute, "candidate Agent VM smoke timeout")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 || *root == "" || *publicKey == "" || *imageRoot == "" || *imagePublicKey == "" {
		return errors.New("agent use requires one id@version reference and configured Agent and Runtime roots")
	}
	selected, err := vmimage.ResolveActive(*imageRoot, *imagePublicKey, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}
	contract, err := runtimeAgentContract(selected)
	if err != nil {
		return err
	}
	if err := smokeAgentCandidate(*root, *publicKey, flags.Arg(0), *imageRoot, *imagePublicKey, selected, *smokeTimeout); err != nil {
		return err
	}
	activation, err := agentpackage.Activate(*root, flags.Arg(0), *publicKey, runtime.GOOS, runtime.GOARCH, contract)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(activation)
}

func smokeAgentCandidate(root, publicKey, reference, imageRoot, imagePublicKey string, image vmimage.Resolved, timeout time.Duration) error {
	if timeout < 10*time.Second || timeout > 10*time.Minute {
		return errors.New("Agent smoke timeout must be between 10s and 10m")
	}
	before, err := vmimage.ReadActivation(imageRoot)
	if err != nil {
		return fmt.Errorf("read active Runtime image for Agent smoke: %w", err)
	}
	if before.ActiveVersion != image.Manifest.ImageVersion {
		return errors.New("active Runtime image changed before Agent smoke")
	}
	if err := runImageSmoke([]string{
		"--image-root", imageRoot,
		"--image-public-key", imagePublicKey,
		"--image-version", image.Manifest.ImageVersion,
		"--agent", reference,
		"--agent-root", root,
		"--agent-public-key", publicKey,
		"--timeout", timeout.String(),
	}); err != nil {
		return err
	}
	after, err := vmimage.ReadActivation(imageRoot)
	if err != nil {
		return fmt.Errorf("re-read active Runtime image after Agent smoke: %w", err)
	}
	if after.ActiveVersion != before.ActiveVersion || after.Generation != before.Generation {
		return errors.New("active Runtime image changed during Agent smoke; Agent was not activated")
	}
	return nil
}

func runAgentStatus(args []string) error {
	flags := flag.NewFlagSet("agent status", flag.ContinueOnError)
	rootDefault, publicKeyDefault := agentDefaults()
	root := flags.String("root", rootDefault, "absolute local Agent registry root")
	publicKey := flags.String("public-key", publicKeyDefault, "trusted Ed25519 Agent signing public key")
	defaultImageRoot, defaultImagePublicKey := configuredImageDefaults()
	imageRoot := flags.String("image-root", defaultImageRoot, "installed Runtime image root")
	imagePublicKey := flags.String("image-public-key", defaultImagePublicKey, "trusted Runtime image public key")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *root == "" || *publicKey == "" || *imageRoot == "" || *imagePublicKey == "" {
		return errors.New("agent status requires configured Agent and Runtime roots")
	}
	selected, err := vmimage.ResolveActive(*imageRoot, *imagePublicKey, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}
	contract, err := runtimeAgentContract(selected)
	if err != nil {
		return err
	}
	resolved, err := agentpackage.ResolveActive(*root, *publicKey, runtime.GOOS, runtime.GOARCH, contract)
	if err != nil {
		return err
	}
	return printAgentResolved(resolved, true)
}

func printAgentResolved(resolved agentpackage.Resolved, active bool) error {
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"reference": resolved.Reference, "active": active, "architecture": resolved.Manifest.Architecture,
		"entrypoint": resolved.Manifest.Entrypoint, "digest": resolved.Digest,
	})
}

func resolveSelectedAgent(root, publicKey, reference string, image vmimage.Resolved) (agentpackage.Resolved, error) {
	if root == "" || publicKey == "" {
		return agentpackage.Resolved{}, errors.New("--agent requires --agent-root and --agent-public-key")
	}
	contract, err := runtimeAgentContract(image)
	if err != nil {
		return agentpackage.Resolved{}, err
	}
	if reference == "active" {
		return agentpackage.ResolveActive(root, publicKey, runtime.GOOS, runtime.GOARCH, contract)
	}
	return agentpackage.Resolve(root, reference, publicKey, runtime.GOOS, runtime.GOARCH, contract)
}

func runtimeAgentContract(image vmimage.Resolved) (agentpackage.RuntimeContract, error) {
	capabilities, err := vmimage.ReadResolvedCapabilities(image)
	if err != nil {
		return agentpackage.RuntimeContract{}, fmt.Errorf("verify Runtime Agent adapter: %w", err)
	}
	if capabilities.AgentAdapter == nil || capabilities.AgentAdapter.Contract == "" {
		return agentpackage.RuntimeContract{}, errors.New("selected Runtime image does not declare a pluggable Resident Agent adapter contract")
	}
	return agentpackage.RuntimeContract{
		Protocol: image.Manifest.Protocol, StateSchema: image.Manifest.StateSchema, AgentAdapter: capabilities.AgentAdapter.Contract,
	}, nil
}

func absoluteAgentPaths(root, publicKey string) (string, string, error) {
	var err error
	if root != "" {
		root, err = filepath.Abs(root)
		if err != nil {
			return "", "", err
		}
	}
	if publicKey != "" {
		publicKey, err = filepath.Abs(publicKey)
		if err != nil {
			return "", "", err
		}
	}
	return root, publicKey, nil
}
