package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"zapvm/internal/agentadapter"
	dimadapter "zapvm/internal/agentadapter/dim"
	"zapvm/internal/clierror"
)

var version = "0.1.0-dev"

const maxAdapterRequestSize = 1 << 20

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdin, os.Stdout); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		os.Exit(clierror.Report(os.Stderr, err, clierror.InvalidRequest))
	}
}

func run(ctx context.Context, args []string, input io.Reader, output io.Writer) error {
	registry, err := agentadapter.NewRegistry(dimadapter.New())
	if err != nil {
		return err
	}
	if len(args) == 0 {
		return errors.New("usage: zapvm-agent-adapter run|list|version")
	}
	switch args[0] {
	case "run":
		if len(args) != 1 {
			return errors.New("adapter run does not accept arguments")
		}
		return runAdapter(ctx, registry, input, output, defaultExecutor)
	case "list":
		if len(args) != 1 {
			return errors.New("adapter list does not accept arguments")
		}
		for _, name := range registry.Names() {
			fmt.Fprintln(output, name)
		}
		return nil
	case "version", "--version", "-version":
		if len(args) != 1 {
			return errors.New("adapter version does not accept arguments")
		}
		fmt.Fprintln(output, version)
		return nil
	case "help", "--help", "-h":
		fmt.Fprintln(output, "usage: zapvm-agent-adapter run|list|version")
		return nil
	default:
		return fmt.Errorf("unknown adapter command %q", args[0])
	}
}

func runAdapter(
	ctx context.Context,
	registry *agentadapter.Registry,
	input io.Reader,
	output io.Writer,
	executorFactory func() (agentadapter.Executor, error),
) error {
	data, err := io.ReadAll(io.LimitReader(input, maxAdapterRequestSize+1))
	if err != nil {
		return fmt.Errorf("read Agent adapter request: %w", err)
	}
	if len(data) == 0 || len(data) > maxAdapterRequestSize {
		return errors.New("Agent adapter request is empty or exceeds 1 MiB")
	}
	protocol, request, err := registry.Decode(data)
	if err != nil {
		return err
	}
	executor, err := executorFactory()
	if err != nil {
		return err
	}
	result := executor.Execute(ctx, request)
	if err := protocol.EncodeResult(output, request, result); err != nil {
		return fmt.Errorf("encode %s result: %w", protocol.Name(), err)
	}
	return nil
}

func defaultExecutor() (agentadapter.Executor, error) {
	binary, err := agentadapter.ResolveZapVMBinary(strings.TrimSpace(os.Getenv("ZAPVM_BIN")))
	if err != nil {
		return nil, err
	}
	return agentadapter.NewCLIExecutor(agentadapter.CLIExecutorOptions{
		Binary: binary, Endpoint: strings.TrimSpace(os.Getenv("ZAPVM_ENDPOINT")),
	})
}
