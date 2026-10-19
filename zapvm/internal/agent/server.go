package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"zapvm/internal/credential"
	"zapvm/internal/protocol"
	"zapvm/internal/workspacepolicy"
)

const (
	maxArguments = 256
	maxTimeout   = 24 * time.Hour
)

var ErrRestartRequested = errors.New("agent restart requested")
var ErrCrashInjected = errors.New("agent crash injected")

type Server struct {
	root           string
	secret         []byte
	runUID         uint32
	runGID         uint32
	isolate        bool
	stateRoot      string
	stateSchema    int
	startedAt      time.Time
	instanceID     string
	restart        chan struct{}
	restartOnce    sync.Once
	crash          chan struct{}
	crashOnce      sync.Once
	allowFault     bool
	flushState     func() error
	credentialRoot string
	nextOwner      atomic.Uint64
	degraded       atomic.Bool
	semaphore      chan struct{}
	protectedMu    sync.Mutex

	mu      sync.Mutex
	running map[string]*runningCommand
}

type runningCommand struct {
	cmd       *exec.Cmd
	cancel    context.CancelFunc
	isolation processIsolation
	owner     uint64
}

type execOutputWriter struct {
	server      *Server
	codec       *protocol.Codec
	request     protocol.Envelope
	messageType string
}

func (writer *execOutputWriter) Write(data []byte) (int, error) {
	writer.server.write(writer.codec, writer.request, writer.messageType, ExecOutput{Data: append([]byte(nil), data...)})
	return len(data), nil
}

func NewServer(root string, secret []byte, maxConcurrent int) (*Server, error) {
	return newServer(root, secret, maxConcurrent, uint32(os.Geteuid()), uint32(os.Getegid()), false)
}

func NewServerAs(root string, secret []byte, maxConcurrent int, uid, gid uint32) (*Server, error) {
	return newServer(root, secret, maxConcurrent, uid, gid, true)
}

func newServer(root string, secret []byte, maxConcurrent int, uid, gid uint32, isolate bool) (*Server, error) {
	if len(secret) < 32 {
		return nil, errors.New("RPC secret must contain at least 32 bytes")
	}
	if maxConcurrent <= 0 {
		return nil, errors.New("max concurrency must be greater than zero")
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace root: %w", err)
	}
	info, err := os.Stat(resolvedRoot)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("workspace root is not a directory")
	}
	credentialRoot, err := prepareCredentialRoot(isolate)
	if err != nil {
		return nil, err
	}
	instanceBytes := make([]byte, 16)
	if _, err := rand.Read(instanceBytes); err != nil {
		return nil, fmt.Errorf("generate agent instance ID: %w", err)
	}
	return &Server{
		root:           resolvedRoot,
		secret:         append([]byte(nil), secret...),
		runUID:         uid,
		runGID:         gid,
		isolate:        isolate,
		startedAt:      time.Now(),
		instanceID:     hex.EncodeToString(instanceBytes),
		restart:        make(chan struct{}),
		crash:          make(chan struct{}),
		flushState:     flushState,
		credentialRoot: credentialRoot,
		semaphore:      make(chan struct{}, maxConcurrent),
		running:        make(map[string]*runningCommand),
	}, nil
}

