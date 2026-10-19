package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
)

const cloudHypervisorMaxResponseBytes = 1 << 20

type cloudHypervisorAPI struct {
	client *http.Client
}

type cloudHypervisorVMMInfo struct {
	Version      string   `json:"version"`
	BuildVersion string   `json:"build_version"`
	PID          int64    `json:"pid"`
	Features     []string `json:"features"`
}

type cloudHypervisorVMInfo struct {
	State string `json:"state"`
}

func newCloudHypervisorAPI(socketPath string) *cloudHypervisorAPI {
	transport := &http.Transport{
		DisableKeepAlives: true,
		Proxy:             nil,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
		},
	}
	return &cloudHypervisorAPI{client: &http.Client{Transport: transport}}
}

func (a *cloudHypervisorAPI) ping(ctx context.Context) (cloudHypervisorVMMInfo, error) {
	var result cloudHypervisorVMMInfo
	body, err := a.request(ctx, http.MethodGet, "vmm.ping")
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return result, fmt.Errorf("decode Cloud Hypervisor vmm.ping response: %w", err)
	}
	if strings.TrimSpace(result.Version) == "" {
		return result, fmt.Errorf("Cloud Hypervisor vmm.ping response is missing version")
	}
	return result, nil
}

func (a *cloudHypervisorAPI) vmInfo(ctx context.Context) (cloudHypervisorVMInfo, error) {
	var result cloudHypervisorVMInfo
	body, err := a.request(ctx, http.MethodGet, "vm.info")
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return result, fmt.Errorf("decode Cloud Hypervisor vm.info response: %w", err)
	}
	if strings.TrimSpace(result.State) == "" {
		return result, fmt.Errorf("Cloud Hypervisor vm.info response is missing state")
	}
	return result, nil
}

func (a *cloudHypervisorAPI) shutdownVM(ctx context.Context) error {
	_, err := a.request(ctx, http.MethodPut, "vm.shutdown")
	return err
}

func (a *cloudHypervisorAPI) pauseVM(ctx context.Context) error {
	_, err := a.request(ctx, http.MethodPut, "vm.pause")
	return err
}

func (a *cloudHypervisorAPI) resumeVM(ctx context.Context) error {
	_, err := a.request(ctx, http.MethodPut, "vm.resume")
	return err
}

func (a *cloudHypervisorAPI) shutdownVMM(ctx context.Context) error {
	_, err := a.request(ctx, http.MethodPut, "vmm.shutdown")
	return err
}

func (a *cloudHypervisorAPI) request(ctx context.Context, method, endpoint string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, method, "http://localhost/api/v1/"+endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("create Cloud Hypervisor %s request: %w", endpoint, err)
	}
	request.Header.Set("Accept", "application/json")
	response, err := a.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("call Cloud Hypervisor %s: %w", endpoint, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, cloudHypervisorMaxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read Cloud Hypervisor %s response: %w", endpoint, err)
	}
	if len(body) > cloudHypervisorMaxResponseBytes {
		return nil, fmt.Errorf("Cloud Hypervisor %s response exceeds %d bytes", endpoint, cloudHypervisorMaxResponseBytes)
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusNoContent {
		detail := strings.TrimSpace(string(body))
		if len(detail) > 512 {
			detail = detail[:512]
		}
		if detail == "" {
			detail = http.StatusText(response.StatusCode)
		}
		return nil, fmt.Errorf("Cloud Hypervisor %s returned HTTP %d: %s", endpoint, response.StatusCode, detail)
	}
	return body, nil
}
