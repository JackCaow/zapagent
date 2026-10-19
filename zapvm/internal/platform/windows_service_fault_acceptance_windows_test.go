//go:build windows && acceptance_fault_injection

package platform

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAcceptanceFaultConfigIgnoresNonMatchingPoint(t *testing.T) {
	programData := t.TempDir()
	t.Setenv("ProgramData", programData)
	directory := filepath.Join(programData, "zapVM")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	config := `{"version":1,"point":"after-grant","grant_index":2,"nonce":"unit-test"}`
	configPath := filepath.Join(directory, windowsServiceFaultConfigName)
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := windowsServiceFaultPoint("after-grant", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(configPath); err != nil {
		t.Fatalf("non-matching config was consumed: %v", err)
	}
}

func TestAcceptanceFaultConfigRejectsUnknownField(t *testing.T) {
	programData := t.TempDir()
	t.Setenv("ProgramData", programData)
	directory := filepath.Join(programData, "zapVM")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	config := `{"version":1,"point":"after-grant","grant_index":2,"nonce":"unit-test","extra":true}`
	if err := os.WriteFile(filepath.Join(directory, windowsServiceFaultConfigName), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := windowsServiceFaultPoint("after-grant", 1); err == nil {
		t.Fatal("config with an unknown field was accepted")
	}
}

func TestAcceptanceFaultServiceInstallRequiresConfirmation(t *testing.T) {
	t.Setenv("ZAPVM_ACCEPTANCE_ALLOW_FAULT_SERVICE", "")
	if err := validateWindowsServiceFaultBinaryInstall(); err == nil {
		t.Fatal("fault-enabled service install was accepted without confirmation")
	}
	t.Setenv("ZAPVM_ACCEPTANCE_ALLOW_FAULT_SERVICE", windowsServiceFaultInstallConfirmation)
	if err := validateWindowsServiceFaultBinaryInstall(); err != nil {
		t.Fatal(err)
	}
}
