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

// The kernel and Python package family must remain consistent across the two
// supported guest architectures when the exact package closure is refreshed.
func TestRootfsLocksKeepSharedKernelAndPythonVersions(t *testing.T) {
	locks := make(map[string]map[string]string)
	for _, arch := range []string{"arm64", "amd64"} {
		data, err := os.ReadFile(filepath.Join("../../packaging/guest", "rootfs-packages-"+arch+".lock"))
		if err != nil {
			t.Fatal(err)
		}
		locks[arch] = make(map[string]string)
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			name, version, ok := strings.Cut(line, "=")
			if !ok || version == "" {
				t.Fatalf("invalid %s lock entry %q", arch, line)
			}
			locks[arch][name] = version
		}
	}
	for _, name := range []string{"linux-virt", "python3", "python3-pyc", "python3-pycache-pyc0", "pyc"} {
		if locks["arm64"][name] == "" || locks["arm64"][name] != locks["amd64"][name] {
			t.Fatalf("inconsistent %s version across guest architectures", name)
		}
	}
	for _, arch := range []string{"arm64", "amd64"} {
		for _, name := range []string{"python3-pyc", "python3-pycache-pyc0", "pyc"} {
			if locks[arch][name] != locks[arch]["python3"] {
				t.Fatalf("%s %s is out of sync with python3", arch, name)
			}
		}
	}
}

func TestLinuxBuilderLocksRejectTampering(t *testing.T) {
	testLinuxPackageLockRejectsTampering(t, "install-linux-builder-packages.sh", "builder")
}

func TestImageConverterLocksRejectTampering(t *testing.T) {
	testLinuxPackageLockRejectsTampering(t, "install-image-converter-packages.sh", "converter")
}

func testLinuxPackageLockRejectsTampering(t *testing.T, scriptName, kind string) {
	if runtime.GOOS == "windows" {
		t.Skip("Guest image construction requires a POSIX host")
	}
	script, err := filepath.Abs("../../scripts/" + scriptName)
	if err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs("../../packaging/linux")
	if err != nil {
		t.Fatal(err)
	}
	for _, arch := range []string{"arm64", "amd64"} {
		t.Run(arch, func(t *testing.T) {
			if out, err := exec.Command("sh", script, root, arch, "--verify-only").CombinedOutput(); err != nil {
				t.Fatalf("valid builder lock: %s: %v", out, err)
			}
			dir := t.TempDir()
			for _, name := range []string{"runtime-lock.env", kind + "-packages-" + arch + ".lock"} {
				data, err := os.ReadFile(filepath.Join(root, name))
				if err != nil {
					t.Fatal(err)
				}
				if name != "runtime-lock.env" {
					data = append(data, []byte("tamper=1\n")...)
				}
				if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			marker := filepath.Join(dir, "apk-called")
			if err := os.WriteFile(filepath.Join(dir, "apk"), []byte("#!/bin/sh\ntouch \"$BUILDER_TEST_MARKER\"\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command("sh", script, dir, arch)
			cmd.Env = append(os.Environ(), "PATH="+dir+string(os.PathListSeparator)+os.Getenv("PATH"), "BUILDER_TEST_MARKER="+marker)
			out, err := cmd.CombinedOutput()
			if err == nil || !strings.Contains(string(out), "digest mismatch") {
				t.Fatalf("tampered builder lock accepted: %s: %v", out, err)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatalf("apk ran with an invalid lock: %v", err)
			}
		})
	}
}

func TestLinuxRuntimeMetadataRejectsAlterationAndSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX build tooling")
	}
	script, err := filepath.Abs("../../scripts/verify-linux-builder-metadata.sh")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	tool, packages := "rustc 1.88.0\ncargo 1.88.0\n", "musl-dev-1.2.5-r13\n"
	lock := fmt.Sprintf("RUST_BUILDER_TOOLCHAIN_SHA256=%x\nRUST_BUILDER_PACKAGES_METADATA_SHA256=%x\n", sha256.Sum256([]byte(tool)), sha256.Sum256([]byte(packages)))
	for name, data := range map[string]string{"runtime-lock.env": lock, "rust-toolchain.txt": tool, "builder-packages.txt": packages} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	check := func(wantSuccess bool) {
		t.Helper()
		out, err := exec.Command("sh", script, dir, dir).CombinedOutput()
		if (err == nil) != wantSuccess {
			t.Fatalf("metadata check: %s: %v", out, err)
		}
	}
	check(true)
	if err := os.WriteFile(filepath.Join(dir, "builder-packages.txt"), []byte("tampered\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	check(false)
	if err := os.Remove(filepath.Join(dir, "builder-packages.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("rust-toolchain.txt", filepath.Join(dir, "builder-packages.txt")); err != nil {
		t.Fatal(err)
	}
	check(false)
}
