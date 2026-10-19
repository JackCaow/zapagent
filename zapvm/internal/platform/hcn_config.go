package platform

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
)

const (
	hcnNetworkFlagsNone  = 0
	hcnEndpointFlagsNone = 0
)

type hcsNetworkAttachment struct {
	NICID      string
	EndpointID string
	MACAddress string
	IPAddress  string
	PrefixBits uint8
	Gateway    string
}

type hcnVersion struct {
	Major uint32 `json:"Major"`
	Minor uint32 `json:"Minor"`
}

type hcnRoute struct {
	NextHop           string `json:"NextHop"`
	DestinationPrefix string `json:"DestinationPrefix"`
	Metric            uint16 `json:"Metric,omitempty"`
}

type hcnIPConfiguration struct {
	IPAddress    string `json:"IpAddress"`
	PrefixLength uint8  `json:"PrefixLength"`
}

type hcnSubnet struct {
	IPAddressPrefix string     `json:"IpAddressPrefix"`
	Routes          []hcnRoute `json:"Routes"`
}

type hcnIPAM struct {
	Type    string      `json:"Type"`
	Subnets []hcnSubnet `json:"Subnets"`
}

type hcnMACRange struct {
	Start string `json:"StartMacAddress"`
	End   string `json:"EndMacAddress"`
}

type hcnNetworkSettings struct {
	Owner         string `json:"Owner"`
	Name          string `json:"Name"`
	Type          string `json:"Type"`
	SchemaVersion hcnVersion
	Flags         uint32    `json:"Flags"`
	IPAMs         []hcnIPAM `json:"Ipams"`
	MACPool       struct {
		Ranges []hcnMACRange `json:"Ranges"`
	} `json:"MacPool"`
}

type hcnACLSettings struct {
	Protocols       string `json:"Protocols,omitempty"`
	Action          string `json:"Action"`
	Direction       string `json:"Direction"`
	LocalAddresses  string `json:"LocalAddresses,omitempty"`
	RemoteAddresses string `json:"RemoteAddresses,omitempty"`
	LocalPorts      string `json:"LocalPorts,omitempty"`
	RemotePorts     string `json:"RemotePorts,omitempty"`
	RuleType        string `json:"RuleType"`
	Priority        uint16 `json:"Priority"`
}

type hcnEndpointPolicy struct {
	Type     string         `json:"Type"`
	Settings hcnACLSettings `json:"Settings"`
}

type hcnEndpointSettings struct {
	Owner              string `json:"Owner"`
	Name               string `json:"Name"`
	HostComputeNetwork string `json:"HostComputeNetwork"`
	SchemaVersion      hcnVersion
	Flags              uint32              `json:"Flags"`
	Policies           []hcnEndpointPolicy `json:"Policies"`
}

func buildHCNNetworkSettings(prefix string) ([]byte, error) {
	subnet, err := netip.ParsePrefix(prefix)
	if err != nil || !subnet.Addr().Is4() || subnet.Bits() != 24 || subnet.Addr() != subnet.Masked().Addr() {
		return nil, fmt.Errorf("HCN subnet must be a canonical IPv4 /24: %q", prefix)
	}
	gateway := subnet.Addr().Next()
	settings := hcnNetworkSettings{
		Owner: "zapVM", Name: "zapVM NAT", Type: "NAT",
		SchemaVersion: hcnVersion{Major: 2, Minor: 0},
		// HCN 2.0 only defines NetworkFlags values such as NonPersistent (8).
		// The old HNS v1 DNS/DHCP bits (1 and 2) are not HCN flags and Windows
		// rejects that mixed document with HCN_E_REQUEST_UNSUPPORTED. Match the
		// public hcsshim NAT shape and manage persistence through explicit delete.
		Flags: hcnNetworkFlagsNone,
		IPAMs: []hcnIPAM{{Type: "Static", Subnets: []hcnSubnet{{
			IPAddressPrefix: prefix,
			Routes:          []hcnRoute{{NextHop: gateway.String(), DestinationPrefix: "0.0.0.0/0", Metric: 1}},
		}}}},
	}
	settings.MACPool.Ranges = []hcnMACRange{{Start: "00-15-5D-F0-00-00", End: "00-15-5D-F0-FF-FF"}}
	return json.Marshal(settings)
}

func buildHCNEndpointSettings(name, networkID string) ([]byte, error) {
	if name == "" || len(name) > 128 || networkID == "" {
		return nil, fmt.Errorf("HCN endpoint name/network ID is invalid")
	}
	settings := hcnEndpointSettings{
		Owner: "zapVM", Name: name, HostComputeNetwork: networkID,
		SchemaVersion: hcnVersion{Major: 2, Minor: 0},
		// HCN 2.0 only defines bit 1 for remote endpoints. The old HNS v1
		// DisableInterCompute/EnableDHCP bits are not valid HCN endpoint flags.
		Flags: hcnEndpointFlagsNone,
		// Keep the HCN DHCP compatibility exception ahead of a fail-closed inbound
		// Switch rule. The guest currently uses the endpoint's static IPAM assignment, but
		// retaining the narrow UDP exception avoids depending on that implementation
		// detail during endpoint initialization. HCN uses protocol 256 for an
		// all-protocol VFP default rule; an omitted Protocols field does not match all.
		// The signed guest independently rejects new inbound flows with nftables,
		// because HCN Host ACLs do not filter Host-to-VM traffic on NAT VM endpoints.
		Policies: []hcnEndpointPolicy{
			{Type: "ACL", Settings: hcnACLSettings{
				Protocols: "17", Action: "Allow", Direction: "In",
				LocalPorts: "68", RemotePorts: "67", RuleType: "Switch", Priority: 100,
			}},
			{Type: "ACL", Settings: hcnACLSettings{
				Protocols: "256", Action: "Block", Direction: "In",
				RuleType: "Switch", Priority: 65500,
			}},
		},
	}
	return json.Marshal(settings)
}

func hasHCNSwitchInboundDeny(policies []hcnEndpointPolicy) bool {
	for _, policy := range policies {
		settings := policy.Settings
		if policy.Type != "ACL" || settings.Action != "Block" || settings.Direction != "In" ||
			settings.LocalAddresses != "" || settings.RemoteAddresses != "" ||
			settings.LocalPorts != "" || settings.RemotePorts != "" {
			continue
		}
		if settings.RuleType == "Switch" && settings.Priority == 65500 && settings.Protocols == "256" {
			return true
		}
	}
	return false
}

func selectHCNIPv4Configuration(prefix string, configurations []hcnIPConfiguration) (string, uint8, string, error) {
	subnet, err := netip.ParsePrefix(prefix)
	if err != nil || !subnet.Addr().Is4() {
		return "", 0, "", fmt.Errorf("invalid HCN IPv4 subnet %q", prefix)
	}
	subnet = subnet.Masked()
	gateway := subnet.Addr().Next()
	for _, configuration := range configurations {
		address, parseErr := netip.ParseAddr(configuration.IPAddress)
		if parseErr != nil || !address.Is4() || !subnet.Contains(address) ||
			configuration.PrefixLength != uint8(subnet.Bits()) || address == subnet.Addr() || address == gateway {
			continue
		}
		return address.String(), configuration.PrefixLength, gateway.String(), nil
	}
	return "", 0, "", errors.New("HCN endpoint did not receive a usable static IPv4 configuration")
}
