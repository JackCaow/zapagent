package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
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
	"sync"
	"syscall"
	"time"

	"zapvm/internal/agentpackage"
	"zapvm/internal/artifactcollector"
	"zapvm/internal/computer"
	"zapvm/internal/credential"
	"zapvm/internal/daemonconfig"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/egress"
	"zapvm/internal/hostpolicy"
	"zapvm/internal/hostpower"
	vmimage "zapvm/internal/image"
	"zapvm/internal/localipc"
	"zapvm/internal/platform"
	"zapvm/internal/state"
	"zapvm/internal/task"
	"zapvm/internal/vmpool"
)

type daemonImageConfig struct {
	root          string
	publicKey     string
	allowUnsigned bool
	activeVersion string
	activeGen     uint64
	kernel        string
	initrd        string
	rootDisk      string
	stateTemplate string
	stateSchema   int
	protocol      int
	agentAdapter  string
	digest        string
}

type daemonPolicy struct {
	domains []string
	ports   []uint16
}

type daemonServer struct {
	ctx                 context.Context
	cancel              context.CancelFunc
	pool                *vmpool.Pool
	computers           *computer.Store
	taskStore           *task.Store
	artifactCollector   *artifactcollector.Collector
	imageMu             sync.Mutex
	image               daemonImageConfig
	agentRoot           string
	agentPublicKey      string
	stateRoot           string
	executable          string
	credentials         *credential.Broker
	credentialDigest    string
	cpuCount            uint
	memoryBytes         uint64
	stopTimeout         time.Duration
	policiesMu          sync.Mutex
	policies            map[string]daemonPolicy
	powerMu             sync.Mutex
	powerOwnsPause      bool
	powerLog            io.Writer
	taskLog             io.Writer
	taskLifecycleMu     sync.Mutex
	taskAdmissionClosed bool
	taskWG              sync.WaitGroup
	taskRuns            map[string]context.CancelCauseFunc
	taskNotifyMu        sync.Mutex
	taskNotify          map[string]chan struct{}
}

func runDaemon(args []string) error {
	if len(args) == 0 {
		return errors.New("daemon requires run, serve, exec, status, pause, resume, or stop")
	}
	switch args[0] {
	case "run":
		return runDaemonConfigured(args[1:])
	case "service-run":
		return runDaemonService(args[1:])
	case "serve":
		return runDaemonServe(args[1:])
	case "exec":
		return runDaemonExec(args[1:])
	case "status":
		return runDaemonStatus(args[1:])
	case "pause":
		return runDaemonPause(args[1:])
	case "resume":
		return runDaemonResume(args[1:])
	case "stop":
		return runDaemonStop(args[1:])
	default:
		return fmt.Errorf("unknown daemon command %q", args[0])
	}
}

func runDaemonConfigured(args []string) error {
	flags := flag.NewFlagSet("daemon run", flag.ContinueOnError)
	configPath := flags.String("config", "", "owner-only daemon JSON configuration")
	validateOnly := flags.Bool("validate", false, "validate config, signed image, and credential bindings without starting")
	printEndpoint := flags.Bool("print-endpoint", false, "print the validated configured daemon endpoint without starting")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *configPath == "" {
		return errors.New("daemon run requires --config and accepts no positional arguments")
	}
	config, err := daemonconfig.Load(*configPath)
	if err != nil {
		return err
	}
	if *printEndpoint {
		if *validateOnly {
			return errors.New("daemon run accepts only one of --validate or --print-endpoint")
		}
		fmt.Fprintln(os.Stdout, config.Endpoint)
		return nil
	}
	if !*validateOnly {
		return runDaemonServe(config.ServeArguments())
	}
	image, err := loadDaemonImage(config.ImageRoot, config.ImagePublicKey, false, "", "", "", "")
	if err != nil {
		return err
	}
	if config.AgentRoot != "" {
		if image.agentAdapter == "" {
			return errors.New("configured Runtime image does not declare a pluggable Resident Agent adapter contract")
		}
		installed, err := agentpackage.ValidateRegistry(config.AgentRoot, config.AgentPublicKey, runtime.GOOS, runtime.GOARCH)
		if err != nil {
			return fmt.Errorf("validate Agent registry: %w", err)
		}
		for _, candidate := range installed {
			if _, err := agentpackage.Resolve(config.AgentRoot, candidate.Reference, config.AgentPublicKey, runtime.GOOS, runtime.GOARCH, image.agentContract()); err != nil {
				return fmt.Errorf("validate Agent %s: %w", candidate.Reference, err)
			}
		}
	}
	bindings := make([]string, 0, len(config.Credentials))
	for _, binding := range config.Credentials {
		bindings = append(bindings, binding.ID+"="+binding.Path)
	}
	broker, err := credential.Load(bindings)
	if err != nil {
		return err
	}
	defer broker.Close()
	fmt.Fprintf(os.Stdout, "schema=1 image_digest=%s agent_registry=%t credentials=%d\n", image.digest, config.AgentRoot != "", len(bindings))
	return nil
}

