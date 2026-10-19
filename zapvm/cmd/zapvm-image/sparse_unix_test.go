//go:build !windows

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestCopyRegularPreservesLargeZeroRangesAsHoles(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "source.raw")
	destination := filepath.Join(directory, "destination.raw")
	// APFS may account a small sparse file as one 8 MiB physical extent even
	// when the middle is a hole. Use a larger logical range so the assertion
	// measures sparse preservation rather than filesystem allocation granularity.
	data := make([]byte, 64<<20)
	copy(data[:16], []byte("zapvm-sparse-test"))
	copy(data[len(data)-16:], []byte("zapvm-sparse-tail"))
	if err := os.WriteFile(source, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copyRegular(source, destination, 0o600); err != nil {
		t.Fatal(err)
	}
	copied, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(copied, data) {
		t.Fatal("sparse copy changed file content")
	}
	info, err := os.Stat(destination)
	if err != nil {
		t.Fatal(err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("missing Unix stat metadata")
	}
	if int64(stat.Blocks)*512 >= info.Size()/2 {
		t.Fatalf("destination was substantially materialized: blocks=%d size=%d", stat.Blocks, info.Size())
	}
}
