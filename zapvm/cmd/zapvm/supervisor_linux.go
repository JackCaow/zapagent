//go:build linux

package main

import (
	"errors"
	"flag"
	"os"

	"zapvm/internal/platform"
)

func runLinuxVMMSupervisor(args []string) error {
	flags := flag.NewFlagSet("_linux-vmm-supervisor", flag.ContinueOnError)
	configPath := flags.String("config", "", "private Linux VMM supervisor configuration")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *configPath == "" || flags.NArg() != 0 {
		return errors.New("Linux VMM supervisor requires exactly one --config path")
	}
	return platform.RunLinuxVMMSupervisor(*configPath, os.Stdout, os.Stderr)
}
