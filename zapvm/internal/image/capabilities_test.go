package image

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDecodeCapabilitiesRejectsUnknownContract(t *testing.T) {
	data := []byte(`{"schema_version":1,"rootfs_mode":"writable","workspace_mode":"read-write-executable","protected_workspace_paths":[".git"],"temporary_storage_scope":"request","temporary_storage_executable":true,"runtime_package_management":"image-build-only","commands":["python3"],"network_modes":["off"]}`)
	if _, err := DecodeCapabilities(data); err == nil {
		t.Fatal("writable rootfs contract was accepted")
	}
}

func TestDecodeCapabilitiesAcceptsPersistentRootlessPackageManagement(t *testing.T) {
	data := []byte(`{"schema_version":1,"rootfs_mode":"read-only","workspace_mode":"read-write-executable","protected_workspace_paths":[".git",".zapcode"],"temporary_storage_scope":"request","temporary_storage_executable":true,"runtime_package_management":"persistent-rootless","commands":["bash","zap-pkg"],"network_modes":["off","restricted"]}`)
	capabilities, err := DecodeCapabilities(data)
	if err != nil {
		t.Fatal(err)
	}
	if capabilities.RuntimePackageManagement != "persistent-rootless" {
		t.Fatalf("runtime package management = %q", capabilities.RuntimePackageManagement)
	}
}

func TestDecodeCapabilitiesAcceptsHostRuntimeWithoutResidentAgent(t *testing.T) {
	data := []byte(`{"schema_version":1,"image_profile":"host-runtime","rootfs_mode":"read-only","workspace_mode":"read-write-executable","protected_workspace_paths":[".git"],"temporary_storage_scope":"request","temporary_storage_executable":true,"runtime_package_management":"persistent-rootless","agent_adapter":{"contract":"acp-resident-v1","entrypoint":"/usr/local/sbin/zapvm-resident-agent","output_format":"stream-json"},"commands":["bash","zap-pkg"],"network_modes":["off","restricted","unrestricted"]}`)
	capabilities, err := DecodeCapabilities(data)
	if err != nil {
		t.Fatal(err)
	}
	if capabilities.ImageProfile != ProfileHostRuntime || capabilities.ResidentAgent != nil || capabilities.AgentAdapter == nil {
		t.Fatalf("unexpected Host capabilities: %+v", capabilities)
	}
}

func TestDecodeCapabilitiesKeepsLegacyAdapterNonPluggable(t *testing.T) {
	data := []byte(`{"schema_version":1,"image_profile":"host-runtime","rootfs_mode":"read-only","workspace_mode":"read-write-executable","protected_workspace_paths":[".git"],"temporary_storage_scope":"request","temporary_storage_executable":true,"runtime_package_management":"persistent-rootless","agent_adapter":{"entrypoint":"/usr/local/sbin/zapvm-resident-agent","output_format":"stream-json"},"commands":["bash"],"network_modes":["off"]}`)
	capabilities, err := DecodeCapabilities(data)
	if err != nil {
		t.Fatal(err)
	}
	if capabilities.AgentAdapter == nil || capabilities.AgentAdapter.Contract != "" {
		t.Fatalf("legacy Agent adapter unexpectedly became pluggable: %+v", capabilities.AgentAdapter)
	}
}

func TestReadActiveCapabilitiesVerifiesSignedFile(t *testing.T) {
	root, publicKey := writeInstalledFixture(t, "1.0.0-capabilities", "arm64")
	capabilities, err := ReadActiveCapabilities(root, publicKey, "arm64")
	if err != nil {
		t.Fatal(err)
	}
	if capabilities.RootFSMode != "read-only" || capabilities.WorkspaceMode != "read-write-executable" {
		t.Fatalf("unexpected capabilities: %+v", capabilities)
	}
	path := filepath.Join(root, "1.0.0-capabilities", CapabilitiesFileName)
	if err := os.WriteFile(path, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadActiveCapabilities(root, publicKey, "arm64"); err == nil {
		t.Fatal("tampered capabilities file was accepted")
	}
}
