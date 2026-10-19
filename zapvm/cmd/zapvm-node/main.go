package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"zapvm/internal/clierror"
	"zapvm/internal/cloudnode"
)

var version = "0.1.0-dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fallback := clierror.Unavailable
		if len(os.Args) == 1 || containsArgument(os.Args[1:], "--validate") || containsArgument(os.Args[1:], "--print-daemon-endpoint") {
			fallback = clierror.InvalidConfiguration
		}
		os.Exit(clierror.Report(os.Stderr, err, fallback))
	}
}

func containsArgument(arguments []string, wanted string) bool {
	for _, argument := range arguments {
		if argument == wanted {
			return true
		}
	}
	return false
}

func run(args []string) error {
	flags := flag.NewFlagSet("zapvm-node", flag.ContinueOnError)
	configPath := flags.String("config", "", "owner-only cloud node JSON configuration")
	validateOnly := flags.Bool("validate", false, "validate configuration and mTLS authority without connecting")
	printDaemonEndpoint := flags.Bool("print-daemon-endpoint", false, "print the validated configured daemon endpoint without connecting")
	serviceRun := flags.Bool("service-run", false, "run as the native Windows zapvm-node service")
	showVersion := flags.Bool("version", false, "print version")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("zapvm-node accepts no positional arguments")
	}
	if *showVersion {
		fmt.Fprintln(os.Stdout, version)
		return nil
	}
	if *configPath == "" {
		return errors.New("zapvm-node requires --config")
	}
	config, err := cloudnode.LoadConfig(*configPath)
	if err != nil {
		return err
	}
	if *printDaemonEndpoint {
		if *validateOnly {
			return errors.New("zapvm-node accepts only one of --validate or --print-daemon-endpoint")
		}
		fmt.Fprintln(os.Stdout, config.DaemonEndpoint)
		return nil
	}
	if *serviceRun {
		if *validateOnly {
			return errors.New("zapvm-node accepts only one of --validate or --service-run")
		}
		return runWindowsNodeService(config, version)
	}
	if *validateOnly {
		if err := cloudnode.ValidateIdentityMaterial(config); err != nil {
			return err
		}
		fmt.Fprintf(os.Stdout, "schema=1 node_uri=%s control_uri=%s managed_identity=%t\n", config.NodeURI(), config.ControlURI(), config.ManagedIdentity())
		return nil
	}
	worker, err := cloudnode.NewWithVersion(config, os.Stderr, version)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return worker.Run(ctx)
}
