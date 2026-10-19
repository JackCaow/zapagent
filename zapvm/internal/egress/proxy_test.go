package egress

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
)

func TestProxyCONNECTUsesVerifiedLiteralAddress(t *testing.T) {
	policy, err := NewPolicy([]string{"example.com"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	resolver := &staticResolver{addresses: []netip.Addr{netip.MustParseAddr("93.184.216.34")}}
	var dialed atomic.Value
	proxy := &Proxy{
		Policy: policy, Resolver: resolver,
		DialContext: func(_ context.Context, network, address string) (net.Conn, error) {
			dialed.Store(network + " " + address)
			proxySide, upstreamSide := net.Pipe()
			go func() {
				defer upstreamSide.Close()
				_, _ = io.Copy(upstreamSide, upstreamSide)
			}()
			return proxySide, nil
		},
	}
	server := httptest.NewServer(proxy.Handler())
	defer server.Close()
	address := strings.TrimPrefix(server.URL, "http://")
	client, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := io.WriteString(client, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\nhello"); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(client)
	status, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(status, "200") {
		t.Fatalf("status=%q err=%v", status, err)
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}
	payload := make([]byte, 5)
	if _, err := io.ReadFull(reader, payload); err != nil || string(payload) != "hello" {
		t.Fatalf("payload=%q err=%v", payload, err)
	}
	if got := dialed.Load(); got != "tcp 93.184.216.34:443" {
		t.Fatalf("proxy dialed %v", got)
	}
}

func TestProxyDeniedTargetNeverDials(t *testing.T) {
	policy, err := NewPolicy([]string{"example.com"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var dialed atomic.Bool
	proxy := &Proxy{
		Policy:   policy,
		Resolver: &staticResolver{addresses: []netip.Addr{netip.MustParseAddr("127.0.0.1")}},
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			dialed.Store(true)
			return nil, nil
		},
	}
	request := httptest.NewRequest("CONNECT", "http://example.com:443", nil)
	request.Host = "example.com:443"
	response := httptest.NewRecorder()
	proxy.Handler().ServeHTTP(response, request)
	if response.Code != 403 || dialed.Load() {
		t.Fatalf("status=%d dialed=%v", response.Code, dialed.Load())
	}
}
