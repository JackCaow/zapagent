// Package relaycrypto defines the cryptographic session used when Browser and
// Guest exchange opaque payloads through an untrusted Control/Node Relay.
package relaycrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"
)

const (
	Version   = 1
	Algorithm = "P-256/HKDF-SHA256/AES-256-GCM"

	DirectionBrowserToGuest = "browser_to_guest"
	DirectionGuestToBrowser = "guest_to_browser"
	RoleBrowser             = "browser"
	RoleGuest               = "guest"
)

// Context is authenticated, not encrypted. Every field binds ciphertext to a
// single tenant, Project, Session, Task, key epoch, and direction.
type Context struct {
	TenantID  string `json:"tenant_id"`
	ProjectID string `json:"project_id"`
	SessionID string `json:"session_id"`
	TaskID    string `json:"task_id"`
	KeyID     string `json:"key_id"`
}

type Envelope struct {
	Version    int    `json:"version"`
	Algorithm  string `json:"algorithm"`
	KeyID      string `json:"key_id"`
	Direction  string `json:"direction"`
	Sequence   uint64 `json:"sequence"`
	Ciphertext []byte `json:"ciphertext"`
}

type KeyPair struct {
	private *ecdh.PrivateKey
	public  []byte
}

func GenerateKeyPair(random io.Reader) (*KeyPair, error) {
	if random == nil {
		random = rand.Reader
	}
	private, err := ecdh.P256().GenerateKey(random)
	if err != nil {
		return nil, fmt.Errorf("generate Relay E2EE key: %w", err)
	}
	return &KeyPair{private: private, public: append([]byte(nil), private.PublicKey().Bytes()...)}, nil
}

func (pair *KeyPair) PublicKey() []byte {
	if pair == nil {
		return nil
	}
	return append([]byte(nil), pair.public...)
}

type Session struct {
	context       Context
	sendDirection string
	recvDirection string
	send          cipher.AEAD
	receive       cipher.AEAD
	sendPrefix    [4]byte
	recvPrefix    [4]byte
	mu            sync.Mutex
	sendSequence  uint64
	recvSequence  uint64
}

func Establish(pair *KeyPair, peerPublic []byte, role string, context Context) (*Session, error) {
	if pair == nil || pair.private == nil || len(peerPublic) == 0 || validateContext(context) != nil {
		return nil, errors.New("Relay E2EE session parameters are invalid")
	}
	peer, err := ecdh.P256().NewPublicKey(peerPublic)
	if err != nil {
		return nil, errors.New("Relay E2EE peer key is invalid")
	}
	shared, err := pair.private.ECDH(peer)
	if err != nil {
		return nil, errors.New("Relay E2EE key agreement failed")
	}
	salt := sha256.Sum256(contextBytes(context))
	browserMaterial, err := hkdf.Key(sha256.New, shared, salt[:], "zapvm/e2ee/browser-to-guest/v1", 36)
	if err != nil {
		return nil, errors.New("derive Relay E2EE browser key")
	}
	guestMaterial, err := hkdf.Key(sha256.New, shared, salt[:], "zapvm/e2ee/guest-to-browser/v1", 36)
	if err != nil {
		return nil, errors.New("derive Relay E2EE Guest key")
	}
	var sendMaterial, recvMaterial []byte
	var sendDirection, recvDirection string
	switch role {
	case RoleBrowser:
		sendMaterial, recvMaterial = browserMaterial, guestMaterial
		sendDirection, recvDirection = DirectionBrowserToGuest, DirectionGuestToBrowser
	case RoleGuest:
		sendMaterial, recvMaterial = guestMaterial, browserMaterial
		sendDirection, recvDirection = DirectionGuestToBrowser, DirectionBrowserToGuest
	default:
		return nil, errors.New("Relay E2EE role is invalid")
	}
	sendAEAD, err := newAEAD(sendMaterial[:32])
	if err != nil {
		return nil, err
	}
	recvAEAD, err := newAEAD(recvMaterial[:32])
	if err != nil {
		return nil, err
	}
	session := &Session{context: context, sendDirection: sendDirection, recvDirection: recvDirection, send: sendAEAD, receive: recvAEAD}
	copy(session.sendPrefix[:], sendMaterial[32:])
	copy(session.recvPrefix[:], recvMaterial[32:])
	return session, nil
}

func (session *Session) Seal(plaintext []byte) (Envelope, error) {
	if session == nil || session.send == nil {
		return Envelope{}, errors.New("Relay E2EE session is not established")
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.sendSequence == ^uint64(0) {
		return Envelope{}, errors.New("Relay E2EE send sequence exhausted")
	}
	session.sendSequence++
	nonce := nonce(session.sendPrefix, session.sendSequence)
	aad := associatedData(session.context, session.sendDirection, session.sendSequence)
	return Envelope{
		Version: Version, Algorithm: Algorithm, KeyID: session.context.KeyID,
		Direction: session.sendDirection, Sequence: session.sendSequence,
		Ciphertext: session.send.Seal(nil, nonce[:], plaintext, aad),
	}, nil
}

func (session *Session) Open(envelope Envelope) ([]byte, error) {
	if session == nil || session.receive == nil || envelope.Version != Version || envelope.Algorithm != Algorithm ||
		envelope.KeyID != session.context.KeyID || envelope.Direction != session.recvDirection || envelope.Sequence == 0 || len(envelope.Ciphertext) == 0 {
		return nil, errors.New("Relay E2EE envelope is invalid")
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if envelope.Sequence != session.recvSequence+1 {
		return nil, errors.New("Relay E2EE sequence is invalid")
	}
	nonce := nonce(session.recvPrefix, envelope.Sequence)
	aad := associatedData(session.context, envelope.Direction, envelope.Sequence)
	plaintext, err := session.receive.Open(nil, nonce[:], envelope.Ciphertext, aad)
	if err != nil {
		return nil, errors.New("Relay E2EE authentication failed")
	}
	session.recvSequence = envelope.Sequence
	return plaintext, nil
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("initialize Relay E2EE cipher")
	}
	return cipher.NewGCM(block)
}

func nonce(prefix [4]byte, sequence uint64) [12]byte {
	var result [12]byte
	copy(result[:4], prefix[:])
	binary.BigEndian.PutUint64(result[4:], sequence)
	return result
}

func associatedData(context Context, direction string, sequence uint64) []byte {
	data := contextBytes(context)
	data = appendField(data, direction)
	var encoded [8]byte
	binary.BigEndian.PutUint64(encoded[:], sequence)
	return append(data, encoded[:]...)
}

func contextBytes(context Context) []byte {
	var data []byte
	for _, value := range []string{context.TenantID, context.ProjectID, context.SessionID, context.TaskID, context.KeyID} {
		data = appendField(data, value)
	}
	return data
}

func appendField(destination []byte, value string) []byte {
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(value)))
	destination = append(destination, size[:]...)
	return append(destination, value...)
}

func validateContext(context Context) error {
	for _, value := range []string{context.TenantID, context.ProjectID, context.SessionID, context.TaskID, context.KeyID} {
		if len(value) == 0 || len(value) > 256 {
			return errors.New("Relay E2EE context is invalid")
		}
	}
	return nil
}
