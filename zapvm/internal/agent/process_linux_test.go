//go:build linux

package agent

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestLinuxIsolationStartsInsideCgroupAndPIDNamespace(t *testing.T) {
	if os.Getenv("ZAPVM_TEST_ISOLATION") != "1" {
		t.Skip("set ZAPVM_TEST_ISOLATION=1 in a privileged cgroup v2 environment")
	}
	command := exec.Command("/bin/sh", "-c", `printf 'pid=%s ' "$$"; cat /proc/self/cgroup`)
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	isolation, err := prepareProcess(command, uint32(os.Geteuid()), uint32(os.Getegid()), true, "", "test-session", "test-request", "", "/workspace", []string{".git"}, []string{"**/.env"})
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
