//go:build windows

package main

import "os/exec"

func configureDaemonWorkerProcess(command *exec.Cmd) {}

func prepareDaemonWorkerRuntime() {}
