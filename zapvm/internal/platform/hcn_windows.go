//go:build windows

package platform

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"unsafe"

	"github.com/Microsoft/go-winio/pkg/guid"
	"golang.org/x/sys/windows"
)

const hcnNetworkID = "64a28f5e-8f5f-5f85-9368-c54ee8cd7086"

var (
	computeNetworkDLL              = windows.NewLazySystemDLL("computenetwork.dll")
	procHCNCreateNetwork           = computeNetworkDLL.NewProc("HcnCreateNetwork")
	procHCNDeleteNetwork           = computeNetworkDLL.NewProc("HcnDeleteNetwork")
	procHCNCloseNetwork            = computeNetworkDLL.NewProc("HcnCloseNetwork")
	procHCNCreateEndpoint          = computeNetworkDLL.NewProc("HcnCreateEndpoint")
	procHCNDeleteEndpoint          = computeNetworkDLL.NewProc("HcnDeleteEndpoint")
	procHCNCloseEndpoint           = computeNetworkDLL.NewProc("HcnCloseEndpoint")
	procHCNQueryEndpointProperties = computeNetworkDLL.NewProc("HcnQueryEndpointProperties")
	ole32DLL                       = windows.NewLazySystemDLL("ole32.dll")
	procCoTaskMemFree              = ole32DLL.NewProc("CoTaskMemFree")
)

func loadHCN() error {
	if err := computeNetworkDLL.Load(); err != nil {
		return err
	}
	for _, procedure := range []*windows.LazyProc{
		procHCNCreateNetwork, procHCNDeleteNetwork, procHCNCloseNetwork,
		procHCNCreateEndpoint, procHCNDeleteEndpoint, procHCNCloseEndpoint,
		procHCNQueryEndpointProperties,
	} {
		if err := procedure.Find(); err != nil {
			return err
		}
	}
	return procCoTaskMemFree.Find()
}

type hcnError struct {
	operation string
	code      uint32
	record    string
}

func (err *hcnError) Error() string {
	if err.record == "" {
		return fmt.Sprintf("HCN %s failed with HRESULT 0x%08x", err.operation, err.code)
	}
	return fmt.Sprintf("HCN %s failed with HRESULT 0x%08x: %s", err.operation, err.code, err.record)
}

func takeHCNString(pointer *uint16) (string, error) {
	if pointer == nil {
		return "", nil
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(pointer)))
	for index := 0; index < windowsServiceMaxFrame/2; index++ {
		unit := *(*uint16)(unsafe.Add(unsafe.Pointer(pointer), uintptr(index)*unsafe.Sizeof(uint16(0))))
		if unit == 0 {
			units := unsafe.Slice(pointer, index)
			return windows.UTF16ToString(units), nil
		}
	}
	return "", errors.New("HCN returned a string larger than 1 MiB")
}

func checkHCNResult(operation string, result uintptr, recordPointer *uint16) error {
	record, recordErr := takeHCNString(recordPointer)
	if recordErr != nil {
		return recordErr
	}
	code := uint32(result)
	if code != 0 || record != "" {
		return &hcnError{operation: operation, code: code, record: record}
	}
	return nil
}

func hcnNotFound(err error, code uint32) bool {
	var target *hcnError
	if !errors.As(err, &target) {
		return false
	}
	return target.code == code || target.code == uint32(windows.ERROR_NOT_FOUND) || target.code == 0x80070490
}

func createHCNNetwork(id string, settings []byte) (windows.Handle, error) {
	identifier, err := guid.FromString(id)
	if err != nil {
		return 0, err
	}
	document, err := windows.UTF16PtrFromString(string(settings))
	if err != nil {
		return 0, err
	}
	var handle windows.Handle
	var record *uint16
	result, _, _ := procHCNCreateNetwork.Call(
		uintptr(unsafe.Pointer(&identifier)), uintptr(unsafe.Pointer(document)),
		uintptr(unsafe.Pointer(&handle)), uintptr(unsafe.Pointer(&record)),
	)
	if err := checkHCNResult("create network", result, record); err != nil {
		if handle != 0 {
			_, _, _ = procHCNCloseNetwork.Call(uintptr(handle))
		}
		return 0, err
	}
	if handle == 0 {
		return 0, errors.New("HCN create network returned a null handle")
	}
	return handle, nil
}

func deleteHCNNetwork(id string) error {
	identifier, err := guid.FromString(id)
	if err != nil {
		return err
	}
	var record *uint16
	result, _, _ := procHCNDeleteNetwork.Call(uintptr(unsafe.Pointer(&identifier)), uintptr(unsafe.Pointer(&record)))
	return checkHCNResult("delete network", result, record)
}

