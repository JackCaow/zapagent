package nodeidentity

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net/url"
	"time"

	"zapvm/internal/credential"
	"zapvm/internal/remoteauth"
)

const (
	minimumTTL = 5 * time.Minute
	maximumTTL = 24 * time.Hour
)

type Authority struct {
	certificate *x509.Certificate
	signer      crypto.Signer
	random      io.Reader
	now         func() time.Time
}

type IssuedCertificate struct {
	CertificatePEM  []byte
	SerialHex       string
	PublicKeySHA256 []byte
	NotBefore       time.Time
	NotAfter        time.Time
}

func Load(certificatePath, privateKeyPath string, now func() time.Time) (*Authority, error) {
	certificatePEM, err := remoteauth.ReadOwnerOnlyFile(certificatePath, 4<<20)
	if err != nil {
		return nil, errors.New("load Node identity CA certificate")
	}
	defer credential.ZeroBytes(certificatePEM)
	privateKeyPEM, err := remoteauth.ReadOwnerOnlyFile(privateKeyPath, 4<<20)
	if err != nil {
		return nil, errors.New("load Node identity CA private key")
	}
	defer credential.ZeroBytes(privateKeyPEM)
	certificateBlock, rest := pem.Decode(certificatePEM)
	if certificateBlock == nil || certificateBlock.Type != "CERTIFICATE" || len(rest) != 0 {
		return nil, errors.New("Node identity CA certificate PEM is invalid")
	}
	certificate, err := x509.ParseCertificate(certificateBlock.Bytes)
	if err != nil || !certificate.IsCA || certificate.KeyUsage&x509.KeyUsageCertSign == 0 {
		return nil, errors.New("Node identity CA certificate is not a signing CA")
	}
	keyBlock, keyRest := pem.Decode(privateKeyPEM)
	if keyBlock == nil || len(keyRest) != 0 {
		return nil, errors.New("Node identity CA private key PEM is invalid")
	}
	key, err := parsePrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, err
	}
	signer, ok := key.(crypto.Signer)
	if !ok || !publicKeysEqual(certificate.PublicKey, signer.Public()) {
		return nil, errors.New("Node identity CA key does not match certificate")
	}
	if now == nil {
		now = time.Now
	}
	return &Authority{certificate: certificate, signer: signer, random: rand.Reader, now: now}, nil
}

func (authority *Authority) Issue(ctx context.Context, nodeURI string, csrDER []byte, ttl time.Duration) (IssuedCertificate, error) {
	if authority == nil || ctx == nil || ctx.Err() != nil || ttl < minimumTTL || ttl > maximumTTL {
		return IssuedCertificate{}, errors.New("Node certificate request is invalid")
	}
	trustDomain, _, err := remoteauth.ParseNodeIdentity(nodeURI)
	if err != nil || trustDomain == "" || len(csrDER) == 0 || len(csrDER) > 64<<10 {
		return IssuedCertificate{}, errors.New("Node certificate request is invalid")
	}
	request, err := x509.ParseCertificateRequest(csrDER)
	if err != nil || request.CheckSignature() != nil {
		return IssuedCertificate{}, errors.New("Node certificate CSR is invalid")
	}
	if len(request.DNSNames) != 0 || len(request.EmailAddresses) != 0 || len(request.IPAddresses) != 0 || len(request.URIs) != 0 {
		return IssuedCertificate{}, errors.New("Node certificate CSR must not select identities")
	}
	serialBytes := make([]byte, 16)
	if _, err := io.ReadFull(authority.random, serialBytes); err != nil {
		return IssuedCertificate{}, errors.New("generate Node certificate serial")
	}
	serialBytes[0] &= 0x7f
	serialBytes[0] |= 0x01
	serial := new(big.Int).SetBytes(serialBytes)
	now := authority.now().UTC().Truncate(time.Second)
	notBefore := now.Add(-time.Minute)
	notAfter := now.Add(ttl)
	if authority.certificate.NotAfter.Before(notAfter) {
		notAfter = authority.certificate.NotAfter.UTC()
	}
	if notAfter.Before(now.Add(minimumTTL)) || now.Before(authority.certificate.NotBefore) {
		return IssuedCertificate{}, errors.New("Node identity CA is outside its issuance window")
	}
	parsedURI, _ := url.Parse(nodeURI)
	template := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: "zapvm-node"},
		NotBefore: notBefore, NotAfter: notAfter, URIs: []*url.URL{parsedURI},
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(authority.random, template, authority.certificate, request.PublicKey, authority.signer)
	if err != nil {
		return IssuedCertificate{}, errors.New("sign Node certificate")
	}
	encoded := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	publicKeyDigest := sha256.Sum256(request.RawSubjectPublicKeyInfo)
	credential.ZeroBytes(der)
	return IssuedCertificate{CertificatePEM: encoded, SerialHex: hex.EncodeToString(serialBytes), PublicKeySHA256: publicKeyDigest[:], NotBefore: notBefore, NotAfter: notAfter}, nil
}

func parsePrivateKey(der []byte) (any, error) {
	if key, err := x509.ParsePKCS8PrivateKey(der); err == nil {
		return key, nil
	}
	if key, err := x509.ParseECPrivateKey(der); err == nil {
		return key, nil
	}
	if key, err := x509.ParsePKCS1PrivateKey(der); err == nil {
		return key, nil
	}
	return nil, errors.New("Node identity CA private key is unsupported")
}

func publicKeysEqual(left, right any) bool {
	leftDER, leftErr := x509.MarshalPKIXPublicKey(left)
	rightDER, rightErr := x509.MarshalPKIXPublicKey(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	return string(leftDER) == string(rightDER)
}
