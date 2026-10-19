package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"testing"
)

func TestCodecRoundTrip(t *testing.T) {
	var buffer bytes.Buffer
	codec := NewCodec(&buffer, &buffer)
	want, err := NewEnvelope("request-1", "session-1", "hello", map[string]string{"nonce": "abc"})
	if err != nil {
		t.Fatal(err)
	}
	if err := codec.Write(want); err != nil {
		t.Fatal(err)
	}
	got, err := codec.Read()
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != want.Version || got.ID != want.ID || got.SessionID != want.SessionID || got.Type != want.Type {
		t.Fatalf("round trip mismatch: got %#v want %#v", got, want)
	}
	if !bytes.Equal(got.Payload, want.Payload) {
		t.Fatalf("payload mismatch: got %s want %s", got.Payload, want.Payload)
	}
}

func TestCodecRejectsOversizedReadBeforeAllocation(t *testing.T) {
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], MaxFrameSize+1)
	codec := NewCodec(bytes.NewReader(header[:]), &bytes.Buffer{})
	_, err := codec.Read()
	if !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("got %v, want ErrFrameTooLarge", err)
	}
}

func TestCodecRejectsOversizedWrite(t *testing.T) {
	codec := NewCodec(&bytes.Buffer{}, &bytes.Buffer{})
	err := codec.Write(Envelope{Version: Version, Type: "data", Payload: []byte(`"` + strings.Repeat("a", MaxFrameSize) + `"`)})
	if !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("got %v, want ErrFrameTooLarge", err)
	}
}

func TestCodecRejectsUnknownVersion(t *testing.T) {
	var buffer bytes.Buffer
	payload := []byte(`{"version":2,"type":"hello"}`)
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	buffer.Write(header[:])
	buffer.Write(payload)
	_, err := NewCodec(&buffer, &bytes.Buffer{}).Read()
	if err == nil || !strings.Contains(err.Error(), "unsupported protocol version") {
		t.Fatalf("unexpected error: %v", err)
	}
}