func closeHCNNetwork(handle windows.Handle) error {
	result, _, _ := procHCNCloseNetwork.Call(uintptr(handle))
	return checkHCNResult("close network", result, nil)
}

func createHCNEndpoint(network windows.Handle, id string, settings []byte) (windows.Handle, error) {
	identifier, err := guid.FromString(id)
	if err != nil {
		return 0, err
	}
	document, err := windows.UTF16PtrFromString(string(settings))
	if err != nil {
		return 0, err
	}
	var handle windows.Handle
	var record *uint16
	result, _, _ := procHCNCreateEndpoint.Call(
		uintptr(network), uintptr(unsafe.Pointer(&identifier)), uintptr(unsafe.Pointer(document)),
		uintptr(unsafe.Pointer(&handle)), uintptr(unsafe.Pointer(&record)),
	)
	if err := checkHCNResult("create endpoint", result, record); err != nil {
		if handle != 0 {
			_, _, _ = procHCNCloseEndpoint.Call(uintptr(handle))
		}
		return 0, err
	}
	if handle == 0 {
		return 0, errors.New("HCN create endpoint returned a null handle")
	}
	return handle, nil
}

func deleteHCNEndpoint(id string) error {
	identifier, err := guid.FromString(id)
	if err != nil {
		return err
	}
	var record *uint16
	result, _, _ := procHCNDeleteEndpoint.Call(uintptr(unsafe.Pointer(&identifier)), uintptr(unsafe.Pointer(&record)))
	return checkHCNResult("delete endpoint", result, record)
}

func closeHCNEndpoint(handle windows.Handle) error {
	result, _, _ := procHCNCloseEndpoint.Call(uintptr(handle))
	return checkHCNResult("close endpoint", result, nil)
}

type hcnEndpointProperties struct {
	ID               string               `json:"ID"`
	MACAddress       string               `json:"MacAddress"`
	IPConfigurations []hcnIPConfiguration `json:"IpConfigurations"`
	Policies         []hcnEndpointPolicy  `json:"Policies"`
}

func queryHCNEndpoint(handle windows.Handle) (hcnEndpointProperties, error) {
	query, err := json.Marshal(map[string]any{
		"SchemaVersion": hcnVersion{Major: 2, Minor: 0},
		"Flags":         1,
	})
	if err != nil {
		return hcnEndpointProperties{}, err
	}
	queryPointer, err := windows.UTF16PtrFromString(string(query))
	if err != nil {
		return hcnEndpointProperties{}, err
	}
	var propertiesPointer, record *uint16
	result, _, _ := procHCNQueryEndpointProperties.Call(
		uintptr(handle), uintptr(unsafe.Pointer(queryPointer)),
		uintptr(unsafe.Pointer(&propertiesPointer)), uintptr(unsafe.Pointer(&record)),
	)
	if err := checkHCNResult("query endpoint", result, record); err != nil {
		if propertiesPointer != nil {
			_, _ = takeHCNString(propertiesPointer)
		}
		return hcnEndpointProperties{}, err
	}
	document, err := takeHCNString(propertiesPointer)
	if err != nil {
		return hcnEndpointProperties{}, err
	}
	var properties hcnEndpointProperties
	if err := json.Unmarshal([]byte(document), &properties); err != nil {
		return hcnEndpointProperties{}, err
	}
	return properties, nil
}

type hcnManager struct {
	mu        sync.Mutex
	network   windows.Handle
	prefix    string
	endpoints map[string]struct{}
}

func newHCNManager() *hcnManager { return &hcnManager{endpoints: make(map[string]struct{})} }

func (manager *hcnManager) ensureNetworkLocked() error {
	if manager.network != 0 {
		return nil
	}
	if err := loadHCN(); err != nil {
		return err
	}
	if err := deleteHCNNetwork(hcnNetworkID); err != nil && !hcnNotFound(err, uint32(windows.HCN_E_NETWORK_NOT_FOUND)) {
		return fmt.Errorf("remove stale zapVM HCN network: %w", err)
	}
	var combined error
	for _, prefix := range []string{"172.29.240.0/24", "192.168.249.0/24", "10.231.240.0/24"} {
		settings, err := buildHCNNetworkSettings(prefix)
		if err != nil {
			return err
		}
		handle, err := createHCNNetwork(hcnNetworkID, settings)
		if err == nil {
			manager.network = handle
			manager.prefix = prefix
			return nil
		}
		combined = errors.Join(combined, fmt.Errorf("subnet %s: %w", prefix, err))
		if cleanupErr := deleteHCNNetwork(hcnNetworkID); cleanupErr != nil && !hcnNotFound(cleanupErr, uint32(windows.HCN_E_NETWORK_NOT_FOUND)) {
			combined = errors.Join(combined, cleanupErr)
			break
		}
	}
	return fmt.Errorf("create zapVM HCN NAT network: %w", combined)
}

