package artifactstore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"mime"
	"net/url"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"zapvm/internal/remoteauth"
)

const (
	maxCredentialSize = 16 << 10
	multipartPartSize = 8 << 20
)

// Config describes a private S3-compatible Artifact bucket. Credentials are
// always loaded from owner-only files so they never need to appear in the
// control-plane configuration or process arguments.
type Config struct {
	Endpoint         string `json:"endpoint"`
	Region           string `json:"region"`
	Bucket           string `json:"bucket"`
	AccessKeyFile    string `json:"access_key_file"`
	SecretKeyFile    string `json:"secret_key_file"`
	SessionTokenFile string `json:"session_token_file,omitempty"`
}

func (config Config) Validate() error {
	endpoint, err := url.Parse(config.Endpoint)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil ||
		endpoint.Path != "" || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return errors.New("Artifact S3 endpoint must be an HTTPS origin without credentials or a path")
	}
	if !validLabel(config.Region, 128) || !validBucket(config.Bucket) {
		return errors.New("Artifact S3 region or bucket is invalid")
	}
	for label, path := range map[string]string{
		"access key": config.AccessKeyFile,
		"secret key": config.SecretKeyFile,
	} {
		if !validSecretPath(path) {
			return fmt.Errorf("Artifact S3 %s file must be an absolute non-NUL path", label)
		}
	}
	if config.SessionTokenFile != "" && !validSecretPath(config.SessionTokenFile) {
		return errors.New("Artifact S3 session token file must be an absolute non-NUL path")
	}
	return nil
}

type S3 struct {
	client *minio.Client
	bucket string
}

func Open(config Config) (*S3, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	accessKey, err := readCredential(config.AccessKeyFile)
	if err != nil {
		return nil, fmt.Errorf("load Artifact S3 access key: %w", err)
	}
	secretKey, err := readCredential(config.SecretKeyFile)
	if err != nil {
		return nil, fmt.Errorf("load Artifact S3 secret key: %w", err)
	}
	sessionToken := ""
	if config.SessionTokenFile != "" {
		sessionToken, err = readCredential(config.SessionTokenFile)
		if err != nil {
			return nil, fmt.Errorf("load Artifact S3 session token: %w", err)
		}
	}
	endpoint, _ := url.Parse(config.Endpoint)
	client, err := minio.New(endpoint.Host, &minio.Options{
		Creds: credentials.NewStaticV4(accessKey, secretKey, sessionToken), Secure: true,
		Region: config.Region, BucketLookup: minio.BucketLookupPath, MaxRetries: 3,
	})
	if err != nil {
		return nil, fmt.Errorf("create Artifact S3 client: %w", err)
	}
	return &S3{client: client, bucket: config.Bucket}, nil
}

func (store *S3) Put(ctx context.Context, key, contentType string, size uint64, expectedSHA256 string, source io.Reader) error {
	if store == nil || store.client == nil || !validObjectKey(key) || source == nil || size == 0 || size > uint64(^uint64(0)>>1) || !validDigest(expectedSHA256) {
		return errors.New("Artifact S3 upload parameters are invalid")
	}
	verifier := &verifyingReader{source: source, hash: sha256.New()}
	info, err := store.client.PutObject(ctx, store.bucket, key, verifier, int64(size), minio.PutObjectOptions{
		ContentType: contentType, PartSize: multipartPartSize, NumThreads: 2, ConcurrentStreamParts: true,
		UserMetadata: map[string]string{"sha256": expectedSHA256},
	})
	actualDigest := hex.EncodeToString(verifier.hash.Sum(nil))
	if err == nil && (verifier.count != size || info.Size != int64(size) || actualDigest != expectedSHA256) {
		err = errors.New("Artifact S3 upload size or digest mismatch")
	}
	if err != nil {
		cleanupContext, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_ = store.client.RemoveObject(cleanupContext, store.bucket, key, minio.RemoveObjectOptions{})
		cancel()
		return fmt.Errorf("upload Artifact to S3: %w", err)
	}
	return nil
}

func (store *S3) SignedGetURL(ctx context.Context, key, name, contentType string, expiry time.Duration) (string, error) {
	if store == nil || store.client == nil || !validObjectKey(key) || !validFileName(name) || expiry < time.Minute || expiry > 24*time.Hour {
		return "", errors.New("Artifact signed download parameters are invalid")
	}
	parameters := make(url.Values)
	parameters.Set("response-content-disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	parameters.Set("response-content-type", contentType)
	signed, err := store.client.PresignedGetObject(ctx, store.bucket, key, expiry, parameters)
	if err != nil {
		return "", fmt.Errorf("sign Artifact S3 download: %w", err)
	}
	return signed.String(), nil
}

func (store *S3) Delete(ctx context.Context, key string) error {
	if store == nil || store.client == nil || !validObjectKey(key) {
		return errors.New("Artifact S3 delete parameters are invalid")
	}
	if err := store.client.RemoveObject(ctx, store.bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("delete Artifact from S3: %w", err)
	}
	return nil
}

type verifyingReader struct {
	source io.Reader
	hash   hash.Hash
	count  uint64
}

func (reader *verifyingReader) Read(destination []byte) (int, error) {
	read, err := reader.source.Read(destination)
	if read > 0 {
		_, _ = reader.hash.Write(destination[:read])
		reader.count += uint64(read)
	}
	return read, err
}

func readCredential(path string) (string, error) {
	data, err := remoteauth.ReadOwnerOnlyFile(path, maxCredentialSize)
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(data))
	if value == "" || len(value) > 4096 || strings.ContainsAny(value, "\r\n\x00") {
		return "", errors.New("credential is empty or malformed")
	}
	return value, nil
}

func validSecretPath(path string) bool {
	return filepath.IsAbs(path) && len(path) <= 32767 && !strings.ContainsRune(path, 0)
}

func validLabel(value string, maximum int) bool {
	if value == "" || len(value) > maximum {
		return false
	}
	for _, character := range value {
		if !((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '-' || character == '_' || character == '.') {
			return false
		}
	}
	return true
}

func validBucket(value string) bool {
	if len(value) < 3 || len(value) > 63 || value[0] == '-' || value[len(value)-1] == '-' || strings.Contains(value, "..") {
		return false
	}
	for _, character := range value {
		if !((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '-' || character == '.') {
			return false
		}
	}
	return true
}

func validObjectKey(value string) bool {
	return value != "" && len(value) <= 1024 && utf8.ValidString(value) && !strings.HasPrefix(value, "/") && !strings.Contains(value, "..") && !strings.ContainsRune(value, 0)
}

func validDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && value == strings.ToLower(value)
}

func validFileName(value string) bool {
	return value != "" && len(value) <= 255 && utf8.ValidString(value) && !strings.ContainsAny(value, "/\\\r\n\x00")
}