func runDaemonServe(args []string) error {
	flags := flag.NewFlagSet("daemon serve", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "owner-only Unix socket or per-user Windows named pipe")
	defaultImageRoot, defaultImagePublicKey := configuredImageDefaults()
	imageRoot := flags.String("image-root", defaultImageRoot, "absolute installed image root containing active.json")
	imagePublicKey := flags.String("image-public-key", defaultImagePublicKey, "trusted Ed25519 image manifest public key")
	defaultAgentRoot, defaultAgentPublicKey := agentDefaults()
	agentRoot := flags.String("agent-root", defaultAgentRoot, "absolute installed Agent registry root")
	agentPublicKey := flags.String("agent-public-key", defaultAgentPublicKey, "trusted Ed25519 Agent signing public key")
	allowUnsigned := flags.Bool("allow-unsigned-image", false, "development only: use explicit unverified image paths")
	kernel := flags.String("kernel", "", "development kernel path")
	initrd := flags.String("initrd", "", "development initrd path")
	rootDisk := flags.String("root-disk", "", "development root disk path")
	stateTemplate := flags.String("state-template", "", "development state disk template")
	stateRoot := flags.String("state-root", "", "owner-only directory for daemon-managed per-route state disks")
	maxWorkers := flags.Int("max-workers", 4, "maximum VMs owned by this daemon")
	maxPerWorkspace := flags.Int("max-per-workspace", 2, "maximum route variants per workspace")
	idleTimeout := flags.Duration("idle-timeout", time.Hour, "idle VM stop timeout")
	stopTimeout := flags.Duration("stop-timeout", 15*time.Second, "worker stop timeout")
	taskRetention := flags.Duration("task-retention", 0, "delete terminal Task journals older than this duration; 0 disables automatic GC")
	taskGCInterval := flags.Duration("task-gc-interval", time.Hour, "automatic Task journal GC interval")
	cpus := flags.Uint("cpus", 2, "vCPUs per pooled VM")
	memoryMiB := flags.Uint64("memory-mib", 2048, "memory MiB per pooled VM")
	var credentialBindings []string
	flags.Func("credential", "authorize id=/absolute/path for all daemon workers; repeatable", func(value string) error {
		credentialBindings = append(credentialBindings, value)
		return nil
	})
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("daemon serve does not accept positional arguments")
	}
	if *cpus < 1 || *cpus > 256 {
		return errors.New("daemon CPU count must be between 1 and 256")
	}
	if *memoryMiB < 256 || *memoryMiB > 1024*1024 {
		return errors.New("daemon memory must be between 256 MiB and 1 TiB")
	}
	if *taskRetention < 0 || *taskRetention > 10*365*24*time.Hour || (*taskRetention > 0 && *taskRetention < time.Minute) {
		return errors.New("task retention must be 0 or between 1 minute and 10 years")
	}
	if *taskRetention > 0 && (*taskGCInterval < time.Minute || *taskGCInterval > 24*time.Hour) {
		return errors.New("task GC interval must be between 1 minute and 24 hours")
	}
	var err error
	if *endpoint == "" {
		*endpoint, err = localipc.DefaultEndpoint()
		if err != nil {
			return err
		}
	}
	if *stateRoot == "" {
		cache, cacheErr := os.UserCacheDir()
		if cacheErr != nil {
			return cacheErr
		}
		*stateRoot = filepath.Join(cache, "zapvm", "daemon-state")
	}
	if *stateRoot, err = filepath.Abs(*stateRoot); err != nil {
		return err
	}
	if *agentRoot, *agentPublicKey, err = absoluteAgentPaths(*agentRoot, *agentPublicKey); err != nil {
		return err
	}
	if (*agentRoot == "") != (*agentPublicKey == "") {
		return errors.New("daemon Agent registry requires both --agent-root and --agent-public-key")
	}
	if err := prepareDaemonStateRoot(*stateRoot); err != nil {
		return err
	}
	computerStore, err := computer.Open(filepath.Join(*stateRoot, "computers"))
	if err != nil {
		return err
	}
	taskStore, err := task.Open(filepath.Join(*stateRoot, "tasks"))
	if err != nil {
		return err
	}
	artifactCollector, err := artifactcollector.Open(filepath.Join(*stateRoot, "artifact-spool"), artifactcollector.Options{})
	if err != nil {
		return err
	}
	recoveredTasks, err := taskStore.RecoverInterrupted()
	if err != nil {
		return err
	}
	if len(recoveredTasks) != 0 {
		fmt.Fprintf(os.Stderr, "zapVM daemon recovered %d interrupted Agent Computer task(s)\n", len(recoveredTasks))
	}
	if *taskRetention > 0 {
		removed, pruneErr := taskStore.Prune(time.Now().UTC().Add(-*taskRetention), automaticTaskPruneLimit)
		if pruneErr != nil {
			return pruneErr
		}
		if len(removed) != 0 {
			fmt.Fprintf(os.Stderr, "zapVM daemon pruned %d expired Agent Computer task(s)\n", len(removed))
		}
	}
	image, err := loadDaemonImage(*imageRoot, *imagePublicKey, *allowUnsigned, *kernel, *initrd, *rootDisk, *stateTemplate)
	if err != nil {
		return err
	}
	if *agentRoot != "" && image.agentAdapter == "" {
		return errors.New("configured Runtime image does not declare a pluggable Resident Agent adapter contract")
	}
	credentialBroker, err := credential.Load(credentialBindings)
	if err != nil {
		return err
	}
	defer credentialBroker.Close()
	credentialDigest := ""
	if len(credentialBindings) > 0 {
		credentialDigest, err = credentialBroker.ScopeDigest()
		if err != nil {
			return err
		}
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	signalCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	serverCtx, cancel := context.WithCancel(signalCtx)
	defer cancel()
	server := &daemonServer{
		ctx: serverCtx, cancel: cancel, image: image, stateRoot: *stateRoot, executable: executable,
		agentRoot: *agentRoot, agentPublicKey: *agentPublicKey,
		computers:         computerStore,
		taskStore:         taskStore,
		artifactCollector: artifactCollector,
		credentials:       credentialBroker, credentialDigest: credentialDigest,
		cpuCount: *cpus, memoryBytes: *memoryMiB * platform.MiB,
		stopTimeout: *stopTimeout, policies: make(map[string]daemonPolicy), taskLog: os.Stderr,
		taskRuns: make(map[string]context.CancelCauseFunc), taskNotify: make(map[string]chan struct{}),
	}
	pool, err := vmpool.New(vmpool.Options{
		MaxWorkers: *maxWorkers, MaxPerWorkspace: *maxPerWorkspace,
		IdleTimeout: *idleTimeout, StopTimeout: *stopTimeout,
	}, server.startWorker)
	if err != nil {
		return err
	}
	server.pool = pool
	go server.monitorHostPower()
	listener, err := localipc.ListenRecovering(*endpoint)
	if err != nil {
		return err
	}
	defer listener.Close()
	go server.sweepIdle(*idleTimeout)
	go server.sweepArtifactCapabilities(time.Minute)
	if *taskRetention > 0 {
		go server.sweepComputerTasks(*taskRetention, *taskGCInterval)
	}
	fmt.Fprintf(os.Stderr, "zapVM daemon listening on %s\n", *endpoint)
	serveErr := server.serve(listener)
	server.closeTaskAdmission()
	server.cancel()
	server.taskWG.Wait()
	closeCtx, closeCancel := context.WithTimeout(context.Background(), *stopTimeout)
	closeErr := pool.Close(closeCtx)
	closeCancel()
	return errors.Join(serveErr, closeErr)
}

func (server *daemonServer) monitorHostPower() {
	err := hostpower.Monitor(server.ctx, server.hostPowerHandlers())
	if err != nil && server.ctx.Err() == nil {
		fmt.Fprintln(os.Stderr, "zapVM daemon Host power monitor unavailable:", err)
	}
}

