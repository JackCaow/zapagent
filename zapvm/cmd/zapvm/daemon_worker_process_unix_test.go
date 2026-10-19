//go:build darwin || linux

package main

import (
	"context"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestDaemonWorkerUsesIndependentProcessSession(t *testing.T) {
	t.Setenv("GO_WANT_DAEMON_WORKER_HELPER", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	worker, err := startDaemonStdioWorker(ctx, os.Args[0], []string{"-test.run=^TestDaemonWorkerHelper$"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer stopCancel()
	defer worker.Stop(stopCtx)
	childPID := worker.command.Process.Pid
	childSession, err := unix.Getsid(childPID)
	if err != nil {
		t.Fatal(err)
	}
	parentSession, err := unix.Getsid(0)
	if err != nil {
		t.Fatal(err)
	}
	if childSession != childPID || childSession == parentSession {
		t.Fatalf("child PID/session = %d/%d, parent session = %d", childPID, childSession, parentSession)
	}
}
