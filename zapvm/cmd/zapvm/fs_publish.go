package main

import (
	"errors"
	"flag"
	"zapvm/internal/fsatomic"
)

// A low-level Host filesystem primitive; policy, durable intent and exclusive
// ownership of source and both parent directories are owned by the caller.
// It does not defend against a concurrent symlink or parent replacement.
// No copy fallback, replacement, workspace discovery, or hooks.
func runFsPublishDirectory(args []string) error {
	flags := flag.NewFlagSet("_fs-publish-directory", flag.ContinueOnError)
	source := flags.String("source", "", "absolute source directory")
	destination := flags.String("destination", "", "absolute destination")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *source == "" || *destination == "" {
		return errors.New("source and destination are required")
	}
	return fsatomic.PublishDirectory(*source, *destination)
}
