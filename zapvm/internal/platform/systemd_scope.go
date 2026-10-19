package platform

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

const minimumSystemdVersion = 254

func parseSystemdVersion(output string) (int, error) {
	fields := strings.Fields(strings.TrimSpace(output))
	if len(fields) < 2 || fields[0] != "systemd" {
		return 0, fmt.Errorf("unrecognized systemd version output %q", strings.TrimSpace(output))
	}
	value := strings.TrimRightFunc(fields[1], func(character rune) bool {
		return character < '0' || character > '9'
	})
	version, err := strconv.Atoi(value)
	if err != nil || version <= 0 {
		return 0, fmt.Errorf("unrecognized systemd version %q", fields[1])
	}
	return version, nil
}

func systemdScopeUnitName(vmID, runtimeDirectory string) string {
	digest := sha256.Sum256([]byte(vmID + "\x00" + filepath.Base(runtimeDirectory)))
	return "zapvm-" + hex.EncodeToString(digest[:8]) + ".scope"
}

func systemdScopeArguments(unitName, executablePath, configPath string, spec Spec) []string {
	memoryLimit := spec.MemoryBytes + 512*MiB
	tasksLimit := uint64(spec.CPUCount)*128 + 256
	cpuQuota := strconv.FormatUint(uint64(spec.CPUCount)*100, 10) + "%"
	return []string{
		"--user",
		"--scope",
		"--quiet",
		"--collect",
		"--no-ask-password",
		"--expand-environment=no",
		"--unit=" + unitName,
		"--description=zapVM " + spec.ID,
		"--property=CPUAccounting=yes",
		"--property=MemoryAccounting=yes",
		"--property=TasksAccounting=yes",
		"--property=IOAccounting=yes",
		"--property=MemoryMax=" + strconv.FormatUint(memoryLimit, 10),
		"--property=MemorySwapMax=0",
		"--property=TasksMax=" + strconv.FormatUint(tasksLimit, 10),
		"--property=CPUQuota=" + cpuQuota,
		"--",
		executablePath,
		"_linux-vmm-supervisor",
		"--config",
		configPath,
	}
}
