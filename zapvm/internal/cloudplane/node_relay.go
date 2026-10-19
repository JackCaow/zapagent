package cloudplane

import (
	"errors"
	"net/http"

	"golang.org/x/net/websocket"

	"zapvm/internal/relayprotocol"
)

func (api *API) nodeTaskRelay(writer http.ResponseWriter, request *http.Request, nodeID, taskID string) {
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	server := websocket.Server{
		Handshake: func(config *websocket.Config, _ *http.Request) error {
			for _, protocol := range config.Protocol {
				if protocol == relayprotocol.Subprotocol {
					config.Protocol = []string{relayprotocol.Subprotocol}
					return nil
				}
			}
			return errors.New("Relay subprotocol is required")
		},
		Handler: func(connection *websocket.Conn) {
			api.serveNodeTaskRelay(connection, nodeID, taskID)
		},
	}
	server.ServeHTTP(writer, request)
}

func (api *API) serveNodeTaskRelay(connection *websocket.Conn, nodeID, taskID string) {
	connection.MaxPayloadBytes = relayprotocol.MaxFrameSize
	data, err := receiveRelayFrame(connection)
	if err != nil {
		return
	}
	var open relayprotocol.Open
	if relayprotocol.Decode(data, &open) != nil || open.Validate() != nil {
		_ = sendRelayFailure(connection, "invalid_request", 0)
		return
	}
	if err := sendRelayFrame(connection, relayprotocol.Ack{
		SchemaVersion: relayprotocol.SchemaVersion, Type: relayprotocol.TypeOpenAck,
	}); err != nil {
		return
	}

	expectedBatchID := open.FirstBatchID
	for {
		data, err = receiveRelayFrame(connection)
		if err != nil {
			return
		}
		var batch relayprotocol.EventBatch
		if relayprotocol.Decode(data, &batch) != nil || batch.Validate(taskID, expectedBatchID) != nil {
			_ = sendRelayFailure(connection, "invalid_request", expectedBatchID)
			return
		}
		if appender, ok := api.store.(TaskEventBatchAppender); ok {
			if _, err := appender.AppendTaskEvents(nodeID, open.Generation, taskID, open.LeaseToken, batch.Events); err != nil {
				_, code := classifyStoreError(err)
				_ = sendRelayFailure(connection, code, batch.BatchID)
				return
			}
		} else {
			for _, event := range batch.Events {
				if _, _, err := api.store.AppendTaskEvent(nodeID, open.Generation, taskID, open.LeaseToken, event); err != nil {
					_, code := classifyStoreError(err)
					_ = sendRelayFailure(connection, code, batch.BatchID)
					return
				}
			}
		}
		if err := sendRelayFrame(connection, relayprotocol.Ack{
			SchemaVersion: relayprotocol.SchemaVersion, Type: relayprotocol.TypeEventAck,
			BatchID: batch.BatchID, Accepted: len(batch.Events),
		}); err != nil {
			return
		}
		expectedBatchID++
	}
}

func receiveRelayFrame(connection *websocket.Conn) ([]byte, error) {
	var data []byte
	if err := websocket.Message.Receive(connection, &data); err != nil {
		return nil, err
	}
	if len(data) == 0 || len(data) > relayprotocol.MaxFrameSize {
		return nil, errors.New("Relay frame size is invalid")
	}
	return data, nil
}

func sendRelayFrame(connection *websocket.Conn, value any) error {
	data, err := relayprotocol.Encode(value)
	if err != nil {
		return err
	}
	return websocket.Message.Send(connection, data)
}

func sendRelayFailure(connection *websocket.Conn, code string, batchID uint64) error {
	return sendRelayFrame(connection, relayprotocol.Failure{
		SchemaVersion: relayprotocol.SchemaVersion, Type: relayprotocol.TypeError, Code: code, BatchID: batchID,
	})
}
