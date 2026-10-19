package egress

import (
	"context"
	"errors"
	"net/netip"
	"reflect"
	"testing"
)

type staticResolver struct {
	addresses []netip.Addr
	err       error
	calls     int
}

func (r *staticResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	r.calls++
	return r.addresses, r.err
}

func TestPolicyAllowsExactAndWildcardPublicTargets(t *testing.T) {
	policy, err := NewPolicy([]string{"example.com", "*.openai.com"}, []uint16{443, 8443})
	if err != nil {
		t.Fatal(err)
	}
	resolver := &staticResolver{addresses: []netip.Addr{netip.MustParseAddr("93.184.216.34")}}
	for _, authority := range []string{"example.com:443", "api.openai.com:8443"} {
		target, err := policy.Resolve(context.Background(), resolver, authority)
		if err != nil || len(target.Addresses) != 1 {
			t.Fatalf("resolve %s: target=%+v err=%v", authority, target, err)
		}
	}
	if _, err := policy.Resolve(context.Background(), resolver, "openai.com:443"); !errors.Is(err, ErrDenied) {
		t.Fatalf("wildcard unexpectedly allowed apex: %v", err)
	}
}

func TestPolicyRejectsBeforeDNSWhenHostOrPortIsDenied(t *testing.T) {
	policy, err := NewPolicy([]string{"example.com"}, []uint16{443})
	if err != nil {
		t.Fatal(err)
	}
	resolver := &staticResolver{addresses: []netip.Addr{netip.MustParseAddr("93.184.216.34")}}
	for _, authority := range []string{"evil.example:443", "example.com:80", "example.com"} {
		if _, err := policy.Resolve(context.Background(), resolver, authority); !errors.Is(err, ErrDenied) {
			t.Fatalf("%s unexpectedly allowed: %v", authority, err)
		}
	}
	if resolver.calls != 0 {
		t.Fatalf("DNS was queried %d times for denied names", resolver.calls)
	}
}

func TestPolicyRejectsPrivateMetadataAndDNSRebinding(t *testing.T) {
	policy, err := NewPolicy([]string{"example.com"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, addresses := range [][]netip.Addr{
		{netip.MustParseAddr("127.0.0.1")},
		{netip.MustParseAddr("169.254.169.254")},
		{netip.MustParseAddr("10.0.0.1")},
		{netip.MustParseAddr("fd00:ec2::254")},
		{netip.MustParseAddr("64:ff9b::a9fe:a9fe")},
		{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("192.168.1.2")},
	} {
		resolver := &staticResolver{addresses: addresses}
		if _, err := policy.Resolve(context.Background(), resolver, "example.com:443"); !errors.Is(err, ErrDenied) {
			t.Fatalf("addresses %v unexpectedly allowed: %v", addresses, err)
		}
	}
}

func TestPolicyCanonicalizesIDN(t *testing.T) {
	policy, err := NewPolicy([]string{"bücher.example"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	resolver := &staticResolver{addresses: []netip.Addr{netip.MustParseAddr("93.184.216.34")}}
	target, err := policy.Resolve(context.Background(), resolver, "xn--bcher-kva.example:443")
	if err != nil || target.Host != "xn--bcher-kva.example" {
		t.Fatalf("target=%+v err=%v", target, err)
	}
}

func TestCanonicalRulesAreStableAndDeduplicated(t *testing.T) {
	policy, err := NewPolicy(
		[]string{" Example.COM. ", "example.com", "*.BÜCHER.example", "*.xn--bcher-kva.example"},
		[]uint16{8443, 443, 8443},
	)
	if err != nil {
		t.Fatal(err)
	}
	domains, ports := policy.CanonicalRules()
	wantDomains := []string{"*.xn--bcher-kva.example", "example.com"}
	wantPorts := []uint16{443, 8443}
	if !reflect.DeepEqual(domains, wantDomains) || !reflect.DeepEqual(ports, wantPorts) {
		t.Fatalf("canonical rules = %v %v, want %v %v", domains, ports, wantDomains, wantPorts)
	}
}
