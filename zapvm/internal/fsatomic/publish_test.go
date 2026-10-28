package fsatomic

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestPublishDirectoryNeverReplacesExistingDirectory(t *testing.T) {
	root := t.TempDir()
	source, destination := filepath.Join(root, "source"), filepath.Join(root, "destination")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(destination, 0700); err != nil {
		t.Fatal(err)
	}
	if err := PublishDirectory(source, destination); err == nil {
		t.Fatal("replaced existing empty directory")
	}
	if _, err := os.Stat(source); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentPublishHasExactlyOneWinner(t *testing.T) {
	root := t.TempDir()
	destination := filepath.Join(root, "destination")
	sources := []string{filepath.Join(root, "one"), filepath.Join(root, "two")}
	for _, source := range sources {
		if err := os.Mkdir(source, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(source, "owner"), []byte(filepath.Base(source)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	results := make([]error, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	for i := range sources {
		go func(i int) { defer wg.Done(); results[i] = PublishDirectory(sources[i], destination) }(i)
	}
	wg.Wait()
	if (results[0] == nil) == (results[1] == nil) {
		t.Fatalf("wanted one winner: %v", results)
	}
	owner, err := os.ReadFile(filepath.Join(destination, "owner"))
	if err != nil {
		t.Fatal(err)
	}
	want := "one"
	if results[1] == nil {
		want = "two"
	}
	if string(owner) != want {
		t.Fatalf("published %q want %q", owner, want)
	}
}

func TestPublishDirectoryRejectsSymlinkSource(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "link")
	if err := os.Symlink(target, source); err != nil {
		t.Skip(err)
	}
	if err := PublishDirectory(source, filepath.Join(root, "destination")); err == nil {
		t.Fatal("published symlink")
	}
}
