//go:build !windows

package cloudnode

import (
	"context"
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/websocket"

	"zapvm/internal/cloudplane"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/relayprotocol"
)

func TestTaskRelayRetriesUnacknowledgedBatchWithoutSplittingEvents(t *testing.T) {
	var attempts atomic.Int32
	var accepted atomic.Int32
	server := httptest.NewTLSServer(websocket.Server{
		Handshake: func(config *websocket.Config, _ *http.Request) error {
			config.Protocol = []string{relayprotocol.Subprotocol}
			return nil
		},
		Handler: func(connection *websocket.Conn) {
			data, err := receiveTaskRelayFrame(connection)
			if err != nil {
				return
			}
			var open relayprotocol.Open
			if relayprotocol.Decode(data, &open) != nil {
				return
			}
			_ = sendTaskRelayFrame(connection, relayprotocol.Ack{SchemaVersion: relayprotocol.SchemaVersion, Type: relayprotocol.TypeOpenAck})
			data, err = receiveTaskRelayFrame(connection)
			if err != nil {
				return
			}
			var batch relayprotocol.EventBatch
			if relayprotocol.Decode(data, &batch) != nil || batch.BatchID != 1 || len(batch.Events) != 10 {
				return
			}
			if attempts.Add(1) == 1 {
				_ = connection.Close()
				return
			}
			accepted.Store(int32(len(batch.Events)))
			_ = sendTaskRelayFrame(connection, relayprotocol.Ack{
				SchemaVersion: relayprotocol.SchemaVersion, Type: relayprotocol.TypeEventAck, BatchID: 1, Accepted: len(batch.Events),
			})
		},
	})
	defer server.Close()

	worker := &Worker{
		config: Config{ControlURL: server.URL, RelayMode: "required"}, generation: "generation-00001",
		relayTLS: &tls.Config{InsecureSkipVerify: true}, // test server certificate only
	}
	lease := cloudplane.Lease{Task: cloudplane.Task{ID: "task-a"}, LeaseToken: "lease-token"}
	uploader := newTaskEventUploader(worker, lease)
	defer uploader.Close()
	events := make([]daemonrpc.ComputerTaskEvent, 10)
	for index := range events {
		events[index] = daemonrpc.ComputerTaskEvent{
			Cursor: uint64(index + 1), Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
			TaskID: "task-a", Type: "exec.output", Stream: "stdout", Data: []byte(strings.Repeat("x", 8)),
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := uploader.Upload(ctx, events); err != nil {
		t.Fatal(err)
	}
	if attempts.Load() != 2 || accepted.Load() != 10 || uploader.batchID != 2 {
		t.Fatalf("attempts=%d accepted=%d next_batch=%d", attempts.Load(), accepted.Load(), uploader.batchID)
	}
}