func (s *Server) Serve(ctx context.Context, connection io.ReadWriteCloser) error {
	owner := s.nextOwner.Add(1)
	defer s.stopOwner(owner)
	codec := protocol.NewCodec(connection, connection)
	if err := protocol.AuthenticateServer(codec, s.secret); err != nil {
		return err
	}
	serveCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	go func() {
		select {
		case <-serveCtx.Done():
			_ = connection.Close()
		case <-done:
		}
	}()
	defer close(done)
	for {
		envelope, err := codec.Read()
		if err != nil {
			if serveCtx.Err() != nil || errors.Is(err, io.EOF) {
				return serveCtx.Err()
			}
			return err
		}
		switch envelope.Type {
		case "exec.start":
			if s.degraded.Load() {
				s.writeError(codec, envelope, "agent is degraded")
				continue
			}
			select {
			case s.semaphore <- struct{}{}:
				go func(request protocol.Envelope) {
					defer func() { <-s.semaphore }()
					s.handleExec(serveCtx, codec, request, owner)
				}(envelope)
			default:
				s.writeError(codec, envelope, "maximum concurrent commands reached")
			}
		case "exec.signal":
			s.handleSignal(codec, envelope)
		case "state.flush":
			if s.degraded.Load() {
				s.writeError(codec, envelope, "agent is degraded")
				continue
			}
			if s.activeCommands() != 0 {
				s.writeError(codec, envelope, "state flush requires an idle agent")
				continue
			}
			if err := s.flushState(); err != nil {
				s.writeError(codec, envelope, err.Error())
				continue
			}
			s.write(codec, envelope, "state.flushed", struct{}{})
		case "health":
			if s.degraded.Load() {
				s.writeError(codec, envelope, "agent is degraded")
				continue
			}
			s.write(codec, envelope, "health.ok", Health{
				ProtocolVersion: protocol.Version,
				InstanceID:      s.instanceID,
				StateSchema:     s.stateSchema,
				ActiveCommands:  s.activeCommands(),
				UptimeMillis:    time.Since(s.startedAt).Milliseconds(),
			})
		case "agent.restart":
			if s.activeCommands() != 0 {
				s.writeError(codec, envelope, "agent restart requires no active commands")
				continue
			}
			s.write(codec, envelope, "agent.restarting", struct{}{})
			s.restartOnce.Do(func() { close(s.restart) })
			return ErrRestartRequested
		case "agent.crash":
			if !s.allowFault {
				s.writeError(codec, envelope, "agent fault injection is disabled")
				continue
			}
			s.write(codec, envelope, "agent.crashing", struct{}{})
			s.crashOnce.Do(func() { close(s.crash) })
			return ErrCrashInjected
		default:
			s.writeError(codec, envelope, "unsupported message type")
		}
	}
}

