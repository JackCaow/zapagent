package credentialkms

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"io"
	"sync"
)

// StaticKeyWrapper is an explicit development/bootstrap adapter. It makes the
// runtime broker testable and deployable before GA-03d managed KMS rollout,
// but must not be described as a production KMS. The key is read from an
// owner-only file by the Control process and never persisted in PostgreSQL.
type StaticKeyWrapper struct {
	mu         sync.Mutex
	key        []byte
	keyID      string
	keyVersion string
	random     io.Reader
	closed     bool
}

func NewStaticKeyWrapper(key []byte, keyID, keyVersion string) (*StaticKeyWrapper, error) {
	if len(key) != DataKeySize || !validMetadataID(keyID, 2048) || !validMetadataID(keyVersion, 256) {
		return nil, errors.New("static Credential wrapper configuration is invalid")
	}
	return &StaticKeyWrapper{
		key: append([]byte(nil), key...), keyID: keyID, keyVersion: keyVersion, random: rand.Reader,
	}, nil
}

func (wrapper *StaticKeyWrapper) Wrap(ctx context.Context, plaintext, aad []byte) (WrappedKey, error) {
	if ctx == nil || ctx.Err() != nil {
		return WrappedKey{}, errors.New("static Credential wrapper context is unavailable")
	}
	wrapper.mu.Lock()
	defer wrapper.mu.Unlock()
	if wrapper.closed || len(wrapper.key) != DataKeySize || len(plaintext) != DataKeySize || len(aad) != 32 {
		return WrappedKey{}, errors.New("static Credential wrapper request is invalid")
	}
	block, err := aes.NewCipher(wrapper.key)
	if err != nil {
		return WrappedKey{}, errors.New("initialize static Credential wrapper")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return WrappedKey{}, errors.New("initialize static Credential wrapper authentication")
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(wrapper.random, nonce); err != nil {
		zero(nonce)
		return WrappedKey{}, errors.New("generate static Credential wrapper nonce")
	}
	ciphertext := append(nonce, gcm.Seal(nil, nonce, plaintext, aad)...)
	return WrappedKey{Provider: "static-aes", KeyID: wrapper.keyID, KeyVersion: wrapper.keyVersion, Ciphertext: ciphertext}, nil
}

func (wrapper *StaticKeyWrapper) Unwrap(ctx context.Context, wrapped WrappedKey, aad []byte) ([]byte, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, errors.New("static Credential wrapper context is unavailable")
	}
	wrapper.mu.Lock()
	defer wrapper.mu.Unlock()
	if wrapper.closed || len(wrapper.key) != DataKeySize || len(aad) != 32 || wrapped.Provider != "static-aes" ||
		wrapped.KeyID != wrapper.keyID || wrapped.KeyVersion != wrapper.keyVersion {
		return nil, errors.New("static Credential wrapper request is invalid")
	}
	block, err := aes.NewCipher(wrapper.key)
	if err != nil {
		return nil, errors.New("initialize static Credential wrapper")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil || len(wrapped.Ciphertext) < gcm.NonceSize()+gcm.Overhead() {
		return nil, errors.New("static Credential wrapped key is invalid")
	}
	plaintext, err := gcm.Open(nil, wrapped.Ciphertext[:gcm.NonceSize()], wrapped.Ciphertext[gcm.NonceSize():], aad)
	if err != nil {
		return nil, errors.New("authenticate static Credential wrapped key")
	}
	return plaintext, nil
}

func (wrapper *StaticKeyWrapper) Close() {
	if wrapper == nil {
		return
	}
	wrapper.mu.Lock()
	defer wrapper.mu.Unlock()
	if wrapper.closed {
		return
	}
	wrapper.closed = true
	zero(wrapper.key)
	wrapper.key = nil
}
