package daemonrpc

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"unicode/utf8"
)

const (
	SchemaVersion = 1
	MaxFrameSize  = 1 << 20
)

var ErrFrameTooLarge = errors.New("daemon RPC frame exceeds 1 MiB")

type Envelope struct {
	SchemaVersion int             `json:"schema_version"`
	ID            string          `json:"id"`
	Type          string          `json:"type"`
	Payload       json.RawMessage `json:"payload,omitempty"`
}

type Codec struct {
	reader io.Reader
	writer io.Writer
	mu     sync.Mutex
}

func NewCodec(reader io.Reader, writer io.Writer) *Codec {
	return &Codec{reader: reader, writer: writer}
}

func NewEnvelope(id, messageType string, payload any) (Envelope, error) {
	envelope := Envelope{SchemaVersion: SchemaVersion, ID: id, Type: messageType}
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return Envelope{}, err
		}
		envelope.Payload = raw
	}
	if err := envelope.Validate(); err != nil {
		return Envelope{}, err
	}
	return envelope, nil
}

func (envelope Envelope) Validate() error {
	if envelope.SchemaVersion != SchemaVersion {
		return errors.New("unsupported daemon RPC schema")
	}
	if !validToken(envelope.ID, 128) {
		return errors.New("daemon RPC ID must contain 1-128 ASCII token characters")
	}
	if !validToken(envelope.Type, 64) {
		return errors.New("daemon RPC type must contain 1-64 ASCII token characters")
	}
	if len(envelope.Payload) > MaxFrameSize || (len(envelope.Payload) > 0 && !json.Valid(envelope.Payload)) {
		return errors.New("daemon RPC payload is oversized or invalid JSON")
	}
	return nil
}

func (codec *Codec) Read() (Envelope, error) {
	var header [4]byte
	if _, err := io.ReadFull(codec.reader, header[:]); err != nil {
		return Envelope{}, err
	}
	size := binary.BigEndian.Uint32(header[:])
	if size == 0 {
		return Envelope{}, errors.New("daemon RPC frame is empty")
	}
	if size > MaxFrameSize {
		return Envelope{}, ErrFrameTooLarge
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(codec.reader, data); err != nil {
		return Envelope{}, err
	}
	var envelope Envelope
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return Envelope{}, fmt.Errorf("decode daemon RPC envelope: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Envelope{}, errors.New("daemon RPC envelope contains trailing JSON")
	}
	if err := envelope.Validate(); err != nil {
		return Envelope{}, err
	}
	return envelope, nil
}

func (codec *Codec) Write(envelope Envelope) error {
	if err := envelope.Validate(); err != nil {
		return err
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	if len(data) > MaxFrameSize {
		return ErrFrameTooLarge
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(data)))
	codec.mu.Lock()
	defer codec.mu.Unlock()
	if err := writeFull(codec.writer, header[:]); err != nil {
		return err
	}
	return writeFull(codec.writer, data)
}

func DecodePayload[T any](payload json.RawMessage) (T, error) {
	var result T
	if len(payload) == 0 || len(payload) > MaxFrameSize {
		return result, errors.New("daemon RPC payload is required and bounded")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return result, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return result, errors.New("daemon RPC payload contains trailing JSON")
	}
	return result, nil
}

func validToken(value string, maximum int) bool {
	if value == "" || len(value) > maximum || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

func writeFull(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		written, err := writer.Write(data)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		data = data[written:]
	}
	return nil
}
