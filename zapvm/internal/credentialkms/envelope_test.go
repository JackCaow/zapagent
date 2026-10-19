package credentialkms

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

type testWrapper struct {
	key         []byte
	unwrapCalls int
	failure     error
}

func (wrapper *testWrapper) Wrap(_ context.Context, plaintext, aad []byte) (WrappedKey, error) {
	if wrapper.failure != nil {
		return WrappedKey{}, wrapper.failure
	}
	block, _ := aes.NewCipher(wrapper.key)
	gcm, _ := cipher.NewGCM(block)
	digest := sha256.Sum256(append(append([]byte(nil), plaintext...), aad...))
	nonce := append([]byte(nil), digest[:gcm.NonceSize()]...)
	return WrappedKey{Provider: "test-kms", KeyID: "key/credential", KeyVersion: "v1", Ciphertext: append(nonce, gcm.Seal(nil, nonce, plaintext, aad)...)}, nil
}

func (wrapper *testWrapper) Unwrap(_ context.Context, wrapped WrappedKey, aad []byte) ([]byte, error) {
	wrapper.unwrapCalls++
	if wrapper.failure != nil {
		return nil, wrapper.failure
	}
	block, _ := aes.NewCipher(wrapper.key)
	gcm, _ := cipher.NewGCM(block)
	if len(wrapped.Ciphertext) < gcm.NonceSize() {
		return nil, errors.New("private provider detail")
	}
	return gcm.Open(nil, wrapped.Ciphertext[:gcm.NonceSize()], wrapped.Ciphertext[gcm.NonceSize():], aad)
}

func TestEnvelopeRoundTripAndPersistenceContainsNoPlaintext(t *testing.T) {
	wrapper := &testWrapper{key: bytes.Repeat([]byte{0x24}, DataKeySize)}
	broker, err := New(wrapper)
	if err != nil {
		t.Fatal(err)
	}
	binding := Binding{TenantID: "acme", ProjectID: "weather", CredentialID: "model-api-key", Version: 7}
	secret := []byte("private-model-token-that-must-not-be-persisted")
	envelope, err := broker.Seal(context.Background(), binding, secret)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, secret) || envelope.SchemaVersion != 1 || envelope.Algorithm != EnvelopeAlgorithm || len(envelope.Nonce) != 12 || len(envelope.AADSHA256) != sha256.Size {
		t.Fatalf("invalid persisted envelope metadata: %s", encoded)
	}
	opened, err := broker.Open(context.Background(), binding, envelope)
	if err != nil || !bytes.Equal(opened, secret) {
		t.Fatalf("open envelope value=%q err=%v", opened, err)
	}
	zero(opened)
}

func TestEnvelopeRejectsBindingAndCiphertextTampering(t *testing.T) {
	wrapper := &testWrapper{key: bytes.Repeat([]byte{0x35}, DataKeySize)}
	broker, _ := New(wrapper)
	binding := Binding{TenantID: "acme", ProjectID: "weather", CredentialID: "search-key", Version: 1}
	envelope, err := broker.Seal(context.Background(), binding, []byte("private-search-token"))
	if err != nil {
		t.Fatal(err)
	}
	other := binding
	other.ProjectID = "billing"
	if _, err := broker.Open(context.Background(), other, envelope); err == nil || wrapper.unwrapCalls != 0 {
		t.Fatalf("binding tamper err=%v unwrap_calls=%d", err, wrapper.unwrapCalls)
	}
	tampered := envelope
	tampered.Ciphertext = append([]byte(nil), envelope.Ciphertext...)
	tampered.Ciphertext[0] ^= 0xff
	if _, err := broker.Open(context.Background(), binding, tampered); err == nil || !strings.Contains(err.Error(), "authenticate") {
		t.Fatalf("ciphertext tamper err=%v", err)
	}
	tampered = envelope
	tampered.WrappedKey.Ciphertext = append([]byte(nil), envelope.WrappedKey.Ciphertext...)
	tampered.WrappedKey.Ciphertext[len(tampered.WrappedKey.Ciphertext)-1] ^= 0xff
	if _, err := broker.Open(context.Background(), binding, tampered); err == nil || strings.Contains(err.Error(), "private") {
		t.Fatalf("wrapped key tamper leaked provider error: %v", err)
	}
}

