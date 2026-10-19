package nodeidentity

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"
)

type EnrollmentProvision struct {
	NodeID      string
	TokenSHA256 []byte
	ExpiresAt   time.Time
}

type CertificateRecord struct {
	NodeID               string
	SerialHex            string
	PublicKeySHA256      []byte
	IssuedAt             time.Time
	NotBefore            time.Time
	NotAfter             time.Time
	RenewedFromSerialHex string
}

func (record CertificateRecord) Validate() error {
	if record.NodeID == "" || !validSerial(record.SerialHex) || len(record.PublicKeySHA256) != sha256.Size ||
		record.IssuedAt.IsZero() || record.NotBefore.After(record.IssuedAt) || !record.NotAfter.After(record.IssuedAt) ||
		record.NotAfter.After(record.IssuedAt.Add(24*time.Hour)) ||
		(record.RenewedFromSerialHex != "" && (!validSerial(record.RenewedFromSerialHex) || record.RenewedFromSerialHex == record.SerialHex)) {
		return errors.New("Node certificate record is invalid")
	}
	return nil
}

func ParseTokenSHA256(value string) ([]byte, error) {
	if len(value) != sha256.Size*2 {
		return nil, errors.New("Node enrollment token digest is invalid")
	}
	digest, err := hex.DecodeString(value)
	if err != nil || hex.EncodeToString(digest) != value {
		return nil, errors.New("Node enrollment token digest is invalid")
	}
	return digest, nil
}

func validSerial(value string) bool {
	if len(value) != 32 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
