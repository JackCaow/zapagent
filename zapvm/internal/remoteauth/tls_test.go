package remoteauth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type testCertificateAuthority struct {
	certificate *x509.Certificate
	key         ed25519.PrivateKey
	pem         []byte
}

func newTestCertificateAuthority(t *testing.T) testCertificateAuthority {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test-ca"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, publicKey, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return testCertificateAuthority{certificate: certificate, key: privateKey, pem: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

func issueTestCertificate(t *testing.T, authority testCertificateAuthority, serial int64, identity string, usage x509.ExtKeyUsage) ([]byte, []byte) {
	t.Helper()
	parsedURI, err := url.Parse(identity)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: "ignored-common-name"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{usage}, URIs: []*url.URL{parsedURI},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, authority.certificate, publicKey, authority.key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
}

func writeTLSMaterial(t *testing.T, directory, name string, certificate, key []byte) (string, string) {
	t.Helper()
	certificatePath := filepath.Join(directory, name+".crt")
	keyPath := filepath.Join(directory, name+".key")
	if err := os.WriteFile(certificatePath, certificate, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, key, 0o600); err != nil {
		t.Fatal(err)
	}
	return certificatePath, keyPath
}

func TestMutualTLSUsesExactSPIFFEIdentities(t *testing.T) {
	directory := t.TempDir()
	authority := newTestCertificateAuthority(t)
	caPath := filepath.Join(directory, "ca.crt")
	if err := os.WriteFile(caPath, authority.pem, 0o644); err != nil {
		t.Fatal(err)
	}
	serverCertificate, serverKey := issueTestCertificate(t, authority, 2, "spiffe://example.test/node/host-a", x509.ExtKeyUsageServerAuth)
	clientCertificate, clientKey := issueTestCertificate(t, authority, 3, testPrincipal, x509.ExtKeyUsageClientAuth)
	serverCertificatePath, serverKeyPath := writeTLSMaterial(t, directory, "server", serverCertificate, serverKey)
	clientCertificatePath, clientKeyPath := writeTLSMaterial(t, directory, "client", clientCertificate, clientKey)
	policy, err := CompilePolicy(testPolicyFile())
	if err != nil {
		t.Fatal(err)
	}
	serverConfig, err := LoadServerTLS(caPath, serverCertificatePath, serverKeyPath, policy)
	if err != nil {
		t.Fatal(err)
	}
	clientConfig, err := LoadClientTLS(caPath, clientCertificatePath, clientKeyPath, policy.NodeURI())
	if err != nil {
		t.Fatal(err)
	}
	serverSide, clientSide := net.Pipe()
	defer serverSide.Close()
	defer clientSide.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	identityResult := make(chan Identity, 1)
	errorResult := make(chan error, 1)
	go func() {
		identity, err := ClientIdentity(tls.Server(serverSide, serverConfig), policy, ctx)
		identityResult <- identity
		errorResult <- err
	}()
	if err := tls.Client(clientSide, clientConfig).HandshakeContext(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-errorResult; err != nil {
		t.Fatal(err)
	}
	if identity := <-identityResult; identity.URI != testPrincipal {
		t.Fatalf("unexpected authenticated identity %#v", identity)
	}

	wrongNodeConfig, err := LoadClientTLS(caPath, clientCertificatePath, clientKeyPath, "spiffe://example.test/node/host-b")
	if err != nil {
		t.Fatal(err)
	}
	serverSide, clientSide = net.Pipe()
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	serverHandshake := make(chan error, 1)
	go func() { serverHandshake <- tls.Server(serverSide, serverConfig).HandshakeContext(ctx) }()
	clientErr := tls.Client(clientSide, wrongNodeConfig).HandshakeContext(ctx)
	_ = clientSide.Close()
	_ = serverSide.Close()
	<-serverHandshake
	if clientErr == nil {
		t.Fatal("client accepted a certificate for the wrong node SPIFFE URI")
	}
}

func TestGenericMutualTLSUsesExactControlAndNodeIdentities(t *testing.T) {
	directory := t.TempDir()
	authority := newTestCertificateAuthority(t)
	caPath := filepath.Join(directory, "ca.crt")
	if err := os.WriteFile(caPath, authority.pem, 0o644); err != nil {
		t.Fatal(err)
	}
	controlURI := "spiffe://example.test/control/primary"
	nodeURI := "spiffe://example.test/node/node-a"
	serverCertificate, serverKey := issueTestCertificate(t, authority, 10, controlURI, x509.ExtKeyUsageServerAuth)
	nodeCertificate, nodeKey := issueTestCertificate(t, authority, 11, nodeURI, x509.ExtKeyUsageClientAuth)
	serverCertificatePath, serverKeyPath := writeTLSMaterial(t, directory, "control", serverCertificate, serverKey)
	nodeCertificatePath, nodeKeyPath := writeTLSMaterial(t, directory, "node", nodeCertificate, nodeKey)
	serverConfig, err := LoadMutualTLSServer(caPath, serverCertificatePath, serverKeyPath, controlURI)
	if err != nil {
		t.Fatal(err)
	}
	clientConfig, err := LoadMutualTLSClient(caPath, nodeCertificatePath, nodeKeyPath, nodeURI, controlURI)
	if err != nil {
		t.Fatal(err)
	}
	serverSide, clientSide := net.Pipe()
	defer serverSide.Close()
	defer clientSide.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	serverResult := make(chan error, 1)
	go func() { serverResult <- tls.Server(serverSide, serverConfig).HandshakeContext(ctx) }()
	if err := tls.Client(clientSide, clientConfig).HandshakeContext(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-serverResult; err != nil {
		t.Fatal(err)
	}
	wrongConfig, err := LoadMutualTLSClient(caPath, nodeCertificatePath, nodeKeyPath, nodeURI, "spiffe://example.test/control/wrong")
	if err != nil {
		t.Fatalf("construct wrong-expectation config: %v", err)
	}
	serverSide, clientSide = net.Pipe()
	wrongServerResult := make(chan error, 1)
	go func() { wrongServerResult <- tls.Server(serverSide, serverConfig).HandshakeContext(ctx) }()
	clientErr := tls.Client(clientSide, wrongConfig).HandshakeContext(ctx)
	_ = clientSide.Close()
	_ = serverSide.Close()
	<-wrongServerResult
	if clientErr == nil {
		t.Fatal("node accepted the wrong control-plane SPIFFE URI")
	}
}

func TestOptionalClientTLSAcceptsOnlyCertificateLessOrTrustedClients(t *testing.T) {
	directory := t.TempDir()
	authority := newTestCertificateAuthority(t)
	caPath := filepath.Join(directory, "ca.crt")
	if err := os.WriteFile(caPath, authority.pem, 0o644); err != nil {
		t.Fatal(err)
	}
	controlURI := "spiffe://example.test/control/primary"
	serverCertificate, serverKey := issueTestCertificate(t, authority, 20, controlURI, x509.ExtKeyUsageServerAuth)
	serverCertificatePath, serverKeyPath := writeTLSMaterial(t, directory, "optional-control", serverCertificate, serverKey)
	serverConfig, err := LoadMutualTLSServerWithOptionalClient(caPath, serverCertificatePath, serverKeyPath, controlURI, true)
	if err != nil {
		t.Fatal(err)
	}
	clientConfig, err := LoadVerifiedServerTLSClient(caPath, controlURI)
	if err != nil {
		t.Fatal(err)
	}
	if err := handshakeTLSConfigs(serverConfig, clientConfig); err != nil {
		t.Fatalf("certificate-less enrollment handshake: %v", err)
	}

	otherAuthority := newTestCertificateAuthority(t)
	untrustedCertificate, untrustedKey := issueTestCertificate(t, otherAuthority, 21, "spiffe://example.test/node/attacker", x509.ExtKeyUsageClientAuth)
	pair, err := tls.X509KeyPair(untrustedCertificate, untrustedKey)
	if err != nil {
		t.Fatal(err)
	}
	untrustedClient := clientConfig.Clone()
	untrustedClient.Certificates = []tls.Certificate{pair}
	if err := handshakeTLSConfigs(serverConfig, untrustedClient); err == nil {
		t.Fatal("optional client TLS accepted an untrusted presented certificate")
	}
}

func TestNodeIdentityAuthorityMustChainToControlClientTrust(t *testing.T) {
	directory := t.TempDir()
	trusted := newTestCertificateAuthority(t)
	trustedPath := filepath.Join(directory, "trusted-ca.pem")
	if err := os.WriteFile(trustedPath, trusted.pem, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyCertificateAuthorityTrust(trustedPath, trustedPath); err != nil {
		t.Fatal(err)
	}
	untrusted := newTestCertificateAuthority(t)
	untrustedPath := filepath.Join(directory, "untrusted-ca.pem")
	if err := os.WriteFile(untrustedPath, untrusted.pem, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyCertificateAuthorityTrust(trustedPath, untrustedPath); err == nil {
		t.Fatal("Control accepted an untrusted Node identity authority")
	}
}

func handshakeTLSConfigs(serverConfig, clientConfig *tls.Config) error {
	serverSide, clientSide := net.Pipe()
	defer serverSide.Close()
	defer clientSide.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	serverResult := make(chan error, 1)
	go func() { serverResult <- tls.Server(serverSide, serverConfig).HandshakeContext(ctx) }()
	clientErr := tls.Client(clientSide, clientConfig).HandshakeContext(ctx)
	if clientErr != nil {
		_ = clientSide.Close()
	}
	serverErr := <-serverResult
	return errors.Join(clientErr, serverErr)
}
