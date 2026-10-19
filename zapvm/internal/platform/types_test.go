package platform

import (
	"strings"
	"testing"
)

func validTestSpec() Spec {
	return Spec{ID: "test", CPUCount: 2, MemoryBytes: 512 * MiB, KernelPath: "/kernel", RootDiskPath: "/root", Network: NetworkOff}
}

func TestSpecResourceAndStringBounds(t *testing.T) {
	tests := []func(*Spec){
		func(spec *Spec) { spec.ID = strings.Repeat("x", 257) },
		func(spec *Spec) { spec.ID = "bad\x00id" },
		func(spec *Spec) { spec.CPUCount = 257 },
		func(spec *Spec) { spec.MemoryBytes = 1024*1024*MiB + MiB },
		func(spec *Spec) { spec.KernelPath = "/bad\x00path" },
		func(spec *Spec) { spec.KernelCmdline = "ok\ninit=/init" },
		func(spec *Spec) { spec.KernelCmdline = strings.Repeat("x", 32769) },
	}
	for index, mutate := range tests {
		spec := validTestSpec()
		mutate(&spec)
		if err := spec.Validate(); err == nil {
			t.Fatalf("case %d unexpectedly accepted", index)
		}
	}
}

func TestSpecUpperBoundsAccepted(t *testing.T) {
	spec := validTestSpec()
	spec.CPUCount = 256
	spec.MemoryBytes = 1024 * 1024 * MiB
	spec.KernelCmdline = strings.Repeat("x", 32768)
	if err := spec.Validate(); err != nil {
		t.Fatal(err)
	}
}
