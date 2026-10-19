package platform

import (
	"slices"
	"strings"
	"testing"
)

func TestParseSystemdVersion(t *testing.T) {
	for _, test := range []struct {
		input string
		want  int
	}{
		{"systemd 254 (254.18-1)", 254},
		{"systemd 255 (255.4-1ubuntu8.5)\n+PAM", 255},
		{"systemd 260~devel", 260},
	} {
		got, err := parseSystemdVersion(test.input)
		if err != nil || got != test.want {
			t.Fatalf("parseSystemdVersion(%q) = %d, %v; want %d", test.input, got, err, test.want)
		}
	}
	for _, input := range []string{"", "other 255", "systemd unknown"} {
		if _, err := parseSystemdVersion(input); err == nil {
			t.Fatalf("parseSystemdVersion(%q) unexpectedly succeeded", input)
		}
	}
}

func TestSystemdScopeArgumentsAreBoundedAndLiteral(t *testing.T) {
	spec := Spec{ID: "vm-$-name", CPUCount: 2, MemoryBytes: 2 * 1024 * MiB}
	unit := systemdScopeUnitName(spec.ID, "/run/user/501/zapvm-123")
	if !strings.HasPrefix(unit, "zapvm-") || !strings.HasSuffix(unit, ".scope") || strings.ContainsAny(unit, "$ /\\") {
		t.Fatalf("unsafe scope unit %q", unit)
	}
	arguments := systemdScopeArguments(unit, "/opt/zap vm/bin/zapvm", "/run/user/501/zapvm-$-123/supervisor.json", spec)
	for _, expected := range []string{
		"--user",
		"--scope",
		"--collect",
		"--expand-environment=no",
		"--property=MemoryMax=2684354560",
		"--property=MemorySwapMax=0",
		"--property=TasksMax=512",
		"--property=CPUQuota=200%",
		"/opt/zap vm/bin/zapvm",
		"/run/user/501/zapvm-$-123/supervisor.json",
	} {
		if !slices.Contains(arguments, expected) {
			t.Fatalf("scope arguments missing %q: %#v", expected, arguments)
		}
	}
	separator := slices.Index(arguments, "--")
	if separator < 0 || separator+4 >= len(arguments) || arguments[separator+2] != "_linux-vmm-supervisor" || arguments[separator+3] != "--config" {
		t.Fatalf("unexpected command separator: %#v", arguments)
	}
}
