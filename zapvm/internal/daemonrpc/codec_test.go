package daemonrpc

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"sync"
	"testing"
)

type testPayload struct {
	Value string `json:"value"`
}

func TestCodecRoundTripAndStrictPayload(t *testing.T) {
	var stream bytes.Buffer
	codec := NewCodec(&stream, &stream)
	envelope, err := NewEnvelope("request-1", "ping", testPayload{Value: "ok"})
	if err != nil {
		t.Fatal(err)
	}
	if err := codec.Write(envelope); err != nil {
		t.Fatal(err)
	}
	read, err := codec.Read()
	if err != nil {
		t.Fatal(err)
	}
	payload, err := DecodePayload[testPayload](read.Payload)
	if err != nil || payload.Value != "ok" {
		t.Fatalf("payload = %+v, %v", payload, err)
	}
	read.Payload = json.RawMessage(`{"value":"ok","unknown":true}`)
	if _, err := DecodePayload[testPayload](read.Payload); err == nil {
		t.Fatal("strict payload decoder accepted unknown field")
	}
}

func TestCodecRejectsMalformedAndOversizedFrames(t *testing.T) {
	frame := func(data []byte) []byte {
		result := make([]byte, 4+len(data))
		binary.BigEndian.PutUint32(result[:4], uint32(len(data)))
		copy(result[4:], data)
		return result
	}
	for name, data := range map[string][]byte{
		"empty":    {0, 0, 0, 0},
		"unknown":  frame([]byte(`{"schema_version":1,"id":"x","type":"ping","unknown":true}`)),
		"trailing": frame([]byte(`{"schema_version":1,"id":"x","type":"ping"} {}`)),
		"bad-id":   frame([]byte(`{"schema_version":1,"id":"bad id","type":"ping"}`)),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NewCodec(bytes.NewReader(data), nil).Read(); err == nil {
				t.Fatal("malformed frame was accepted")
			}
		})
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], MaxFrameSize+1)
	if _, err := NewCodec(bytes.NewReader(header[:]), nil).Read(); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("oversized frame error = %v", err)
	}
}

func TestCodecSerializesConcurrentWrites(t *testing.T) {
	var stream bytes.Buffer
	codec := NewCodec(nil, &stream)
	const writers = 32
	var wait sync.WaitGroup
	for index := 0; index < writers; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			envelope, err := NewEnvelope("request", "event", testPayload{Value: "payload"})
			if err == nil {
				err = codec.Write(envelope)
			}
			if err != nil {
				t.Errorf("write: %v", err)
			}
		}()
	}
	wait.Wait()
	reader := NewCodec(&stream, nil)
	for index := 0; index < writers; index++ {
		if _, err := reader.Read(); err != nil {
			t.Fatalf("read frame %d: %v", index, err)
		}
	}
}

func FuzzCodecRead(f *testing.F) {
	envelope, _ := NewEnvelope("seed", "ping", testPayload{Value: "ok"})
	var seed bytes.Buffer
	_ = NewCodec(nil, &seed).Write(envelope)
	f.Add(seed.Bytes())
	f.Add([]byte{0, 0, 0, 1, '{'})
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > MaxFrameSize+4 {
			data = data[:MaxFrameSize+4]
		}
		envelope, err := NewCodec(bytes.NewReader(data), nil).Read()
		if err == nil {
			if err := envelope.Validate(); err != nil {
				t.Fatalf("Read accepted invalid envelope: %v", err)
			}
		}
	})
}
