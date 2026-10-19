package egress

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"time"
)

const defaultDoHEndpoint = "https://cloudflare-dns.com/dns-query"

var fakeIPPrefix = netip.MustParsePrefix("198.18.0.0/15")

// NewHostResolver returns the resolver used by the Host CONNECT proxy. Most
// systems use their native resolver unchanged. Proxy clients such as Clash and
// Mihomo can instead synthesize RFC 2544 benchmark addresses for every public
// name. When the complete native answer is from that Fake-IP range, resolve the
// name again over DNS-over-HTTPS so policy validation and literal-IP dialing
// still use the real public destination.
func NewHostResolver() Resolver {
	return &fakeIPFallbackResolver{
		primary: net.DefaultResolver,
		client: &http.Client{
			Timeout: 5 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return errors.New("DNS-over-HTTPS redirect is not allowed")
			},
		},
		endpoint: defaultDoHEndpoint,
	}
}

type fakeIPFallbackResolver struct {
	primary  Resolver
	client   *http.Client
	endpoint string
}

func (r *fakeIPFallbackResolver) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	primary := r.primary
	if primary == nil {
		primary = net.DefaultResolver
	}
	addresses, err := primary.LookupNetIP(ctx, network, host)
	if err != nil || !onlyFakeIPAddresses(addresses) {
		return addresses, err
	}
	addresses, err = r.lookupDoH(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("system DNS returned only Fake-IP addresses for %s; public DNS fallback failed: %w", host, err)
	}
	return addresses, nil
}

func onlyFakeIPAddresses(addresses []netip.Addr) bool {
	if len(addresses) == 0 {
		return false
	}
	for _, address := range addresses {
		if !fakeIPPrefix.Contains(address.Unmap()) {
			return false
		}
	}
	return true
}

func (r *fakeIPFallbackResolver) lookupDoH(ctx context.Context, host string) ([]netip.Addr, error) {
	client := r.client
	if client == nil {
		client = http.DefaultClient
	}
	endpoint := r.endpoint
	if endpoint == "" {
		endpoint = defaultDoHEndpoint
	}
	seen := make(map[netip.Addr]struct{})
	addresses := make([]netip.Addr, 0, 4)
	for _, queryType := range []uint16{1, 28} {
		queryURL, err := url.Parse(endpoint)
		if err != nil {
			return nil, err
		}
		query := queryURL.Query()
		query.Set("name", host)
		query.Set("type", strconv.Itoa(int(queryType)))
		queryURL.RawQuery = query.Encode()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, queryURL.String(), nil)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Accept", "application/dns-json")
		response, err := client.Do(request)
		if err != nil {
			return nil, err
		}
		var payload struct {
			Status int `json:"Status"`
			Answer []struct {
				Type uint16 `json:"type"`
				Data string `json:"data"`
			} `json:"Answer"`
		}
		decodeErr := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&payload)
		closeErr := response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("DNS-over-HTTPS returned HTTP %d", response.StatusCode)
		}
		if decodeErr != nil {
			return nil, decodeErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if payload.Status != 0 {
			return nil, fmt.Errorf("DNS-over-HTTPS returned DNS status %d", payload.Status)
		}
		for _, answer := range payload.Answer {
			if answer.Type != queryType {
				continue
			}
			address, parseErr := netip.ParseAddr(answer.Data)
			if parseErr != nil {
				continue
			}
			address = address.Unmap()
			if _, exists := seen[address]; exists {
				continue
			}
			seen[address] = struct{}{}
			addresses = append(addresses, address)
		}
	}
	if len(addresses) == 0 {
		return nil, errors.New("DNS-over-HTTPS returned no IP addresses")
	}
	return addresses, nil
}