func (manager *hcnManager) CreateEndpoint(vmID, _ string) (*hcsNetworkAttachment, func() error, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if err := manager.ensureNetworkLocked(); err != nil {
		return nil, func() error { return nil }, err
	}
	endpointID := deterministicVMID("hcn-endpoint:" + vmID)
	nicID := deterministicVMID("hcn-nic:" + vmID)
	if err := deleteHCNEndpoint(endpointID); err != nil && !hcnNotFound(err, uint32(windows.HCN_E_ENDPOINT_NOT_FOUND)) {
		return nil, func() error { return nil }, fmt.Errorf("remove stale HCN endpoint: %w", err)
	}
	name := "zapvm-" + strings.ReplaceAll(endpointID, "-", "")[:16]
	settings, err := buildHCNEndpointSettings(name, hcnNetworkID)
	if err != nil {
		return nil, func() error { return nil }, err
	}
	handle, err := createHCNEndpoint(manager.network, endpointID, settings)
	if err != nil {
		return nil, func() error { return nil }, err
	}
	properties, queryErr := queryHCNEndpoint(handle)
	closeErr := closeHCNEndpoint(handle)
	if queryErr != nil || closeErr != nil {
		_ = deleteHCNEndpoint(endpointID)
		return nil, func() error { return nil }, errors.Join(queryErr, closeErr)
	}
	if properties.ID != "" && !strings.EqualFold(properties.ID, endpointID) {
		_ = deleteHCNEndpoint(endpointID)
		return nil, func() error { return nil }, errors.New("HCN returned a mismatched endpoint ID")
	}
	if properties.MACAddress == "" {
		_ = deleteHCNEndpoint(endpointID)
		return nil, func() error { return nil }, errors.New("HCN endpoint has no MAC address")
	}
	if !hasHCNSwitchInboundDeny(properties.Policies) {
		_ = deleteHCNEndpoint(endpointID)
		policies, _ := json.Marshal(properties.Policies)
		return nil, func() error { return nil }, fmt.Errorf("HCN endpoint did not retain the required fail-closed Switch inbound deny policy: %s", policies)
	}
	ipAddress, prefixBits, gateway, err := selectHCNIPv4Configuration(manager.prefix, properties.IPConfigurations)
	if err != nil {
		_ = deleteHCNEndpoint(endpointID)
		return nil, func() error { return nil }, err
	}
	manager.endpoints[endpointID] = struct{}{}
	var once sync.Once
	var cleanupErr error
	cleanup := func() error {
		once.Do(func() {
			manager.mu.Lock()
			defer manager.mu.Unlock()
			cleanupErr = deleteHCNEndpoint(endpointID)
			if hcnNotFound(cleanupErr, uint32(windows.HCN_E_ENDPOINT_NOT_FOUND)) {
				cleanupErr = nil
			}
			if cleanupErr == nil {
				delete(manager.endpoints, endpointID)
			}
		})
		return cleanupErr
	}
	return &hcsNetworkAttachment{
		NICID: nicID, EndpointID: endpointID, MACAddress: properties.MACAddress,
		IPAddress: ipAddress, PrefixBits: prefixBits, Gateway: gateway,
	}, cleanup, nil
}

func (manager *hcnManager) Close() error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	var result error
	for endpointID := range manager.endpoints {
		if err := deleteHCNEndpoint(endpointID); err != nil && !hcnNotFound(err, uint32(windows.HCN_E_ENDPOINT_NOT_FOUND)) {
			result = errors.Join(result, err)
		}
	}
	manager.endpoints = make(map[string]struct{})
	if manager.network != 0 {
		result = errors.Join(result, closeHCNNetwork(manager.network))
		manager.network = 0
	}
	if err := deleteHCNNetwork(hcnNetworkID); err != nil && !hcnNotFound(err, uint32(windows.HCN_E_NETWORK_NOT_FOUND)) {
		result = errors.Join(result, err)
	}
	return result
}
