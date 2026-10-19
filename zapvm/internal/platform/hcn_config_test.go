package platform

import (
	"encoding/json"
	"testing"
)

func TestBuildHCNNetworkSettings(t *testing.T) {
	payload, err := buildHCNNetworkSettings("172.29.240.0/24")
	if err != nil {
		t.Fatal(err)
	}
	var settings hcnNetworkSettings
	if err := json.Unmarshal(payload, &settings); err != nil {
		t.Fatal(err)
	}
	if settings.Type != "NAT" || settings.SchemaVersion != (hcnVersion{Major: 2, Minor: 0}) {
		t.Fatalf("network settings = %#v", settings)
	}
	wantedFlags := uint32(hcnNetworkFlagsNone)
	if settings.Flags != wantedFlags {
		t.Fatalf("flags = %d, want %d", settings.Flags, wantedFlags)
	}
	subnet := settings.IPAMs[0].Subnets[0]
	if subnet.Routes[0].NextHop != "172.29.240.1" || subnet.Routes[0].DestinationPrefix != "0.0.0.0/0" {
		t.Fatalf("route = %#v", subnet.Routes[0])
	}
	if len(settings.MACPool.Ranges) != 1 {
		t.Fatalf("MAC ranges = %#v", settings.MACPool.Ranges)
	}
}

func TestBuildHCNNetworkSettingsRejectsUnsafePrefix(t *testing.T) {
	for _, prefix := range []string{"", "172.29.240.1/24", "172.29.0.0/16", "2001:db8::/64"} {
		if _, err := buildHCNNetworkSettings(prefix); err == nil {
			t.Fatalf("prefix %q unexpectedly accepted", prefix)
		}
	}
}

func TestBuildHCNEndpointSettings(t *testing.T) {
	payload, err := buildHCNEndpointSettings("zapvm-test", "network-guid")
	if err != nil {
		t.Fatal(err)
	}
	var settings hcnEndpointSettings
	if err := json.Unmarshal(payload, &settings); err != nil {
		t.Fatal(err)
	}
	wantedFlags := uint32(hcnEndpointFlagsNone)
	if settings.Flags != wantedFlags || len(settings.Policies) != 2 {
		t.Fatalf("endpoint settings = %#v", settings)
	}
	dhcp := settings.Policies[0]
	if dhcp.Type != "ACL" || dhcp.Settings.Action != "Allow" || dhcp.Settings.Direction != "In" || dhcp.Settings.LocalPorts != "68" || dhcp.Settings.RemotePorts != "67" {
		t.Fatalf("DHCP policy = %#v", dhcp)
	}
	if !hasHCNSwitchInboundDeny(settings.Policies) {
		t.Fatalf("endpoint has no fail-closed Switch inbound deny policy: %#v", settings.Policies)
	}
}

func TestHCNSwitchInboundDenyIdentity(t *testing.T) {
	valid := hcnEndpointPolicy{Type: "ACL", Settings: hcnACLSettings{
		Protocols: "256", Action: "Block", Direction: "In", RuleType: "Switch", Priority: 65500,
	}}
	if !hasHCNSwitchInboundDeny([]hcnEndpointPolicy{valid}) {
		t.Fatal("valid Switch inbound deny policy was rejected")
	}
	invalid := []hcnEndpointPolicy{
		{Type: "ACL", Settings: hcnACLSettings{Protocols: "256", Action: "Allow", Direction: "In", RuleType: "Switch", Priority: 65500}},
		{Type: "ACL", Settings: hcnACLSettings{Protocols: "256", Action: "Block", Direction: "Out", RuleType: "Switch", Priority: 65500}},
		{Type: "ACL", Settings: hcnACLSettings{Protocols: "256", Action: "Block", Direction: "In", RuleType: "Host", Priority: 65500}},
		{Type: "ACL", Settings: hcnACLSettings{Protocols: "256", Action: "Block", Direction: "In", RuleType: "Switch", Priority: 65499}},
		{Type: "ACL", Settings: hcnACLSettings{Action: "Block", Direction: "In", RuleType: "Switch", Priority: 65500}},
		{Type: "ACL", Settings: hcnACLSettings{Protocols: "256", Action: "Block", Direction: "In", RuleType: "Switch", Priority: 65500, LocalPorts: "443"}},
	}
	for _, policy := range invalid {
		if hasHCNSwitchInboundDeny([]hcnEndpointPolicy{policy}) {
			t.Fatalf("invalid Switch inbound deny policy was accepted: %#v", policy)
		}
	}
}

func TestSelectHCNIPv4Configuration(t *testing.T) {
	ip, bits, gateway, err := selectHCNIPv4Configuration("172.29.240.0/24", []hcnIPConfiguration{
		{IPAddress: "2001:db8::1", PrefixLength: 64},
		{IPAddress: "172.29.240.2", PrefixLength: 24},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ip != "172.29.240.2" || bits != 24 || gateway != "172.29.240.1" {
		t.Fatalf("static network = %s/%d via %s", ip, bits, gateway)
	}
	for _, configurations := range [][]hcnIPConfiguration{
		nil,
		{{IPAddress: "172.29.240.1", PrefixLength: 24}},
		{{IPAddress: "172.29.241.2", PrefixLength: 24}},
		{{IPAddress: "172.29.240.2", PrefixLength: 16}},
	} {
		if _, _, _, err := selectHCNIPv4Configuration("172.29.240.0/24", configurations); err == nil {
			t.Fatalf("invalid configurations accepted: %+v", configurations)
		}
	}
}
