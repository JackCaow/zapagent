package protocol

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

const (
	Version      = 1
	MaxFrameSize = 1 << 20
)

var ErrFrameTooLarge = errors.New("protocol frame exceeds limit")

type Envelope struct {
	Version   int             `json:"version"`
	ID        string          `json:"id,omitempty"`
	SessionID string          `json:"session_id,omitempty"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

func NewEnvelope(id, sessionID, messageType string, payload any) (Envelope, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return Envelope{}, err
	}
	return Envelope{Version: Version, ID: id, SessionID: sessionID, Type: messageType, Payload: raw}, nil
}

type Codec struct {
	r  io.Reader
	w  io.Writer
	mu sync.Mutex
}

func NewCodec(r io.Reader, w io.Writer) *Codec {
	return &Codec{r: r, w: w}
}

func (c *Codec) Read() (Envelope, error) {
	var header [4]byte
	if _, err := io.ReadFull(c.r, header[:]); err != nil {
		return Envelope{}, err
	}
	size := binary.BigEndian.Uint32(header[:])
	if size == 0 {
		return Envelope{}, errors.New("empty protocol frame")
	}
	if size > MaxFrameSize {
		return Envelope{}, ErrFrameTooLarge
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(c.r, payload); err != nil {
		return Envelope{}, err
	}
	var envelope Envelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return Envelope{}, fmt.Errorf("decode protocol frame: %w", err)
	}
	if envelope.Version != Version {
		return Envelope{}, fmt.Errorf("unsupported protocol version %d", envelope.Version)
	}
	if envelope.Type == "" {
		return Envelope{}, errors.New("protocol message type is required")
	}
	return envelope, nil
}

func (c *Codec) Write(envelope Envelope) error {
	if envelope.Version == 0 {
		envelope.Version = Version
	}
	if envelope.Version != Version {
		return fmt.Errorf("unsupported protocol version %d", envelope.Version)
	}
	if envelope.Type == "" {
		return errors.New("protocol message type is required")
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	if len(payload) > MaxFrameSize {
		return ErrFrameTooLarge
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := writeFull(c.w, header[:]); err != nil {
		return err
	}
	return writeFull(c.w, payload)
}

func writeFull(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}