func (server *daemonServer) hostPowerHandlers() hostpower.Handlers {
	powerLog := server.powerLog
	if powerLog == nil {
		powerLog = os.Stderr
	}
	return hostpower.Handlers{
		Suspend: func(context.Context) error {
			server.powerMu.Lock()
			defer server.powerMu.Unlock()
			if server.powerOwnsPause {
				return nil
			}
			timeout := 4 * time.Second
			if runtime.GOOS == "windows" {
				timeout = 1500 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			owned, err := server.pool.Suspend(ctx)
			cancel()
			server.powerOwnsPause = owned
			if err == nil {
				fmt.Fprintf(powerLog, "zapVM daemon Host suspend completed ownership=%t\n", owned)
			}
			return err
		},
		Resume: func(context.Context) error {
			server.powerMu.Lock()
			defer server.powerMu.Unlock()
			if !server.powerOwnsPause {
				return nil
			}
			ctx, cancel := context.WithTimeout(context.Background(), server.stopTimeout)
			err := server.pool.Resume(ctx)
			cancel()
			if err == nil {
				server.powerOwnsPause = false
				fmt.Fprintln(powerLog, "zapVM daemon Host resume completed")
			}
			return err
		},
		Report: func(err error) {
			fmt.Fprintln(os.Stderr, "zapVM daemon Host power event:", err)
		},
	}
}

func (server *daemonServer) serve(listener net.Listener) error {
	go func() {
		<-server.ctx.Done()
		_ = listener.Close()
	}()
	semaphore := make(chan struct{}, 64)
	var wait sync.WaitGroup
	defer wait.Wait()
	for {
		connection, err := listener.Accept()
		if err != nil {
			if server.ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		select {
		case semaphore <- struct{}{}:
			wait.Add(1)
			go func() {
				defer wait.Done()
				defer func() { <-semaphore }()
				server.handle(connection)
			}()
		default:
			_ = connection.Close()
		}
	}
}

func (server *daemonServer) handle(connection net.Conn) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
	codec := daemonrpc.NewCodec(connection, connection)
	envelope, err := codec.Read()
	if err != nil {
		return
	}
	_ = connection.SetDeadline(time.Time{})
	writeError := func(err error) {
		response, envelopeErr := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeError, daemonrpc.Error{Message: err.Error()})
		if envelopeErr == nil {
			_ = codec.Write(response)
		}
	}
	switch envelope.Type {
	case daemonrpc.TypePing:
		if err := daemonrpc.DecodeEmpty(envelope.Payload); err != nil {
			writeError(err)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypePong, daemonrpc.Empty{})
		_ = codec.Write(response)
	case daemonrpc.TypeStatus:
		if err := daemonrpc.DecodeEmpty(envelope.Payload); err != nil {
			writeError(err)
			return
		}
		stats := server.pool.Stats()
		status := daemonrpc.Status{
			Version: version, ImageDigest: server.image.digest,
			Workers: stats.Workers, Starting: stats.Starting, Stopping: stats.Stopping,
			Leases: stats.Leases, Degraded: stats.Degraded, Paused: stats.Paused, RouteIDs: server.pool.Keys(),
			StartAttempts: stats.StartAttempts, StartFailures: stats.StartFailures,
			StartDurationMillisTotal: stats.StartDurationMillisTotal, StartDurationMillisMax: stats.StartDurationMillisMax,
		}
		if computers, err := server.listComputers(); err == nil && len(computers) <= daemonrpc.MaxComputerRuntimes {
			status.ComputerRuntimes = make([]daemonrpc.ComputerRuntime, 0, len(computers))
			for _, computer := range computers {
				status.ComputerRuntimes = append(status.ComputerRuntimes, daemonrpc.ComputerRuntime{ID: computer.ID, State: computer.RuntimeState})
			}
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeStatus, status)
		_ = codec.Write(response)
	case daemonrpc.TypeComputerCreate:
		request, err := daemonrpc.DecodeComputerCreate(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		created, err := server.createComputer(request.Computer)
		if err != nil {
			writeError(err)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputer, created)
		_ = codec.Write(response)
	case daemonrpc.TypeComputerList:
		if err := daemonrpc.DecodeEmpty(envelope.Payload); err != nil {
			writeError(err)
			return
		}
		computers, err := server.listComputers()
		if err != nil {
			writeError(err)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputers, daemonrpc.ComputerList{Computers: computers})
		_ = codec.Write(response)
	case daemonrpc.TypeComputerInspect:
		request, err := daemonrpc.DecodeComputerReference(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		current, err := server.inspectComputer(request.ID)
		if err != nil {
			writeError(err)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputer, current)
		_ = codec.Write(response)
	case daemonrpc.TypeComputerStart:
		request, err := daemonrpc.DecodeComputerReference(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		current, err := server.startComputer(server.ctx, request.ID)
		if err != nil {
			writeError(err)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputer, current)
		_ = codec.Write(response)
	case daemonrpc.TypeComputerStop:
		request, err := daemonrpc.DecodeComputerReference(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		if _, err := server.inspectComputer(request.ID); err != nil {
			writeError(err)
			return
		}
		stopCtx, stopCancel := context.WithTimeout(context.Background(), server.stopTimeout)
		stopErr := server.pool.StopComputer(stopCtx, request.ID)
		stopCancel()
		if stopErr != nil {
			writeError(stopErr)
			return
		}
		current, err := server.inspectComputer(request.ID)
		if err != nil {
			writeError(err)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerStopped, current)
		_ = codec.Write(response)
	case daemonrpc.TypeComputerWorkspaceList:
		request, err := daemonrpc.DecodeComputerWorkspaceRequest(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		listing, err := server.listComputerWorkspace(request)
		if err != nil {
			writeError(err)
			return
		}
		response, err := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeWorkspaceListing, listing)
		if err != nil {
			writeError(err)
			return
		}
		_ = codec.Write(response)
	case daemonrpc.TypeComputerWorkspaceRead:
		request, err := daemonrpc.DecodeComputerWorkspaceRequest(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		file, err := server.readComputerWorkspace(request)
		if err != nil {
			writeError(err)
			return
		}
		response, err := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeWorkspaceFile, file)
		if err != nil {
			writeError(err)
			return
		}
		_ = codec.Write(response)
	case daemonrpc.TypeComputerWorkspaceDiff:
		request, err := daemonrpc.DecodeComputerWorkspaceRequest(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		diff, err := server.diffComputerWorkspace(server.ctx, request)
		if err != nil {
			writeError(err)
			return
		}
		response, err := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeWorkspaceDiff, diff)
		if err != nil {
			writeError(err)
			return
		}
		_ = codec.Write(response)
	case daemonrpc.TypeComputerGitPush:
		request, err := daemonrpc.DecodeComputerGitPush(envelope.Payload)
		credential.ZeroBytes(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		result, err := server.pushComputerGit(server.ctx, request)
		if err != nil {
			writeError(err)
			return
		}
		response, err := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeGitPushResult, result)
		if err != nil {
			writeError(err)
			return
		}
		_ = codec.Write(response)
	case daemonrpc.TypeComputerArtifactCollect:
		request, err := daemonrpc.DecodeComputerArtifactCollect(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		collection, err := server.collectComputerArtifacts(request)
		if err != nil {
			writeError(err)
			return
		}
		response, err := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeArtifactCollection, collection)
		if err != nil {
			writeError(err)
			return
		}
		_ = codec.Write(response)
	case daemonrpc.TypeComputerArtifactOpen:
		request, err := daemonrpc.DecodeComputerArtifactOpen(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		if err := server.streamComputerArtifact(codec, envelope.ID, request); err != nil {
			writeError(err)
		}
	case daemonrpc.TypeComputerExec:
		request, err := daemonrpc.DecodeComputerExec(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		if server.computers == nil {
			writeError(errors.New("Agent Computer store is unavailable"))
			return
		}
		record, err := server.computers.Get(request.ID)
		if err != nil {
			writeError(err)
			return
		}
		execRequest := daemonrpc.ExecRequest{
			ComputerID: record.ID, Workspace: record.Workspace, WorkspaceReadOnly: record.WorkspaceReadOnly,
			Network: record.Network, AllowedDomains: record.AllowedDomains, AllowedPorts: record.AllowedPorts,
			Command: request.Command,
		}
		if err := server.handleExec(connection, codec, envelope.ID, execRequest); err != nil {
			writeError(err)
		}
	case daemonrpc.TypeComputerTaskSubmit:
		request, err := daemonrpc.DecodeComputerTaskSubmit(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		created, err := server.submitComputerTask(request)
		if err != nil {
			writeError(err)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTask, created)
		_ = codec.Write(response)
	case daemonrpc.TypeComputerTaskSubmitCredentialed:
		request, err := daemonrpc.DecodeComputerTaskCredentialSubmit(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		defer credential.ZeroValues(request.Values)
		created, err := server.submitCredentialedComputerTask(request)
		if err != nil {
			writeError(err)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTask, created)
		_ = codec.Write(response)
	case daemonrpc.TypeComputerTaskList:
		request, err := daemonrpc.DecodeComputerTaskList(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		tasks, err := server.listComputerTasks(request.ComputerID)
		if err != nil {
			writeError(err)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTasks, daemonrpc.ComputerTaskList{Tasks: tasks})
		_ = codec.Write(response)
	case daemonrpc.TypeComputerTaskInspect:
		request, err := daemonrpc.DecodeComputerTaskReference(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		current, err := server.inspectComputerTask(request.ID)
		if err != nil {
			writeError(err)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTask, current)
		_ = codec.Write(response)
	case daemonrpc.TypeComputerTaskAttach:
		request, err := daemonrpc.DecodeComputerTaskAttach(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		if err := server.handleComputerTaskAttach(connection, codec, envelope.ID, request); err != nil {
			writeError(err)
		}
	case daemonrpc.TypeComputerTaskCancel:
		request, err := daemonrpc.DecodeComputerTaskReference(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		current, err := server.cancelComputerTask(request.ID)
		if err != nil {
			writeError(err)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTask, current)
		_ = codec.Write(response)
	case daemonrpc.TypeComputerTaskRetry:
		request, err := daemonrpc.DecodeComputerTaskRetry(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		created, err := server.retryComputerTask(request)
		if err != nil {
			writeError(err)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTask, created)
		_ = codec.Write(response)
	case daemonrpc.TypeComputerTaskPrune:
		request, err := daemonrpc.DecodeComputerTaskPrune(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		retention := time.Duration(request.RetentionMillis) * time.Millisecond
		removed, err := server.pruneComputerTasks(retention, request.Limit)
		if err != nil {
			writeError(err)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTasksPruned, removed)
		_ = codec.Write(response)
	case daemonrpc.TypePause:
		if err := daemonrpc.DecodeEmpty(envelope.Payload); err != nil {
			writeError(err)
			return
		}
		pauseCtx, pauseCancel := context.WithTimeout(context.Background(), server.stopTimeout)
		pauseErr := server.pool.Pause(pauseCtx)
		pauseCancel()
		if pauseErr != nil {
			writeError(pauseErr)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypePaused, daemonrpc.Empty{})
		_ = codec.Write(response)
	case daemonrpc.TypeResume:
		if err := daemonrpc.DecodeEmpty(envelope.Payload); err != nil {
			writeError(err)
			return
		}
		resumeCtx, resumeCancel := context.WithTimeout(context.Background(), server.stopTimeout)
		resumeErr := server.pool.Resume(resumeCtx)
		resumeCancel()
		if resumeErr != nil {
			writeError(resumeErr)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeResumed, daemonrpc.Empty{})
		_ = codec.Write(response)
	case daemonrpc.TypeShutdown:
		if err := daemonrpc.DecodeEmpty(envelope.Payload); err != nil {
			writeError(err)
			return
		}
		server.closeTaskAdmission()
		server.cancel()
		server.taskWG.Wait()
		closeCtx, closeCancel := context.WithTimeout(context.Background(), server.stopTimeout)
		closeErr := server.pool.Close(closeCtx)
		closeCancel()
		if closeErr != nil {
			writeError(closeErr)
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeStopped, daemonrpc.Empty{})
		_ = codec.Write(response)
	case daemonrpc.TypeExec, daemonrpc.TypeExecSealed:
		request, err := daemonrpc.DecodeExec(envelope.Payload)
		if err != nil {
			writeError(err)
			return
		}
		if envelope.Type == daemonrpc.TypeExecSealed {
			request.Command.RequireProcessSeal = true
		} else if request.Command.RequireProcessSeal {
			writeError(errors.New("sealed execution requires exec.sealed.v1"))
			return
		}
		if err := server.handleExec(connection, codec, envelope.ID, request); err != nil {
			writeError(err)
		}
	default:
		writeError(fmt.Errorf("unsupported daemon request type %q", envelope.Type))
	}
}

func (server *daemonServer) createComputer(spec daemonrpc.ComputerSpec) (daemonrpc.ComputerSpec, error) {
	if server.computers == nil {
		return daemonrpc.ComputerSpec{}, errors.New("Agent Computer store is unavailable")
	}
	workspace, err := hostpolicy.ValidateWorkspace(spec.Workspace)
	if err != nil {
		return daemonrpc.ComputerSpec{}, err
	}
	spec.Workspace = workspace
	if spec.CPUCount == 0 {
		spec.CPUCount = server.cpuCount
	}
	if spec.MemoryMiB == 0 {
		spec.MemoryMiB = server.memoryBytes / platform.MiB
	}
	if err := spec.Validate(false); err != nil {
		return daemonrpc.ComputerSpec{}, err
	}
	if spec.Agent != "" {
		if server.agentRoot == "" || server.agentPublicKey == "" {
			return daemonrpc.ComputerSpec{}, errors.New("daemon has no trusted pluggable Agent registry")
		}
		image, err := server.currentImage()
		if err != nil {
			return daemonrpc.ComputerSpec{}, err
		}
		if _, err := agentpackage.Resolve(server.agentRoot, spec.Agent, server.agentPublicKey, runtime.GOOS, runtime.GOARCH, image.agentContract()); err != nil {
			return daemonrpc.ComputerSpec{}, fmt.Errorf("resolve Computer Agent: %w", err)
		}
	}
	_, policy, err := normalizeDaemonPolicy(daemonrpc.ExecRequest{
		Network: spec.Network, AllowedDomains: spec.AllowedDomains, AllowedPorts: spec.AllowedPorts,
	})
	if err != nil {
		return daemonrpc.ComputerSpec{}, err
	}
	if spec.Network == platform.NetworkRestricted {
		spec.AllowedDomains = policy.domains
		spec.AllowedPorts = policy.ports
	}
	record, err := server.computers.Create(computer.Record{
		ID: spec.ID, Agent: spec.Agent, Workspace: spec.Workspace, WorkspaceReadOnly: spec.WorkspaceReadOnly,
		Network: spec.Network, AllowedDomains: spec.AllowedDomains, AllowedPorts: spec.AllowedPorts,
		CPUCount: spec.CPUCount, MemoryMiB: spec.MemoryMiB,
	})
	if err != nil {
		return daemonrpc.ComputerSpec{}, err
	}
	return server.computerSpec(record), nil
}

func (server *daemonServer) inspectComputer(id string) (daemonrpc.ComputerSpec, error) {
	if server.computers == nil {
		return daemonrpc.ComputerSpec{}, errors.New("Agent Computer store is unavailable")
	}
	record, err := server.computers.Get(id)
	if err != nil {
		return daemonrpc.ComputerSpec{}, err
	}
	return server.computerSpec(record), nil
}

func (server *daemonServer) listComputers() ([]daemonrpc.ComputerSpec, error) {
	if server.computers == nil {
		return nil, errors.New("Agent Computer store is unavailable")
	}
	records, err := server.computers.List()
	if err != nil {
		return nil, err
	}
	result := make([]daemonrpc.ComputerSpec, 0, len(records))
	for _, record := range records {
		result = append(result, server.computerSpec(record))
	}
	return result, nil
}

func (server *daemonServer) computerSpec(record computer.Record) daemonrpc.ComputerSpec {
	state := vmpool.ComputerStopped
	if server.pool != nil {
		state = server.pool.ComputerStatus(record.ID)
	}
	return daemonrpc.ComputerSpec{
		ID: record.ID, Agent: record.Agent, Workspace: record.Workspace, WorkspaceReadOnly: record.WorkspaceReadOnly,
		Network: record.Network, AllowedDomains: append([]string(nil), record.AllowedDomains...),
		AllowedPorts: append([]uint16(nil), record.AllowedPorts...), CPUCount: record.CPUCount,
		MemoryMiB: record.MemoryMiB, CreatedAt: record.CreatedAt, RuntimeState: state,
	}
}

func (server *daemonServer) handleExec(connection net.Conn, codec *daemonrpc.Codec, requestID string, request daemonrpc.ExecRequest) error {
	execCtx, cancel := context.WithCancel(server.ctx)
	defer cancel()
	go func() {
		var extra [1]byte
		_, _ = connection.Read(extra[:])
		cancel()
	}()
	return server.executeDaemonRequest(execCtx, request, func() error {
		accepted, _ := daemonrpc.NewEnvelope(requestID, daemonrpc.TypeAccepted, daemonrpc.Empty{})
		return codec.Write(accepted)
	}, func(event daemonrpc.Event) error {
		response, err := daemonrpc.NewEnvelope(requestID, daemonrpc.TypeEvent, event)
		if err != nil {
			return err
		}
		return codec.Write(response)
	})
}

func (server *daemonServer) startWorker(ctx context.Context, route vmpool.Route) (vmpool.Worker, error) {
	// Starting a new VM is the security boundary where every signed artifact is
	// verified again. Warm task admission only checks the small activation
	// pointer so it does not hash a multi-gigabyte image on every turn.
	image, err := server.verifyCurrentImage()
	if err != nil {
		return nil, err
	}
	if image.digest != route.ImageDigest {
		return nil, errors.New("active image changed during daemon route acquisition; retry request")
	}
	if route.AgentReference != "" {
		selectedAgent, err := agentpackage.Resolve(server.agentRoot, route.AgentReference, server.agentPublicKey, runtime.GOOS, runtime.GOARCH, image.agentContract())
		if err != nil {
			return nil, fmt.Errorf("verify Computer Agent: %w", err)
		}
		if selectedAgent.Digest != route.AgentDigest {
			return nil, errors.New("Computer Agent changed during daemon route acquisition; retry request")
		}
	}
	format, suffix := "raw", ".raw"
	if runtime.GOOS == "windows" {
		format, suffix = "vhdx", ".vhdx"
	}
	stateDisk := filepath.Join(server.stateRoot, route.StateDigest+suffix)
	if _, err := os.Lstat(stateDisk); errors.Is(err, os.ErrNotExist) {
		var createErr error
		if format == "raw" {
			createErr = state.CreateFromTemplateSchemaCapacity(image.stateTemplate, stateDisk, format, image.stateSchema, state.DefaultComputerBytes)
		} else {
			createErr = state.CreateFromTemplateSchema(image.stateTemplate, stateDisk, format, image.stateSchema)
		}
		if createErr != nil {
			return nil, createErr
		}
	} else if err != nil {
		return nil, err
	} else if _, err := state.Inspect(stateDisk); err != nil {
		return nil, err
	}
	arguments := []string{
		"run", "--id", "daemon-" + route.StateDigest[:16], "--state-disk", stateDisk,
		// Keep the virtio console device attached. Besides preserving pre-Agent
		// boot evidence, this is the Linux boot shape validated on nested-KVM
		// hosts. Worker stdout remains protocol-only because runVM routes this
		// console to stderr whenever --serve-stdio is active.
		"--workspace", route.Workspace, "--network", string(route.Network), "--console=true",
		"--serve-stdio", "--idle-timeout=24h", "--cpus", strconv.FormatUint(uint64(route.CPUCount), 10),
		"--memory-mib", strconv.FormatUint(route.MemoryBytes/platform.MiB, 10),
	}
	if image.allowUnsigned {
		arguments = append(arguments, "--allow-unsigned-image", "--kernel", image.kernel, "--initrd", image.initrd, "--root-disk", image.rootDisk)
	} else {
		arguments = append(arguments, "--image-root", image.root, "--image-public-key", image.publicKey)
	}
	if route.AgentReference != "" {
		arguments = append(arguments, "--agent", route.AgentReference, "--agent-root", server.agentRoot, "--agent-public-key", server.agentPublicKey)
	}
	if route.WorkspaceReadOnly {
		arguments = append(arguments, "--workspace-read-only")
	}
	if route.Network == platform.NetworkRestricted {
		server.policiesMu.Lock()
		policy, exists := server.policies[route.NetworkPolicyDigest]
		server.policiesMu.Unlock()
		if !exists {
			return nil, errors.New("daemon route lost its restricted network policy")
		}
		for _, domain := range policy.domains {
			arguments = append(arguments, "--allow-domain", domain)
		}
		for _, port := range policy.ports {
			arguments = append(arguments, "--allow-port", strconv.FormatUint(uint64(port), 10))
		}
	}
	snapshotBindings, cleanup, err := server.materializeCredentials()
	if err != nil {
		return nil, err
	}
	defer cleanup()
	for _, binding := range snapshotBindings {
		arguments = append(arguments, "--credential", binding)
	}
	return startDaemonStdioWorker(ctx, server.executable, arguments, os.Stderr)
}

func (server *daemonServer) currentImage() (daemonImageConfig, error) {
	server.imageMu.Lock()
	defer server.imageMu.Unlock()
	if server.image.allowUnsigned {
		return server.image, nil
	}
	activation, err := vmimage.ReadActivation(server.image.root)
	if err != nil {
		return daemonImageConfig{}, err
	}
	if activation.ActiveVersion == server.image.activeVersion && activation.Generation == server.image.activeGen {
		return server.image, nil
	}
	return server.reloadCurrentImageLocked()
}

func (server *daemonServer) verifyCurrentImage() (daemonImageConfig, error) {
	server.imageMu.Lock()
	defer server.imageMu.Unlock()
	if server.image.allowUnsigned {
		return server.image, nil
	}
	return server.reloadCurrentImageLocked()
}

func (server *daemonServer) reloadCurrentImageLocked() (daemonImageConfig, error) {
	loaded, err := loadDaemonImage(server.image.root, server.image.publicKey, false, "", "", "", "")
	if err != nil {
		return daemonImageConfig{}, err
	}
	server.image = loaded
	return loaded, nil
}

func (server *daemonServer) materializeCredentials() ([]string, func(), error) {
	ids := server.credentials.IDs()
	if len(ids) == 0 {
		return nil, func() {}, nil
	}
	directory, err := os.MkdirTemp(server.stateRoot, ".credentials-")
	if err != nil {
		return nil, func() {}, err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		_ = os.RemoveAll(directory)
		return nil, func() {}, err
	}
	cleanup := func() {
		for _, id := range ids {
			path := filepath.Join(directory, id)
			if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
				file, openErr := os.OpenFile(path, os.O_WRONLY, 0)
				if openErr == nil {
					zero := make([]byte, 4096)
					remaining := info.Size()
					for remaining > 0 {
						chunk := int64(len(zero))
						if remaining < chunk {
							chunk = remaining
						}
						_, _ = file.Write(zero[:chunk])
						remaining -= chunk
					}
					_ = file.Close()
				}
			}
		}
		_ = os.RemoveAll(directory)
	}
	values, err := server.credentials.Resolve(ids)
	if err != nil {
		cleanup()
		return nil, func() {}, err
	}
	defer credential.ZeroValues(values)
	bindings := make([]string, 0, len(ids))
	for _, id := range ids {
		path := filepath.Join(directory, id)
		if err := os.WriteFile(path, values[id], 0o600); err != nil {
			cleanup()
			return nil, func() {}, err
		}
		bindings = append(bindings, id+"="+path)
	}
	return bindings, cleanup, nil
}

func (server *daemonServer) sweepIdle(idleTimeout time.Duration) {
	interval := idleTimeout / 2
	if interval < time.Second {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-server.ctx.Done():
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			if err := server.pool.SweepIdle(ctx); err != nil && !errors.Is(err, vmpool.ErrClosed) {
				fmt.Fprintln(os.Stderr, "zapVM daemon idle sweep:", err)
			}
			cancel()
		}
	}
}

func runDaemonExec(args []string) error {
	flags := flag.NewFlagSet("daemon exec", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	workspace := flags.String("workspace", "", "authorized workspace (default current directory)")
	workspaceReadOnly := flags.Bool("workspace-read-only", false, "share workspace read-only")
	network := flags.String("network", "unrestricted", "off, restricted, or unrestricted")
	sessionID := flags.String("session-id", "cli-session", "logical Session identity")
	explicitRequestID := flags.String("request-id", "", "host-authored unique command identity")
	requireProcessSeal := flags.Bool("require-process-seal", false, "require verified guest process containment")
	cwd := flags.String("cwd", ".", "guest command working directory")
	timeout := flags.Duration("exec-timeout", time.Minute, "guest command timeout")
	resultFile := flags.String("result-file", "", "write structured terminal result to a new file")
	var domains []string
	var ports []uint16
	var credentialIDs []string
	var protectedWorkspacePaths []string
	var deniedWorkspacePatterns []string
	flags.Func("allow-domain", "restricted-network domain; repeatable", func(value string) error { domains = append(domains, value); return nil })
	flags.Func("allow-port", "restricted-network port; repeatable", func(value string) error {
		parsed, err := strconv.ParseUint(value, 10, 16)
		if err != nil || parsed == 0 {
			return fmt.Errorf("invalid port %q", value)
		}
		ports = append(ports, uint16(parsed))
		return nil
	})
	flags.Func("credential-id", "request a daemon-authorized credential ID; repeatable", func(value string) error { credentialIDs = append(credentialIDs, value); return nil })
	flags.Func("protect-workspace-path", "workspace-relative path to expose read-only inside the Guest; repeatable", func(value string) error {
		protectedWorkspacePaths = append(protectedWorkspacePaths, value)
		return nil
	})
	flags.Func("deny-workspace-pattern", "workspace-relative path pattern to mask inside the Guest; repeatable", func(value string) error {
		deniedWorkspacePatterns = append(deniedWorkspacePatterns, value)
		return nil
	})
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() == 0 {
		return errors.New("daemon exec requires a command after --")
	}
	if *workspace == "" {
		var err error
		*workspace, err = os.Getwd()
		if err != nil {
			return err
		}
	}
	requestID := *explicitRequestID
	if requestID == "" {
		var err error
		requestID, err = randomDaemonID()
		if err != nil {
			return err
		}
	}
	request := daemonrpc.ExecRequest{
		Workspace: *workspace, WorkspaceReadOnly: *workspaceReadOnly, Network: platform.NetworkMode(*network),
		AllowedDomains: domains, AllowedPorts: ports,
		Command: daemonrpc.Command{
			ID: requestID, SessionID: *sessionID, Argv: flags.Args(), Cwd: *cwd,
			CredentialIDs: credentialIDs, ProtectedWorkspacePaths: protectedWorkspacePaths,
			DeniedWorkspacePatterns: deniedWorkspacePatterns,
			TimeoutMillis:           uint64(timeout.Milliseconds()),
			RequireProcessSeal:      *requireProcessSeal,
		},
	}
	if err := request.Validate(); err != nil {
		return err
	}
	requestType := daemonrpc.TypeExec
	if *requireProcessSeal {
		requestType = daemonrpc.TypeExecSealed
	}
	terminal, streamErr := daemonClientStreamResultTo(*endpoint, requestID, requestType, request, os.Stdout, os.Stderr)
	if *requireProcessSeal {
		if err := validateDaemonSealReceipt(terminal, requestID); err != nil {
			return errors.Join(streamErr, err)
		}
	}
	if *resultFile != "" && terminal != nil {
		if err := writeDaemonExecResult(*resultFile, *terminal, requestID, *sessionID); err != nil {
			return errors.Join(streamErr, err)
		}
	}
	// Strict sealed callers need both an independently verifiable receipt and
	// the real guest exit status. Legacy structured callers retain their
	// existing exit-zero behavior and interpret the result file themselves.
	if *requireProcessSeal {
		return streamErr
	}
	return daemonExecClientError(*resultFile, terminal, streamErr)
}

func validateDaemonSealReceipt(event *daemonrpc.Event, requestID string) error {
	if event == nil || event.CommandID != requestID || event.ExitCode == nil || event.Seal == nil || event.Seal.Mechanism != "cgroup-v2" || event.Seal.State != "empty" {
		return errors.New("missing or invalid process seal receipt")
	}
	return nil
}

// A structured caller owns Guest exit-code interpretation. Returning the same
// Guest failure as a Host CLI error would append transport metadata to Guest
// stderr and make the external Agent result ambiguous. Infrastructure failures
// do not carry a terminal Guest exit code and remain errors.
func daemonExecClientError(resultFile string, terminal *daemonrpc.Event, streamErr error) error {
	if resultFile != "" && terminal != nil && terminal.ExitCode != nil {
		return nil
	}
	return streamErr
}

func daemonClientExec(endpoint, requestID string, request daemonrpc.ExecRequest) error {
	return daemonClientExecTo(endpoint, requestID, request, os.Stdout, os.Stderr)
}

func daemonClientExecTo(endpoint, requestID string, request daemonrpc.ExecRequest, stdout, stderr io.Writer) error {
	return daemonClientStreamTo(endpoint, requestID, daemonrpc.TypeExec, request, stdout, stderr)
}

func daemonClientStreamTo(endpoint, requestID, requestType string, payload any, stdout, stderr io.Writer) error {
	_, err := daemonClientStreamResultTo(endpoint, requestID, requestType, payload, stdout, stderr)
	return err
}

func daemonClientStreamResultTo(endpoint, requestID, requestType string, payload any, stdout, stderr io.Writer) (*daemonrpc.Event, error) {
	if stdout == nil {
		stdout = io.Discard
	}
	if stderr == nil {
		stderr = io.Discard
	}
	connection, codec, err := dialDaemon(endpoint)
	if err != nil {
		return nil, err
	}
	defer connection.Close()
	envelope, err := daemonrpc.NewEnvelope(requestID, requestType, payload)
	if err != nil {
		return nil, err
	}
	if err := codec.Write(envelope); err != nil {
		return nil, err
	}
	for {
		response, err := codec.Read()
		if err != nil {
			return nil, err
		}
		if response.ID != requestID {
			return nil, errors.New("daemon response request ID mismatch")
		}
		switch response.Type {
		case daemonrpc.TypeAccepted:
			if err := daemonrpc.DecodeEmpty(response.Payload); err != nil {
				return nil, err
			}
		case daemonrpc.TypeEvent:
			event, err := daemonrpc.DecodePayload[daemonrpc.Event](response.Payload)
			if err != nil {
				return nil, err
			}
			if event.Type == "output" {
				writer := stdout
				if event.Stream == "stderr" {
					writer = stderr
				}
				if _, err := writer.Write(event.Data); err != nil {
					return nil, err
				}
			}
			if event.Type == "result" {
				if event.OK == nil || !*event.OK {
					if event.ExitCode != nil && *event.ExitCode > 0 && *event.ExitCode <= 255 {
						return &event, &guestCommandExitError{Code: *event.ExitCode}
					}
					if event.Error == "" {
						return &event, errors.New("daemon guest command failed")
					}
					return &event, errors.New(event.Error)
				}
				return &event, nil
			}
		case daemonrpc.TypeError:
			message, err := daemonrpc.DecodePayload[daemonrpc.Error](response.Payload)
			if err != nil {
				return nil, err
			}
			return nil, errors.New(message.Message)
		default:
			return nil, fmt.Errorf("unexpected daemon response type %q", response.Type)
		}
	}
}

func writeDaemonExecResult(path string, event daemonrpc.Event, requestID, sessionID string) error {
	if !filepath.IsAbs(path) {
		return errors.New("daemon exec result file must be absolute")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create daemon exec result file: %w", err)
	}
	encodeErr := json.NewEncoder(file).Encode(struct {
		ExitCode  *int                   `json:"exit_code,omitempty"`
		RequestID string                 `json:"request_id"`
		SessionID string                 `json:"session_id"`
		Seal      *daemonrpc.ProcessSeal `json:"seal,omitempty"`
	}{ExitCode: event.ExitCode, RequestID: requestID, SessionID: sessionID, Seal: event.Seal})
	return errors.Join(encodeErr, file.Close())
}

func runDaemonStatus(args []string) error {
	flags := flag.NewFlagSet("daemon status", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	configPath := flags.String("config", "", "owner-only daemon JSON configuration used to select the endpoint")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("daemon status does not accept positional arguments")
	}
	selectedEndpoint, err := daemonStatusEndpoint(*endpoint, *configPath)
	if err != nil {
		return err
	}
	response, err := daemonSimpleRequest(selectedEndpoint, daemonrpc.TypeStatus)
	if err != nil {
		return err
	}
	if response.Type != daemonrpc.TypeStatus {
		return fmt.Errorf("unexpected daemon status response %q", response.Type)
	}
	status, err := daemonrpc.DecodePayload[daemonrpc.Status](response.Payload)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(status)
}

func daemonStatusEndpoint(endpoint, configPath string) (string, error) {
	if endpoint != "" && configPath != "" {
		return "", errors.New("daemon status accepts only one of --endpoint or --config")
	}
	if configPath == "" {
		return endpoint, nil
	}
	config, err := daemonconfig.Load(configPath)
	if err != nil {
		return "", err
	}
	return config.Endpoint, nil
}

func runDaemonStop(args []string) error {
	flags := flag.NewFlagSet("daemon stop", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("daemon stop does not accept positional arguments")
	}
	response, err := daemonSimpleRequest(*endpoint, daemonrpc.TypeShutdown)
	if err != nil {
		return err
	}
	if response.Type != daemonrpc.TypeStopped {
		return fmt.Errorf("unexpected daemon stop response %q", response.Type)
	}
	return daemonrpc.DecodeEmpty(response.Payload)
}

func runDaemonPause(args []string) error {
	return runDaemonControl(args, "pause", daemonrpc.TypePause, daemonrpc.TypePaused)
}

func runDaemonResume(args []string) error {
	return runDaemonControl(args, "resume", daemonrpc.TypeResume, daemonrpc.TypeResumed)
}

func runDaemonControl(args []string, name, requestType, responseType string) error {
	flags := flag.NewFlagSet("daemon "+name, flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "daemon endpoint")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("daemon %s does not accept positional arguments", name)
	}
	response, err := daemonSimpleRequest(*endpoint, requestType)
	if err != nil {
		return err
	}
	if response.Type != responseType {
		return fmt.Errorf("unexpected daemon %s response %q", name, response.Type)
	}
	return daemonrpc.DecodeEmpty(response.Payload)
}

func daemonSimpleRequest(endpoint, messageType string) (daemonrpc.Envelope, error) {
	return daemonRequest(endpoint, messageType, daemonrpc.Empty{})
}

func daemonRequest(endpoint, messageType string, payload any) (daemonrpc.Envelope, error) {
	requestID, err := randomDaemonID()
	if err != nil {
		return daemonrpc.Envelope{}, err
	}
	connection, codec, err := dialDaemon(endpoint)
	if err != nil {
		return daemonrpc.Envelope{}, err
	}
	defer connection.Close()
	request, err := daemonrpc.NewEnvelope(requestID, messageType, payload)
	if err != nil {
		return daemonrpc.Envelope{}, err
	}
	if err := codec.Write(request); err != nil {
		return daemonrpc.Envelope{}, err
	}
	response, err := codec.Read()
	if err != nil {
		return daemonrpc.Envelope{}, err
	}
	if response.ID != requestID {
		return daemonrpc.Envelope{}, errors.New("daemon response request ID mismatch")
	}
	if response.Type == daemonrpc.TypeError {
		message, decodeErr := daemonrpc.DecodePayload[daemonrpc.Error](response.Payload)
		if decodeErr != nil {
			return daemonrpc.Envelope{}, decodeErr
		}
		return daemonrpc.Envelope{}, errors.New(message.Message)
	}
	return response, nil
}

func dialDaemon(endpoint string) (net.Conn, *daemonrpc.Codec, error) {
	var err error
	if endpoint == "" {
		endpoint, err = localipc.DefaultEndpoint()
		if err != nil {
			return nil, nil, err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connection, err := localipc.Dial(ctx, endpoint)
	if err != nil {
		return nil, nil, err
	}
	return connection, daemonrpc.NewCodec(connection, connection), nil
}

func loadDaemonImage(root, publicKey string, allowUnsigned bool, kernel, initrd, rootDisk, stateTemplate string) (daemonImageConfig, error) {
	abs := func(path string) (string, error) {
		if path == "" {
			return "", nil
		}
		return filepath.Abs(path)
	}
	var err error
	for _, item := range []*string{&root, &publicKey, &kernel, &initrd, &rootDisk, &stateTemplate} {
		if *item, err = abs(*item); err != nil {
			return daemonImageConfig{}, err
		}
	}
	if allowUnsigned {
		if root != "" || publicKey != "" || kernel == "" || rootDisk == "" || stateTemplate == "" {
			return daemonImageConfig{}, errors.New("unsigned daemon image requires kernel/root-disk/state-template and no signed image flags")
		}
		hash := sha256.New()
		for index, path := range []string{kernel, initrd, rootDisk, stateTemplate} {
			if path == "" {
				continue
			}
			_, _ = fmt.Fprintf(hash, "%d\x00", index)
			if err := hashDaemonArtifact(hash, path); err != nil {
				return daemonImageConfig{}, err
			}
		}
		return daemonImageConfig{allowUnsigned: true, kernel: kernel, initrd: initrd, rootDisk: rootDisk, stateTemplate: stateTemplate, stateSchema: state.CurrentStateSchema, protocol: 1, digest: hex.EncodeToString(hash.Sum(nil))}, nil
	}
	if root == "" || publicKey == "" || kernel != "" || initrd != "" || rootDisk != "" || stateTemplate != "" {
		return daemonImageConfig{}, errors.New("daemon requires signed image-root/public-key or explicit --allow-unsigned-image artifacts")
	}
	resolved, err := vmimage.ResolveActive(root, publicKey, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return daemonImageConfig{}, err
	}
	activation, err := vmimage.ReadActivation(root)
	if err != nil {
		return daemonImageConfig{}, err
	}
	if activation.ActiveVersion != resolved.Manifest.ImageVersion {
		return daemonImageConfig{}, errors.New("active image changed while it was being verified")
	}
	manifestData, err := vmimage.ReadBoundedRegular(filepath.Join(resolved.Directory, "manifest.json"), vmimage.MaxManifestSize)
	if err != nil {
		return daemonImageConfig{}, err
	}
	digest := sha256.Sum256(manifestData)
	capabilities, err := vmimage.ReadResolvedCapabilities(resolved)
	if err != nil {
		return daemonImageConfig{}, fmt.Errorf("verify Runtime capabilities: %w", err)
	}
	agentAdapter := ""
	if capabilities.AgentAdapter != nil {
		agentAdapter = capabilities.AgentAdapter.Contract
	}
	return daemonImageConfig{
		root: root, publicKey: publicKey, activeVersion: activation.ActiveVersion, activeGen: activation.Generation,
		stateTemplate: resolved.StateTemplate, stateSchema: resolved.Manifest.StateSchema, protocol: resolved.Manifest.Protocol,
		agentAdapter: agentAdapter, digest: hex.EncodeToString(digest[:]),
	}, nil
}

func (image daemonImageConfig) agentContract() agentpackage.RuntimeContract {
	return agentpackage.RuntimeContract{Protocol: image.protocol, StateSchema: image.stateSchema, AgentAdapter: image.agentAdapter}
}

func normalizeDaemonPolicy(request daemonrpc.ExecRequest) (string, daemonPolicy, error) {
	if request.Network != platform.NetworkRestricted {
		return "", daemonPolicy{}, nil
	}
	validated, err := egress.NewPolicy(request.AllowedDomains, request.AllowedPorts)
	if err != nil {
		return "", daemonPolicy{}, err
	}
	domains, ports := validated.CanonicalRules()
	encoded, _ := json.Marshal(struct {
		Domains []string `json:"domains"`
		Ports   []uint16 `json:"ports"`
	}{Domains: domains, Ports: ports})
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), daemonPolicy{domains: domains, ports: ports}, nil
}

func hashDaemonArtifact(destination io.Writer, path string) error {
	before, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect unsigned daemon artifact %s: %w", path, err)
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("unsigned daemon artifact %s must be a regular file, not a symlink", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return err
	}
	current, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !os.SameFile(before, opened) || !os.SameFile(opened, current) || !current.Mode().IsRegular() || current.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("unsigned daemon artifact %s changed while opening", path)
	}
	_, _ = fmt.Fprintf(destination, "%s\x00%d\x00", filepath.Base(path), opened.Size())
	written, err := io.Copy(destination, file)
	if err != nil {
		return fmt.Errorf("hash unsigned daemon artifact %s: %w", path, err)
	}
	after, err := file.Stat()
	if err != nil {
		return err
	}
	if written != opened.Size() || after.Size() != opened.Size() || after.ModTime() != opened.ModTime() {
		return fmt.Errorf("unsigned daemon artifact %s changed while hashing", path)
	}
	return nil
}

func daemonStateDigest(route vmpool.Route) string {
	route.StateDigest = ""
	encoded, _ := json.Marshal(route)
	digest := sha256.Sum256(append([]byte("zapvm-daemon-state-v1\x00"), encoded...))
	return hex.EncodeToString(digest[:])
}

func computerStateDigest(id string) string {
	digest := sha256.Sum256(append([]byte("zapvm-computer-state-v1\x00"), []byte(id)...))
	return hex.EncodeToString(digest[:])
}

func prepareDaemonStateRoot(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("daemon state root must be a real directory")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		return errors.New("daemon state root must have mode 0700")
	}
	return nil
}

func randomDaemonID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}
