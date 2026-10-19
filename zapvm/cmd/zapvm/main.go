package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"zapvm/internal/agent"
	"zapvm/internal/auditlog"
	"zapvm/internal/clierror"
	"zapvm/internal/credential"
	"zapvm/internal/egress"
	"zapvm/internal/hostpolicy"
	vmimage "zapvm/internal/image"
	"zapvm/internal/platform"
	"zapvm/internal/protocol"
	"zapvm/internal/state"
)

var version = "0.1.0-dev"

const reservedGuestProxyID uint32 = 998

func main() {
	prepareDaemonWorkerRuntime()
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		os.Exit(reportCLIError(os.Args[1:], err, os.Stderr))
	}
}

func reportCLIError(args []string, err error, output io.Writer) int {
	var guestExit *guestCommandExitError
	if errors.As(err, &guestExit) && guestExit.Code > 0 && guestExit.Code <= 255 {
		// Guest stderr has already been streamed. An ordinary command failure
		// is not a VM transport outage and must preserve its exit status.
		return guestExit.Code
	}
	return clierror.Report(output, err, commandErrorFallback(args))
}

func commandErrorFallback(args []string) clierror.Code {
	if len(args) == 0 {
		return clierror.InvalidRequest
	}
	switch args[0] {
	case "agent", "capabilities", "image-smoke":
		return clierror.InvalidImage
	case "state":
		return clierror.InvalidState
	case "doctor", "diagnose", "service":
		return clierror.InvalidConfiguration
	case "computer", "daemon", "gateway", "proxy":
		return clierror.Unavailable
	case "run":
		return clierror.ExecutionFailed
	case "help", "--help", "-h", "version", "--version", "-version":
		return clierror.InvalidRequest
	default:
		return clierror.InvalidRequest
	}
}

