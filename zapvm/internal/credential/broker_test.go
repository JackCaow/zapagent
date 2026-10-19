package credential

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBrokerLoadsResolvesCopiesAndZeroes(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "token")
	if err := os.WriteFile(path, []byte("secret-value"), 0o600); err != nil {
		t.Fatal(err)
	}
	broker, err := Load([]string{"api-token=" + path})
	if err != nil {
		t.Fatal(err)
	}
	if ids := broker.IDs(); len(ids) != 1 || ids[0] != "api-token" {
		t.Fatalf("IDs = %v", ids)
	}
	first, err := broker.Resolve([]string{"api-token"})
	if err != nil {
		t.Fatal(err)
	}
	first["api-token"][0] = 'X'
	second, err := broker.Resolve([]string{"api-token"})
	if err != nil {
		t.Fatal(err)
	}
	if string(second["api-token"]) != "secret-value" {
		t.Fatalf("broker value was aliased: %q", second["api-token"])
	}
	ZeroValues(first)
	ZeroValues(second)
	broker.Close()
	if _, err := broker.Resolve([]string{"api-token"}); err == nil {
		t.Fatal("closed broker resolved a value")
	}
}

func TestBrokerScopeDigestIsStableAndValueBound(t *testing.T) {
	directory := t.TempDir()
	first := filepath.Join(directory, "first")
	second := filepath.Join(directory, "second")
	if err := os.WriteFile(first, []byte("alpha"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("beta"), 0o600); err != nil {
		t.Fatal(err)
	}
	left, err := Load([]string{"b=" + second, "a=" + first})
	if err != nil {
		t.Fatal(err)
	}
	defer left.Close()
	right, err := Load([]string{"a=" + first, "b=" + second})
	if err != nil {
		t.Fatal(err)
	}
	defer right.Close()
	leftDigest, err := left.ScopeDigest()
	if err != nil {
		t.Fatal(err)
	}
	rightDigest, err := right.ScopeDigest()
	if err != nil {
		t.Fatal(err)
	}
	if leftDigest != rightDigest || len(leftDigest) != 64 {
		t.Fatalf("scope digests = %q, %q", leftDigest, rightDigest)
	}
	if err := os.WriteFile(second, []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	changed, err := Load([]string{"a=" + first, "b=" + second})
	if err != nil {
		t.Fatal(err)
	}
	defer changed.Close()
	changedDigest, err := changed.ScopeDigest()
	if err != nil {
		t.Fatal(err)
	}
	if changedDigest == leftDigest {
		t.Fatal("credential value change did not change scope digest")
	}
}

func TestBrokerRejectsUnsafeBindings(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "token")
	if err := os.WriteFile(path, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(directory, "link")
	if err := os.Symlink(path, symlink); err != nil {
		t.Fatal(err)
	}
	for name, bindings := range map[string][]string{
		"missing separator": {path},
		"invalid id":        {"../token=" + path},
		"relative path":     {"token=relative"},
		"duplicate":         {"token=" + path, "token=" + path},
		"symlink":           {"token=" + symlink},
	} {
		t.Run(name, func(t *testing.T) {
			if broker, err := Load(bindings); err == nil {
				broker.Close()
				t.Fatal("unsafe binding was accepted")
			}
		})
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if broker, err := Load([]string{"token=" + path}); err == nil {
			broker.Close()
			t.Fatal("group/other-readable credential was accepted")
		}
	}
}

func TestBrokerLimitsAndUnknownIDs(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "token")
	if err := os.WriteFile(path, bytes.Repeat([]byte{'x'}, MaxValueSize+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if broker, err := Load([]string{"token=" + path}); err == nil {
		broker.Close()
		t.Fatal("oversized credential was accepted")
	}
	if err := os.WriteFile(path, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	broker, err := Load([]string{"token=" + path})
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Close()
	if _, err := broker.Resolve([]string{"missing"}); err == nil || !strings.Contains(err.Error(), "not authorized") {
		t.Fatalf("unknown credential error = %v", err)
	}
}
