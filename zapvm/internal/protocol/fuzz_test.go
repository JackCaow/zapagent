package protocol

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func FuzzCodecRead(f *testing.F) {
	var valid bytes.Buffer
	validCodec := NewCodec(&valid, &valid)
	envelope, err := NewEnvelope("seed", "session", "health", map[string]bool{"ready": true})
	if err != nil {
		f.Fatal(err)
	}
	if err := validCodec.Write(envelope); err != nil {
		f.Fatal(err)
	}
	f.Add(valid.Bytes())
	f.Add([]byte{0, 0, 0, 0})
	oversized := make([]byte, 4)
	binary.BigEndian.PutUint32(oversized, MaxFrameSize+1)
	f.Add(oversized)
	f.Add([]byte{0, 0, 0, 2, '{', '}'})

	f.Fuzz(func(t *testing.T, data []byte) {
		decoded, err := NewCodec(bytes.NewReader(data), &bytes.Buffer{}).Read()
		if err != nil {
			return
		}
		if decoded.Version != Version || decoded.Type == "" {
			t.Fatalf("successful read violated envelope invariants: %#v", decoded)
		}
		var roundTrip bytes.Buffer
		codec := NewCodec(&roundTrip, &roundTrip)
		if err := codec.Write(decoded); err != nil {
			t.Fatalf("re-encode accepted envelope: %v", err)
		}
		got, err := codec.Read()
		if err != nil {
			t.Fatalf("read re-encoded envelope: %v", err)
		}
		if got.Version != decoded.Version || got.Type != decoded.Type || got.ID != decoded.ID || got.SessionID != decoded.SessionID {
			t.Fatalf("round trip changed envelope: got %#v want %#v", got, decoded)
		}
	})
}

func FuzzAuthenticateServerEnvelope(f *testing.F) {
	secret := bytes.Repeat([]byte{0x42}, 32)
	clientNonce := bytes.Repeat([]byte{0x11}, authNonceSize)
	request, err := NewEnvelope("auth", "", "hello.request", helloRequest{
		Nonce: encode(clientNonce),
		Proof: encode(proof(secret, "client", clientNonce)),
	})
	if err != nil {
		f.Fatal(err)
	}
	var valid bytes.Buffer
	if err := NewCodec(&valid, &valid).Write(request); err != nil {
		f.Fatal(err)
	}
	f.Add(valid.Bytes())
	f.Add([]byte("not-a-frame"))
	f.Add([]byte{0, 0, 0, 0})

	f.Fuzz(func(t *testing.T, data []byte) {
		serverNonce := bytes.Repeat([]byte{0x22}, authNonceSize)
		var response bytes.Buffer
		err := authenticateServer(
			NewCodec(bytes.NewReader(data), &response),
			secret,
			bytes.NewReader(serverNonce),
		)
		if err != nil {
			return
		}
		decoded, err := NewCodec(&response, &bytes.Buffer{}).Read()
		if err != nil {
			t.Fatalf("successful authentication emitted invalid response: %v", err)
		}
		if decoded.ID != "auth" || decoded.Type != "hello.response" {
			t.Fatalf("unexpected successful response: %#v", decoded)
		}
	})
}
