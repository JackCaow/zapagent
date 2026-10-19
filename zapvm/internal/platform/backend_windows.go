//go:build windows

package platform

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type windowsBackend struct{}

func newBackend() Backend { return &windowsBackend{} }

func (*windowsBackend) Name() string { return "hyper-v-hcs" }

func (b *windowsBackend) Doctor(ctx context.Context) DoctorReport {
	report := baseReport(b.Name())
	buildOutput, buildErr := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "[Environment]::OSVersion.Version.Build").CombinedOutput()
	build, parseErr := strconv.Atoi(strings.TrimSpace(string(buildOutput)))
	switch {
	case buildErr != nil || parseErr != nil:
		report.Checks = append(report.Checks, Check{"hcs-schema-2.1", CheckFail, "unable to determine Windows build"})
	case build < 20348:
		report.Checks = append(report.Checks, Check{"hcs-schema-2.1", CheckFail, fmt.Sprintf("Windows build %d is older than required build 20348", build)})
	default:
		report.Checks = append(report.Checks, Check{"hcs-schema-2.1", CheckPass, fmt.Sprintf("Windows build %d", build)})
	}
	if err := loadHCS(); err != nil {
		report.Checks = append(report.Checks, Check{"compute-core-api", CheckFail, err.Error()})
	} else {
		report.Checks = append(report.Checks, Check{"compute-core-api", CheckPass, "ComputeCore.dll public HCS API is available"})
	}
	if err := loadHCN(); err != nil {
		report.Checks = append(report.Checks, Check{"compute-network-api", CheckFail, err.Error()})
	} else {
		report.Checks = append(report.Checks, Check{"compute-network-api", CheckPass, "ComputeNetwork.dll public HCN API is available"})
	}
	serviceCtx, serviceCancel := context.WithTimeout(ctx, 2*time.Second)
	_, serviceErr := callWindowsService(serviceCtx, windowsServiceRequest{Version: windowsServiceProtocolVersion, Operation: windowsServiceOpPing})
	serviceCancel()
	if serviceErr != nil {
		report.Checks = append(report.Checks, Check{"zapvm-service", CheckFail, serviceErr.Error()})
	} else {
		report.Checks = append(report.Checks, Check{"zapvm-service", CheckPass, "named-pipe identity boundary is reachable"})
	}
	for _, service := range []string{"vmcompute", "hns", "vfpext"} {
		out, err := exec.CommandContext(ctx, "sc.exe", "query", service).CombinedOutput()
		if err != nil {
			report.Checks = append(report.Checks, Check{service, CheckFail, strings.TrimSpace(string(out))})
			continue
		}
		status := CheckWarn
		detail := "installed but not running"
		if strings.Contains(string(out), "RUNNING") {
			status, detail = CheckPass, "running"
		}
		report.Checks = append(report.Checks, Check{service, status, detail})
	}
	featureOutput, featureErr := exec.CommandContext(ctx, "dism.exe", "/Online", "/Get-FeatureInfo", "/FeatureName:VirtualMachinePlatform", "/English").CombinedOutput()
	if featureErr != nil || !strings.Contains(string(featureOutput), "State : Enabled") {
		report.Checks = append(report.Checks, Check{"virtual-machine-platform", CheckFail, "Windows optional feature VirtualMachinePlatform is not enabled"})
	} else {
		report.Checks = append(report.Checks, Check{"virtual-machine-platform", CheckPass, "enabled"})
	}
	hypervisorOutput, hypervisorErr := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_ComputerSystem).HypervisorPresent").CombinedOutput()
	if hypervisorErr != nil || !strings.EqualFold(strings.TrimSpace(string(hypervisorOutput)), "True") {
		report.Checks = append(report.Checks, Check{"hypervisor", CheckFail, "Windows does not report an active hypervisor"})
	} else {
		report.Checks = append(report.Checks, Check{"hypervisor", CheckPass, "active"})
	}
	return report
}

func (*windowsBackend) Start(ctx context.Context, spec Spec, _ io.Writer) (Instance, error) {
	spec.SetDefaults()
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	if spec.InitrdPath == "" {
		return nil, fmt.Errorf("Windows HCS direct-kernel boot requires an initrd")
	}
	response, err := callWindowsService(ctx, windowsServiceRequest{
		Version: windowsServiceProtocolVersion, Operation: windowsServiceOpStart, Spec: &spec,
	})
	if err != nil {
		return nil, err
	}
	instance := newWindowsServiceInstance(spec.ID, response.VMID)
	go instance.watch()
	return instance, nil
}
