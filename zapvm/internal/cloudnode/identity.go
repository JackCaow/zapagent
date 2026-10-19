package cloudnode

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"zapvm/internal/credential"
	"zapvm/internal/remoteauth"
)

const managedIdentityFileLimit = 4 << 20

var ErrIdentityReenrollmentRequired = errors.New("managed Node identity expired; a new enrollment token is required")

type identityManifest struct {
	SchemaVersion int    `json:"schema_version"`
	Certificate   string `json:"certificate"`
	PrivateKey    string `json:"private_key"`
	SerialHex     string `json:"serial_hex"`
	NotAfter      string `json:"not_after"`
}

type certificateResponse struct {
	Certificate []byte `json:"certificate"`
	SerialHex   string `json:"serial_hex"`
	NotBefore   string `json:"not_before"`
	NotAfter    string `json:"not_after"`
}

type managedIdentity struct {
	config           Config
	manifest         identityManifest
	pair             tls.Certificate
	now              func() time.Time
	nextRenewAttempt time.Time
	renewalFailures  uint8
}

func newManagedIdentity(config Config) (*managedIdentity, error) {
	if !config.ManagedIdentity() {
		return nil, errors.New("managed Node identity is not configured")
	}
	if err := os.MkdirAll(config.IdentityDirectory, 0o700); err != nil {
		return nil, fmt.Errorf("create Node identity directory: %w", err)
	}
	info, err := os.Lstat(config.IdentityDirectory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("Node identity directory must be a real directory")
	}
	if err := os.Chmod(config.IdentityDirectory, 0o700); err != nil {
		return nil, fmt.Errorf("protect Node identity directory: %w", err)
	}
	identity := &managedIdentity{config: config, now: time.Now}
	if err := identity.load(); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return identity, nil
}

func ValidateIdentityMaterial(config Config) error {
	if !config.ManagedIdentity() {
		_, err := remoteauth.LoadMutualTLSClient(config.ServerCA, config.Certificate, config.PrivateKey, config.NodeURI(), config.ControlURI())
		return err
	}
	if _, err := remoteauth.LoadVerifiedServerTLSClient(config.ServerCA, config.ControlURI()); err != nil {
		return err
	}
	identity := &managedIdentity{config: config, now: time.Now}
	if err := identity.load(); err == nil {
		_, err = identity.tlsConfig()
		return err
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	token, err := remoteauth.ReadOwnerOnlyFile(config.EnrollmentTokenFile, 4096)
	credential.ZeroBytes(token)
	return err
}

func (identity *managedIdentity) ensure(ctx context.Context) (bool, error) {
	if identity.manifest.SchemaVersion == 0 {
		return true, identity.enroll(ctx)
	}
	now := identity.now()
	notAfter, err := time.Parse(time.RFC3339Nano, identity.manifest.NotAfter)
	if err != nil {
		return false, errors.New("managed Node identity has invalid expiry")
	}
	if !notAfter.After(now) {
		if now.Before(identity.nextRenewAttempt) {
			return false, nil
		}
		if info, statErr := os.Lstat(identity.config.EnrollmentTokenFile); statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			identity.deferRenewal(now)
			return false, ErrIdentityReenrollmentRequired
		}
		if err := identity.enroll(ctx); err != nil {
			identity.deferRenewal(now)
			return false, fmt.Errorf("re-enroll expired managed Node identity: %w", err)
		}
		identity.renewalFailures = 0
		identity.nextRenewAttempt = time.Time{}
		return true, nil
	}
	if notAfter.Sub(now) > time.Duration(identity.config.RenewBeforeSeconds)*time.Second {
		return false, nil
	}
	if now.Before(identity.nextRenewAttempt) {
		return false, nil
	}
	if err := identity.renew(ctx); err != nil {
		identity.deferRenewal(now)
		return false, err
	}
	identity.renewalFailures = 0
	identity.nextRenewAttempt = time.Time{}
	return true, nil
}

