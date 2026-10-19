//go:build windows && !acceptance_fault_injection

package platform

import "testing"

func TestProductionWindowsServiceHasNoFaultInjection(t *testing.T) {
	if windowsServiceFaultInjectionEnabled {
		t.Fatal("production Windows service unexpectedly enables fault injection")
	}
	if err := windowsServiceFaultPoint("after-hcs-start", -1); err != nil {
		t.Fatalf("production fault point is not a no-op: %v", err)
	}
	if err := validateWindowsServiceFaultBinaryInstall(); err != nil {
		t.Fatalf("production service install was gated as a fault build: %v", err)
	}
}