func (s *Server) handleExec(parent context.Context, codec *protocol.Codec, envelope protocol.Envelope, owner uint64) {
	if envelope.ID == "" {
		s.writeError(codec, envelope, "request ID is required")
		return
	}
	var request ExecStart
	if err := decodeExecStart(envelope.Payload, &request); err != nil {
		credential.ZeroBytes(envelope.Payload)
		credential.ZeroValues(request.Credentials)
		s.writeError(codec, envelope, "invalid exec request")
		return
	}
	credential.ZeroBytes(envelope.Payload)
	defer credential.ZeroValues(request.Credentials)
	if err := validateExec(request); err != nil {
		s.writeError(codec, envelope, err.Error())
		return
	}
	cwd, err := s.resolveCwd(request.Cwd)
	if err != nil {
		s.writeError(codec, envelope, err.Error())
		return
	}
	if (len(request.ProtectedWorkspacePaths) > 0 || len(request.DeniedWorkspacePatterns) > 0) && !s.isolate {
		s.writeError(codec, envelope, "workspace path policies require workload mount isolation")
		return
	}
	var protectedLease *workspacepolicy.ProtectedPathsLease
	if len(request.ProtectedWorkspacePaths) > 0 {
		// A missing protected leaf needs a real mountpoint. Serialize its full
		// lifecycle so concurrent requests cannot observe or reuse another
		// request's temporary placeholder.
		s.protectedMu.Lock()
		defer s.protectedMu.Unlock()
		protectedLease, err = workspacepolicy.ReserveProtectedPaths(s.root, request.ProtectedWorkspacePaths)
		if err != nil {
			s.writeError(codec, envelope, err.Error())
			return
		}
		defer func() {
			if err := protectedLease.Cleanup(); err != nil {
				s.degraded.Store(true)
			}
		}()
	}
	timeout, err := resolveExecTimeout(request.TimeoutMillis)
	if err != nil {
		s.writeError(codec, envelope, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd := exec.Command(request.Argv[0], request.Argv[1:]...)
	cmd.Dir = cwd
	credentialLease, err := prepareCredentialLease(s.credentialRoot, request.Credentials, s.runUID, s.runGID)
	if err != nil {
		s.writeError(codec, envelope, "prepare request credentials")
		return
	}
	credentialCleaned := false
	defer func() {
		if !credentialCleaned {
			if err := credentialLease.Cleanup(); err != nil {
				s.degraded.Store(true)
			}
		}
	}()
	cmd.Env = safeEnvironment(request.Env, credentialLease.exposedPath(s.isolate))
	isolation, err := prepareProcess(cmd, s.runUID, s.runGID, s.isolate, s.stateRoot, envelope.SessionID, envelope.ID, credentialLeasePath(credentialLease), s.root, request.ProtectedWorkspacePaths, request.DeniedWorkspacePatterns)
	if err != nil {
		s.writeError(codec, envelope, err.Error())
		return
	}
	cleanupIsolation := true
	defer func() {
		if cleanupIsolation {
			_ = isolation.Cleanup()
		}
	}()
	// Use non-file writers so os/exec owns the copy goroutines and Wait does not
	// return until every stdout/stderr byte has been handed to the RPC codec.
	// StdoutPipe followed by Wait can close the pipe before a slow reader drains
	// its final buffered bytes.
	cmd.Stdout = &execOutputWriter{server: s, codec: codec, request: envelope, messageType: "exec.stdout"}
	cmd.Stderr = &execOutputWriter{server: s, codec: codec, request: envelope, messageType: "exec.stderr"}

	s.mu.Lock()
	if _, exists := s.running[envelope.ID]; exists {
		s.mu.Unlock()
		s.writeError(codec, envelope, "request ID is already running")
		return
	}
	if err := cmd.Start(); err != nil {
		s.mu.Unlock()
		s.writeError(codec, envelope, err.Error())
		return
	}
	if err := isolation.AfterStart(); err != nil {
		s.mu.Unlock()
		_ = killProcessTree(cmd)
		_ = isolation.Kill()
		_ = cmd.Wait()
		s.writeError(codec, envelope, err.Error())
		return
	}
	s.running[envelope.ID] = &runningCommand{cmd: cmd, cancel: cancel, isolation: isolation, owner: owner}
	s.mu.Unlock()

	s.write(codec, envelope, "exec.started", ExecStarted{PID: cmd.Process.Pid})
	killed := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = isolation.Kill()
			_ = killProcessTree(cmd)
		case <-killed:
		}
	}()
	waitErr := cmd.Wait()
	close(killed)
	_ = isolation.Kill()
	_ = killProcessTree(cmd)
	_ = isolation.Cleanup()
	cleanupIsolation = false

	s.mu.Lock()
	delete(s.running, envelope.ID)
	s.mu.Unlock()
	if err := credentialLease.Cleanup(); err != nil {
		credentialCleaned = true
		s.degraded.Store(true)
		s.writeError(codec, envelope, "credential cleanup failed")
		return
	}
	credentialCleaned = true
	exitCode := 0
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			s.writeError(codec, envelope, waitErr.Error())
			return
		}
	}
	s.write(codec, envelope, "exec.exit", ExecExit{Code: exitCode})
}

func (s *Server) handleSignal(codec *protocol.Codec, envelope protocol.Envelope) {
	var request ExecSignal
	if err := json.Unmarshal(envelope.Payload, &request); err != nil {
		s.writeError(codec, envelope, "invalid signal request")
		return
	}
	s.mu.Lock()
	running := s.running[envelope.ID]
	s.mu.Unlock()
	if running == nil {
		s.writeError(codec, envelope, "request is not running")
		return
	}
	if err := signalProcessTree(running.cmd, request.Signal); err != nil {
		s.writeError(codec, envelope, err.Error())
	}
}

func (s *Server) write(codec *protocol.Codec, request protocol.Envelope, messageType string, payload any) {
	response, err := protocol.NewEnvelope(request.ID, request.SessionID, messageType, payload)
	if err == nil {
		_ = codec.Write(response)
	}
}

func (s *Server) writeError(codec *protocol.Codec, request protocol.Envelope, message string) {
	s.write(codec, request, "error", ErrorMessage{Message: message})
}

func (s *Server) resolveCwd(requested string) (string, error) {
	if requested == "" || requested == "." {
		return s.root, nil
	}
	candidate := requested
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(s.root, candidate)
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", fmt.Errorf("resolve working directory: %w", err)
	}
	relative, err := filepath.Rel(s.root, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("working directory escapes workspace root")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", errors.New("working directory is not a directory")
	}
	return resolved, nil
}