func (identity *managedIdentity) deferRenewal(now time.Time) {
	identity.renewalFailures++
	delay := 30 * time.Second
	for index := uint8(1); index < identity.renewalFailures && delay < 5*time.Minute; index++ {
		delay *= 2
	}
	if delay > 5*time.Minute {
		delay = 5 * time.Minute
	}
	identity.nextRenewAttempt = now.Add(delay)
}

func (identity *managedIdentity) tlsConfig() (*tls.Config, error) {
	certificatePath := filepath.Join(identity.config.IdentityDirectory, identity.manifest.Certificate)
	keyPath := filepath.Join(identity.config.IdentityDirectory, identity.manifest.PrivateKey)
	return remoteauth.LoadMutualTLSClient(identity.config.ServerCA, certificatePath, keyPath, identity.config.NodeURI(), identity.config.ControlURI())
}

func (identity *managedIdentity) enroll(ctx context.Context) error {
	token, err := remoteauth.ReadOwnerOnlyFile(identity.config.EnrollmentTokenFile, 4096)
	if err != nil {
		return fmt.Errorf("load Node enrollment token: %w", err)
	}
	defer credential.ZeroBytes(token)
	if len(token) < 32 {
		return errors.New("Node enrollment token is too short")
	}
	key, csr, keyPEM, err := generateNodeKeyAndCSR()
	if err != nil {
		return err
	}
	defer credential.ZeroBytes(keyPEM)
	tlsConfig, err := remoteauth.LoadVerifiedServerTLSClient(identity.config.ServerCA, identity.config.ControlURI())
	if err != nil {
		return err
	}
	response, err := identity.post(ctx, tlsConfig, "/v1/node/enroll", map[string]any{"node_id": identity.config.NodeID, "token": token, "csr": csr})
	if err != nil {
		return err
	}
	if err := identity.install(response, key, keyPEM); err != nil {
		return err
	}
	if err := os.Remove(identity.config.EnrollmentTokenFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove consumed Node enrollment token: %w", err)
	}
	return syncIdentityDirectory(filepath.Dir(identity.config.EnrollmentTokenFile))
}

func (identity *managedIdentity) renew(ctx context.Context) error {
	key, csr, keyPEM, err := generateNodeKeyAndCSR()
	if err != nil {
		return err
	}
	defer credential.ZeroBytes(keyPEM)
	tlsConfig, err := identity.tlsConfig()
	if err != nil {
		return err
	}
	response, err := identity.post(ctx, tlsConfig, "/v1/node/certificate/renew", map[string]any{"csr": csr})
	if err != nil {
		return err
	}
	return identity.install(response, key, keyPEM)
}

func (identity *managedIdentity) post(ctx context.Context, tlsConfig *tls.Config, path string, body any) (certificateResponse, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return certificateResponse{}, errors.New("encode Node identity request")
	}
	defer credential.ZeroBytes(encoded)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, identity.config.ControlURL+path, bytes.NewReader(encoded))
	if err != nil {
		return certificateResponse{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	transport := &http.Transport{Proxy: nil, TLSClientConfig: tlsConfig, ForceAttemptHTTP2: true, DisableCompression: true}
	client := &http.Client{Transport: transport, Timeout: 30 * time.Second}
	defer transport.CloseIdleConnections()
	httpResponse, err := client.Do(request)
	if err != nil {
		return certificateResponse{}, fmt.Errorf("request Node identity: %w", err)
	}
	defer httpResponse.Body.Close()
	if httpResponse.StatusCode != http.StatusCreated {
		_, _ = io.CopyN(io.Discard, httpResponse.Body, 64<<10)
		return certificateResponse{}, fmt.Errorf("Node identity endpoint returned HTTP %d", httpResponse.StatusCode)
	}
	limited := io.LimitReader(httpResponse.Body, managedIdentityFileLimit+1)
	var response certificateResponse
	decoder := json.NewDecoder(limited)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&response); err != nil || len(response.Certificate) == 0 {
		return certificateResponse{}, errors.New("decode Node identity response")
	}
	return response, nil
}

