package cloudplane

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/websocket"

	"zapvm/internal/daemonrpc"
	"zapvm/internal/relayprotocol"
)

func TestNodeTaskRelayBatchesAndIdempotentlyReplaysEvents(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 8, 8, 7, 0, 0, 0, time.UTC)}
	store, _ := openTestStore(t, clock)
	if _, err := store.RegisterNode("node-a", "generation-00001"); err != nil {
		t.Fatal(err)
	}
	submitTask(t, store, testPrincipalA, "relay-task", Scope{TenantID: "acme", ProjectID: "weather"})
	leases, err := store.Claim("node-a", "generation-00001", 1)
	if err != nil || len(leases) != 1 {
		t.Fatalf("claim=%#v err=%v", leases, err)
	}
	lease := leases[0]
	if _, err := store.Acknowledge("node-a", "generation-00001", "relay-task", lease.LeaseToken); err != nil {
		t.Fatal(err)
	}
	api, err := NewAPI(store, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	nodeURI, _ := url.Parse("spiffe://example.test/node/node-a")
	leaf := &x509.Certificate{URIs: []*url.URL{nodeURI}}
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		request.TLS = &tls.ConnectionState{
			PeerCertificates: []*x509.Certificate{leaf}, VerifiedChains: [][]*x509.Certificate{{leaf}},
		}
		api.Handler().ServeHTTP(writer, request)
	})
	server := httptest.NewServer(handler)
	defer server.Close()

	batch := relayprotocol.EventBatch{
		SchemaVersion: relayprotocol.SchemaVersion, Type: relayprotocol.TypeEventBatch, BatchID: 1,
		Events: []daemonrpc.ComputerTaskEvent{
			{Cursor: 1, Timestamp: clock.Now().Format(time.RFC3339Nano), TaskID: "relay-task", Type: "exec.output", Stream: "stdout", Data: []byte("one")},
			{Cursor: 2, Timestamp: clock.Now().Add(time.Millisecond).Format(time.RFC3339Nano), TaskID: "relay-task", Type: "exec.output", Stream: "stdout", Data: []byte("two")},
		},
	}
	for attempt := 0; attempt < 2; attempt++ {
		config, err := websocket.NewConfig(strings.Replace(server.URL, "http://", "ws://", 1)+"/v1/node/tasks/relay-task/relay", server.URL)
		if err != nil {
			t.Fatal(err)
		}
		config.Protocol = []string{relayprotocol.Subprotocol}
		connection, err := websocket.DialConfig(config)
		if err != nil {
			t.Fatal(err)
		}
		open := relayprotocol.Open{SchemaVersion: relayprotocol.SchemaVersion, Type: relayprotocol.TypeOpen,
			Generation: "generation-00001", LeaseToken: lease.LeaseToken, FirstBatchID: 1}
		if err := sendRelayFrame(connection, open); err != nil {
			t.Fatal(err)
		}
		data, err := receiveRelayFrame(connection)
		if err != nil {
			t.Fatal(err)
		}
		var openAck relayprotocol.Ack
		if relayprotocol.Decode(data, &openAck) != nil || openAck.Type != relayprotocol.TypeOpenAck {
			t.Fatalf("open ack=%s", data)
		}
		if err := sendRelayFrame(connection, batch); err != nil {
			t.Fatal(err)
		}
		data, err = receiveRelayFrame(connection)
		if err != nil {
			t.Fatal(err)
		}
		var ack relayprotocol.Ack
		if relayprotocol.Decode(data, &ack) != nil || ack.Type != relayprotocol.TypeEventAck || ack.BatchID != 1 || ack.Accepted != 2 {
			t.Fatalf("event ack=%s", data)
		}
		_ = connection.Close()
	}
	events, err := store.TaskEvents(Scope{TenantID: "acme", ProjectID: "weather"}, "relay-task", 0, 10)
	if err != nil || len(events) != 2 || string(events[0].Data) != "one" || string(events[1].Data) != "two" {
		t.Fatalf("events=%#v err=%v", events, err)
	}
}