func TestEnvelopeRedactsWrapperErrorsAndUsesUniqueNonces(t *testing.T) {
	privateFailure := errors.New("kms response contained private account and token")
	wrapper := &testWrapper{key: bytes.Repeat([]byte{0x46}, DataKeySize), failure: privateFailure}
	broker, _ := New(wrapper)
	binding := Binding{TenantID: "acme", ProjectID: "weather", CredentialID: "model-key", Version: 1}
	if _, err := broker.Seal(context.Background(), binding, []byte("secret")); err == nil || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "account") {
		t.Fatalf("wrapper error was not redacted: %v", err)
	}
	wrapper.failure = nil
	seen := make(map[string]struct{})
	for index := 0; index < 128; index++ {
		envelope, err := broker.Seal(context.Background(), binding, []byte("secret"))
		if err != nil {
			t.Fatal(err)
		}
		key := string(envelope.Nonce)
		if _, duplicate := seen[key]; duplicate {
			t.Fatal("Credential envelope nonce was reused")
		}
		seen[key] = struct{}{}
	}
}

func TestEnvelopeRejectsInvalidMetadataAndOversizedValues(t *testing.T) {
	wrapper := &testWrapper{key: bytes.Repeat([]byte{0x57}, DataKeySize)}
	broker, _ := New(wrapper)
	valid := Binding{TenantID: "acme", ProjectID: "weather", CredentialID: "model-key", Version: 1}
	if _, err := broker.Seal(context.Background(), Binding{}, []byte("secret")); err == nil {
		t.Fatal("invalid binding accepted")
	}
	if _, err := broker.Seal(context.Background(), valid, make([]byte, MaximumPlaintextSize+1)); err == nil {
		t.Fatal("oversized plaintext accepted")
	}
	envelope, err := broker.Seal(context.Background(), valid, []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	envelope.SchemaVersion++
	if _, err := broker.Open(context.Background(), valid, envelope); err == nil {
		t.Fatal("unknown envelope schema accepted")
	}
}

func TestStaticKeyWrapperRoundTripTamperAndClose(t *testing.T) {
	wrapper, err := NewStaticKeyWrapper(bytes.Repeat([]byte{0x68}, DataKeySize), "local/credential-kek", "v1")
	if err != nil {
		t.Fatal(err)
	}
	broker, err := New(wrapper)
	if err != nil {
		t.Fatal(err)
	}
	binding := Binding{TenantID: "acme", ProjectID: "weather", CredentialID: "model-key", Version: 1}
	envelope, err := broker.Seal(context.Background(), binding, []byte("static-wrapper-private-value"))
	if err != nil {
		t.Fatal(err)
	}
	opened, err := broker.Open(context.Background(), binding, envelope)
	if err != nil || string(opened) != "static-wrapper-private-value" {
		t.Fatalf("static wrapper opened=%q err=%v", opened, err)
	}
	zero(opened)
	tampered := envelope
	tampered.WrappedKey.Ciphertext = append([]byte(nil), envelope.WrappedKey.Ciphertext...)
	tampered.WrappedKey.Ciphertext[len(tampered.WrappedKey.Ciphertext)-1] ^= 0xff
	if _, err := broker.Open(context.Background(), binding, tampered); err == nil {
		t.Fatal("tampered static wrapped key was accepted")
	}
	wrapper.Close()
	if _, err := broker.Open(context.Background(), binding, envelope); err == nil {
		t.Fatal("closed static wrapper remained usable")
	}
}
