package relayprotocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"

	"zapvm/internal/daemonrpc"
)

const (
	SchemaVersion = 1
	Subprotocol   = "zapvm.task-events.v1"
	MaxFrameSize  = 512 << 10
	MaxEvents     = 64
)

const (
	TypeOpen       = "open"
	TypeOpenAck    = "open_ack"
	TypeEventBatch = "event_batch"
	TypeEventAck   = "event_ack"
	TypeError      = "error"
)

// Open authenticates one task-scoped event stream. Lease material remains
// inside the mutually authenticated TLS connection and is never logged.
type Open struct {
	SchemaVersion int    `json:"schema_version"`
	Type          string `json:"type"`
	Generation    string `json:"generation"`
	LeaseToken    string `json:"lease_token"`
	FirstBatchID  uint64 `json:"first_batch_id"`
}

// EventBatch amortizes one network acknowledgement across bounded Guest
// events. Source cursors keep a retried batch idempotent at the Control store.
type EventBatch struct {
	SchemaVersion int                           `json:"schema_version"`
	Type          string                        `json:"type"`
	BatchID       uint64                        `json:"batch_id"`
	Events        []daemonrpc.ComputerTaskEvent `json:"events"`
}

type Ack struct {
	SchemaVersion int    `json:"schema_version"`
	Type          string `json:"type"`
	BatchID       uint64 `json:"batch_id,omitempty"`
	Accepted      int    `json:"accepted,omitempty"`
}

type Failure struct {
	SchemaVersion int    `json:"schema_version"`
	Type          string `json:"type"`
	Code          string `json:"code"`
	BatchID       uint64 `json:"batch_id,omitempty"`
}

func Decode(data []byte, destination any) error {
	if len(data) == 0 || len(data) > MaxFrameSize {
		return errors.New("Relay frame size is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("Relay frame contains trailing JSON")
	}
	return nil
}

func Encode(value any) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 || len(data) > MaxFrameSize {
		return nil, errors.New("Relay frame size is invalid")
	}
	return data, nil
}

func (open Open) Validate() error {
	if open.SchemaVersion != SchemaVersion || open.Type != TypeOpen || open.Generation == "" ||
		open.LeaseToken == "" || open.FirstBatchID == 0 {
		return errors.New("Relay open frame is invalid")
	}
	return nil
}

func (batch EventBatch) Validate(taskID string, expectedBatchID uint64) error {
	if batch.SchemaVersion != SchemaVersion || batch.Type != TypeEventBatch || batch.BatchID != expectedBatchID ||
		len(batch.Events) == 0 || len(batch.Events) > MaxEvents {
		return errors.New("Relay event batch is invalid")
	}
	for _, event := range batch.Events {
		if event.TaskID != taskID {
			return errors.New("Relay event batch Task is invalid")
		}
	}
	return nil
}
