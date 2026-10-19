package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"zapvm/internal/agent"
)

const reservedProxyID uint32 = 998

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "zapvm-agent:", err)
		os.Exit(1)
	}
}

func run() error {
	workspace := flag.String("workspace-root", "/workspace", "authorized workspace mount root")
	secretFile := flag.String("secret-file", "/run/zapvm/rpc-secret", "root-only raw RPC secret file")
	transport := flag.String("transport", "vsock", "vsock or stdio")
	port := flag.Uint("port", 19090, "vsock port")
	concurrency := flag.Int("max-concurrent", 4, "maximum concurrent commands")
	maxConnections := flag.Int("max-connections", 8, "maximum concurrent authenticated transport connections")
	identityFile := flag.String("identity-file", "/run/zapvm/identity.json", "root-only workload UID/GID file")
	stateRoot := flag.String("state-root", "/var/lib/zapvm", "optional validated state mount root")
	flag.Parse()

	secret, err := readSecret(*secretFile)
	if err != nil {
		return err
	}
	uid, gid, faultInjection, err := readIdentity(*identityFile)
	if err != nil {
		return err
	}
	stateSchema, err := prepareStateRoot(*stateRoot, uid, gid)
	if err != nil {
		return err
	}
	if *maxConnections <= 0 {
		return errors.New("max connections must be greater than zero")
	}
	if err := agent.CleanupStaleIsolation(); err != nil {
		return fmt.Errorf("cleanup stale workload isolation: %w", err)
	}
	server, err := agent.NewServerAs(*workspace, secret, *concurrency, uid, gid)
	if err != nil {
		return err
	}
	if faultInjection {
		server.EnableFaultInjection()
	}
	server.SetStateRoot(*stateRoot, stateSchema)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	switch *transport {
	case "stdio":
		return server.Serve(ctx, stdioConnection{})
	case "vsock":
		connectCID, err := configuredVSockConnectCID()
		if err != nil {
			return err
		}
		if connectCID != 0 {
			return serveVSockConnectPool(ctx, server, connectCID, uint32(*port), *maxConnections)
		}
		listener, err := listenVSock(uint32(*port))
		if err != nil {
			return err
		}
		defer listener.Close()
		defer func() {
			select {
			case <-server.CrashRequested():
			default:
				server.Shutdown()
			}
		}()
		go func() {
			select {
			case <-ctx.Done():
			case <-server.RestartRequested():
			case <-server.CrashRequested():
			}
			_ = listener.Close()
		}()
		semaphore := make(chan struct{}, *maxConnections)
		for {
			connection, err := listener.Accept()
			if err != nil {
				select {
				case <-server.CrashRequested():
					return agent.ErrCrashInjected
				default:
				}
				select {
				case <-server.RestartRequested():
					return agent.ErrRestartRequested
				default:
				}
				if ctx.Err() != nil {
					return nil
				}
				return err
			}
			select {
			case semaphore <- struct{}{}:
				go func() {
					defer func() { <-semaphore }()
					serveErr := server.Serve(ctx, connection)
					_ = connection.Close()
					if serveErr != nil && !errors.Is(serveErr, agent.ErrRestartRequested) && !errors.Is(serveErr, agent.ErrCrashInjected) && ctx.Err() == nil {
						fmt.Fprintln(os.Stderr, "zapvm-agent: connection:", serveErr)
					}
				}()
			default:
				_ = connection.Close()
			}
		}
	default:
		return fmt.Errorf("unsupported transport %q", *transport)
	}
}

func serveVSockConnectPool(ctx context.Context, server *agent.Server, cid, port uint32, workers int) error {
	workerCtx, cancel := context.WithCancel(ctx)
	var connections sync.Map
	defer func() {
		cancel()
		connections.Range(func(key, _ any) bool {
			_ = key.(io.Closer).Close()
			return true
		})
	}()
	results := make(chan error, workers)
	for worker := 0; worker < workers; worker++ {
		go func() {
			for {
				connection, err := dialVSock(cid, port)
				if err != nil {
					select {
					case <-workerCtx.Done():
						results <- nil
						return
					case <-time.After(100 * time.Millisecond):
						continue
					}
				}
				connections.Store(connection, struct{}{})
				serveErr := server.Serve(workerCtx, connection)
				connections.Delete(connection)
				_ = connection.Close()
				if errors.Is(serveErr, agent.ErrRestartRequested) || errors.Is(serveErr, agent.ErrCrashInjected) {
					results <- serveErr
					return
				}
				select {
				case <-workerCtx.Done():
					results <- nil
					return
				default:
				}
			}
		}()
	}
	select {
	case <-ctx.Done():
		server.Shutdown()
		return nil
	case <-server.RestartRequested():
		server.Shutdown()
		return agent.ErrRestartRequested
	case <-server.CrashRequested():
		return agent.ErrCrashInjected
	case err := <-results:
		return err
	}
}

func parseVSockConnectCID(cmdline string) (uint32, error) {
	for _, field := range strings.Fields(cmdline) {
		const prefix = "zapvm.agent_connect_cid="
		if !strings.HasPrefix(field, prefix) {
			continue
		}
		value, err := strconv.ParseUint(strings.TrimPrefix(field, prefix), 10, 32)
		if err != nil || value == 0 {
			return 0, errors.New("invalid zapvm.agent_connect_cid kernel option")
		}
		return uint32(value), nil
	}
	return 0, nil
}