func (s *Server) stopAll() {
	s.stopOwner(0)
}

func (s *Server) stopOwner(owner uint64) {
	s.mu.Lock()
	running := make([]*runningCommand, 0, len(s.running))
	for _, command := range s.running {
		if owner == 0 || command.owner == owner {
			running = append(running, command)
		}
	}
	s.mu.Unlock()
	for _, command := range running {
		command.cancel()
		_ = command.isolation.Kill()
		_ = killProcessTree(command.cmd)
	}
}

func (s *Server) activeCommands() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.running)
}

func (s *Server) RestartRequested() <-chan struct{} { return s.restart }

func (s *Server) CrashRequested() <-chan struct{} { return s.crash }

func (s *Server) EnableFaultInjection() { s.allowFault = true }

func (s *Server) SetStateRoot(path string, schema int) {
	s.stateRoot = path
	s.stateSchema = schema
}

func (s *Server) Shutdown() { s.stopAll() }

func validateExec(request ExecStart) error {
	if len(request.Argv) == 0 {
		return errors.New("argv must not be empty")
	}
	if len(request.Argv) > maxArguments {
		return errors.New("too many arguments")
	}
	if request.Argv[0] == "" {
		return errors.New("executable must not be empty")
	}
	for _, argument := range request.Argv {
		if len(argument) > 128*1024 || strings.IndexByte(argument, 0) >= 0 {
			return errors.New("invalid argument")
		}
	}
	for key, value := range request.Env {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.IndexByte(value, 0) >= 0 {
			return errors.New("invalid environment variable")
		}
	}
	totalCredentials := 0
	if len(request.Credentials) > credential.MaxCredentials {
		return errors.New("too many credentials")
	}
	for id, value := range request.Credentials {
		if !credential.ValidID(id) || len(value) == 0 || len(value) > credential.MaxValueSize {
			return errors.New("invalid credential ID or value size")
		}
		totalCredentials += len(value)
		if totalCredentials > credential.MaxTotalSize {
			return errors.New("credential values exceed total size limit")
		}
	}
	if err := workspacepolicy.ValidateProtectedPaths(request.ProtectedWorkspacePaths); err != nil {
		return err
	}
	if err := workspacepolicy.ValidateDeniedPatterns(request.DeniedWorkspacePatterns); err != nil {
		return err
	}
	return nil
}

func decodeExecStart(data []byte, request *ExecStart) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(request); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("exec request contains trailing JSON")
	}
	return nil
}

func credentialLeasePath(lease *credentialLease) string {
	if lease == nil {
		return ""
	}
	return lease.path
}

func resolveExecTimeout(milliseconds uint64) (time.Duration, error) {
	if milliseconds == 0 {
		return maxTimeout, nil
	}
	if milliseconds > uint64(maxTimeout/time.Millisecond) {
		return 0, errors.New("timeout exceeds 24 hour limit")
	}
	return time.Duration(milliseconds) * time.Millisecond, nil
}

func safeEnvironment(extra map[string]string, credentialDirectory string) []string {
	environment := map[string]string{
		"HOME":                 "/home/zapvm",
		"LANG":                 "C.UTF-8",
		"LOGNAME":              "zapvm",
		"NIX_CONFIG":           "experimental-features = nix-command flakes\nsandbox = false",
		"NIX_REMOTE":           "local",
		"NIX_USER_PROFILE_DIR": "/nix/var/nix/profiles/zap-computer",
		"PATH":                 "/nix/var/nix/profiles/zap-computer/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"SSL_CERT_FILE":        "/etc/ssl/certs/ca-certificates.crt",
		"TMPDIR":               "/tmp",
		"USER":                 "zapvm",
		"XDG_CACHE_HOME":       "/nix/var/nix/zap-cache",
		"XDG_STATE_HOME":       "/nix/var/nix/zap-state",
	}
	for key, value := range extra {
		if key == "ZAPVM_CREDENTIAL_DIR" {
			continue
		}
		if _, reserved := environment[key]; reserved {
			continue
		}
		environment[key] = value
	}
	if credentialDirectory != "" {
		environment["ZAPVM_CREDENTIAL_DIR"] = credentialDirectory
	}
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+environment[key])
	}
	return result
}
