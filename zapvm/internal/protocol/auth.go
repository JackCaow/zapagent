package protocol

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const authNonceSize = 32

var ErrAuthentication = errors.New("guest RPC authentication failed")

type helloRequest struct {
	Nonce string `json:"nonce"`
	Proof string `json:"proof"`
}

type helloResponse struct {
	Nonce string `json:"nonce"`
	Proof string `json:"proof"`
}

func AuthenticateClient(codec *Codec, secret []byte) error {
	return authenticateClient(codec, secret, rand.Reader)
}

func authenticateClient(codec *Codec, secret []byte, random io.Reader) error {
	if len(secret) < 32 {
		return errors.New("RPC secret must contain at least 32 bytes")
	}
	clientNonce, err := randomNonce(random)
	if err != nil {
		return err
	}
	request := helloRequest{
		Nonce: encode(clientNonce),
		Proof: encode(proof(secret, "client", clientNonce)),
	}
	envelope, err := NewEnvelope("auth", "", "hello.request", request)
	if err != nil {
		return err
	}
	if err := codec.Write(envelope); err != nil {
		return err
	}
	responseEnvelope, err := codec.Read()
	if err != nil {
		return err
	}
	if responseEnvelope.Type != "hello.response" || responseEnvelope.ID != "auth" {
		return ErrAuthentication
	}
	var response helloResponse
	if err := json.Unmarshal(responseEnvelope.Payload, &response); err != nil {
		return ErrAuthentication
	}
	serverNonce, err := decodeNonce(response.Nonce)
	if err != nil {
		return ErrAuthentication
	}
	want := proof(secret, "server", clientNonce, serverNonce)
	got, err := base64.RawStdEncoding.DecodeString(response.Proof)
	if err != nil || subtle.ConstantTimeCompare(want, got) != 1 {
		return ErrAuthentication
	}
	return nil
}

func AuthenticateServer(codec *Codec, secret []byte) error {
	return authenticateServer(codec, secret, rand.Reader)
}

func authenticateServer(codec *Codec, secret []byte, random io.Reader) error {
	if len(secret) < 32 {
		return errors.New("RPC secret must contain at least 32 bytes")
	}
	envelope, err := codec.Read()
	if err != nil {
		return err
	}
	if envelope.Type != "hello.request" || envelope.ID != "auth" {
		return ErrAuthentication
	}
	var request helloRequest
	if err := json.Unmarshal(envelope.Payload, &request); err != nil {
		return ErrAuthentication
	}
	clientNonce, err := decodeNonce(request.Nonce)
	if err != nil {
		return ErrAuthentication
	}
	want := proof(secret, "client", clientNonce)
	got, err := base64.RawStdEncoding.DecodeString(request.Proof)
	if err != nil || !hmac.Equal(want, got) {
		return ErrAuthentication
	}
	serverNonce, err := randomNonce(random)
	if err != nil {
		return err
	}
	response := helloResponse{
		Nonce: encode(serverNonce),
		Proof: encode(proof(secret, "server", clientNonce, serverNonce)),
	}
	responseEnvelope, err := NewEnvelope("auth", "", "hello.response", response)
	if err != nil {
		return err
	}
	return codec.Write(responseEnvelope)
}

func randomNonce(random io.Reader) ([]byte, error) {
	nonce := make([]byte, authNonceSize)
	if _, err := io.ReadFull(random, nonce); err != nil {
		return nil, fmt.Errorf("generate auth nonce: %w", err)
	}
	return nonce, nil
}

func decodeNonce(value string) ([]byte, error) {
	nonce, err := base64.RawStdEncoding.DecodeString(value)
	if err != nil || len(nonce) != authNonceSize {
		return nil, ErrAuthentication
	}
	return nonce, nil
}

func encode(value []byte) string {
	return base64.RawStdEncoding.EncodeToString(value)
}

func proof(secret []byte, role string, nonces ...[]byte) []byte {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("zapvm-rpc-v1\x00"))
	_, _ = mac.Write([]byte(role))
	for _, nonce := range nonces {
		_, _ = mac.Write([]byte{0})
		_, _ = mac.Write(nonce)
	}
	return mac.Sum(nil)
}