func run(args []string) error {
	if len(args) == 0 {
		usage()
		return nil
	}
	switch args[0] {
	case "_linux-vmm-supervisor":
		return runLinuxVMMSupervisor(args[1:])
	case "capabilities":
		return runCapabilities(args[1:])
	case "agent":
		return runAgent(args[1:])
	case "computer":
		return runComputer(args[1:])
	case "doctor":
		return doctor(args[1:])
	case "verify":
		return runVerify(args[1:])
	case "diagnose":
		return runDiagnose(args[1:])
	case "gateway":
		return runGateway(args[1:])
	case "image-smoke":
		return runImageSmoke(args[1:])
	case "daemon":
		return runDaemon(args[1:])
	case "run":
		return runVM(args[1:])
	case "proxy":
		return runProxy(args[1:])
	case "state":
		return runState(args[1:])
	case "service":
		return platform.WindowsServiceCommand(args[1:])
	case "version", "--version", "-version":
		fmt.Println(version)
		return nil
	case "help", "--help", "-h":
		usage()
		return nil
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: zapvm <command>

commands:
  agent    manage independently signed, pluggable Agent packages
  capabilities inspect the signed active image execution contract
  computer manage persistent Agent Computers through the local daemon
  doctor   inspect platform virtualization prerequisites
  verify   boot and verify the installed Agent Computer
  diagnose write a redacted diagnostic JSON snapshot
  gateway  expose authorized Agent Computers through an mTLS remote gateway
  image-smoke boot and validate a staged signed image before activation
  daemon   serve or call the per-user cross-process VM pool
  run      start a VM from a signed active image and execute a command or plan
  proxy    run a policy-enforcing HTTPS CONNECT egress proxy
  state    create or inspect a managed writable state disk
  service  install, control, or inspect the Windows HCS service
  version  print version`)
}

func runImageSmoke(args []string) error {
	flags := flag.NewFlagSet("image-smoke", flag.ContinueOnError)
	defaultImageRoot, defaultImagePublicKey := configuredImageDefaults()
	imageRoot := flags.String("image-root", defaultImageRoot, "absolute installed image root")
	imagePublicKey := flags.String("image-public-key", defaultImagePublicKey, "trusted Ed25519 image manifest public key")
	imageVersion := flags.String("image-version", "", "staged signed image version")
	timeout := flags.Duration("timeout", 2*time.Minute, "candidate boot and guest validation timeout")
	rootDefault, agentPublicKeyDefault := agentDefaults()
	agentReference := flags.String("agent", "", "independently signed Agent id@version or active")
	agentRoot := flags.String("agent-root", rootDefault, "absolute local Agent registry root")
	agentPublicKey := flags.String("agent-public-key", agentPublicKeyDefault, "trusted Ed25519 Agent signing public key")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *imageRoot == "" || *imagePublicKey == "" || *imageVersion == "" {
		return errors.New("image-smoke requires image-root, image-public-key, and image-version")
	}
	if *timeout < 10*time.Second || *timeout > 10*time.Minute {
		return errors.New("image-smoke timeout must be between 10s and 10m")
	}
	absoluteRoot, err := filepath.Abs(*imageRoot)
	if err != nil {
		return err
	}
	absoluteKey, err := filepath.Abs(*imagePublicKey)
	if err != nil {
		return err
	}
	resolved, err := vmimage.ResolveVersion(absoluteRoot, *imageVersion, absoluteKey, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return fmt.Errorf("resolve staged image: %w", err)
	}
	temporaryRoot, err := os.MkdirTemp("", "zapvm-image-smoke-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporaryRoot)
	stateFormat := "raw"
	stateName := "state.raw"
	if runtime.GOOS == "windows" {
		stateFormat = "vhdx"
		stateName = "state.vhdx"
	}
	statePath := filepath.Join(temporaryRoot, stateName)
	if err := state.CreateFromTemplateSchema(resolved.StateTemplate, statePath, stateFormat, resolved.Manifest.StateSchema); err != nil {
		return fmt.Errorf("create candidate smoke state: %w", err)
	}
	workspace := filepath.Join(temporaryRoot, "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		return err
	}
	smokeScript := `set -eu
grep -Eq '^[^ ]+ / [^ ]+ ro([, ]|$)' /proc/mounts
test -r /etc/zapvm/capabilities.json
test -d /var/lib/zapvm/data
printf 'candidate-state-ok\n' >/var/lib/zapvm/data/image-smoke
test "$(cat /var/lib/zapvm/data/image-smoke)" = candidate-state-ok
rm -f /var/lib/zapvm/data/image-smoke
`
	if resolved.Manifest.SchemaVersion < 3 {
		smokeScript += "command -v zap >/dev/null\n"
	}
	selectedAgentVersion := ""
	if *agentReference != "" {
		selectedAgent, resolveErr := resolveSelectedAgent(*agentRoot, *agentPublicKey, *agentReference, resolved)
		if resolveErr != nil {
			return fmt.Errorf("resolve smoke Agent: %w", resolveErr)
		}
		selectedAgentVersion = selectedAgent.Manifest.Version
	}
	if resolved.AgentDiskPath != "" || selectedAgentVersion != "" {
		agentVersion := ""
		for _, layer := range resolved.Manifest.Layers {
			if layer.Name == "agent" {
				agentVersion = layer.Version
				break
			}
		}
		if selectedAgentVersion != "" {
			agentVersion = selectedAgentVersion
		}
		smokeScript += `
mountpoint -q /opt/zapvm-agent
grep -Eq '^[^ ]+ /opt/zapvm-agent [^ ]+ ro,([^ ]*,)?nosuid,([^ ]*,)?nodev(,| |$)' /proc/mounts
test -x /opt/zapvm-agent/bin/agent
test ! -L /opt/zapvm-agent/bin/agent
agent_output=$(/opt/zapvm-agent/bin/agent --version)
printf '%s\n' "$agent_output"
printf '%s\n' "$agent_output" | grep -F -- ` + shellSingleQuote(agentVersion) + ` >/dev/null`
	}
	smokeScript += `
printf 'ZAPVM_IMAGE_SMOKE_OK\n'`
	agentStartTimeout := *timeout
	if agentStartTimeout > 5*time.Minute {
		agentStartTimeout = 5 * time.Minute
	}
	runArguments := []string{
		"--id", "image-smoke-" + *imageVersion,
		"--image-root", absoluteRoot,
		"--image-public-key", absoluteKey,
		"--image-version", *imageVersion,
		"--state-disk", statePath,
		"--workspace", workspace,
		"--workspace-read-only",
		"--network", "off",
		"--console=true",
		"--stop-after-exec",
		"--exec-timeout", timeout.String(),
		"--agent-start-timeout", agentStartTimeout.String(),
		"--session-id", "image-smoke",
	}
	if *agentReference != "" {
		runArguments = append(runArguments, "--agent", *agentReference, "--agent-root", *agentRoot, "--agent-public-key", *agentPublicKey)
	}
	runArguments = append(runArguments, "--", "/bin/sh", "-c", smokeScript)
	return runVM(runArguments)
}

func runVerify(args []string) error {
	flags := flag.NewFlagSet("verify", flag.ContinueOnError)
	defaultImageRoot, defaultImagePublicKey := configuredImageDefaults()
	imageRoot := flags.String("image-root", defaultImageRoot, "absolute installed image root")
	imagePublicKey := flags.String("image-public-key", defaultImagePublicKey, "trusted Ed25519 image manifest public key")
	timeout := flags.Duration("timeout", 3*time.Minute, "Agent Computer boot validation timeout")
	rootDefault, agentPublicKeyDefault := agentDefaults()
	agentReference := flags.String("agent", "", "independently signed Agent id@version or active")
	agentRoot := flags.String("agent-root", rootDefault, "absolute local Agent registry root")
	agentPublicKey := flags.String("agent-public-key", agentPublicKeyDefault, "trusted Ed25519 Agent signing public key")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("verify does not accept positional arguments")
	}
	if *imageRoot == "" || *imagePublicKey == "" {
		return errors.New("Agent Computer image is not installed; reinstall the complete package or set ZAPVM_IMAGE_ROOT and ZAPVM_IMAGE_PUBLIC_KEY")
	}
	if err := doctor(nil); err != nil {
		return err
	}
	absoluteRoot, err := filepath.Abs(*imageRoot)
	if err != nil {
		return err
	}
	absoluteKey, err := filepath.Abs(*imagePublicKey)
	if err != nil {
		return err
	}
	activation, err := vmimage.ReadActivation(absoluteRoot)
	if err != nil {
		return fmt.Errorf("read installed Agent Computer image: %w", err)
	}
	capabilities, err := vmimage.ReadActiveCapabilities(absoluteRoot, absoluteKey, runtime.GOARCH)
	if err != nil {
		return fmt.Errorf("verify installed Agent Computer image: %w", err)
	}
	if *agentReference == "" && capabilities.ImageProfile == vmimage.ProfileHostRuntime {
		*agentReference = "active"
	}
	if *agentReference != "" {
		if capabilities.AgentAdapter == nil {
			return errors.New("installed Runtime image does not provide the generic Agent adapter")
		}
		resolvedImage, resolveErr := vmimage.ResolveActive(absoluteRoot, absoluteKey, runtime.GOOS, runtime.GOARCH)
		if resolveErr != nil {
			return resolveErr
		}
		selectedAgent, resolveErr := resolveSelectedAgent(*agentRoot, *agentPublicKey, *agentReference, resolvedImage)
		if resolveErr != nil {
			return fmt.Errorf("resolve Agent Computer package: %w", resolveErr)
		}
		fmt.Printf("agent: %s\n", selectedAgent.Reference)
	} else if capabilities.ImageProfile != vmimage.ProfileAgentComputer || capabilities.ResidentAgent == nil || !capabilities.ResidentAgent.Available {
		return errors.New("installed image is not a complete Agent Computer and no pluggable Agent is configured")
	}
	fmt.Printf("image: %s (%s)\n", activation.ActiveVersion, capabilities.ImageProfile)
	if *agentReference == "" {
		fmt.Printf("agent: %s (bundled)\n", capabilities.ResidentAgent.Version)
	}
	smokeArguments := []string{
		"--image-root", absoluteRoot,
		"--image-public-key", absoluteKey,
		"--image-version", activation.ActiveVersion,
		"--timeout", timeout.String(),
	}
	if *agentReference != "" {
		smokeArguments = append(smokeArguments, "--agent", *agentReference, "--agent-root", *agentRoot, "--agent-public-key", *agentPublicKey)
	}
	if err := runImageSmoke(smokeArguments); err != nil {
		return err
	}
	fmt.Println("ZAPVM_AGENT_COMPUTER_OK")
	return nil
}

func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func runState(args []string) error {
	if len(args) == 0 {
		return errors.New("state requires create or inspect")
	}
	switch args[0] {
	case "create":
		flags := flag.NewFlagSet("state create", flag.ContinueOnError)
		template := flags.String("template", "", "signed image state.raw or state.vhdx template")
		output := flags.String("output", "", "new absolute per-VM state disk path")
		format := flags.String("format", "", "raw or vhdx")
		stateSchema := flags.Int("schema", state.CurrentStateSchema, "signed template guest state schema")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if *template == "" || *output == "" || *format == "" {
			return errors.New("state create requires --template, --output, and --format")
		}
		absoluteTemplate, err := filepath.Abs(*template)
		if err != nil {
			return err
		}
		absoluteOutput, err := filepath.Abs(*output)
		if err != nil {
			return err
		}
		if err := state.CreateFromTemplateSchema(absoluteTemplate, absoluteOutput, *format, *stateSchema); err != nil {
			return err
		}
		fmt.Fprintln(os.Stdout, absoluteOutput)
		return nil
	case "inspect":
		flags := flag.NewFlagSet("state inspect", flag.ContinueOnError)
		disk := flags.String("disk", "", "managed state disk path")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if *disk == "" {
			return errors.New("state inspect requires --disk")
		}
		absoluteDisk, err := filepath.Abs(*disk)
		if err != nil {
			return err
		}
		metadata, err := state.Inspect(absoluteDisk)
		if err != nil {
			return err
		}
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(metadata)
	default:
		return fmt.Errorf("unknown state command %q", args[0])
	}
}

func runProxy(args []string) error {
	flags := flag.NewFlagSet("proxy", flag.ContinueOnError)
	listenAddress := flags.String("listen", "127.0.0.1:0", "TCP listen address")
	allowNonLoopback := flags.Bool("allow-non-loopback", false, "explicitly expose the proxy beyond loopback")
	auditJSON := flags.Bool("audit-json", false, "write policy decisions as JSON to stderr")
	maxConcurrent := flags.Int("max-concurrent", 32, "maximum simultaneous CONNECT tunnels")
	var domains []string
	var ports []uint16
	flags.Func("allow-domain", "exact domain or *.suffix rule; repeatable", func(value string) error {
		domains = append(domains, value)
		return nil
	})
	flags.Func("allow-port", "allowed destination port; repeatable (default 443)", func(value string) error {
		parsed, err := strconv.ParseUint(value, 10, 16)
		if err != nil || parsed == 0 {
			return fmt.Errorf("invalid port %q", value)
		}
		ports = append(ports, uint16(parsed))
		return nil
	})
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(domains) == 0 {
		return errors.New("at least one --allow-domain is required")
	}
	policy, err := egress.NewPolicy(domains, ports)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", *listenAddress)
	if err != nil {
		return err
	}
	defer listener.Close()
	if tcpAddress, ok := listener.Addr().(*net.TCPAddr); ok && !tcpAddress.IP.IsLoopback() && !*allowNonLoopback {
		return errors.New("refusing non-loopback proxy listener without --allow-non-loopback")
	}
	proxy := &egress.Proxy{
		Policy: policy, Resolver: egress.NewHostResolver(), MaxConcurrent: *maxConcurrent,
		ConnectTimeout: 10 * time.Second, IdleTimeout: 5 * time.Minute,
	}
	if *auditJSON {
		encoder := json.NewEncoder(os.Stderr)
		var auditMu sync.Mutex
		proxy.Audit = func(event egress.AuditEvent) {
			auditMu.Lock()
			defer auditMu.Unlock()
			_ = encoder.Encode(event)
		}
	}
	fmt.Fprintln(os.Stdout, listener.Addr().String())
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	serveErr := make(chan error, 1)
	go func() { serveErr <- proxy.Serve(listener) }()
	select {
	case err := <-serveErr:
		if errors.Is(err, net.ErrClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		_ = listener.Close()
		err := <-serveErr
		if errors.Is(err, net.ErrClosed) {
			return nil
		}
		return err
	}
}

func doctor(args []string) error {
	flags := flag.NewFlagSet("doctor", flag.ContinueOnError)
	jsonOutput := flags.Bool("json", false, "emit JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	report := platform.Current().Doctor(context.Background())
	if *jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(report); err != nil {
			return err
		}
	} else {
		fmt.Printf("backend: %s (%s/%s)\n", report.Backend, report.OS, report.Arch)
		for _, check := range report.Checks {
			fmt.Printf("%-5s %-28s %s\n", check.Status, check.Name, check.Detail)
		}
	}
	if !report.Ready() {
		return errors.New("platform prerequisites are not ready")
	}
	return nil
}

func runVM(args []string) (returnErr error) {
	flags := flag.NewFlagSet("run", flag.ContinueOnError)
	id := flags.String("id", "zapvm-dev", "VM identifier")
	defaultImageRoot, defaultImagePublicKey := configuredImageDefaults()
	imageRoot := flags.String("image-root", defaultImageRoot, "absolute installed image root containing active.json")
	imagePublicKey := flags.String("image-public-key", defaultImagePublicKey, "trusted Ed25519 image manifest public key")
	imageVersion := flags.String("image-version", "", "staged signed image version to boot without changing active.json")
	allowUnsignedImage := flags.Bool("allow-unsigned-image", false, "development only: allow explicit unverified kernel/root paths")
	kernel := flags.String("kernel", "", "absolute Linux kernel path")
	initrd := flags.String("initrd", "", "absolute initrd path")
	rootDisk := flags.String("root-disk", "", "absolute raw/VHDX root disk path")
	stateDisk := flags.String("state-disk", "", "absolute writable state disk path")
	agentDisk := flags.String("agent-disk", "", "absolute read-only Agent layer raw/VHDX disk path")
	agentReference := flags.String("agent", "", "signed pluggable Agent id@version or active")
	defaultAgentRoot, defaultAgentPublicKey := agentDefaults()
	agentRoot := flags.String("agent-root", defaultAgentRoot, "absolute installed Agent registry root")
	agentPublicKey := flags.String("agent-public-key", defaultAgentPublicKey, "trusted Ed25519 Agent signing public key")
	bootShare := flags.String("boot-share", "", "absolute read-only bootstrap share path")
	workspace := flags.String("workspace", "", "absolute authorized workspace path")
	workspaceReadOnly := flags.Bool("workspace-read-only", false, "mount the explicitly authorized workspace read-only")
	sessionID := flags.String("session-id", "cli-session", "logical Session identity for cgroup and persistent HOME isolation")
	rpcSecretFile := flags.String("rpc-secret-file", "", "authenticate the guest agent with this raw secret")
	cmdline := flags.String("cmdline", defaultKernelCmdline(runtime.GOOS), "Linux kernel command line")
	cpus := flags.Uint("cpus", 2, "virtual CPU count")
	memoryMiB := flags.Uint64("memory-mib", 2048, "memory in MiB")
	network := flags.String("network", "unrestricted", "off, restricted, or unrestricted")
	egressAuditJSON := flags.Bool("egress-audit-json", false, "write restricted-network policy decisions as JSON")
	var allowedDomains []string
	var allowedPorts []uint16
	var credentialBindings []string
	flags.Func("allow-domain", "restricted-network exact domain or *.suffix; repeatable", func(value string) error {
		allowedDomains = append(allowedDomains, value)
		return nil
	})
	flags.Func("allow-port", "restricted-network destination port; repeatable (default 443)", func(value string) error {
		parsed, parseErr := strconv.ParseUint(value, 10, 16)
		if parseErr != nil || parsed == 0 {
			return fmt.Errorf("invalid port %q", value)
		}
		allowedPorts = append(allowedPorts, uint16(parsed))
		return nil
	})
	flags.Func("credential", "authorize id=/absolute/path for request-scoped file injection; repeatable", func(value string) error {
		credentialBindings = append(credentialBindings, value)
		return nil
	})
	console := flags.Bool("console", true, "attach serial console")
	stopAfterExec := flags.Bool("stop-after-exec", false, "gracefully stop the VM after the structured guest command exits")
	execTimeout := flags.Duration("exec-timeout", time.Minute, "guest command timeout (1ms to 24h)")
	execPlanPath := flags.String("exec-plan", "", "strict JSON plan for multiple commands in one VM")
	serveStdio := flags.Bool("serve-stdio", false, "keep one VM alive and accept schema-1 JSONL requests on stdin")
	idleTimeout := flags.Duration("idle-timeout", 15*time.Minute, "serve-stdio idle shutdown timeout (1s to 24h)")
	auditLogPath := flags.String("audit-log", "", "append redacted, hash-chained lifecycle events to this file")
	heartbeatInterval := flags.Duration("heartbeat-interval", 5*time.Second, "independent guest agent heartbeat interval")
	heartbeatTimeout := flags.Duration("heartbeat-timeout", 2*time.Second, "deadline for each guest agent heartbeat")
	agentStartTimeout := flags.Duration("agent-start-timeout", defaultAgentStartTimeout(runtime.GOOS), "deadline for the guest agent to become reachable (1s to 5m)")
	restartAgentBeforeExec := flags.Bool("restart-agent-before-exec", false, "fault injection: request one supervised guest agent restart before execution")
	crashAgentAfter := flags.Duration("crash-agent-after", 0, "fault injection: crash the guest agent after this delay during execution")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *stopAfterExec && flags.NArg() == 0 {
		if *execPlanPath == "" && !*serveStdio {
			return errors.New("--stop-after-exec requires a guest command after -- or --exec-plan")
		}
	}
	if *execPlanPath != "" && flags.NArg() != 0 {
		return errors.New("--exec-plan cannot be combined with a command after --")
	}
	if *serveStdio && (*execPlanPath != "" || flags.NArg() != 0) {
		return errors.New("--serve-stdio cannot be combined with --exec-plan or a command after --")
	}
	if *execPlanPath != "" && *crashAgentAfter > 0 {
		return errors.New("--exec-plan cannot be combined with --crash-agent-after fault injection")
	}
	if *serveStdio && *crashAgentAfter > 0 {
		return errors.New("--serve-stdio cannot be combined with --crash-agent-after fault injection")
	}
	if len(credentialBindings) > 0 && flags.NArg() == 0 && *execPlanPath == "" && !*serveStdio {
		return errors.New("--credential requires a guest command, --exec-plan, or --serve-stdio")
	}
	if err := validateExecTimeout(*execTimeout); err != nil {
		return err
	}
	if *idleTimeout < time.Second || *idleTimeout > 24*time.Hour {
		return errors.New("idle timeout must be between 1s and 24h")
	}
	if *heartbeatInterval < 500*time.Millisecond || *heartbeatTimeout <= 0 || *heartbeatTimeout > *heartbeatInterval {
		return errors.New("heartbeat interval must be at least 500ms and timeout must be positive and no greater than the interval")
	}
	if err := validateAgentStartTimeout(*agentStartTimeout); err != nil {
		return err
	}
	if *crashAgentAfter < 0 || (*crashAgentAfter > 0 && flags.NArg() == 0) {
		return errors.New("--crash-agent-after must be non-negative and requires a guest command")
	}
	if *sessionID == "" || len(*sessionID) > 256 || strings.IndexByte(*sessionID, 0) >= 0 {
		return errors.New("session ID must contain 1-256 non-NUL bytes")
	}
	abs := func(path string) (string, error) {
		if path == "" {
			return "", nil
		}
		return filepath.Abs(path)
	}
	var err error
	if *imageRoot, err = abs(*imageRoot); err != nil {
		return err
	}
	if *imagePublicKey, err = abs(*imagePublicKey); err != nil {
		return err
	}
	if *kernel, err = abs(*kernel); err != nil {
		return err
	}
	if *initrd, err = abs(*initrd); err != nil {
		return err
	}
	if *rootDisk, err = abs(*rootDisk); err != nil {
		return err
	}
	if *stateDisk, err = abs(*stateDisk); err != nil {
		return err
	}
	if *agentDisk, err = abs(*agentDisk); err != nil {
		return err
	}
	if *agentRoot, *agentPublicKey, err = absoluteAgentPaths(*agentRoot, *agentPublicKey); err != nil {
		return err
	}
	if *bootShare, err = abs(*bootShare); err != nil {
		return err
	}
	if *rpcSecretFile, err = abs(*rpcSecretFile); err != nil {
		return err
	}
	if *workspace, err = abs(*workspace); err != nil {
		return err
	}
	if *execPlanPath, err = abs(*execPlanPath); err != nil {
		return err
	}
	if *auditLogPath, err = abs(*auditLogPath); err != nil {
		return err
	}
	var lifecycleAudit *auditlog.Log
	auditPhase := "preflight"
	if *auditLogPath != "" {
		lifecycleAudit, err = auditlog.Open(*auditLogPath, *id)
		if err != nil {
			return fmt.Errorf("open lifecycle audit log: %w", err)
		}
		if err := lifecycleAudit.Append("run_requested", auditPhase); err != nil {
			_ = lifecycleAudit.Close()
			return fmt.Errorf("write lifecycle audit log: %w", err)
		}
		defer func() {
			event := "run_completed"
			if returnErr != nil {
				event = "run_failed"
			}
			if auditErr := lifecycleAudit.Append(event, auditPhase); auditErr != nil {
				returnErr = errors.Join(returnErr, fmt.Errorf("finalize lifecycle audit log: %w", auditErr))
			}
			if auditErr := lifecycleAudit.Close(); auditErr != nil {
				returnErr = errors.Join(returnErr, fmt.Errorf("close lifecycle audit log: %w", auditErr))
			}
		}()
	}
	recordAudit := func(event, phase string) error {
		auditPhase = phase
		if lifecycleAudit == nil {
			return nil
		}
		if err := lifecycleAudit.Append(event, phase); err != nil {
			return fmt.Errorf("write lifecycle audit event %s: %w", event, err)
		}
		return nil
	}
	var selectedExecPlan *execPlan
	if *execPlanPath != "" {
		plan, planErr := loadExecPlan(*execPlanPath, *execTimeout)
		if planErr != nil {
			return planErr
		}
		selectedExecPlan = &plan
	}
	var credentialBroker *credential.Broker
	if len(credentialBindings) > 0 {
		credentialBroker, err = credential.Load(credentialBindings)
		if err != nil {
			return err
		}
		defer credentialBroker.Close()
	}
	if selectedExecPlan != nil {
		if err := validatePlanCredentialBindings(*selectedExecPlan, credentialBroker); err != nil {
			return err
		}
	}
	if (*imageRoot == "") != (*imagePublicKey == "") {
		return errors.New("--image-root and --image-public-key must be provided together")
	}
	if *imageVersion != "" && *imageRoot == "" {
		return errors.New("--image-version requires --image-root and --image-public-key")
	}
	selectedImageStateSchema := 0
	selectedStateTemplate := ""
	selectedVMMPath := ""
	selectedVirtioFSDPath := ""
	selectedVMMVersion := ""
	selectedVirtioFSDVersion := ""
	auditPhase = "image_validation"
	if *imageRoot != "" {
		if *allowUnsignedImage {
			return errors.New("--allow-unsigned-image cannot be combined with a signed image root")
		}
		if *kernel != "" || *initrd != "" || *rootDisk != "" || *agentDisk != "" {
			return errors.New("--kernel, --initrd, --root-disk, and --agent-disk cannot override a signed image")
		}
		var resolved vmimage.Resolved
		var resolveErr error
		if *imageVersion == "" {
			resolved, resolveErr = vmimage.ResolveActive(*imageRoot, *imagePublicKey, runtime.GOOS, runtime.GOARCH)
		} else {
			resolved, resolveErr = vmimage.ResolveVersion(*imageRoot, *imageVersion, *imagePublicKey, runtime.GOOS, runtime.GOARCH)
		}
		if resolveErr != nil {
			return resolveErr
		}
		*kernel = resolved.KernelPath
		*initrd = resolved.InitrdPath
		*rootDisk = resolved.RootDiskPath
		*agentDisk = resolved.AgentDiskPath
		if *agentReference != "" {
			selectedAgent, agentErr := resolveSelectedAgent(*agentRoot, *agentPublicKey, *agentReference, resolved)
			if agentErr != nil {
				return fmt.Errorf("resolve pluggable Agent: %w", agentErr)
			}
			*agentDisk = selectedAgent.DiskPath
			fmt.Fprintf(os.Stderr, "using signed Agent %s\n", selectedAgent.Reference)
		}
		selectedStateTemplate = resolved.StateTemplate
		selectedImageStateSchema = resolved.Manifest.StateSchema
		selectedVMMPath = resolved.VMMPath
		selectedVirtioFSDPath = resolved.VirtioFSDPath
		selectedVMMVersion = resolved.VMMVersion
		selectedVirtioFSDVersion = resolved.VirtioVersion
		selection := "active"
		if *imageVersion != "" {
			selection = "staged"
		}
		fmt.Fprintf(os.Stderr, "using signed %s image %s (state schema %d)\n", selection, resolved.Manifest.ImageVersion, resolved.Manifest.StateSchema)
	} else if !*allowUnsignedImage {
		return errors.New("a signed --image-root/--image-public-key is required; explicit paths require --allow-unsigned-image")
	} else {
		if *agentReference != "" {
			return errors.New("--agent requires a signed Runtime image")
		}
		fmt.Fprintln(os.Stderr, "warning: using explicitly allowed unsigned development image paths")
	}
	if *workspace != "" {
		if *workspace, err = hostpolicy.ValidateWorkspace(*workspace); err != nil {
			return err
		}
	}
	var restrictedPolicy *egress.Policy
	if *network == string(platform.NetworkRestricted) {
		if len(allowedDomains) == 0 {
			return errors.New("restricted network requires at least one --allow-domain")
		}
		restrictedPolicy, err = egress.NewPolicy(allowedDomains, allowedPorts)
		if err != nil {
			return err
		}
	} else if len(allowedDomains) > 0 || len(allowedPorts) > 0 {
		return errors.New("--allow-domain/--allow-port require --network restricted")
	}
	var rpcSecret []byte
	cleanupBootstrap := func() {}
	cleanupEmptyWorkspace := func() {}
	defer func() {
		cleanupEmptyWorkspace()
		cleanupBootstrap()
	}()
	needsAgent := *bootShare != "" || *rpcSecretFile != "" || *workspace != "" || *stateDisk != "" || *restartAgentBeforeExec || *crashAgentAfter > 0 || flags.NArg() > 0 || selectedExecPlan != nil || *serveStdio
	if needsAgent && *stateDisk == "" && selectedStateTemplate != "" {
		temporaryStateRoot, err := os.MkdirTemp("", "zapvm-run-state-")
		if err != nil {
			return fmt.Errorf("create temporary state directory: %w", err)
		}
		defer os.RemoveAll(temporaryStateRoot)
		stateFormat := "raw"
		stateName := "state.raw"
		if runtime.GOOS == "windows" {
			stateFormat = "vhdx"
			stateName = "state.vhdx"
		}
		*stateDisk = filepath.Join(temporaryStateRoot, stateName)
		if err := state.CreateFromTemplateSchema(selectedStateTemplate, *stateDisk, stateFormat, selectedImageStateSchema); err != nil {
			return fmt.Errorf("create temporary Agent Computer state: %w", err)
		}
	}
	if needsAgent {
		if *workspace == "" {
			emptyWorkspace, workspaceErr := os.MkdirTemp("", "zapvm-empty-workspace-")
			if workspaceErr != nil {
				return workspaceErr
			}
			if workspaceErr := os.Chmod(emptyWorkspace, 0o755); workspaceErr != nil {
				_ = os.RemoveAll(emptyWorkspace)
				return workspaceErr
			}
			*workspace = emptyWorkspace
			*workspaceReadOnly = true
			cleanupEmptyWorkspace = func() { _ = os.RemoveAll(emptyWorkspace) }
		}
		preparedShare, preparedSecret, cleanup, prepareErr := prepareBootstrap(
			*bootShare, *rpcSecretFile, *crashAgentAfter > 0, *workspaceReadOnly, platform.NetworkMode(*network),
		)
		if prepareErr != nil {
			return prepareErr
		}
		*bootShare = preparedShare
		rpcSecret = preparedSecret
		cleanupBootstrap = cleanup
	}
	var stateHandle *state.Handle
	stateAttached := false
	stateClean := false
	stateFlushed := false
	verifiedStateSchema := 0
	if *stateDisk != "" {
		auditPhase = "state_open"
		stateHandle, err = state.OpenForVM(*stateDisk, *id)
		if err != nil {
			return err
		}
		metadata := stateHandle.Metadata()
		if selectedImageStateSchema > 0 && metadata.StateSchema > selectedImageStateSchema {
			_ = stateHandle.Restore()
			stateHandle = nil
			return fmt.Errorf("state schema %d is newer than signed image support %d", metadata.StateSchema, selectedImageStateSchema)
		}
		expectedFormat := "raw"
		if runtime.GOOS == "windows" {
			expectedFormat = "vhdx"
		}
		if metadata.DiskFormat != expectedFormat {
			_ = stateHandle.Restore()
			stateHandle = nil
			return fmt.Errorf("state disk format %q is unsupported on %s; want %s", metadata.DiskFormat, runtime.GOOS, expectedFormat)
		}
		if stateHandle.PreviousDirty() {
			fmt.Fprintln(os.Stderr, "state disk was not cleanly stopped; guest fsck/schema recovery is required")
		}
		defer func() {
			if stateHandle == nil {
				return
			}
			var closeErr error
			switch {
			case !stateAttached:
				closeErr = stateHandle.Restore()
			case stateClean:
				closeErr = stateHandle.MarkClean(verifiedStateSchema)
			default:
				closeErr = stateHandle.CloseDirty()
			}
			if closeErr != nil {
				returnErr = errors.Join(returnErr, fmt.Errorf("close state disk: %w", closeErr))
			}
		}()
	}
	spec := platform.Spec{
		ID:                *id,
		CPUCount:          *cpus,
		MemoryBytes:       *memoryMiB * platform.MiB,
		KernelPath:        *kernel,
		InitrdPath:        *initrd,
		RootDiskPath:      *rootDisk,
		VMMPath:           selectedVMMPath,
		VirtioFSDPath:     selectedVirtioFSDPath,
		VMMVersion:        selectedVMMVersion,
		VirtioFSDVersion:  selectedVirtioFSDVersion,
		StateDiskPath:     *stateDisk,
		AgentDiskPath:     *agentDisk,
		BootSharePath:     *bootShare,
		WorkspacePath:     *workspace,
		WorkspaceReadOnly: *workspaceReadOnly,
		KernelCmdline:     *cmdline,
		Network:           platform.NetworkMode(*network),
		Console:           *console,
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	auditPhase = "vm_starting"
	consoleOutput := vmConsoleOutput(*serveStdio, os.Stdout, os.Stderr)
	instance, err := platform.Current().Start(ctx, spec, consoleOutput)
	if err != nil {
		return err
	}
	stateAttached = stateHandle != nil
	defer func() {
		if returnErr == nil || instance.State() == platform.StateStopped || instance.State() == platform.StateFailed {
			return
		}
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer stopCancel()
		if stopErr := instance.Stop(stopCtx); stopErr != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("cleanup VM: %w", stopErr))
		}
	}()
	if err := recordAudit("vm_started", "running"); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "VM %s started\n", instance.ID())
	proxyErr := make(chan error, 1)
	heartbeatErr := make(chan error, 1)
	faultErr := make(chan error, 1)
	stopHeartbeat := func() {}
	stopFault := func() {}
	defer func() { stopHeartbeat() }()
	defer func() { stopFault() }()
	if restrictedPolicy != nil {
		listenerBackend, ok := instance.(platform.HostListener)
		if !ok {
			return errors.New("platform backend does not expose guest-to-Host transport")
		}
		listener, listenErr := listenerBackend.ListenHost(19091)
		if listenErr != nil {
			return fmt.Errorf("listen for restricted egress: %w", listenErr)
		}
		defer listener.Close()
		hostProxy := &egress.Proxy{
			Policy: restrictedPolicy, Resolver: egress.NewHostResolver(), MaxConcurrent: 64,
			ConnectTimeout: 10 * time.Second, IdleTimeout: 5 * time.Minute,
		}
		if *egressAuditJSON {
			encoder := json.NewEncoder(os.Stderr)
			var auditMu sync.Mutex
			hostProxy.Audit = func(event egress.AuditEvent) {
				auditMu.Lock()
				defer auditMu.Unlock()
				_ = encoder.Encode(event)
			}
		}
		go func() { proxyErr <- hostProxy.Serve(listener) }()
		fmt.Fprintln(os.Stderr, "restricted egress proxy ready")
	}
	if len(rpcSecret) > 0 {
		dialer, ok := instance.(platform.AgentDialer)
		if !ok {
			return errors.New("platform backend does not expose guest agent transport")
		}
		dialCtx, dialCancel := context.WithTimeout(ctx, *agentStartTimeout)
		connection, codec, dialErr := connectAuthenticatedAgentWithRetry(dialCtx, dialer, rpcSecret)
		dialCancel()
		if dialErr != nil {
			return fmt.Errorf("connect guest agent: %w", dialErr)
		}
		if *restartAgentBeforeExec {
			beforeRestart, healthErr := checkAgentHealth(connection, codec, 0, *heartbeatTimeout)
			if healthErr != nil {
				_ = connection.Close()
				return fmt.Errorf("identify guest agent before restart: %w", healthErr)
			}
			if restartErr := requestAgentRestart(connection, codec, 5*time.Second); restartErr != nil {
				_ = connection.Close()
				return fmt.Errorf("request guest agent restart: %w", restartErr)
			}
			_ = connection.Close()
			reconnectCtx, reconnectCancel := context.WithTimeout(ctx, 30*time.Second)
			connection, codec, dialErr = reconnectRestartedAgent(reconnectCtx, dialer, rpcSecret, beforeRestart.InstanceID, *heartbeatTimeout)
			reconnectCancel()
			if dialErr != nil {
				return fmt.Errorf("reconnect supervised guest agent: %w", dialErr)
			}
			fmt.Fprintln(os.Stderr, "guest agent supervised restart recovered")
		}
		fmt.Fprintln(os.Stderr, "guest agent authenticated")
		if stateHandle != nil && stateHandle.PreviousDirty() {
			fmt.Fprintln(os.Stderr, "state disk recovery gate passed")
		}
		healthCtx, healthCancel := context.WithCancel(ctx)
		healthDialCtx, healthDialCancel := context.WithTimeout(healthCtx, 10*time.Second)
		healthConnection, healthCodec, healthErr := connectAuthenticatedAgentWithRetry(healthDialCtx, dialer, rpcSecret)
		healthDialCancel()
		if healthErr != nil {
			healthCancel()
			_ = connection.Close()
			return fmt.Errorf("connect guest health channel: %w", healthErr)
		}
		health, healthErr := checkAgentHealth(healthConnection, healthCodec, 0, *heartbeatTimeout)
		if healthErr != nil {
			healthCancel()
			_ = healthConnection.Close()
			_ = connection.Close()
			return fmt.Errorf("initial guest health check: %w", healthErr)
		}
		if health.InstanceID == "" {
			healthCancel()
			_ = healthConnection.Close()
			_ = connection.Close()
			return errors.New("guest health omitted instance ID")
		}
		if stateHandle != nil {
			if health.StateSchema != state.CurrentStateSchema {
				healthCancel()
				_ = healthConnection.Close()
				_ = connection.Close()
				return fmt.Errorf("guest reported state schema %d, want %d", health.StateSchema, state.CurrentStateSchema)
			}
			verifiedStateSchema = health.StateSchema
		}
		heartbeatGate := &heartbeatGate{}
		var heartbeatMu sync.Mutex
		heartbeatGeneration := uint64(1)
		heartbeatStopped := false
		currentHealthCancel := healthCancel
		currentHealthConnection := healthConnection
		startHeartbeat := func(generation uint64, monitorCtx context.Context, monitorConnection io.ReadWriteCloser, monitorCodec *protocol.Codec, commandConnection io.ReadWriteCloser) {
			go func() {
				healthErr := monitorAgentHealth(monitorCtx, monitorConnection, monitorCodec, *heartbeatInterval, *heartbeatTimeout, heartbeatGate)
				if healthErr == nil {
					return
				}
				heartbeatMu.Lock()
				current := !heartbeatStopped && generation == heartbeatGeneration
				heartbeatMu.Unlock()
				if current {
					heartbeatErr <- healthErr
					_ = commandConnection.Close()
				}
			}()
		}
		stopHeartbeat = func() {
			heartbeatMu.Lock()
			if heartbeatStopped {
				heartbeatMu.Unlock()
				return
			}
			heartbeatStopped = true
			heartbeatGeneration++
			cancel := currentHealthCancel
			healthConnection := currentHealthConnection
			heartbeatMu.Unlock()
			cancel()
			_ = healthConnection.Close()
		}
		startHeartbeat(heartbeatGeneration, healthCtx, healthConnection, healthCodec, connection)
		var reconnectAfterResume func(context.Context) error
		if runtime.GOOS == "windows" {
			reconnectAfterResume = func(resumeCtx context.Context) error {
				reconnectCtx, reconnectCancel := context.WithTimeout(resumeCtx, 30*time.Second)
				defer reconnectCancel()
				newConnection, newCodec, newCommandHealth, reconnectErr := connectHealthyAgentWithRetry(
					reconnectCtx, dialer, rpcSecret, health.InstanceID, *heartbeatTimeout,
				)
				if reconnectErr != nil {
					return fmt.Errorf("reconnect guest command channel after resume: %w", reconnectErr)
				}
				newHealthConnection, newHealthCodec, newHealth, reconnectErr := connectHealthyAgentWithRetry(
					reconnectCtx, dialer, rpcSecret, health.InstanceID, *heartbeatTimeout,
				)
				if reconnectErr != nil {
					_ = newConnection.Close()
					return fmt.Errorf("reconnect guest health channel after resume: %w", reconnectErr)
				}
				if newCommandHealth.StateSchema != health.StateSchema || newHealth.StateSchema != health.StateSchema {
					_ = newHealthConnection.Close()
					_ = newConnection.Close()
					return errors.New("guest state schema changed across VM resume")
				}
				newHealthCtx, newHealthCancel := context.WithCancel(ctx)
				heartbeatMu.Lock()
				if heartbeatStopped {
					heartbeatMu.Unlock()
					newHealthCancel()
					_ = newHealthConnection.Close()
					_ = newConnection.Close()
					return context.Canceled
				}
				oldHealthCancel := currentHealthCancel
				oldHealthConnection := currentHealthConnection
				oldConnection := connection
				connection = newConnection
				codec = newCodec
				currentHealthCancel = newHealthCancel
				currentHealthConnection = newHealthConnection
				heartbeatGeneration++
				generation := heartbeatGeneration
				heartbeatMu.Unlock()
				oldHealthCancel()
				_ = oldHealthConnection.Close()
				_ = oldConnection.Close()
				startHeartbeat(generation, newHealthCtx, newHealthConnection, newHealthCodec, newConnection)
				fmt.Fprintln(os.Stderr, "guest agent channels reconnected after resume")
				return nil
			}
		}
		fmt.Fprintln(os.Stderr, "guest agent health ready")
		if auditErr := recordAudit("agent_ready", "running"); auditErr != nil {
			healthCancel()
			_ = healthConnection.Close()
			_ = connection.Close()
			return auditErr
		}
		if *crashAgentAfter > 0 {
			faultCtx, faultCancel := context.WithCancel(ctx)
			stopFault = faultCancel
			go func() {
				timer := time.NewTimer(*crashAgentAfter)
				defer timer.Stop()
				select {
				case <-faultCtx.Done():
					return
				case <-timer.C:
				}
				crashCtx, crashCancel := context.WithTimeout(faultCtx, 10*time.Second)
				defer crashCancel()
				crashConnection, crashCodec, crashErr := connectAuthenticatedAgentWithRetry(crashCtx, dialer, rpcSecret)
				if crashErr == nil {
					crashErr = requestAgentCrash(crashConnection, crashCodec, 2*time.Second)
					_ = crashConnection.Close()
				}
				faultErr <- crashErr
			}()
		}
		if flags.NArg() > 0 {
			directCredentials, credentialErr := resolveCommandCredentials(credentialBroker, credentialIDs(credentialBroker))
			if credentialErr != nil {
				_ = connection.Close()
				return credentialErr
			}
			execErr := executeGuest(codec, flags.Args(), platform.NetworkMode(*network), *sessionID, *execTimeout, directCredentials)
			credential.ZeroValues(directCredentials)
			if execErr != nil {
				_ = connection.Close()
				if *crashAgentAfter > 0 {
					select {
					case crashErr := <-faultErr:
						if crashErr != nil {
							return fmt.Errorf("inject guest agent crash: %w", crashErr)
						}
						select {
						case healthErr := <-heartbeatErr:
							return fmt.Errorf("guest agent degraded after injected crash: %w", healthErr)
						case <-time.After(*heartbeatInterval + *heartbeatTimeout + time.Second):
							return fmt.Errorf("guest agent crash closed command transport without a heartbeat failure: %w", execErr)
						}
					default:
					}
				}
				select {
				case healthErr := <-heartbeatErr:
					return fmt.Errorf("guest agent degraded: %w", healthErr)
				default:
				}
				return execErr
			}
		}
		if selectedExecPlan != nil {
			if planErr := runExecPlan(ctx, dialer, rpcSecret, *selectedExecPlan, platform.NetworkMode(*network), *execTimeout, credentialBroker); planErr != nil {
				_ = connection.Close()
				select {
				case healthErr := <-heartbeatErr:
					return fmt.Errorf("guest agent degraded during execution plan: %w", healthErr)
				default:
				}
				return fmt.Errorf("execute guest plan: %w", planErr)
			}
		}
		if *serveStdio {
			if auditErr := recordAudit("exec_stream_started", "running"); auditErr != nil {
				_ = connection.Close()
				return auditErr
			}
			streamDone := make(chan error, 1)
			go func() {
				streamDone <- serveExecStream(ctx, os.Stdin, os.Stdout, dialer, rpcSecret, platform.NetworkMode(*network), *execTimeout, *idleTimeout, credentialBroker, &vmExecStreamController{instance: instance, heartbeat: heartbeatGate, afterResume: reconnectAfterResume})
			}()
			select {
			case streamErr := <-streamDone:
				if streamErr != nil {
					_ = connection.Close()
					return fmt.Errorf("serve execution stream: %w", streamErr)
				}
			case healthErr := <-heartbeatErr:
				_ = connection.Close()
				return fmt.Errorf("guest agent degraded during execution stream: %w", healthErr)
			case <-ctx.Done():
				_ = connection.Close()
				return ctx.Err()
			}
			if auditErr := recordAudit("exec_stream_drained", "draining"); auditErr != nil {
				_ = connection.Close()
				return auditErr
			}
		}
		if stateHandle != nil {
			if flushErr := flushGuestState(codec); flushErr != nil {
				_ = connection.Close()
				select {
				case healthErr := <-heartbeatErr:
					return fmt.Errorf("guest agent degraded before state flush: %w", healthErr)
				default:
				}
				return fmt.Errorf("flush guest state: %w", flushErr)
			}
			stateFlushed = true
			fmt.Fprintln(os.Stderr, "guest state flush acknowledged")
			if auditErr := recordAudit("state_flushed", "draining"); auditErr != nil {
				_ = connection.Close()
				return auditErr
			}
		}
		_ = connection.Close()
	}
	waitErr := make(chan error, 1)
	go func() { waitErr <- instance.Wait(context.Background()) }()
	if *stopAfterExec || *serveStdio {
		stopFault()
		stopHeartbeat()
		select {
		case healthErr := <-heartbeatErr:
			return fmt.Errorf("guest agent degraded before stop: %w", healthErr)
		default:
		}
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer stopCancel()
		if err := recordAudit("vm_stop_requested", "stopping"); err != nil {
			return err
		}
		if err := instance.Stop(stopCtx); err != nil {
			return err
		}
		select {
		case err := <-waitErr:
			stateClean = stateHandle != nil && verifiedStateSchema == state.CurrentStateSchema && stateFlushed && err == nil
			if err == nil {
				if auditErr := recordAudit("vm_stopped", "stopped"); auditErr != nil {
					return auditErr
				}
			}
			if *serveStdio && err == nil {
				if stateHandle != nil {
					if !stateClean {
						return errors.New("VM stopped without a verified clean state transition")
					}
					if stateErr := stateHandle.MarkClean(verifiedStateSchema); stateErr != nil {
						return fmt.Errorf("commit clean state before final stream event: %w", stateErr)
					}
					stateHandle = nil
					if auditErr := recordAudit("state_clean_committed", "stopped"); auditErr != nil {
						return auditErr
					}
				}
				sink := &execPlanEventSink{encoder: json.NewEncoder(os.Stdout)}
				if eventErr := sink.write(execPlanEvent{SchemaVersion: 1, Type: "vm_stopped"}); eventErr != nil {
					return eventErr
				}
			}
			return err
		case <-time.After(time.Second):
			return fmt.Errorf("VM %s did not report stopped", strconv.Quote(instance.ID()))
		}
	}
	select {
	case err := <-waitErr:
		if err == nil {
			if auditErr := recordAudit("vm_stopped", "stopped"); auditErr != nil {
				return auditErr
			}
		}
		return err
	case err := <-proxyErr:
		if err != nil && !errors.Is(err, net.ErrClosed) {
			return fmt.Errorf("restricted egress proxy: %w", err)
		}
		return nil
	case err := <-heartbeatErr:
		return fmt.Errorf("guest agent degraded: %w", err)
	case <-ctx.Done():
		stopFault()
		stopHeartbeat()
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer stopCancel()
		if err := recordAudit("vm_stop_requested", "stopping"); err != nil {
			return err
		}
		if err := instance.Stop(stopCtx); err != nil {
			return err
		}
		select {
		case err := <-waitErr:
			stateClean = stateHandle != nil && verifiedStateSchema == state.CurrentStateSchema && stateFlushed && err == nil
			if err == nil {
				if auditErr := recordAudit("vm_stopped", "stopped"); auditErr != nil {
					return auditErr
				}
			}
			return err
		case <-time.After(time.Second):
			return fmt.Errorf("VM %s did not report stopped", strconv.Quote(instance.ID()))
		}
	}
}

func vmConsoleOutput(serveStdio bool, stdout, stderr io.Writer) io.Writer {
	if serveStdio {
		// stdout is the framed JSON protocol in worker mode. Keep VMM,
		// virtiofsd, and systemd scope diagnostics off that channel even when a
		// backend emits startup output while the guest console is disabled.
		return stderr
	}
	return stdout
}

func defaultKernelCmdline(hostOS string) string {
	switch hostOS {
	case "windows":
		return "console=hvc0 root=/dev/vda ro rootfstype=ext4 modules=ext4,sd_mod,scsi_mod,hv_storvsc,9p,9pnet,9pnet_virtio,hv_sock"
	default:
		return "console=hvc0 root=/dev/vda ro rootfstype=ext4 modules=ext4,virtio_blk,virtiofs,virtio_balloon"
	}
}

func defaultAgentStartTimeout(hostOS string) time.Duration {
	if hostOS == "windows" {
		// HCS direct-kernel boot and its Plan9 shares have substantially more
		// startup variance than local VZ/KVM, especially on shared Hyper-V hosts.
		return 90 * time.Second
	}
	return 30 * time.Second
}

type deadlineConnection interface {
	io.ReadWriteCloser
	SetDeadline(time.Time) error
}

func connectAuthenticatedAgent(ctx context.Context, dialer platform.AgentDialer, secret []byte) (io.ReadWriteCloser, *protocol.Codec, error) {
	connection, err := dialer.DialAgent(ctx, 19090)
	if err != nil {
		return nil, nil, err
	}
	deadlineConn, ok := connection.(deadlineConnection)
	if !ok {
		_ = connection.Close()
		return nil, nil, errors.New("guest agent transport does not support authentication deadlines")
	}
	if deadline, hasDeadline := ctx.Deadline(); hasDeadline {
		if err := deadlineConn.SetDeadline(deadline); err != nil {
			_ = connection.Close()
			return nil, nil, err
		}
		defer deadlineConn.SetDeadline(time.Time{})
	}
	codec := protocol.NewCodec(connection, connection)
	if err := protocol.AuthenticateClient(codec, secret); err != nil {
		_ = connection.Close()
		return nil, nil, err
	}
	return connection, codec, nil
}

func connectAuthenticatedAgentWithRetry(ctx context.Context, dialer platform.AgentDialer, secret []byte) (io.ReadWriteCloser, *protocol.Codec, error) {
	var failures []error
	for {
		connection, codec, err := connectAuthenticatedAgent(ctx, dialer, secret)
		if err == nil {
			return connection, codec, nil
		}
		failures = append(failures, err)
		select {
		case <-ctx.Done():
			return nil, nil, fmt.Errorf("agent did not return before deadline: %w", errors.Join(failures...))
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func reconnectRestartedAgent(ctx context.Context, dialer platform.AgentDialer, secret []byte, previousInstanceID string, healthTimeout time.Duration) (io.ReadWriteCloser, *protocol.Codec, error) {
	if previousInstanceID == "" {
		return nil, nil, errors.New("guest agent did not report an instance ID before restart")
	}
	var failures []error
	for {
		connection, codec, err := connectAuthenticatedAgent(ctx, dialer, secret)
		if err == nil {
			health, healthErr := checkAgentHealth(connection, codec, 0, healthTimeout)
			switch {
			case healthErr != nil:
				failures = append(failures, healthErr)
			case health.InstanceID == "":
				failures = append(failures, errors.New("guest agent health omitted instance ID"))
			case health.InstanceID == previousInstanceID:
				failures = append(failures, errors.New("guest agent has not restarted yet"))
			default:
				return connection, codec, nil
			}
			_ = connection.Close()
		} else {
			failures = append(failures, err)
		}
		select {
		case <-ctx.Done():
			return nil, nil, fmt.Errorf("new agent instance did not return before deadline: %w", errors.Join(failures...))
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func connectHealthyAgentWithRetry(ctx context.Context, dialer platform.AgentDialer, secret []byte, expectedInstanceID string, healthTimeout time.Duration) (io.ReadWriteCloser, *protocol.Codec, agent.Health, error) {
	if expectedInstanceID == "" {
		return nil, nil, agent.Health{}, errors.New("expected guest agent instance ID is required")
	}
	var failures []error
	for {
		connection, codec, err := connectAuthenticatedAgent(ctx, dialer, secret)
		if err == nil {
			health, healthErr := checkAgentHealth(connection, codec, 0, healthTimeout)
			switch {
			case healthErr != nil:
				failures = append(failures, healthErr)
			case health.InstanceID != expectedInstanceID:
				failures = append(failures, fmt.Errorf("guest agent instance ID %q does not match the running instance", health.InstanceID))
			default:
				return connection, codec, health, nil
			}
			_ = connection.Close()
		} else {
			failures = append(failures, err)
		}
		select {
		case <-ctx.Done():
			return nil, nil, agent.Health{}, fmt.Errorf("healthy agent channel did not return before deadline: %w", errors.Join(failures...))
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func requestAgentRestart(connection io.ReadWriteCloser, codec *protocol.Codec, timeout time.Duration) error {
	clear, err := setManagementDeadline(connection, timeout)
	if err != nil {
		return err
	}
	defer clear()
	request, err := protocol.NewEnvelope("agent-restart", "system", "agent.restart", struct{}{})
	if err != nil {
		return err
	}
	if err := codec.Write(request); err != nil {
		return err
	}
	response, err := codec.Read()
	if err != nil {
		return err
	}
	if response.ID != request.ID || response.Type != "agent.restarting" {
		return fmt.Errorf("unexpected agent restart response %q/%q", response.ID, response.Type)
	}
	return nil
}

func requestAgentCrash(connection io.ReadWriteCloser, codec *protocol.Codec, timeout time.Duration) error {
	clear, err := setManagementDeadline(connection, timeout)
	if err != nil {
		return err
	}
	defer clear()
	request, err := protocol.NewEnvelope("agent-crash", "system", "agent.crash", struct{}{})
	if err != nil {
		return err
	}
	if err := codec.Write(request); err != nil {
		return err
	}
	response, err := codec.Read()
	if err != nil {
		return err
	}
	if response.ID != request.ID || response.Type != "agent.crashing" {
		return fmt.Errorf("unexpected agent crash response %q/%q", response.ID, response.Type)
	}
	return nil
}

func setManagementDeadline(connection io.ReadWriteCloser, timeout time.Duration) (func(), error) {
	deadlineConn, ok := connection.(deadlineConnection)
	if !ok {
		return func() {}, errors.New("guest agent transport does not support management deadlines")
	}
	if err := deadlineConn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return func() {}, err
	}
	return func() { _ = deadlineConn.SetDeadline(time.Time{}) }, nil
}

func checkAgentHealth(connection io.ReadWriteCloser, codec *protocol.Codec, sequence uint64, timeout time.Duration) (agent.Health, error) {
	deadlineConn, ok := connection.(deadlineConnection)
	if !ok {
		return agent.Health{}, errors.New("guest health transport does not support deadlines")
	}
	if err := deadlineConn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return agent.Health{}, err
	}
	defer deadlineConn.SetDeadline(time.Time{})
	id := "health-" + strconv.FormatUint(sequence, 10)
	request, err := protocol.NewEnvelope(id, "system", "health", struct{}{})
	if err != nil {
		return agent.Health{}, err
	}
	if err := codec.Write(request); err != nil {
		return agent.Health{}, err
	}
	response, err := codec.Read()
	if err != nil {
		return agent.Health{}, err
	}
	if response.ID != id || response.Type != "health.ok" {
		return agent.Health{}, fmt.Errorf("unexpected health response %q/%q", response.ID, response.Type)
	}
	var health agent.Health
	if err := json.Unmarshal(response.Payload, &health); err != nil {
		return agent.Health{}, err
	}
	if health.ProtocolVersion != protocol.Version {
		return agent.Health{}, fmt.Errorf("guest health protocol version %d", health.ProtocolVersion)
	}
	return health, nil
}

type heartbeatGate struct {
	mu     sync.Mutex
	paused bool
}

func (gate *heartbeatGate) Pause() {
	gate.mu.Lock()
	gate.paused = true
	gate.mu.Unlock()
}

func (gate *heartbeatGate) Resume() {
	gate.mu.Lock()
	gate.paused = false
	gate.mu.Unlock()
}

type vmExecStreamController struct {
	instance    platform.Instance
	heartbeat   *heartbeatGate
	afterResume func(context.Context) error
}

func (controller *vmExecStreamController) Pause(ctx context.Context) error {
	controller.heartbeat.Pause()
	if err := controller.instance.Pause(ctx); err != nil {
		controller.heartbeat.Resume()
		return err
	}
	return nil
}

func (controller *vmExecStreamController) Resume(ctx context.Context) error {
	if err := controller.instance.Resume(ctx); err != nil {
		return err
	}
	if controller.afterResume != nil {
		if err := controller.afterResume(ctx); err != nil {
			return err
		}
	}
	controller.heartbeat.Resume()
	return nil
}

func monitorAgentHealth(ctx context.Context, connection io.ReadWriteCloser, codec *protocol.Codec, interval, timeout time.Duration, gate *heartbeatGate) error {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	var sequence uint64 = 1
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			gate.mu.Lock()
			if gate.paused {
				gate.mu.Unlock()
				continue
			}
			if _, err := checkAgentHealth(connection, codec, sequence, timeout); err != nil {
				gate.mu.Unlock()
				if ctx.Err() != nil {
					return nil
				}
				return err
			}
			sequence++
			gate.mu.Unlock()
		}
	}
}

func flushGuestState(codec *protocol.Codec) error {
	request, err := protocol.NewEnvelope("state-flush", "system", "state.flush", struct{}{})
	if err != nil {
		return err
	}
	if err := codec.Write(request); err != nil {
		return err
	}
	response, err := codec.Read()
	if err != nil {
		return err
	}
	if response.ID != request.ID {
		return fmt.Errorf("unexpected state flush response ID %q", response.ID)
	}
	if response.Type == "error" {
		return fmt.Errorf("guest rejected state flush: %s", response.Payload)
	}
	if response.Type != "state.flushed" {
		return fmt.Errorf("unexpected state flush response type %q", response.Type)
	}
	return nil
}

type bootstrapIdentity struct {
	UID               uint32               `json:"uid"`
	GID               uint32               `json:"gid"`
	FaultInjection    bool                 `json:"fault_injection,omitempty"`
	WorkspaceReadOnly bool                 `json:"workspace_read_only,omitempty"`
	NetworkMode       platform.NetworkMode `json:"network_mode"`
}

func prepareBootstrap(existingShare, secretFile string, faultInjection, workspaceReadOnly bool, networkMode platform.NetworkMode) (string, []byte, func(), error) {
	if networkMode != platform.NetworkOff && networkMode != platform.NetworkRestricted && networkMode != platform.NetworkUnrestricted {
		return "", nil, func() {}, fmt.Errorf("invalid bootstrap network mode %q", networkMode)
	}
	secret := make([]byte, 32)
	if secretFile != "" {
		data, err := os.ReadFile(secretFile)
		if err != nil {
			return "", nil, func() {}, err
		}
		if len(data) < 32 {
			return "", nil, func() {}, errors.New("RPC secret file must contain at least 32 bytes")
		}
		secret = data
	} else if existingShare != "" {
		data, err := os.ReadFile(filepath.Join(existingShare, "rpc-secret"))
		if err != nil {
			return "", nil, func() {}, err
		}
		secret = data
	} else if _, err := rand.Read(secret); err != nil {
		return "", nil, func() {}, fmt.Errorf("generate RPC secret: %w", err)
	}
	if len(secret) < 32 {
		return "", nil, func() {}, errors.New("RPC secret must contain at least 32 bytes")
	}
	if existingShare != "" {
		if faultInjection {
			return "", nil, func() {}, errors.New("agent crash injection requires an auto-generated bootstrap share")
		}
		identityData, err := os.ReadFile(filepath.Join(existingShare, "identity.json"))
		if err != nil {
			return "", nil, func() {}, fmt.Errorf("bootstrap identity: %w", err)
		}
		var identity bootstrapIdentity
		if err := json.Unmarshal(identityData, &identity); err != nil || identity.UID == 0 || identity.GID == 0 {
			return "", nil, func() {}, errors.New("bootstrap identity is invalid")
		}
		if identity.UID == reservedGuestProxyID || identity.GID == reservedGuestProxyID {
			return "", nil, func() {}, errors.New("bootstrap identity collides with reserved guest proxy identity")
		}
		if identity.WorkspaceReadOnly != workspaceReadOnly {
			return "", nil, func() {}, errors.New("bootstrap identity workspace policy does not match requested workspace mode")
		}
		if identity.NetworkMode != networkMode {
			return "", nil, func() {}, errors.New("bootstrap identity network policy does not match requested network mode")
		}
		return existingShare, secret, func() {}, nil
	}
	directory, err := os.MkdirTemp("", "zapvm-bootstrap-")
	if err != nil {
		return "", nil, func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(directory) }
	if err := os.WriteFile(filepath.Join(directory, "rpc-secret"), secret, 0o600); err != nil {
		cleanup()
		return "", nil, func() {}, err
	}
	uid, gid := currentHostIdentity()
	if uid == 0 || gid == 0 {
		uid, gid = 1000, 1000
	}
	if uid == reservedGuestProxyID || gid == reservedGuestProxyID {
		cleanup()
		return "", nil, func() {}, errors.New("Host UID/GID collides with reserved guest proxy identity 998")
	}
	identity, err := json.Marshal(bootstrapIdentity{
		UID: uid, GID: gid, FaultInjection: faultInjection,
		WorkspaceReadOnly: workspaceReadOnly, NetworkMode: networkMode,
	})
	if err != nil {
		cleanup()
		return "", nil, func() {}, err
	}
	if err := os.WriteFile(filepath.Join(directory, "identity.json"), identity, 0o600); err != nil {
		cleanup()
		return "", nil, func() {}, err
	}
	return directory, secret, cleanup, nil
}

func validateExecTimeout(timeout time.Duration) error {
	if timeout < time.Millisecond || timeout > 24*time.Hour {
		return errors.New("exec timeout must be between 1ms and 24h")
	}
	return nil
}

func validateAgentStartTimeout(timeout time.Duration) error {
	if timeout < time.Second || timeout > 5*time.Minute {
		return errors.New("agent start timeout must be between 1s and 5m")
	}
	return nil
}

func executeGuest(codec *protocol.Codec, argv []string, networkMode platform.NetworkMode, sessionID string, timeout time.Duration, credentials map[string][]byte) error {
	return executeGuestTo(codec, "cli-exec", argv, ".", networkMode, sessionID, timeout, credentials, nil, nil, os.Stdout, os.Stderr, nil)
}

type guestCommandExitError struct{ Code int }

func (err *guestCommandExitError) Error() string {
	return fmt.Sprintf("guest command exited with code %d", err.Code)
}

func executeGuestTo(codec *protocol.Codec, requestID string, argv []string, cwd string, networkMode platform.NetworkMode, sessionID string, timeout time.Duration, credentials map[string][]byte, protectedWorkspacePaths, deniedWorkspacePatterns []string, stdout, stderr io.Writer, onStarted func(agent.ExecStarted) error) error {
	environment := map[string]string{}
	if networkMode == platform.NetworkRestricted {
		for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"} {
			environment[key] = "http://127.0.0.1:3128"
		}
		environment["NO_PROXY"] = "localhost,127.0.0.1,::1"
		environment["no_proxy"] = environment["NO_PROXY"]
	}
	request, err := protocol.NewEnvelope(requestID, sessionID, "exec.start", agent.ExecStart{
		Argv: argv, Cwd: cwd, Env: environment, Credentials: credentials,
		ProtectedWorkspacePaths: protectedWorkspacePaths, DeniedWorkspacePatterns: deniedWorkspacePatterns,
		TimeoutMillis: uint64(timeout.Milliseconds()),
	})
	if err != nil {
		return err
	}
	if err := codec.Write(request); err != nil {
		credential.ZeroBytes(request.Payload)
		return err
	}
	credential.ZeroBytes(request.Payload)
	for {
		response, err := codec.Read()
		if err != nil {
			return err
		}
		switch response.Type {
		case "exec.started":
			var started agent.ExecStarted
			if err := json.Unmarshal(response.Payload, &started); err != nil || started.PID <= 0 {
				return errors.New("guest returned an invalid exec.started payload")
			}
			if onStarted != nil {
				if err := onStarted(started); err != nil {
					return err
				}
			}
		case "exec.stdout", "exec.stderr":
			var output agent.ExecOutput
			if err := json.Unmarshal(response.Payload, &output); err != nil {
				return err
			}
			writer := stdout
			if response.Type == "exec.stderr" {
				writer = stderr
			}
			if _, err := writer.Write(output.Data); err != nil {
				return err
			}
		case "exec.exit":
			var exit agent.ExecExit
			if err := json.Unmarshal(response.Payload, &exit); err != nil {
				return err
			}
			if exit.Code != 0 {
				return &guestCommandExitError{Code: exit.Code}
			}
			return nil
		case "error":
			var message agent.ErrorMessage
			if err := json.Unmarshal(response.Payload, &message); err != nil {
				return err
			}
			return errors.New(message.Message)
		default:
			return fmt.Errorf("unexpected guest response %q", response.Type)
		}
	}
}

func credentialIDs(broker *credential.Broker) []string {
	if broker == nil {
		return nil
	}
	return broker.IDs()
}
