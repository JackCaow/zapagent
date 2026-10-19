package remoteauth

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
)

const maxTLSMaterialSize = 4 << 20

// VerifyCertificateAuthorityTrust ensures certificates issued by the
// configured Node identity authority can be accepted by the Control listener's
// client CA bundle. It catches a fail-closed but operationally fatal split-CA
// configuration before the service starts.
func VerifyCertificateAuthorityTrust(caBundlePath, authorityCertificatePath string) error {
	caPEM, err := readSecureRegularFile(caBundlePath, maxTLSMaterialSize, false)
	if err != nil {
		return fmt.Errorf("load remote client CA: %w", err)
	}
	authorityPEM, err := readSecureRegularFile(authorityCertificatePath, maxTLSMaterialSize, false)
	if err != nil {
		return fmt.Errorf("load Node identity authority certificate: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return errors.New("remote client CA bundle contains no certificates")
	}
	block, rest := pem.Decode(authorityPEM)
	if block == nil || block.Type != "CERTIFICATE" || len(rest) != 0 {
		return errors.New("Node identity authority certificate must contain exactly one certificate")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil || !certificate.IsCA || certificate.KeyUsage&x509.KeyUsageCertSign == 0 {
		return errors.New("Node identity authority certificate is not a signing CA")
	}
	if _, err := certificate.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}}); err != nil {
		return errors.New("Node identity authority is not trusted by the client CA bundle")
	}
	return nil
}

