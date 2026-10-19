package platform

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildHCSConfigUsesVHDPlan9AndVSock(t *testing.T) {
	spec := Spec{
		ID: "workspace-a", CPUCount: 3, MemoryBytes: 1536 * MiB,
		KernelPath: `C:\images\kernel`, InitrdPath: `C:\images\initramfs`,
		RootDiskPath: `C:\images\rootfs.vhdx`, StateDiskPath: `C:\state\state.vhdx`, AgentDiskPath: `C:\images\agent.vhdx`,
		BootSharePath: `C:\boot`, WorkspacePath: `C:\work`, WorkspaceReadOnly: false,
		KernelCmdline: "root=/dev/vda ro", Network: NetworkOff,
	}
	vmID, document, err := buildHCSConfig(spec)
	if err != nil {
		t.Fatal(err)
	}
	if vmID != deterministicVMID(spec.ID) || len(vmID) != 36 {
		t.Fatalf("unexpected VM ID %q", vmID)
	}
	for _, expected := range []string{
		`"LinuxKernelDirect"`, `root=/dev/sda ro rootwait init=/sbin/init pci=off initcall_blacklist=virtio_vsock_init zapvm.agent_connect_cid=2`,
		`rootfs.vhdx`, `state.vhdx`, `agent.vhdx`, `"ReadOnly":true`, `"zapvm_boot"`, `"zapvm_workspace"`,
		`"00004a92-facb-11e6-bd58-64006a7986d3"`,
		`"00004a93-facb-11e6-bd58-64006a7986d3"`,
	} {
		if !strings.Contains(document, expected) {
			t.Fatalf("HCS document missing %s: %s", expected, document)
		}
	}
	var decoded struct {
		SchemaVersion struct {
			Major int `json:"Major"`
			Minor int `json:"Minor"`
		} `json:"SchemaVersion"`
		VirtualMachine struct {
			Chipset struct {
				LinuxKernelDirect struct {
					KernelCmdLine string `json:"KernelCmdLine"`
				} `json:"LinuxKernelDirect"`
			} `json:"Chipset"`
			ComputeTopology struct {
				Memory map[string]json.RawMessage `json:"Memory"`
			} `json:"ComputeTopology"`
			Devices struct {
				Plan9 struct {
					Shares []struct {
						Name                 string `json:"Name"`
						AccessName           string `json:"AccessName"`
						Flags                int    `json:"Flags"`
						ReadOnly             *bool  `json:"ReadOnly"`
						UseShareRootIdentity *bool  `json:"UseShareRootIdentity"`
					} `json:"Shares"`
				} `json:"Plan9"`
			} `json:"Devices"`
		} `json:"VirtualMachine"`
	}
	if err := json.Unmarshal([]byte(document), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.SchemaVersion.Major != 2 || decoded.SchemaVersion.Minor != 1 {
		t.Fatalf("schema version = %d.%d, want 2.1", decoded.SchemaVersion.Major, decoded.SchemaVersion.Minor)
	}
	if _, exists := decoded.VirtualMachine.ComputeTopology.Memory["Backing"]; exists {
		t.Fatal("ordinary LCOW document must not force a memory backing extension")
	}
	shares := decoded.VirtualMachine.Devices.Plan9.Shares
	if len(shares) != 2 || shares[0].Name != "0" || shares[0].AccessName != "zapvm_boot" || shares[0].Flags != hcsPlan9Metadata|hcsPlan9ReadOnly || shares[1].Name != "1" || shares[1].AccessName != "zapvm_workspace" || shares[1].Flags != hcsPlan9Metadata {
		t.Fatalf("unexpected Plan9 shares: %+v", shares)
	}
	for _, share := range shares {
		if share.ReadOnly != nil || share.UseShareRootIdentity != nil {
			t.Fatalf("HCS document contains non-LCOW Plan9 fields: %+v", share)
		}
	}
	cmdline := decoded.VirtualMachine.Chipset.LinuxKernelDirect.KernelCmdLine
	for _, option := range []string{"root=/dev/sda", "rootwait", "init=/sbin/init", "pci=off", "initcall_blacklist=virtio_vsock_init", "zapvm.agent_connect_cid=2"} {
		if !hasKernelOption(cmdline, option) {
			t.Fatalf("kernel cmdline %q does not contain %q", cmdline, option)
		}
	}
}

func TestHCSKernelOptionsAreNotDuplicatedOrOverridden(t *testing.T) {
	spec := Spec{
		ID: "options", CPUCount: 2, MemoryBytes: 1024 * MiB,
		KernelPath: `C:\images\kernel`, InitrdPath: `C:\images\initramfs`,
		RootDiskPath:  `C:\images\rootfs.vhdx`,
		KernelCmdline: "root=/dev/sda rootwait init=/custom pci=off initcall_blacklist=custom",
		Network:       NetworkOff,
	}
	_, document, err := buildHCSConfig(spec)
	if err != nil {
		t.Fatal(err)
	}
	for _, option := range []string{"rootwait", "pci=off", "init="} {
		if count := strings.Count(document, option); count != 1 {
			t.Fatalf("%q appears %d times in %s", option, count, document)
		}
	}
	if !strings.Contains(document, "init=/custom") || !strings.Contains(document, "initcall_blacklist=custom") {
		t.Fatalf("caller kernel options were overridden: %s", document)
	}
}

func TestDeterministicVMIDIsStableAndDistinct(t *testing.T) {
	first := deterministicVMID("a")
	if first != deterministicVMID("a") || first == deterministicVMID("b") {
		t.Fatal("deterministic VM ID is not stable and distinct")
	}
}

func TestHCSConfigIncludesHCNAdapterOnlyWhenRequested(t *testing.T) {
	spec := Spec{
		ID: "network", CPUCount: 2, MemoryBytes: 512 * MiB,
		KernelPath: `C:\images\kernel`, InitrdPath: `C:\images\initramfs`,
		RootDiskPath: `C:\images\rootfs.vhdx`, Network: NetworkUnrestricted,
	}
	_, document, err := buildHCSConfigWithNetwork(spec, &hcsNetworkAttachment{
		NICID: "nic-id", EndpointID: "endpoint-id", MACAddress: "00-15-5D-F0-00-01",
		IPAddress: "172.29.240.2", PrefixBits: 24, Gateway: "172.29.240.1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(document, `"NetworkAdapters":{"nic-id":{"EndpointId":"endpoint-id","MacAddress":"00-15-5D-F0-00-01"}}`) {
		t.Fatalf("missing HCN adapter: %s", document)
	}
	for _, option := range []string{"zapvm.network_ip=172.29.240.2", "zapvm.network_prefix=24", "zapvm.network_gateway=172.29.240.1"} {
		if !strings.Contains(document, option) {
			t.Fatalf("missing static HCN option %q: %s", option, document)
		}
	}
	_, document, err = buildHCSConfig(spec)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(document, "NetworkAdapters") {
		t.Fatalf("network-off config unexpectedly contains adapter: %s", document)
	}
	spec.KernelCmdline = "zapvm.network_ip=10.0.0.2"
	if _, _, err := buildHCSConfigWithNetwork(spec, &hcsNetworkAttachment{
		NICID: "nic-id", EndpointID: "endpoint-id", MACAddress: "00-15-5D-F0-00-01",
		IPAddress: "172.29.240.2", PrefixBits: 24, Gateway: "172.29.240.1",
	}); err == nil {
		t.Fatal("caller override of reserved HCN configuration was accepted")
	}
}

func TestHCSConfigAttachesDebugSerialConsole(t *testing.T) {
	spec := Spec{
		ID: "console", CPUCount: 2, MemoryBytes: 512 * MiB,
		KernelPath: `C:\images\kernel`, InitrdPath: `C:\images\initramfs`,
		RootDiskPath: `C:\images\rootfs.vhdx`, Network: NetworkOff,
		KernelCmdline: "console=hvc0 root=/dev/vda ro",
	}
	_, document, err := buildHCSConfigWithDevices(spec, nil, `\\.\pipe\zapvm-console-test`)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{`"ComPorts":{"0":{"NamedPipe":"\\\\.\\pipe\\zapvm-console-test"}}`, "8250_core.nr_uarts=1", "console=ttyS0,115200"} {
		if !strings.Contains(document, expected) {
			t.Fatalf("console HCS document missing %q: %s", expected, document)
		}
	}
}