func prepareStateRoot(root string, uid, gid uint32) (int, error) {
	rootInfo, err := os.Lstat(root)
	if err != nil || rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return 0, errors.New("state root must be a real directory")
	}
	schemaPath := filepath.Join(root, "schema-version")
	data, err := os.ReadFile(schemaPath)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read state schema: %w", err)
	}
	if strings.TrimSpace(string(data)) != "3" {
		return 0, errors.New("unsupported state schema")
	}
	schemaInfo, err := os.Lstat(schemaPath)
	if err != nil || !schemaInfo.Mode().IsRegular() || schemaInfo.Mode()&os.ModeSymlink != 0 {
		return 0, errors.New("state schema must be a regular file")
	}
	migrationRoot := filepath.Join(root, ".schema-migrations")
	migrationInfo, err := os.Lstat(migrationRoot)
	if err != nil || migrationInfo.Mode()&os.ModeSymlink != 0 || !migrationInfo.IsDir() {
		return 0, errors.New("state migration root must be a real directory")
	}
	for _, version := range []string{"2", "3"} {
		markerPath := filepath.Join(migrationRoot, version)
		marker, markerErr := os.ReadFile(markerPath)
		if markerErr != nil || strings.TrimSpace(string(marker)) != version {
			return 0, fmt.Errorf("state schema %s migration marker is missing or invalid", version)
		}
		markerInfo, markerErr := os.Lstat(markerPath)
		if markerErr != nil || !markerInfo.Mode().IsRegular() || markerInfo.Mode()&os.ModeSymlink != 0 {
			return 0, fmt.Errorf("state schema %s migration marker must be a regular file", version)
		}
	}
	dataPath := filepath.Join(root, "data")
	if err := os.MkdirAll(dataPath, 0o750); err != nil {
		return 0, fmt.Errorf("create state data directory: %w", err)
	}
	dataInfo, err := os.Lstat(dataPath)
	if err != nil || dataInfo.Mode()&os.ModeSymlink != 0 || !dataInfo.IsDir() {
		return 0, errors.New("state data path must be a real directory")
	}
	if err := os.Chown(dataPath, int(uid), int(gid)); err != nil {
		return 0, fmt.Errorf("assign state data directory: %w", err)
	}
	if err := os.Chmod(dataPath, 0o750); err != nil {
		return 0, fmt.Errorf("protect state data directory: %w", err)
	}
	sessionsPath := filepath.Join(root, "sessions")
	if err := os.MkdirAll(sessionsPath, 0o711); err != nil {
		return 0, fmt.Errorf("create Session state directory: %w", err)
	}
	sessionsInfo, err := os.Lstat(sessionsPath)
	if err != nil || sessionsInfo.Mode()&os.ModeSymlink != 0 || !sessionsInfo.IsDir() {
		return 0, errors.New("Session state path must be a real directory")
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(sessionsPath, 0, 0); err != nil {
			return 0, fmt.Errorf("protect Session state directory: %w", err)
		}
	}
	if err := os.Chmod(sessionsPath, 0o711); err != nil {
		return 0, fmt.Errorf("protect Session state directory: %w", err)
	}
	computerPath := filepath.Join(root, "computer")
	if err := os.MkdirAll(computerPath, 0o711); err != nil {
		return 0, fmt.Errorf("create Computer state directory: %w", err)
	}
	computerInfo, err := os.Lstat(computerPath)
	if err != nil || computerInfo.Mode()&os.ModeSymlink != 0 || !computerInfo.IsDir() {
		return 0, errors.New("Computer state path must be a real directory")
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(computerPath, 0, 0); err != nil {
			return 0, fmt.Errorf("protect Computer state directory: %w", err)
		}
	}
	if err := os.Chmod(computerPath, 0o711); err != nil {
		return 0, fmt.Errorf("protect Computer state directory: %w", err)
	}
	for _, name := range []string{"nix"} {
		path := filepath.Join(computerPath, name)
		if err := os.MkdirAll(path, 0o700); err != nil {
			return 0, fmt.Errorf("create Computer %s directory: %w", name, err)
		}
		if err := validateOwnedDirectory(path, uid, gid); err != nil {
			return 0, fmt.Errorf("prepare Computer %s directory: %w", name, err)
		}
	}
	return 3, nil
}

func validateOwnedDirectory(path string, uid, gid uint32) error {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("path must be a real directory")
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(path, int(uid), int(gid)); err != nil {
			return err
		}
	}
	return os.Chmod(path, 0o700)
}

type workloadIdentity struct {
	UID            uint32 `json:"uid"`
	GID            uint32 `json:"gid"`
	FaultInjection bool   `json:"fault_injection,omitempty"`
}

func readIdentity(path string) (uint32, uint32, bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, false, fmt.Errorf("read workload identity: %w", err)
	}
	var identity workloadIdentity
	if err := json.Unmarshal(data, &identity); err != nil {
		return 0, 0, false, fmt.Errorf("decode workload identity: %w", err)
	}
	if identity.UID == 0 || identity.GID == 0 {
		return 0, 0, false, errors.New("workload identity must not be root")
	}
	if identity.UID == reservedProxyID || identity.GID == reservedProxyID {
		return 0, 0, false, errors.New("workload identity collides with reserved proxy identity")
	}
	return identity.UID, identity.GID, identity.FaultInjection, nil
}

func readSecret(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("RPC secret file must not be readable or writable by group/others")
	}
	secret, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(secret) < 32 {
		return nil, errors.New("RPC secret file must contain at least 32 bytes")
	}
	return secret, nil
}

type stdioConnection struct{}

func (stdioConnection) Read(data []byte) (int, error)  { return os.Stdin.Read(data) }
func (stdioConnection) Write(data []byte) (int, error) { return os.Stdout.Write(data) }
func (stdioConnection) Close() error                   { return nil }

var _ io.ReadWriteCloser = stdioConnection{}
