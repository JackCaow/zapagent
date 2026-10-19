package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type mountConfig struct {
	target     string
	share      string
	port       uint32
	readOnly   bool
	executable bool
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "zapvm-plan9-mount:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("zapvm-plan9-mount", flag.ContinueOnError)
	target := flags.String("target", "", "absolute guest mount point")
	share := flags.String("share", "", "HCS Plan9 AccessName")
	port := flags.Uint("port", 564, "Host Plan9 VSOCK port")
	readOnly := flags.Bool("readonly", false, "mount read-only")
	executable := flags.Bool("executable", false, "allow execution from the mounted share")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *target == "" || *share == "" || *port == 0 || *port > uint(^uint32(0)) {
		return errors.New("--target, --share, and a non-zero uint32 --port are required")
	}
	if !filepath.IsAbs(*target) {
		return errors.New("target must be absolute")
	}
	if !validShareName(*share) {
		return errors.New("share must contain only ASCII letters, digits, dot, underscore, or hyphen")
	}
	if *readOnly && *executable {
		return errors.New("read-only shares cannot be marked executable")
	}
	config := mountConfig{
		target: filepath.Clean(*target), share: *share, port: uint32(*port),
		readOnly: *readOnly, executable: *executable,
	}
	return mountPlan9(config)
}

func validShareName(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || strings.ContainsRune("._-", character) {
			continue
		}
		return false
	}
	return true
}

func plan9MountData(fd int, share string) string {
	return "trans=fd,rfdno=" + strconv.Itoa(fd) + ",wfdno=" + strconv.Itoa(fd) +
		",msize=65536,version=9p2000.L,cache=none,aname=" + share
}
