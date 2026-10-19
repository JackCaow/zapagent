package credentialkms

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"io"
	"regexp"
)

const (
	EnvelopeSchemaVersion = 1
	EnvelopeAlgorithm     = "AES-256-GCM"
	DataKeySize           = 32
	MaximumPlaintextSize  = 64 << 10
	MaximumWrappedKeySize = 16 << 10
)

var (
	scopeID      = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,127}$`)
	credentialID = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]{0,63}$`)
	metadataID   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$`)
)

// Binding is authenticated but not encrypted. The same envelope cannot be
// moved to another tenant, project, Credential ID, or version.
type Binding struct {
	TenantID     string
	ProjectID    string
	CredentialID string
	Version      uint64
}

// WrappedKey is opaque provider output. Ciphertext contains only an encrypted
// data key; it never contains the Credential value itself.
type WrappedKey struct {
	Provider   string `json:"provider"`
	KeyID      string `json:"key_id"`
	KeyVersion string `json:"key_version"`
	Ciphertext []byte `json:"ciphertext"`
}

// Envelope is safe to persist. Plaintext data keys and Credential values are
// never fields of this structure.
type Envelope struct {
	SchemaVersion int        `json:"schema_version"`
	Algorithm     string     `json:"algorithm"`
	WrappedKey    WrappedKey `json:"wrapped_key"`
	Nonce         []byte     `json:"nonce"`
	Ciphertext    []byte     `json:"ciphertext"`
	AADSHA256     []byte     `json:"aad_sha256"`
}

type KeyWrapper interface {
	Wrap(context.Context, []byte, []byte) (WrappedKey, error)
	Unwrap(context.Context, WrappedKey, []byte) ([]byte, error)
}

type Broker struct {
	wrapper KeyWrapper
	random  io.Reader
}

func New(wrapper KeyWrapper) (*Broker, error) {
	if wrapper == nil {
		return nil, errors.New("KMS key wrapper is required")
	}
	return &Broker{wrapper: wrapper, random: rand.Reader}, nil
}

func (broker *Broker) Seal(ctx context.Context, binding Binding, plaintext []byte) (Envelope, error) {
	if ctx == nil || broker == nil || broker.wrapper == nil {
		return Envelope{}, errors.New("KMS envelope broker is not initialized")
	}
	if len(plaintext) == 0 || len(plaintext) > MaximumPlaintextSize {
		return Envelope{}, errors.New("Credential plaintext size is invalid")
	}
	aad, err := bindingAAD(binding)
	if err != nil {
		return Envelope{}, err
	}
	dataKey := make([]byte, DataKeySize)
	if _, err := io.ReadFull(broker.random, dataKey); err != nil {
		zero(dataKey)
		return Envelope{}, errors.New("generate Credential data key")
	}
	defer zero(dataKey)
	block, err := aes.NewCipher(dataKey)
	if err != nil {
		return Envelope{}, errors.New("initialize Credential envelope cipher")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return Envelope{}, errors.New("initialize Credential envelope authentication")
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(broker.random, nonce); err != nil {
		zero(nonce)
		return Envelope{}, errors.New("generate Credential envelope nonce")
	}
	digest := sha256.Sum256(aad)
	wrapped, err := broker.wrapper.Wrap(ctx, dataKey, digest[:])
	if err != nil {
		zero(nonce)
		return Envelope{}, errors.New("wrap Credential data key")
	}
	if err := validateWrappedKey(wrapped); err != nil {
		zero(nonce)
		zero(wrapped.Ciphertext)
		return Envelope{}, err
	}
	return Envelope{
		SchemaVersion: EnvelopeSchemaVersion,
		Algorithm:     EnvelopeAlgorithm,
		WrappedKey:    cloneWrappedKey(wrapped),
		Nonce:         nonce,
		Ciphertext:    gcm.Seal(nil, nonce, plaintext, aad),
		AADSHA256:     append([]byte(nil), digest[:]...),
	}, nil
}

func (broker *Broker) Open(ctx context.Context, binding Binding, envelope Envelope) ([]byte, error) {
	if ctx == nil || broker == nil || broker.wrapper == nil {
		return nil, errors.New("KMS envelope broker is not initialized")
	}
	aad, err := bindingAAD(binding)
	if err != nil {
		return nil, err
	}
	if err := validateEnvelope(envelope); err != nil {
		return nil, err
	}
	digest := sha256.Sum256(aad)
	if subtle.ConstantTimeCompare(envelope.AADSHA256, digest[:]) != 1 {
		return nil, errors.New("Credential envelope binding differs")
	}
	dataKey, err := broker.wrapper.Unwrap(ctx, cloneWrappedKey(envelope.WrappedKey), digest[:])
	if err != nil {
		zero(dataKey)
		return nil, errors.New("unwrap Credential data key")
	}
	defer zero(dataKey)
	if len(dataKey) != DataKeySize {
		return nil, errors.New("unwrapped Credential data key is invalid")
	}
	block, err := aes.NewCipher(dataKey)
	if err != nil {
		return nil, errors.New("initialize Credential envelope cipher")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("initialize Credential envelope authentication")
	}
	if len(envelope.Nonce) != gcm.NonceSize() || len(envelope.Ciphertext) < gcm.Overhead() || len(envelope.Ciphertext) > MaximumPlaintextSize+gcm.Overhead() {
		return nil, errors.New("Credential envelope ciphertext is invalid")
	}
	plaintext, err := gcm.Open(nil, envelope.Nonce, envelope.Ciphertext, aad)
	if err != nil {
		return nil, errors.New("authenticate Credential envelope")
	}
	return plaintext, nil
}

func validateEnvelope(envelope Envelope) error {
	if envelope.SchemaVersion != EnvelopeSchemaVersion || envelope.Algorithm != EnvelopeAlgorithm || len(envelope.AADSHA256) != sha256.Size {
		return errors.New("Credential envelope metadata is invalid")
	}
	if len(envelope.Nonce) != 12 || len(envelope.Ciphertext) < 16 || len(envelope.Ciphertext) > MaximumPlaintextSize+16 {
		return errors.New("Credential envelope ciphertext is invalid")
	}
	if err := validateWrappedKey(envelope.WrappedKey); err != nil {
		return err
	}
	return nil
}

func validateWrappedKey(wrapped WrappedKey) error {
	if !validMetadataID(wrapped.Provider, 128) || !validMetadataID(wrapped.KeyID, 2048) || !validMetadataID(wrapped.KeyVersion, 256) || len(wrapped.Ciphertext) == 0 || len(wrapped.Ciphertext) > MaximumWrappedKeySize {
		return errors.New("wrapped Credential data key metadata is invalid")
	}
	return nil
}

func bindingAAD(binding Binding) ([]byte, error) {
	if !scopeID.MatchString(binding.TenantID) || !scopeID.MatchString(binding.ProjectID) || !credentialID.MatchString(binding.CredentialID) || binding.Version == 0 {
		return nil, errors.New("Credential envelope binding is invalid")
	}
	parts := []string{"zapvm-credential-envelope-v1", binding.TenantID, binding.ProjectID, binding.CredentialID}
	result := make([]byte, 0, 128)
	var length [8]byte
	for _, part := range parts {
		binary.BigEndian.PutUint64(length[:], uint64(len(part)))
		result = append(result, length[:]...)
		result = append(result, part...)
	}
	binary.BigEndian.PutUint64(length[:], binding.Version)
	result = append(result, length[:]...)
	return result, nil
}

func validMetadataID(value string, maximum int) bool {
	return len(value) > 0 && len(value) <= maximum && metadataID.MatchString(value)
}

func cloneWrappedKey(source WrappedKey) WrappedKey {
	return WrappedKey{Provider: source.Provider, KeyID: source.KeyID, KeyVersion: source.KeyVersion, Ciphertext: append([]byte(nil), source.Ciphertext...)}
}

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
