package egress

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/net/idna"
)

var ErrDenied = errors.New("egress policy denied target")

type Resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

type Target struct {
	Host      string
	Port      uint16
	Addresses []netip.Addr
}

type domainRule struct {
	value    string
	wildcard bool
}

type Policy struct {
	domains []domainRule
	ports   map[uint16]struct{}
}

func NewPolicy(allowedDomains []string, allowedPorts []uint16) (*Policy, error) {
	policy := &Policy{ports: make(map[uint16]struct{})}
	if len(allowedPorts) == 0 {
		allowedPorts = []uint16{443}
	}
	for _, port := range allowedPorts {
		if port == 0 {
			return nil, errors.New("egress port must be between 1 and 65535")
		}
		policy.ports[port] = struct{}{}
	}
	for _, input := range allowedDomains {
		rule := domainRule{}
		value := strings.TrimSpace(input)
		if strings.HasPrefix(value, "*.") {
			rule.wildcard = true
			value = value[2:]
		}
		canonical, err := canonicalHost(value)
		if err != nil {
			return nil, fmt.Errorf("invalid egress domain %q: %w", input, err)
		}
		if _, err := netip.ParseAddr(canonical); err == nil && rule.wildcard {
			return nil, fmt.Errorf("IP address %q cannot be wildcarded", input)
		}
		rule.value = canonical
		policy.domains = append(policy.domains, rule)
	}
	return policy, nil
}

// CanonicalRules returns a stable, deduplicated representation suitable for
// authorization-route hashing and for forwarding to another policy parser.
func (p *Policy) CanonicalRules() ([]string, []uint16) {
	domains := make([]string, 0, len(p.domains))
	for _, rule := range p.domains {
		value := rule.value
		if rule.wildcard {
			value = "*." + value
		}
		domains = append(domains, value)
	}
	sort.Strings(domains)
	domains = deduplicateSorted(domains)
	ports := make([]uint16, 0, len(p.ports))
	for port := range p.ports {
		ports = append(ports, port)
	}
	sort.Slice(ports, func(left, right int) bool { return ports[left] < ports[right] })
	return domains, ports
}

func deduplicateSorted(values []string) []string {
	if len(values) < 2 {
		return values
	}
	write := 1
	for read := 1; read < len(values); read++ {
		if values[read] == values[write-1] {
			continue
		}
		values[write] = values[read]
		write++
	}
	return values[:write]
}

func (p *Policy) Resolve(ctx context.Context, resolver Resolver, authority string) (Target, error) {
	host, portText, err := net.SplitHostPort(authority)
	if err != nil {
		return Target{}, fmt.Errorf("%w: target must be host:port", ErrDenied)
	}
	portNumber, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || portNumber == 0 {
		return Target{}, fmt.Errorf("%w: invalid port", ErrDenied)
	}
	port := uint16(portNumber)
	if _, allowed := p.ports[port]; !allowed {
		return Target{}, fmt.Errorf("%w: port %d is not allowed", ErrDenied, port)
	}
	canonical, err := canonicalHost(host)
	if err != nil || !p.allowsHost(canonical) {
		return Target{}, fmt.Errorf("%w: host is not allowed", ErrDenied)
	}
	addresses := make([]netip.Addr, 0, 4)
	if literal, parseErr := netip.ParseAddr(canonical); parseErr == nil {
		addresses = append(addresses, literal.Unmap())
	} else {
		if resolver == nil {
			resolver = net.DefaultResolver
		}
		resolved, resolveErr := resolver.LookupNetIP(ctx, "ip", canonical)
		if resolveErr != nil {
			return Target{}, fmt.Errorf("resolve %s: %w", canonical, resolveErr)
		}
		seen := make(map[netip.Addr]struct{}, len(resolved))
		for _, address := range resolved {
			address = address.Unmap()
			if _, exists := seen[address]; !exists {
				seen[address] = struct{}{}
				addresses = append(addresses, address)
			}
		}
	}
	if len(addresses) == 0 {
		return Target{}, fmt.Errorf("%w: host resolved to no addresses", ErrDenied)
	}
	// Reject the whole answer set if any address is unsafe. Picking a public
	// answer from a mixed public/private set would make DNS rebinding possible.
	for _, address := range addresses {
		if reason := forbiddenAddressReason(address); reason != "" {
			return Target{}, fmt.Errorf("%w: resolved address is %s", ErrDenied, reason)
		}
	}
	return Target{Host: canonical, Port: port, Addresses: addresses}, nil
}

func (p *Policy) allowsHost(host string) bool {
	for _, rule := range p.domains {
		if !rule.wildcard && host == rule.value {
			return true
		}
		if rule.wildcard && strings.HasSuffix(host, "."+rule.value) && host != rule.value {
			return true
		}
	}
	return false
}

func canonicalHost(input string) (string, error) {
	value := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(input)), ".")
	if value == "" {
		return "", errors.New("empty host")
	}
	if address, err := netip.ParseAddr(value); err == nil {
		return address.Unmap().String(), nil
	}
	ascii, err := idna.Lookup.ToASCII(value)
	if err != nil {
		return "", err
	}
	if len(ascii) > 253 || strings.ContainsAny(ascii, "/\\:@[]%\x00") {
		return "", errors.New("invalid domain name")
	}
	for _, label := range strings.Split(ascii, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", errors.New("invalid domain label")
		}
		for _, character := range label {
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
				return "", errors.New("invalid domain character")
			}
		}
	}
	return ascii, nil
}

var forbiddenPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::/128"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fec0::/10"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("3fff::/20"),
}

var nat64Prefixes = []netip.Prefix{
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
}

func forbiddenAddressReason(address netip.Addr) string {
	if !address.IsValid() || !address.IsGlobalUnicast() {
		return "non-global"
	}
	for _, prefix := range forbiddenPrefixes {
		if prefix.Contains(address) {
			if prefix == netip.MustParsePrefix("169.254.0.0/16") {
				return "link-local or metadata"
			}
			return "private or special-use"
		}
	}
	for _, prefix := range nat64Prefixes {
		if prefix.Contains(address) {
			bytes := address.As16()
			embedded := netip.AddrFrom4([4]byte{bytes[12], bytes[13], bytes[14], bytes[15]})
			if reason := forbiddenAddressReason(embedded); reason != "" {
				return "NAT64-embedded " + reason
			}
		}
	}
	return ""
}
