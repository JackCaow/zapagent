//go:build darwin || linux

package localipc

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOwnerOnlySocketAuthenticatesSameUIDPeer(t *testing.T) {
	directory := shortTempDir(t)
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	endpoint := filepath.Join(directory, "daemon.sock")
	listener, err := Listen(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	info, err := os.Lstat(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode = %s", info.Mode())
	}
	serverDone := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverDone <- acceptErr
			return
		}
		defer connection.Close()
		buffer := make([]byte, 4)
		if _, acceptErr = io.ReadFull(connection, buffer); acceptErr == nil && string(buffer) != "ping" {
			acceptErr = errors.New("unexpected request")
		}
		if acceptErr == nil {
			_, acceptErr = connection.Write([]byte("pong"))
		}
		serverDone <- acceptErr
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	client, err := Dial(ctx, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	response := make([]byte, 4)
	if _, err := io.ReadFull(client, response); err != nil {
		t.Fatal(err)
	}
	_ = client.Close()
	if string(response) != "pong" {
		t.Fatalf("response = %q", response)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(endpoint); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket path survived listener close: %v", err)
	}
}

func TestUnixListenerRejectsInsecureParentAndExistingEndpoint(t *testing.T) {
	directory := shortTempDir(t)
	if err := os.Chmod(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	endpoint := filepath.Join(directory, "daemon.sock")
	if _, err := Listen(endpoint); err == nil {
		t.Fatal("listener accepted group/world-readable parent")
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(endpoint, []byte("do-not-replace"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Listen(endpoint); err == nil {
		t.Fatal("listener replaced an existing endpoint")
	}
	data, err := os.ReadFile(endpoint)
	if err != nil || string(data) != "do-not-replace" {
		t.Fatalf("existing endpoint changed: %q, %v", data, err)
	}
}

func TestRecoveringListenerReclaimsOnlyStaleSocket(t *testing.T) {
	directory := shortTempDir(t)
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	endpoint := filepath.Join(directory, "daemon.sock")
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Name: endpoint, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	stale.SetUnlinkOnClose(false)
	if err := stale.Close(); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(endpoint); err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("stale socket setup failed: %v, %v", info, err)
	}
	recovered, err := ListenRecovering(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ListenRecovering(endpoint); err == nil {
		t.Fatal("second daemon acquired an active endpoint")
	}
	if err := recovered.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(endpoint); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("recovered listener left socket after close: %v", err)
	}
}

func TestRecoveringListenerPreservesNonSocketAndRejectsSymlinkLock(t *testing.T) {
	directory := shortTempDir(t)
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	endpoint := filepath.Join(directory, "daemon.sock")
	if err := os.WriteFile(endpoint, []byte("do-not-replace"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ListenRecovering(endpoint); err == nil {
		t.Fatal("recovering listener replaced a regular file")
	}
	data, err := os.ReadFile(endpoint)
	if err != nil || string(data) != "do-not-replace" {
		t.Fatalf("regular endpoint changed: %q, %v", data, err)
	}
	if err := os.Remove(endpoint); err != nil {
		t.Fatal(err)
	}
	lockTarget := filepath.Join(directory, "lock-target")
	if err := os.WriteFile(lockTarget, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(endpoint + ".lock"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(lockTarget, endpoint+".lock"); err != nil {
		t.Fatal(err)
	}
	if _, err := ListenRecovering(endpoint); err == nil {
		t.Fatal("recovering listener followed a symlink ownership lock")
	}
}

func shortTempDir(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "zli-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return directory
}
