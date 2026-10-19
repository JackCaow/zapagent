package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"regexp"
	"time"

	"zapvm/internal/cloudplane"
	"zapvm/internal/controlpostgres"
)

var environmentName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "zapvm-control-db:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("zapvm-control-db", flag.ContinueOnError)
	dsnEnvironment := flags.String("dsn-env", "ZAPVM_POSTGRES_DSN", "environment variable containing the PostgreSQL DSN")
	allowInsecureLocalhost := flags.Bool("development-insecure-localhost", false, "allow sslmode=disable only for loopback development PostgreSQL")
	timeout := flags.Duration("timeout", 2*time.Minute, "bounded PostgreSQL operation timeout")
	controlConfig := flags.String("control-config", "", "owner-only Control config used to lock and validate state.json")
	repairDrift := flags.Bool("repair-drift", false, "replace a tracked PostgreSQL mirror only after detected drift")
	replaceUntracked := flags.Bool("replace-untracked", false, "replace non-empty PostgreSQL state without mirror metadata")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return errors.New("usage: zapvm-control-db [options] migrate|status|import-file|verify-file")
	}
	command := flags.Arg(0)
	if command != "migrate" && command != "status" && command != "import-file" && command != "verify-file" {
		return errors.New("usage: zapvm-control-db [options] migrate|status|import-file|verify-file")
	}
	fileCommand := command == "import-file" || command == "verify-file"
	if fileCommand != (*controlConfig != "") {
		return errors.New("--control-config is required only for import-file and verify-file")
	}
	if command != "import-file" && (*repairDrift || *replaceUntracked) {
		return errors.New("drift replacement options require import-file")
	}
	if !environmentName.MatchString(*dsnEnvironment) {
		return errors.New("DSN environment variable name is invalid")
	}
	if *timeout < time.Second || *timeout > 30*time.Minute {
		return errors.New("timeout must be between 1 second and 30 minutes")
	}
	dsn, exists := os.LookupEnv(*dsnEnvironment)
	if !exists || dsn == "" {
		return fmt.Errorf("PostgreSQL DSN environment variable %s is not set", *dsnEnvironment)
	}
	_ = os.Unsetenv(*dsnEnvironment)
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	migrator, err := controlpostgres.Open(ctx, dsn, controlpostgres.OpenOptions{AllowInsecureLocalhost: *allowInsecureLocalhost})
	if err != nil {
		return err
	}
	defer migrator.Close()
	var output any
	switch command {
	case "migrate":
		output, err = migrator.Apply(ctx)
	case "status":
		output, err = migrator.Status(ctx)
	case "import-file", "verify-file":
		if command == "import-file" {
			if _, err = migrator.Apply(ctx); err != nil {
				break
			}
		}
		var snapshot cloudplane.OfflineSnapshot
		var lockedStore *cloudplane.Store
		snapshot, lockedStore, err = openOfflineSnapshot(*controlConfig)
		if err != nil {
			break
		}
		if command == "import-file" {
			output, err = migrator.ImportFileSnapshot(ctx, snapshot, controlpostgres.FileImportOptions{RepairDrift: *repairDrift, ReplaceUntracked: *replaceUntracked})
		} else {
			output, err = migrator.VerifyFileSnapshot(ctx, snapshot)
		}
		err = errors.Join(err, lockedStore.Close())
	}
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(true)
	return encoder.Encode(output)
}

func openOfflineSnapshot(configPath string) (cloudplane.OfflineSnapshot, *cloudplane.Store, error) {
	config, err := cloudplane.LoadConfig(configPath)
	if err != nil {
		return cloudplane.OfflineSnapshot{}, nil, err
	}
	store, err := cloudplane.Open(config.StateRoot, config.Nodes, config.StoreOptions())
	if err != nil {
		return cloudplane.OfflineSnapshot{}, nil, err
	}
	snapshot, err := store.OfflineSnapshot()
	if err != nil {
		return cloudplane.OfflineSnapshot{}, nil, errors.Join(err, store.Close())
	}
	return snapshot, store, nil
}
