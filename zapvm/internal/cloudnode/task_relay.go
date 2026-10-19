package cloudnode

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"golang.org/x/net/websocket"

	"zapvm/internal/cloudplane"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/relayprotocol"
)

const (
	taskRelayBatchDelay  = 25 * time.Millisecond
	taskRelayBatchSize   = 64 << 10
	taskRelayBatchEvents = 64
)

type taskEventUploader struct {
	worker     *Worker
	lease      cloudplane.Lease
	connection *websocket.Conn
	batchID    uint64
	fallback   bool
	mode       string
}

func newTaskEventUploader(worker *Worker, lease cloudplane.Lease) *taskEventUploader {
	mode := worker.config.RelayMode
	if mode == "" {
		mode = "auto"
	}
	worker.clientMu.RLock()
	relayReady := worker.relayTLS != nil
	worker.clientMu.RUnlock()
	return &taskEventUploader{
		worker: worker, lease: lease, batchID: 1, mode: mode,
		fallback: mode == "off" || (mode == "auto" && !relayReady),
	}
}

func (uploader *taskEventUploader) Upload(ctx context.Context, events []daemonrpc.ComputerTaskEvent) error {
	if len(events) == 0 {
		return nil
	}
	if uploader.fallback {
		return uploader.uploadLegacy(ctx, events)
	}
	batch := relayprotocol.EventBatch{
		SchemaVersion: relayprotocol.SchemaVersion, Type: relayprotocol.TypeEventBatch,
		BatchID: uploader.batchID, Events: append([]daemonrpc.ComputerTaskEvent(nil), events...),
	}
	var last error
	for attempt := 0; attempt < 5; attempt++ {
		if err := uploader.ensureConnection(ctx); err != nil {
			last = err
		} else if err := uploader.exchange(ctx, batch); err != nil {
			last = err
			uploader.closeConnection()
		} else {
			uploader.batchID++
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.Join(ctx.Err(), last)
		case <-time.After(time.Duration(attempt+1) * 50 * time.Millisecond):
		}
	}
	if uploader.mode == "auto" {
		uploader.fallback = true
		uploader.worker.logEvent("task_relay", "task_id", uploader.lease.Task.ID, "fallback", "relay_unavailable")
		return uploader.uploadLegacy(ctx, events)
	}
	return last
}

func (uploader *taskEventUploader) ensureConnection(ctx context.Context) error {
	if uploader.connection != nil {
		return nil
	}
	uploader.worker.clientMu.RLock()
	tlsConfig := uploader.worker.relayTLS
	if tlsConfig != nil {
		tlsConfig = tlsConfig.Clone()
	}
	uploader.worker.clientMu.RUnlock()
	if tlsConfig == nil {
		return errors.New("cloud Node Relay identity is not initialized")
	}
	location := "wss://" + strings.TrimPrefix(uploader.worker.config.ControlURL, "https://") +
		"/v1/node/tasks/" + uploader.lease.Task.ID + "/relay"
	config, err := websocket.NewConfig(location, uploader.worker.config.ControlURL)
	if err != nil {
		return err
	}
	config.Protocol = []string{relayprotocol.Subprotocol}
	config.TlsConfig = tlsConfig
	config.Header = http.Header{cloudplane.RequestIDHeader: []string{uploader.worker.nextRequestID("/v1/node/tasks/:id/relay")}}
	connection, err := config.DialContext(ctx)
	if err != nil {
		return err
	}
	connection.MaxPayloadBytes = relayprotocol.MaxFrameSize
	open := relayprotocol.Open{
		SchemaVersion: relayprotocol.SchemaVersion, Type: relayprotocol.TypeOpen,
		Generation: uploader.worker.generation, LeaseToken: uploader.lease.LeaseToken, FirstBatchID: uploader.batchID,
	}
	if err := sendTaskRelayFrame(connection, open); err != nil {
		_ = connection.Close()
		return err
	}
	data, err := receiveTaskRelayFrame(connection)
	if err != nil {
		_ = connection.Close()
		return err
	}
	var ack relayprotocol.Ack
	if relayprotocol.Decode(data, &ack) != nil || ack.SchemaVersion != relayprotocol.SchemaVersion || ack.Type != relayprotocol.TypeOpenAck {
		_ = connection.Close()
		return errors.New("cloud Control returned an invalid Relay open acknowledgement")
	}
	uploader.connection = connection
	uploader.worker.logEvent("task_relay", "task_id", uploader.lease.Task.ID, "connected", "")
	return nil
}

func (uploader *taskEventUploader) exchange(ctx context.Context, batch relayprotocol.EventBatch) error {
	if deadline, ok := ctx.Deadline(); ok {
		_ = uploader.connection.SetDeadline(deadline)
	} else {
		_ = uploader.connection.SetDeadline(time.Now().Add(30 * time.Second))
	}
	defer uploader.connection.SetDeadline(time.Time{})
	if err := sendTaskRelayFrame(uploader.connection, batch); err != nil {
		return err
	}
	data, err := receiveTaskRelayFrame(uploader.connection)
	if err != nil {
		return err
	}
	var ack relayprotocol.Ack
	if relayprotocol.Decode(data, &ack) == nil && ack.SchemaVersion == relayprotocol.SchemaVersion &&
		ack.Type == relayprotocol.TypeEventAck && ack.BatchID == batch.BatchID && ack.Accepted == len(batch.Events) {
		return nil
	}
	var failure relayprotocol.Failure
	if relayprotocol.Decode(data, &failure) == nil && failure.Type == relayprotocol.TypeError {
		return fmt.Errorf("cloud Control Relay rejected batch: %s", failure.Code)
	}
	return errors.New("cloud Control returned an invalid Relay event acknowledgement")
}

func (uploader *taskEventUploader) uploadLegacy(ctx context.Context, events []daemonrpc.ComputerTaskEvent) error {
	for _, event := range events {
		body := map[string]any{
			"generation": uploader.worker.generation, "lease_token": uploader.lease.LeaseToken, "event": event,
		}
		if err := uploader.worker.postRetry(ctx, "/v1/node/tasks/"+uploader.lease.Task.ID+"/events", body, nil); err != nil {
			return err
		}
	}
	return nil
}

func (uploader *taskEventUploader) Close() {
	uploader.closeConnection()
}

func (uploader *taskEventUploader) closeConnection() {
	if uploader.connection != nil {
		_ = uploader.connection.Close()
		uploader.connection = nil
	}
}

func sendTaskRelayFrame(connection *websocket.Conn, value any) error {
	data, err := relayprotocol.Encode(value)
	if err != nil {
		return err
	}
	return websocket.Message.Send(connection, data)
}

func receiveTaskRelayFrame(connection *websocket.Conn) ([]byte, error) {
	var data []byte
	if err := websocket.Message.Receive(connection, &data); err != nil {
		return nil, err
	}
	if len(data) == 0 || len(data) > relayprotocol.MaxFrameSize {
		return nil, errors.New("cloud Control Relay frame size is invalid")
	}
	return data, nil
}
