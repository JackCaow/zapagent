//go:build !windows

package cloudnode

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"zapvm/internal/nodeidentity"
	"zapvm/internal/remoteauth"
)

func TestManagedIdentityEnrollsPersistsAndRenewsWithFreshLocalKey(t *testing.T) {
	root := t.TempDir()
	authorityMaterial, caPath := writeDevelopmentPKI(t, root)
	caKeyDER, err := x509.MarshalPKCS8PrivateKey(authorityMaterial.key)
	if err != nil {
		t.Fatal(err)
	}
	caKeyPath := filepath.Join(root, "ca.key")
	if err := os.WriteFile(caKeyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: caKeyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	authority, err := nodeidentity.Load(caPath, caKeyPath, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	controlCertificate, controlKey := issueDevelopmentCertificate(t, root, authorityMaterial, 2, "managed-control", devControlURI, x509.ExtKeyUsageServerAuth)
	serverTLS, err := remoteauth.LoadMutualTLSServerWithOptionalClient(caPath, controlCertificate, controlKey, devControlURI, true)
	if err != nil {
		t.Fatal(err)
	}
	token := []byte("managed-identity-single-use-token-value")
	recoveryToken := []byte("managed-identity-rotated-recovery-token")
	var mutex sync.Mutex
	enrollments := 0
	serials := make([]string, 0, 2)
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body struct {
			NodeID string `json:"node_id"`
			Token  []byte `json:"token"`
			CSR    []byte `json:"csr"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			http.Error(writer, "bad request", http.StatusBadRequest)
			return
		}
		mutex.Lock()
		defer mutex.Unlock()
		switch request.URL.Path {
		case "/v1/node/enroll":
			expectedToken := token
			if enrollments == 1 {
				expectedToken = recoveryToken
			}
			if enrollments > 1 || request.TLS == nil || len(request.TLS.PeerCertificates) != 0 || body.NodeID != "host-a" || string(body.Token) != string(expectedToken) {
				http.Error(writer, "forbidden", http.StatusForbidden)
				return
			}
			enrollments++
		case "/v1/node/certificate/renew":
			if enrollments == 0 || request.TLS == nil || len(request.TLS.PeerCertificates) != 1 || len(request.TLS.PeerCertificates[0].URIs) != 1 || request.TLS.PeerCertificates[0].URIs[0].String() != devNodeURI {
				http.Error(writer, "forbidden", http.StatusForbidden)
				return
			}
		default:
			http.NotFound(writer, request)
			return
		}
		issued, err := authority.Issue(request.Context(), devNodeURI, body.CSR, 5*time.Minute)
		if err != nil {
			t.Logf("issue managed identity: %v csr=%d", err, len(body.CSR))
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		serials = append(serials, issued.SerialHex)
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(writer).Encode(certificateResponse{Certificate: issued.CertificatePEM, SerialHex: issued.SerialHex, NotBefore: issued.NotBefore.Format(time.RFC3339Nano), NotAfter: issued.NotAfter.Format(time.RFC3339Nano)})
	})
	server := httptest.NewUnstartedServer(handler)
	server.TLS = serverTLS
	server.StartTLS()
	defer server.Close()

	tokenPath := filepath.Join(root, "enrollment.token")
	if err := os.WriteFile(tokenPath, token, 0o600); err != nil {
		t.Fatal(err)
	}
	config := Config{SchemaVersion: 1, ControlURL: server.URL, TrustDomain: devTrustDomain, ControlID: "control", NodeID: "host-a",
		ServerCA: caPath, EnrollmentTokenFile: tokenPath, IdentityDirectory: filepath.Join(root, "identity"), RenewBeforeSeconds: 60,
		DaemonEndpoint: filepath.Join(root, "daemon.sock")}
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	identity, err := newManagedIdentity(config)
	if err != nil {
		t.Fatal(err)
	}
	changed, err := identity.ensure(context.Background())
	if err != nil || !changed {
		t.Fatalf("enroll changed=%t err=%v", changed, err)
	}
	if _, err := os.Stat(tokenPath); !os.IsNotExist(err) {
		t.Fatalf("consumed enrollment token still exists: %v", err)
	}
	firstManifest := identity.manifest
	firstCertificate := identity.pair.Leaf
	if firstCertificate == nil || fmt.Sprintf("%032x", firstCertificate.SerialNumber) != firstManifest.SerialHex {
		t.Fatalf("first managed identity = %#v", firstManifest)
	}
	if err := identity.renew(context.Background()); err != nil {
		t.Fatal(err)
	}
	if identity.manifest.SerialHex == firstManifest.SerialHex || identity.manifest.PrivateKey == firstManifest.PrivateKey || len(serials) != 2 {
		t.Fatalf("managed identity did not rotate: before=%#v after=%#v serials=%v", firstManifest, identity.manifest, serials)
	}
	for _, name := range []string{"current.json", identity.manifest.Certificate, identity.manifest.PrivateKey} {
		info, err := os.Stat(filepath.Join(config.IdentityDirectory, name))
		if err != nil {
			t.Fatalf("managed identity file %s: %v", name, err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("managed identity file %s mode=%v", name, info.Mode().Perm())
		}
	}
	reloaded, err := newManagedIdentity(config)
	if err != nil || reloaded.manifest.SerialHex != identity.manifest.SerialHex {
		t.Fatalf("reloaded managed identity=%#v err=%v", reloaded, err)
	}
	if err := ValidateIdentityMaterial(config); err != nil {
		t.Fatal(err)
	}
	reloaded.now = func() time.Time { return reloaded.pair.Leaf.NotAfter.Add(time.Second) }
	if changed, err := reloaded.ensure(context.Background()); changed || !errors.Is(err, ErrIdentityReenrollmentRequired) {
		t.Fatalf("expired identity without rotated token changed=%t err=%v", changed, err)
	}
	if err := os.WriteFile(tokenPath, recoveryToken, 0o600); err != nil {
		t.Fatal(err)
	}
	reloaded.nextRenewAttempt = time.Time{}
	if changed, err := reloaded.ensure(context.Background()); err != nil || !changed || enrollments != 2 || len(serials) != 3 {
		t.Fatalf("expired identity recovery changed=%t enrollments=%d serials=%v err=%v", changed, enrollments, serials, err)
	}
	if _, err := os.Stat(tokenPath); !os.IsNotExist(err) {
		t.Fatalf("rotated recovery token was not consumed: %v", err)
	}
}

func TestManagedIdentityRejectsSymlinkDirectory(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(root, "identity")
	if err := os.Symlink(target, linked); err != nil {
		t.Fatal(err)
	}
	config := Config{EnrollmentTokenFile: filepath.Join(root, "token"), IdentityDirectory: linked}
	if _, err := newManagedIdentity(config); err == nil {
		t.Fatal("managed identity accepted a symlink directory")
	}
}
