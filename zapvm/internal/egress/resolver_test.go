package egress

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync/atomic"
	"testing"
)

func TestFakeIPResolverUsesPublicDoHFallback(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		writer.Header().Set("Content-Type", "application/dns-json")
		if request.URL.Query().Get("type") == "1" {
			_, _ = fmt.Fprint(writer, `{"Status":0,"Answer":[{"type":1,"data":"93.184.216.34"}]}`)
			return
		}
		_, _ = fmt.Fprint(writer, `{"Status":0,"Answer":[]}`)
	}))
	defer server.Close()

	resolver := &fakeIPFallbackResolver{
		primary:  &staticResolver{addresses: []netip.Addr{netip.MustParseAddr("198.18.8.166")}},
		client:   server.Client(),
		endpoint: server.URL,
	}
	addresses, err := resolver.LookupNetIP(context.Background(), "ip", "example.com")
	if err != nil || len(addresses) != 1 || addresses[0].String() != "93.184.216.34" {
		t.Fatalf("addresses=%v err=%v", addresses, err)
	}
	if requests.Load() != 2 {
		t.Fatalf("DNS-over-HTTPS requests=%d, want 2", requests.Load())
	}
}

func TestFakeIPResolverDoesNotFallbackForNormalOrMixedAnswers(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests.Add(1)
	}))
	defer server.Close()
	for _, input := range [][]netip.Addr{
		{netip.MustParseAddr("93.184.216.34")},
		{netip.MustParseAddr("198.18.8.166"), netip.MustParseAddr("10.0.0.2")},
	} {
		resolver := &fakeIPFallbackResolver{
			primary:  &staticResolver{addresses: input},
			client:   server.Client(),
			endpoint: server.URL,
		}
		addresses, err := resolver.LookupNetIP(context.Background(), "ip", "example.com")
		if err != nil || len(addresses) != len(input) {
			t.Fatalf("addresses=%v err=%v", addresses, err)
		}
	}
	if requests.Load() != 0 {
		t.Fatalf("unexpected DNS-over-HTTPS requests=%d", requests.Load())
	}
}

func TestPolicyStillRejectsPrivateDoHFallbackAnswer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/dns-json")
		if request.URL.Query().Get("type") == "1" {
			_, _ = fmt.Fprint(writer, `{"Status":0,"Answer":[{"type":1,"data":"10.0.0.5"}]}`)
			return
		}
		_, _ = fmt.Fprint(writer, `{"Status":0,"Answer":[]}`)
	}))
	defer server.Close()
	resolver := &fakeIPFallbackResolver{
		primary:  &staticResolver{addresses: []netip.Addr{netip.MustParseAddr("198.18.8.166")}},
		client:   server.Client(),
		endpoint: server.URL,
	}
	policy, err := NewPolicy([]string{"example.com"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := policy.Resolve(context.Background(), resolver, "example.com:443"); err == nil {
		t.Fatal("private DNS-over-HTTPS answer was accepted")
	}
}
