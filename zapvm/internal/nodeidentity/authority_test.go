package nodeidentity

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAuthorityIssuesOnlyServerSelectedShortLivedNodeIdentity(t *testing.T) {
	now := time.Date(2026, 8, 8, 1, 0, 0, 0, time.UTC)
	authority := testAuthority(t, now)
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "ignored"}}, key)
	if err != nil {
		t.Fatal(err)
	}
	issued, err := authority.Issue(context.Background(), "spiffe://example.test/node/host-a", csrDER, 6*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	block, rest := pem.Decode(issued.CertificatePEM)
	if block == nil || len(rest) != 0 {
		t.Fatal("issued certificate is not one PEM block")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if len(certificate.URIs) != 1 || certificate.URIs[0].String() != "spiffe://example.test/node/host-a" ||
		len(certificate.DNSNames) != 0 || certificate.NotAfter.Sub(now) != 6*time.Hour ||
		len(certificate.ExtKeyUsage) != 1 || certificate.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth ||
		certificate.KeyUsage != x509.KeyUsageDigitalSignature || len(issued.SerialHex) != 32 {
		t.Fatalf("issued Node certificate = %#v", certificate)
	}
	if _, err := certificate.Verify(x509.VerifyOptions{Roots: testCertPool(authority.certificate), CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		t.Fatal(err)
	}
}

func TestAuthorityRejectsCSRSelectedIdentityAndUnsafeTTL(t *testing.T) {
	now := time.Date(2026, 8, 8, 1, 0, 0, 0, time.UTC)
	authority := testAuthority(t, now)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	selected, _ := url.Parse("spiffe://attacker.test/node/owned")
	csr, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{URIs: []*url.URL{selected}}, key)
	if _, err := authority.Issue(context.Background(), "spiffe://example.test/node/host-a", csr, time.Hour); err == nil {
		t.Fatal("CSR-selected identity was accepted")
	}
	plain, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, key)
	for _, ttl := range []time.Duration{time.Minute, 25 * time.Hour} {
		if _, err := authority.Issue(context.Background(), "spiffe://example.test/node/host-a", plain, ttl); err == nil {
			t.Fatalf("unsafe TTL %s was accepted", ttl)
		}
	}
}

func TestAuthorityAcceptsMinimumTTL(t *testing.T) {
	now := time.Date(2026, 8, 8, 1, 0, 0, 0, time.UTC)
	authority := testAuthority(t, now)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	csr, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, key)
	issued, err := authority.Issue(context.Background(), "spiffe://example.test/node/host-a", csr, 5*time.Minute)
	if err != nil || issued.NotAfter.Sub(now) != 5*time.Minute {
		t.Fatalf("minimum TTL issued=%#v err=%v", issued, err)
	}
}

func testAuthority(t *testing.T, now time.Time) *Authority {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test-ca"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(48 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	certificatePath := filepath.Join(directory, "ca.pem")
	privateKeyPath := filepath.Join(directory, "ca.key")
	keyDER, _ := x509.MarshalPKCS8PrivateKey(key)
	if err := os.WriteFile(certificatePath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(privateKeyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	authority, err := Load(certificatePath, privateKeyPath, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	return authority
}

func testCertPool(certificate *x509.Certificate) *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(certificate)
	return pool
}