func LoadServerTLS(caPath, certificatePath, keyPath string, policy *Policy) (*tls.Config, error) {
	if policy == nil {
		return nil, errors.New("remote policy is required")
	}
	caPEM, err := readSecureRegularFile(caPath, maxTLSMaterialSize, false)
	if err != nil {
		return nil, fmt.Errorf("load remote client CA: %w", err)
	}
	certificatePEM, err := readSecureRegularFile(certificatePath, maxTLSMaterialSize, false)
	if err != nil {
		return nil, fmt.Errorf("load remote server certificate: %w", err)
	}
	keyPEM, err := readSecureRegularFile(keyPath, maxTLSMaterialSize, true)
	if err != nil {
		return nil, fmt.Errorf("load remote server private key: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("remote client CA bundle contains no certificates")
	}
	pair, err := tls.X509KeyPair(certificatePEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("load remote server key pair: %w", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse remote server certificate: %w", err)
	}
	pair.Leaf = leaf
	if err := requireSingleURI(leaf, policy.NodeURI()); err != nil {
		return nil, fmt.Errorf("remote server identity: %w", err)
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{pair},
		ClientCAs:    pool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
	}, nil
}

func LoadClientTLS(caPath, certificatePath, keyPath, expectedNodeURI string) (*tls.Config, error) {
	trustDomain, _, err := ParseNodeIdentity(expectedNodeURI)
	if err != nil {
		return nil, err
	}
	caPEM, err := readSecureRegularFile(caPath, maxTLSMaterialSize, false)
	if err != nil {
		return nil, fmt.Errorf("load remote server CA: %w", err)
	}
	certificatePEM, err := readSecureRegularFile(certificatePath, maxTLSMaterialSize, false)
	if err != nil {
		return nil, fmt.Errorf("load remote client certificate: %w", err)
	}
	keyPEM, err := readSecureRegularFile(keyPath, maxTLSMaterialSize, true)
	if err != nil {
		return nil, fmt.Errorf("load remote client private key: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("remote server CA bundle contains no certificates")
	}
	pair, err := tls.X509KeyPair(certificatePEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("load remote client key pair: %w", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse remote client certificate: %w", err)
	}
	pair.Leaf = leaf
	if len(leaf.URIs) != 1 {
		return nil, errors.New("remote client certificate must contain exactly one URI SAN")
	}
	if _, err := ParseClientIdentity(leaf.URIs[0].String(), trustDomain); err != nil {
		return nil, fmt.Errorf("remote client identity: %w", err)
	}
	return &tls.Config{
		MinVersion:         tls.VersionTLS13,
		Certificates:       []tls.Certificate{pair},
		InsecureSkipVerify: true, // Replaced by the exact chain and SPIFFE verification below.
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("remote server sent no certificate")
			}
			intermediates := x509.NewCertPool()
			for _, certificate := range state.PeerCertificates[1:] {
				intermediates.AddCert(certificate)
			}
			if _, err := state.PeerCertificates[0].Verify(x509.VerifyOptions{
				Roots: pool, Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			}); err != nil {
				return fmt.Errorf("verify remote server certificate: %w", err)
			}
			return requireSingleURI(state.PeerCertificates[0], expectedNodeURI)
		},
	}, nil
}

// LoadMutualTLSServer builds a TLS 1.3 server which requires a client
// certificate signed by caPath and presents exactly expectedServerURI.
// Authorization of the verified client URI remains the caller's responsibility.
func LoadMutualTLSServer(caPath, certificatePath, keyPath, expectedServerURI string) (*tls.Config, error) {
	return LoadMutualTLSServerWithOptionalClient(caPath, certificatePath, keyPath, expectedServerURI, false)
}

// LoadMutualTLSServerWithOptionalClient permits a certificate-less TLS client
// only so the HTTP enrollment handler can authenticate a single-use bootstrap
// token. Every other Control route continues to require principal().
func LoadMutualTLSServerWithOptionalClient(caPath, certificatePath, keyPath, expectedServerURI string, optionalClient bool) (*tls.Config, error) {
	if expectedServerURI == "" {
		return nil, errors.New("remote server SPIFFE URI is required")
	}
	caPEM, err := readSecureRegularFile(caPath, maxTLSMaterialSize, false)
	if err != nil {
		return nil, fmt.Errorf("load remote client CA: %w", err)
	}
	certificatePEM, err := readSecureRegularFile(certificatePath, maxTLSMaterialSize, false)
	if err != nil {
		return nil, fmt.Errorf("load remote server certificate: %w", err)
	}
	keyPEM, err := readSecureRegularFile(keyPath, maxTLSMaterialSize, true)
	if err != nil {
		return nil, fmt.Errorf("load remote server private key: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("remote client CA bundle contains no certificates")
	}
	pair, err := tls.X509KeyPair(certificatePEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("load remote server key pair: %w", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse remote server certificate: %w", err)
	}
	pair.Leaf = leaf
	if err := requireSingleURI(leaf, expectedServerURI); err != nil {
		return nil, fmt.Errorf("remote server identity: %w", err)
	}
	clientAuth := tls.RequireAndVerifyClientCert
	if optionalClient {
		clientAuth = tls.VerifyClientCertIfGiven
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{pair},
		ClientCAs: pool, ClientAuth: clientAuth,
	}, nil
}

// LoadMutualTLSClient builds a TLS 1.3 client with an exact local SPIFFE URI
// and verifies the server chain plus its exact SPIFFE URI.
func LoadMutualTLSClient(caPath, certificatePath, keyPath, localURI, expectedServerURI string) (*tls.Config, error) {
	if localURI == "" || expectedServerURI == "" {
		return nil, errors.New("local and expected server SPIFFE URIs are required")
	}
	caPEM, err := readSecureRegularFile(caPath, maxTLSMaterialSize, false)
	if err != nil {
		return nil, fmt.Errorf("load remote server CA: %w", err)
	}
	certificatePEM, err := readSecureRegularFile(certificatePath, maxTLSMaterialSize, false)
	if err != nil {
		return nil, fmt.Errorf("load remote client certificate: %w", err)
	}
	keyPEM, err := readSecureRegularFile(keyPath, maxTLSMaterialSize, true)
	if err != nil {
		return nil, fmt.Errorf("load remote client private key: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("remote server CA bundle contains no certificates")
	}
	pair, err := tls.X509KeyPair(certificatePEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("load remote client key pair: %w", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse remote client certificate: %w", err)
	}
	pair.Leaf = leaf
	if err := requireSingleURI(leaf, localURI); err != nil {
		return nil, fmt.Errorf("remote client identity: %w", err)
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{pair},
		InsecureSkipVerify: true, // Replaced by exact chain and SPIFFE verification below.
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("remote server sent no certificate")
			}
			intermediates := x509.NewCertPool()
			for _, certificate := range state.PeerCertificates[1:] {
				intermediates.AddCert(certificate)
			}
			if _, err := state.PeerCertificates[0].Verify(x509.VerifyOptions{
				Roots: pool, Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			}); err != nil {
				return fmt.Errorf("verify remote server certificate: %w", err)
			}
			return requireSingleURI(state.PeerCertificates[0], expectedServerURI)
		},
	}, nil
}

// LoadVerifiedServerTLSClient verifies a TLS server against caPath and an exact
// SPIFFE URI without presenting a client certificate. It is intended only for
// bootstrap enrollment protected by a single-use token.
func LoadVerifiedServerTLSClient(caPath, expectedServerURI string) (*tls.Config, error) {
	if expectedServerURI == "" {
		return nil, errors.New("expected server SPIFFE URI is required")
	}
	caPEM, err := readSecureRegularFile(caPath, maxTLSMaterialSize, false)
	if err != nil {
		return nil, fmt.Errorf("load remote server CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("remote server CA bundle contains no certificates")
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS13, InsecureSkipVerify: true, // Replaced by exact chain and SPIFFE verification below.
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("remote server sent no certificate")
			}
			intermediates := x509.NewCertPool()
			for _, certificate := range state.PeerCertificates[1:] {
				intermediates.AddCert(certificate)
			}
			if _, err := state.PeerCertificates[0].Verify(x509.VerifyOptions{
				Roots: pool, Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			}); err != nil {
				return fmt.Errorf("verify remote server certificate: %w", err)
			}
			return requireSingleURI(state.PeerCertificates[0], expectedServerURI)
		},
	}, nil
}

func ClientIdentity(connection *tls.Conn, policy *Policy, timeoutContext context.Context) (Identity, error) {
	if connection == nil || policy == nil {
		return Identity{}, errors.New("remote TLS connection and policy are required")
	}
	if err := connection.HandshakeContext(timeoutContext); err != nil {
		return Identity{}, fmt.Errorf("remote TLS handshake: %w", err)
	}
	state := connection.ConnectionState()
	if len(state.VerifiedChains) == 0 || len(state.PeerCertificates) == 0 {
		return Identity{}, errors.New("remote client certificate was not verified")
	}
	leaf := state.PeerCertificates[0]
	if len(leaf.URIs) != 1 {
		return Identity{}, errors.New("remote client certificate must contain exactly one URI SAN")
	}
	identity, err := ParseClientIdentity(leaf.URIs[0].String(), policy.trustDomain)
	if err != nil {
		return Identity{}, err
	}
	if _, ok := policy.Identity(identity.URI); !ok {
		return Identity{}, errors.New("remote access denied")
	}
	return identity, nil
}

func requireSingleURI(certificate *x509.Certificate, expected string) error {
	if certificate == nil || len(certificate.URIs) != 1 || certificate.URIs[0].String() != expected {
		return fmt.Errorf("certificate must contain exactly URI SAN %q", expected)
	}
	return nil
}

func PEMCertificate(data []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("PEM contains no certificate")
	}
	return x509.ParseCertificate(block.Bytes)
}
