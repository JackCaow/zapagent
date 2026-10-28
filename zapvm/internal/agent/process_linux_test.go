//go:build linux

package agent

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const workloadUID, workloadGID = 65534, 65534

func privilegedTestWorkspace(t *testing.T) string {
	t.Helper()
	workspace := os.Getenv("ZAPVM_TEST_WORKSPACE")
	if workspace == "" {
		workspace = "/workspace"
	}
	root, err := os.MkdirTemp(workspace, "zapvm-seal-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	// Launcher mounts a new /tmp and runs as non-root, so fixtures must live
	// in the mounted workspace and be writable by the workload identity.
	if err := os.Chown(root, workloadUID, workloadGID); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestLinuxIsolationStartsInsideCgroupAndPIDNamespace(t *testing.T) {
	if os.Getenv("ZAPVM_TEST_ISOLATION") != "1" {
		t.Skip("set ZAPVM_TEST_ISOLATION=1 in a privileged cgroup v2 environment")
	}
	command := exec.Command("/bin/sh", "-c", `printf 'pid=%s ' "$$"; cat /proc/self/cgroup`)
	root := privilegedTestWorkspace(t)
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	command.Dir = root
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	// The real launcher refuses root workload identities, even though the test
	// process itself must run as root to set up namespaces and cgroups.
	isolation, err := prepareProcess(command, workloadUID, workloadGID, true, "", "test-session", "test-request", "", root, []string{".git"}, []string{"**/.env"})
	if err != nil {
		t.Fatal(err)
	}
	defer isolation.Cleanup()
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	if err := isolation.AfterStart(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("command failed: %v: %s", err, output.String())
	}
	if !strings.Contains(output.String(), "pid=1 ") {
		t.Fatalf("command did not become PID 1 in its namespace: %q", output.String())
	}
	if !strings.Contains(output.String(), "/zapvm/") {
		t.Fatalf("command did not start inside zapVM cgroup: %q", output.String())
	}
}

// Run inside the privileged Linux guest with ZAPVM_TEST_ISOLATION=1.
// The child deliberately detaches and closes inherited output; a process
// group-only kill would miss it and allow the delayed write.
func TestLinuxSealKillsSetsidDescendantBeforeReceipt(t *testing.T) {
	if os.Getenv("ZAPVM_TEST_ISOLATION") != "1" {
		t.Skip("set ZAPVM_TEST_ISOLATION=1 in a privileged cgroup v2 environment")
	}
	root := privilegedTestWorkspace(t)
	command := exec.Command("/bin/sh", "-c", `set -eu; command -v setsid >/dev/null; setsid /bin/sh -c 'touch ready; sleep 2; echo escaped > escaped' </dev/null >/dev/null 2>&1 & while [ ! -f ready ]; do sleep 0.01; done`)
	command.Dir = root
	isolation, err := prepareProcess(command, workloadUID, workloadGID, true, "", "test-seal", "test-setsid", "", root, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer isolation.Cleanup()
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	if err := isolation.AfterStart(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	seal, err := isolation.Seal()
	if err != nil || seal == nil || seal.Mechanism != "cgroup-v2" || seal.State != "empty" {
		t.Fatalf("invalid seal: %+v %v", seal, err)
	}
	time.Sleep(2200 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(root, "escaped")); !os.IsNotExist(err) {
		t.Fatalf("detached descendant wrote after seal: %v", err)
	}
}
