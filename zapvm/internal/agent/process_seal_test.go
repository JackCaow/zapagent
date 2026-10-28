package agent

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCgroupEmptyRequiresExplicitValidObservation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events")
	for _, content := range []string{"", "frozen 0\n", "populated x\n", "populated 0\npopulated 1\n"} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := waitCgroupEmpty(path, 20*time.Millisecond); err == nil {
			t.Fatalf("accepted malformed event %q", content)
		}
	}
	if err := os.WriteFile(path, []byte("populated 1\nfrozen 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := waitCgroupEmpty(path, 20*time.Millisecond); err == nil {
		t.Fatal("accepted populated cgroup")
	}
	if err := os.WriteFile(path, []byte("populated 0\nfrozen 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := waitCgroupEmpty(path, 20*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := waitCgroupEmpty(path, 20*time.Millisecond); err == nil {
		t.Fatal("accepted missing cgroup")
	}
}
