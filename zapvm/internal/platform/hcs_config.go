package platform

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
)

const (
	hcsSCSIController = "df6d0690-79e5-55b6-a5ec-c1e2f77f580a"
	hcsPlan9Port      = 564
	hcsPlan9Metadata  = 0x00000004
	hcsPlan9ReadOnly  = 0x00000001
)

func buildHCSConfig(spec Spec) (string, string, error) {
	return buildHCSConfigWithDevices(spec, nil, "")
}

func buildHCSConfigWithNetwork(spec Spec, network *hcsNetworkAttachment) (string, string, error) {
	return buildHCSConfigWithDevices(spec, network, "")
}

func buildHCSConfigWithDevices(spec Spec, network *hcsNetworkAttachment, consolePipe string) (string, string, error) {
	vmID := deterministicVMID(spec.ID)
	cmdline := strings.Replace(spec.KernelCmdline, "root=/dev/vda", "root=/dev/sda", 1)
	if !hasKernelOption(cmdline, "rootwait") {
		cmdline += " rootwait"
	}
	if !hasKernelOptionKey(cmdline, "init") {
		// The signed Alpine rootfs uses OpenRC's standard init path. The
		// Microsoft LCOW utility rootfs uses /init, but that file is not part of
		// this image and causes switch_root to panic before userspace starts.
		cmdline += " init=/sbin/init"
	}
	for _, option := range []string{"pci=off", "initcall_blacklist=virtio_vsock_init"} {
		if !hasKernelOption(cmdline, option) {
			cmdline += " " + option
		}
	}
	if !hasKernelOptionKey(cmdline, "zapvm.agent_connect_cid") {
		// HCS/Hyper-V's established LCOW transport has the Windows host listen
		// and the Linux guest connect to VMADDR_CID_HOST. Cloud Hypervisor uses
		// the opposite direction, so this is an explicit Windows-only contract.
		cmdline += " zapvm.agent_connect_cid=2"
	}
	if consolePipe != "" {
		cmdline += " 8250_core.nr_uarts=1 8250_core.skip_txen_test=1 console=ttyS0,115200"
	} else if !hasKernelOptionKey(cmdline, "8250_core.nr_uarts") {
		cmdline += " 8250_core.nr_uarts=0"
	}
	attachments := map[string]any{
		"0": map[string]any{"Type": "VirtualDisk", "Path": spec.RootDiskPath, "ReadOnly": true},
	}
	if spec.StateDiskPath != "" {
		attachments["1"] = map[string]any{"Type": "VirtualDisk", "Path": spec.StateDiskPath, "ReadOnly": false}
	}
	if spec.AgentDiskPath != "" {
		attachments["2"] = map[string]any{"Type": "VirtualDisk", "Path": spec.AgentDiskPath, "ReadOnly": true}
	}
	shares := make([]map[string]any, 0, 2)
	addShare := func(name, path string, readOnly bool) {
		if path == "" {
			return
		}
		flags := hcsPlan9Metadata
		if readOnly {
			flags |= hcsPlan9ReadOnly
		}
		shares = append(shares, map[string]any{
			// HCS treats Name as the resource identifier. hcsshim's LCOW path
			// uses a decimal counter here and exposes the guest-visible tag
			// independently through AccessName.
			"Name": fmt.Sprintf("%d", len(shares)), "AccessName": name,
			"Path": path, "Port": hcsPlan9Port, "Flags": flags,
		})
	}
	addShare("zapvm_boot", spec.BootSharePath, true)
	addShare("zapvm_workspace", spec.WorkspacePath, spec.WorkspaceReadOnly)
	serviceTable := make(map[string]any, 2)
	for _, port := range []uint32{19090, 19091} {
		serviceID := fmt.Sprintf("%08x-facb-11e6-bd58-64006a7986d3", port)
		serviceTable[serviceID] = map[string]any{
			"AllowWildcardBinds":        true,
			"BindSecurityDescriptor":    "D:P(A;;FA;;;WD)",
			"ConnectSecurityDescriptor": "D:P(A;;FA;;;SY)(A;;FA;;;BA)",
		}
	}
	devices := map[string]any{
		"Scsi": map[string]any{hcsSCSIController: map[string]any{"Attachments": attachments}},
		"HvSocket": map[string]any{"HvSocketConfig": map[string]any{
			"DefaultBindSecurityDescriptor":    "D:P(A;;FA;;;SY)(A;;FA;;;BA)",
			"DefaultConnectSecurityDescriptor": "D:P(A;;FA;;;SY)(A;;FA;;;BA)",
			"ServiceTable":                     serviceTable,
		}},
		"Plan9": map[string]any{"Shares": shares},
	}
	if consolePipe != "" {
		devices["ComPorts"] = map[string]any{"0": map[string]any{"NamedPipe": consolePipe}}
	}
	if network != nil {
		if network.NICID == "" || network.EndpointID == "" || network.MACAddress == "" ||
			network.IPAddress == "" || network.PrefixBits == 0 || network.Gateway == "" {
			return "", "", fmt.Errorf("incomplete HCN network attachment")
		}
		for _, option := range []struct{ key, value string }{
			{key: "zapvm.network_ip", value: network.IPAddress},
			{key: "zapvm.network_prefix", value: fmt.Sprintf("%d", network.PrefixBits)},
			{key: "zapvm.network_gateway", value: network.Gateway},
		} {
			if hasKernelOptionKey(cmdline, option.key) {
				return "", "", fmt.Errorf("kernel command line overrides reserved HCN option %s", option.key)
			}
			cmdline += " " + option.key + "=" + option.value
		}
		devices["NetworkAdapters"] = map[string]any{
			network.NICID: map[string]any{"EndpointId": network.EndpointID, "MacAddress": network.MACAddress},
		}
	}
	config := map[string]any{
		// Microsoft hcsshim uses schema 2.1 for the ordinary LCOW
		// direct-kernel path. Schema 2.5 is reserved for the VMGS/SNP path.
		"SchemaVersion":                     map[string]uint32{"Major": 2, "Minor": 1},
		"Owner":                             "zapVM",
		"ShouldTerminateOnLastHandleClosed": true,
		"VirtualMachine": map[string]any{
			"StopOnReset": true,
			"Chipset": map[string]any{
				"LinuxKernelDirect": map[string]any{
					"KernelFilePath": spec.KernelPath,
					"InitRdPath":     spec.InitrdPath,
					"KernelCmdLine":  cmdline,
				},
			},
			"ComputeTopology": map[string]any{
				"Memory":    map[string]any{"SizeInMB": spec.MemoryBytes / MiB},
				"Processor": map[string]any{"Count": spec.CPUCount},
			},
			"Devices": devices,
		},
	}
	data, err := json.Marshal(config)
	if err != nil {
		return "", "", err
	}
	return vmID, string(data), nil
}

func hasKernelOption(cmdline, option string) bool {
	for _, field := range strings.Fields(cmdline) {
		if field == option {
			return true
		}
		if strings.HasPrefix(option, "initcall_blacklist=") && strings.HasPrefix(field, "initcall_blacklist=") {
			wanted := strings.TrimPrefix(option, "initcall_blacklist=")
			for _, value := range strings.Split(strings.TrimPrefix(field, "initcall_blacklist="), ",") {
				if value == wanted {
					return true
				}
			}
		}
	}
	return false
}

func hasKernelOptionKey(cmdline, key string) bool {
	for _, field := range strings.Fields(cmdline) {
		if field == key || strings.HasPrefix(field, key+"=") {
			return true
		}
	}
	return false
}

func deterministicVMID(id string) string {
	sum := sha256.Sum256([]byte("zapvm-hcs-v1\x00" + id))
	bytes := sum[:16]
	bytes[6] = (bytes[6] & 0x0f) | 0x50
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}
