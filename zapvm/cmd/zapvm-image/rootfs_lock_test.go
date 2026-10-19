package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRootfsPackageLocks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Guest image construction requires a POSIX host")
	}
	script, err := filepath.Abs("../../scripts/install-rootfs-packages.sh")
	if err != nil {
		t.Fatal(err)
	}
	locks, err := filepath.Abs("../../packaging/guest")
	if err != nil {
		t.Fatal(err)
	}
	for _, arch := range []string{"arm64", "amd64"} {
		t.Run(arch, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(locks, "rootfs-packages-"+arch+".lock"))
			if err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			fakeAPK := filepath.Join(dir, "apk")
			if err := os.WriteFile(fakeAPK, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command("sh", script, locks, arch)
			cmd.Env = append(os.Environ(), "PATH="+dir+string(os.PathListSeparator)+os.Getenv("PATH"))
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("install: %s: %v", output, err)
			}
			if string(output) != "add\n--no-cache\n"+string(data) {
				t.Fatalf("apk did not receive every exact constraint: %s", output)
			}
			// A missing upstream exact version must fail without an unpinned retry.
			if err := os.WriteFile(fakeAPK, []byte("#!/bin/sh\necho exact-version-unavailable >&2\nexit 42\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			cmd = exec.Command("sh", script, locks, arch)
			cmd.Env = append(os.Environ(), "PATH="+dir+string(os.PathListSeparator)+os.Getenv("PATH"))
			output, err = cmd.CombinedOutput()
			if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 42 || strings.Count(string(output), "exact-version-unavailable") != 1 {
				t.Fatalf("missing exact version was not propagated: %s: %v", output, err)
			}
		})
	}
}

func TestRootfsPackageLockRejectsInvalidInput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Guest image construction requires a POSIX host")
	}
	script, err := filepath.Abs("../../scripts/install-rootfs-packages.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name, data, arch string
		count            int
		tamperDigest     bool
	}{
		{"digest mismatch", "bash=5.3.3-r1\n", "arm64", 1, true},
		{"unversioned", "bash\n", "arm64", 1, false},
		{"range", "bash>=5.3.3-r1\n", "arm64", 1, false},
		{"duplicate", "bash=5.3.3-r1\nbash=5.3.2-r1\n", "arm64", 2, false},
		{"truncated closure", "bash=5.3.3-r1\n", "arm64", 2, false},
		{"empty", "", "arm64", 1, false},
		{"option injection", "--allow-untrusted=1\n", "arm64", 1, false},
		{"shell text", "bash=1;touch /tmp/nope\n", "arm64", 1, false},
		{"unsupported arch", "bash=5.3.3-r1\n", "riscv64", 1, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			digest := fmt.Sprintf("%x", sha256.Sum256([]byte(tt.data)))
			if tt.tamperDigest {
				digest = strings.Repeat("0", 64)
			}
			lockEnv := fmt.Sprintf("APK_LOCK_ARM64_SHA256=%s\nAPK_INSTALLED_ARM64_PACKAGES=%d\n", digest, tt.count)
			for name, data := range map[string]string{
				"rootfs-lock.env":            lockEnv,
				"rootfs-packages-arm64.lock": tt.data,
				"apk":                        "#!/bin/sh\necho APK_MUST_NOT_RUN\nexit 0\n",
			} {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			cmd := exec.Command("sh", script, dir, tt.arch)
			cmd.Env = append(os.Environ(), "PATH="+dir+string(os.PathListSeparator)+os.Getenv("PATH"))
			output, err := cmd.CombinedOutput()
			if err == nil || strings.Contains(string(output), "APK_MUST_NOT_RUN") {
				t.Fatalf("invalid lock reached apk: %s: %v", output, err)
			}
		})
	}
}