func (identity *managedIdentity) install(response certificateResponse, key *ecdsa.PrivateKey, keyPEM []byte) error {
	if len(response.SerialHex) != 32 || strings.ToLower(response.SerialHex) != response.SerialHex {
		return errors.New("Node identity response has invalid serial")
	}
	pair, err := tls.X509KeyPair(response.Certificate, keyPEM)
	if err != nil {
		return errors.New("Node identity certificate does not match generated key")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil || leaf.SerialNumber == nil || fmt.Sprintf("%032x", leaf.SerialNumber) != response.SerialHex ||
		len(leaf.URIs) != 1 || leaf.URIs[0].String() != identity.config.NodeURI() || leaf.NotAfter.Before(time.Now()) {
		return errors.New("Node identity certificate response is invalid")
	}
	if public, ok := leaf.PublicKey.(*ecdsa.PublicKey); !ok || !public.Equal(&key.PublicKey) {
		return errors.New("Node identity certificate public key mismatch")
	}
	serial := response.SerialHex
	certificateName := "node-" + serial + ".pem"
	keyName := "node-" + serial + ".key"
	if err := atomicOwnerOnlyWrite(filepath.Join(identity.config.IdentityDirectory, certificateName), response.Certificate); err != nil {
		return err
	}
	if err := atomicOwnerOnlyWrite(filepath.Join(identity.config.IdentityDirectory, keyName), keyPEM); err != nil {
		return err
	}
	manifest := identityManifest{SchemaVersion: 1, Certificate: certificateName, PrivateKey: keyName, SerialHex: serial, NotAfter: leaf.NotAfter.UTC().Format(time.RFC3339Nano)}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	if err := atomicOwnerOnlyWrite(filepath.Join(identity.config.IdentityDirectory, "current.json"), encoded); err != nil {
		return err
	}
	pair.Leaf = leaf
	identity.manifest, identity.pair = manifest, pair
	return nil
}

func (identity *managedIdentity) load() error {
	manifestPath := filepath.Join(identity.config.IdentityDirectory, "current.json")
	encoded, err := remoteauth.ReadOwnerOnlyFile(manifestPath, 64<<10)
	if err != nil {
		return err
	}
	var manifest identityManifest
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil || manifest.SchemaVersion != 1 || filepath.Base(manifest.Certificate) != manifest.Certificate || filepath.Base(manifest.PrivateKey) != manifest.PrivateKey {
		return errors.New("managed Node identity manifest is invalid")
	}
	certificatePEM, err := remoteauth.ReadOwnerOnlyFile(filepath.Join(identity.config.IdentityDirectory, manifest.Certificate), managedIdentityFileLimit)
	if err != nil {
		return err
	}
	keyPEM, err := remoteauth.ReadOwnerOnlyFile(filepath.Join(identity.config.IdentityDirectory, manifest.PrivateKey), managedIdentityFileLimit)
	if err != nil {
		return err
	}
	pair, err := tls.X509KeyPair(certificatePEM, keyPEM)
	if err != nil {
		return errors.New("load managed Node identity key pair")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil || leaf.SerialNumber == nil || fmt.Sprintf("%032x", leaf.SerialNumber) != manifest.SerialHex || len(leaf.URIs) != 1 || leaf.URIs[0].String() != identity.config.NodeURI() {
		return errors.New("managed Node identity manifest does not match certificate")
	}
	pair.Leaf = leaf
	identity.manifest, identity.pair = manifest, pair
	return nil
}

func generateNodeKeyAndCSR() (*ecdsa.PrivateKey, []byte, []byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, nil, errors.New("generate Node identity key")
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, key)
	if err != nil {
		return nil, nil, nil, errors.New("generate Node identity CSR")
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, nil, errors.New("encode Node identity key")
	}
	return key, csr, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), nil
}

func atomicOwnerOnlyWrite(path string, data []byte) error {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".zapvm-identity-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	if err := syncIdentityDirectory(directory); err != nil {
		return err
	}
	committed = true
	return nil
}
