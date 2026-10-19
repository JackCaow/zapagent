package artifactstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

func TestConfigRequiresHTTPSAndOwnerOnlyCredentialPaths(t *testing.T) {
	config := Config{
		Endpoint: "https://objects.example.test", Region: "us-east-1", Bucket: "zapvm-artifacts",
		AccessKeyFile: "/secure/access", SecretKeyFile: "/secure/secret",
	}
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*Config){
		func(value *Config) { value.Endpoint = "http://objects.example.test" },
		func(value *Config) { value.Endpoint = "https://objects.example.test/path" },
		func(value *Config) { value.Bucket = "Bad_Bucket" },
		func(value *Config) { value.AccessKeyFile = "relative" },
	} {
		candidate := config
		mutate(&candidate)
		if candidate.Validate() == nil {
			t.Fatalf("invalid Artifact S3 config accepted: %#v", candidate)
		}
	}
}

func TestS3PutSignAndDeleteAgainstCompatibleEndpoint(t *testing.T) {
	data := []byte("Artifact body")
	digest := sha256.Sum256(data)
	expectedDigest := hex.EncodeToString(digest[:])
	putSeen, deleteSeen := false, false
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") == "" || request.URL.Path != "/zapvm-artifacts/v1/scope/artifact/hash" {
			http.Error(writer, "unsigned or unexpected request", http.StatusBadRequest)
			return
		}
		switch request.Method {
		case http.MethodPut:
			body, err := io.ReadAll(request.Body)
			if err != nil || !bytes.Equal(body, data) || request.Header.Get("X-Amz-Meta-Sha256") != expectedDigest {
				http.Error(writer, "invalid upload", http.StatusBadRequest)
				return
			}
			putSeen = true
			writer.Header().Set("ETag", `"artifact-etag"`)
			writer.WriteHeader(http.StatusOK)
		case http.MethodDelete:
			deleteSeen = true
			writer.WriteHeader(http.StatusNoContent)
		default:
			http.Error(writer, "unexpected method", http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()
	endpoint, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := minio.New(endpoint.Host, &minio.Options{
		Creds: credentials.NewStaticV4("access-key", "secret-key", ""), Secure: true,
		Transport: server.Client().Transport, Region: "us-east-1", BucketLookup: minio.BucketLookupPath, MaxRetries: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	store := &S3{client: client, bucket: "zapvm-artifacts"}
	key := "v1/scope/artifact/hash"
	if err := store.Put(context.Background(), key, "application/octet-stream", uint64(len(data)), expectedDigest, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	signed, err := store.SignedGetURL(context.Background(), key, "报告.bin", "application/octet-stream", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	signedURL, err := url.Parse(signed)
	if err != nil || signedURL.Scheme != "https" || signedURL.Host != endpoint.Host || signedURL.Query().Get("X-Amz-Signature") == "" ||
		!strings.Contains(signedURL.Query().Get("response-content-disposition"), "attachment") {
		t.Fatalf("signed URL=%q err=%v", signed, err)
	}
	if err := store.Delete(context.Background(), key); err != nil {
		t.Fatal(err)
	}
	if !putSeen || !deleteSeen {
		t.Fatalf("S3 lifecycle put=%t delete=%t", putSeen, deleteSeen)
	}
}

func TestReadCredentialAndVerifier(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "credential")
	if err := os.WriteFile(path, []byte("secret-value\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	value, err := readCredential(path)
	if err != nil || value != "secret-value" {
		t.Fatalf("credential=%q err=%v", value, err)
	}
	data := []byte("verified Artifact body")
	verifier := &verifyingReader{source: bytes.NewReader(data), hash: sha256.New()}
	read, err := io.ReadAll(verifier)
	digest := sha256.Sum256(data)
	if err != nil || !bytes.Equal(read, data) || verifier.count != uint64(len(data)) ||
		hex.EncodeToString(verifier.hash.Sum(nil)) != hex.EncodeToString(digest[:]) {
		t.Fatalf("verifier count=%d err=%v", verifier.count, err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readCredential(path); err == nil {
		t.Fatal("group/world-readable S3 credential was accepted")
	}
}
