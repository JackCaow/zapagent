//go:build darwin || linux

package main

import (
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

func configureDaemonWorkerProcess(command *exec.Cmd) {
	// A foreground daemon may itself have a controlling terminal. Give the VM
	// worker a separate session so daemon termination closes stdin (and lets the
	// stdio protocol drain) instead of also delivering terminal SIGHUP.
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func prepareDaemonWorkerRuntime() {
	if os.Getenv("ZAPVM_DAEMON_WORKER") == "1" {
		signal.Ignore(syscall.SIGPIPE)
	}
}
