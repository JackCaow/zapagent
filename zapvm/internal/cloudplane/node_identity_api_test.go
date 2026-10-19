package cloudplane

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"zapvm/internal/nodeidentity"
)

type apiNodeIdentityBackend struct {
	Backend
	mu       sync.Mutex
	token    [sha256.Size]byte
	consumed bool
	records  map[string]nodeidentity.CertificateRecord
}

func (backend *apiNodeIdentityBackend) ProvisionNodeEnrollmentTokens([]nodeidentity.EnrollmentProvision) error {
	return nil
}

func (backend *apiNodeIdentityBackend) EnrollNodeCertificate(nodeID string, token []byte, record nodeidentity.CertificateRecord) error {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	digest := sha256.Sum256(token)
	if backend.consumed || subtle.ConstantTimeCompare(digest[:], backend.token[:]) != 1 || record.NodeID != nodeID || record.RenewedFromSerialHex != "" {
		return ErrUnauthorized
	}
	backend.consumed = true
	backend.records[record.SerialHex] = record
	return nil
}

func (backend *apiNodeIdentityBackend) RenewNodeCertificate(nodeID, currentSerial string, record nodeidentity.CertificateRecord) error {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if _, ok := backend.records[currentSerial]; !ok || record.NodeID != nodeID || record.RenewedFromSerialHex != currentSerial {
		return ErrFenced
	}
	backend.records[record.SerialHex] = record
	return nil
}

func (backend *apiNodeIdentityBackend) AuthorizeNodeCertificate(nodeID, serialHex string) error {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	record, ok := backend.records[serialHex]
	if !ok || record.NodeID != nodeID {
		return ErrUnauthorized
	}
	return nil
}

func (backend *apiNodeIdentityBackend) RevokeNodeCertificate(_, nodeID, serialHex string) error {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	record, ok := backend.records[serialHex]
	if !ok || record.NodeID != nodeID {
		return ErrNotFound
	}
	delete(backend.records, serialHex)
	return nil
}

func TestNodeIdentityAPIEnrollmentRenewalSerialAuthorizationAndRevocation(t *testing.T) {
	clock := &testClock{now: time.Now().UTC().Truncate(time.Second)}
	store, _ := openTestStore(t, clock)
	token := []byte("api-single-use-node-enrollment-token")
	backend := &apiNodeIdentityBackend{Backend: store, token: sha256.Sum256(token), records: make(map[string]nodeidentity.CertificateRecord)}
	authority := apiNodeAuthority(t, clock.now)
	api, err := NewAPI(backend, "example.test", []string{testPrincipalA})
	if err != nil {
		t.Fatal(err)
	}
	if err := api.EnableNodeIdentity(authority, 6*time.Hour); err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()

	firstKey, firstCSR := apiNodeCSR(t)
	enrollRequest := httptest.NewRequest(http.MethodPost, "/v1/node/enroll", apiJSON(t, map[string]any{"node_id": "node-a", "token": token, "csr": firstCSR}))
	enrolled := callAPI(t, handler, enrollRequest)
	if enrolled.Code != http.StatusCreated {
		t.Fatalf("enrollment status=%d body=%s", enrolled.Code, enrolled.Body.String())
	}
	first := decodeNodeCertificateResponse(t, enrolled)
	firstLeaf := verifyAPIIdentityCertificate(t, first, firstKey, "spiffe://example.test/node/node-a")
	replay := callAPI(t, handler, httptest.NewRequest(http.MethodPost, "/v1/node/enroll", apiJSON(t, map[string]any{"node_id": "node-a", "token": token, "csr": firstCSR})))
	if replay.Code != http.StatusForbidden {
		t.Fatalf("replayed token status=%d body=%s", replay.Code, replay.Body.String())
	}

	secondKey, secondCSR := apiNodeCSR(t)
	renewRequest := apiNodeRequest(t, http.MethodPost, "/v1/node/certificate/renew", firstLeaf, map[string]any{"csr": secondCSR})
	renewed := callAPI(t, handler, renewRequest)
	if renewed.Code != http.StatusCreated {
		t.Fatalf("renewal status=%d body=%s", renewed.Code, renewed.Body.String())
	}
	second := decodeNodeCertificateResponse(t, renewed)
	secondLeaf := verifyAPIIdentityCertificate(t, second, secondKey, "spiffe://example.test/node/node-a")
	if second.SerialHex == first.SerialHex {
		t.Fatal("renewal reused a certificate serial")
	}
	for _, leaf := range []*x509.Certificate{firstLeaf, secondLeaf} {
		registered := callAPI(t, handler, apiNodeRequest(t, http.MethodPost, "/v1/node/register", leaf, map[string]any{"generation": "generation-identity-0001"}))
		if registered.Code != http.StatusOK {
			t.Fatalf("overlap Node certificate status=%d body=%s", registered.Code, registered.Body.String())
		}
	}

	revoked := callAPI(t, handler, apiRequest(t, http.MethodPost, "/v1/admin/nodes/node-a/certificates/"+second.SerialHex+"/revoke", testPrincipalA, nil))
	if revoked.Code != http.StatusOK {
		t.Fatalf("revocation status=%d body=%s", revoked.Code, revoked.Body.String())
	}
	denied := callAPI(t, handler, apiNodeRequest(t, http.MethodPost, "/v1/node/register", secondLeaf, map[string]any{"generation": "generation-identity-0002"}))
	if denied.Code != http.StatusForbidden {
		t.Fatalf("revoked certificate status=%d body=%s", denied.Code, denied.Body.String())
	}
}

func apiNodeAuthority(t *testing.T, now time.Time) *nodeidentity.Authority {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "api-node-ca"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(48 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalPKCS8PrivateKey(key)
	root := t.TempDir()
	certificatePath, keyPath := filepath.Join(root, "ca.pem"), filepath.Join(root, "ca.key")
	if err := os.WriteFile(certificatePath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	authority, err := nodeidentity.Load(certificatePath, keyPath, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	return authority
}

func apiNodeCSR(t *testing.T) (*ecdsa.PrivateKey, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, key)
	if err != nil {
		t.Fatal(err)
	}
	return key, csr
}

func apiJSON(t *testing.T, value any) *bytes.Reader {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.NewReader(encoded)
}

func apiNodeRequest(t *testing.T, method, path string, leaf *x509.Certificate, body any) *http.Request {
	t.Helper()
	request := httptest.NewRequest(method, path, apiJSON(t, body))
	request.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{leaf}, VerifiedChains: [][]*x509.Certificate{{leaf}}}
	return request
}

func decodeNodeCertificateResponse(t *testing.T, recorder *httptest.ResponseRecorder) nodeCertificateResponse {
	t.Helper()
	var response nodeCertificateResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func verifyAPIIdentityCertificate(t *testing.T, response nodeCertificateResponse, key *ecdsa.PrivateKey, expectedURI string) *x509.Certificate {
	t.Helper()
	block, rest := pem.Decode(response.Certificate)
	if block == nil || len(rest) != 0 {
		t.Fatal("invalid Node certificate PEM")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	public, ok := leaf.PublicKey.(*ecdsa.PublicKey)
	if !ok || !public.Equal(&key.PublicKey) || len(leaf.URIs) != 1 || leaf.URIs[0].String() != expectedURI || len(leaf.DNSNames) != 0 || len(response.SerialHex) != 32 {
		t.Fatalf("issued Node certificate=%#v", leaf)
	}
	return leaf
}

var _ NodeIdentityBackend = (*apiNodeIdentityBackend)(nil)
