package credential

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

const (
	MaxCredentials = 16
	MaxValueSize   = 64 << 10
	MaxTotalSize   = 256 << 10
)

type Broker struct {
	mu     sync.Mutex
	values map[string][]byte
	closed bool
}

func Load(bindings []string) (*Broker, error) {
	if len(bindings) > MaxCredentials {
		return nil, fmt.Errorf("at most %d credential bindings are allowed", MaxCredentials)
	}
	broker := &Broker{values: make(map[string][]byte, len(bindings))}
	failed := true
	defer func() {
		if failed {
			broker.Close()
		}
	}()
	total := 0
	for _, binding := range bindings {
		id, path, ok := strings.Cut(binding, "=")
		if !ok || !ValidID(id) || path == "" {
			return nil, errors.New("credential binding must be id=/absolute/path with a valid ID")
		}
		if _, exists := broker.values[id]; exists {
			return nil, fmt.Errorf("duplicate credential ID %q", id)
		}
		if !filepath.IsAbs(path) || len(path) > 32767 || strings.IndexByte(path, 0) >= 0 {
			return nil, fmt.Errorf("credential %q path must be absolute and non-NUL", id)
		}
		value, err := readCredential(path)
		if err != nil {
			return nil, fmt.Errorf("load credential %q: %w", id, err)
		}
		total += len(value)
		if total > MaxTotalSize {
			zero(value)
			return nil, fmt.Errorf("credential values exceed %d-byte total limit", MaxTotalSize)
		}
		broker.values[id] = value
	}
	failed = false
	return broker, nil
}

func (broker *Broker) Resolve(ids []string) (map[string][]byte, error) {
	if len(ids) > MaxCredentials {
		return nil, fmt.Errorf("at most %d credential IDs are allowed per command", MaxCredentials)
	}
	broker.mu.Lock()
	defer broker.mu.Unlock()
	if broker.closed {
		return nil, errors.New("credential broker is closed")
	}
	result := make(map[string][]byte, len(ids))
	for _, id := range ids {
		if !ValidID(id) {
			zeroMap(result)
			return nil, fmt.Errorf("invalid credential ID %q", id)
		}
		if _, duplicate := result[id]; duplicate {
			zeroMap(result)
			return nil, fmt.Errorf("duplicate credential ID %q", id)
		}
		value, exists := broker.values[id]
		if !exists {
			zeroMap(result)
			return nil, fmt.Errorf("credential ID %q is not authorized", id)
		}
		result[id] = append([]byte(nil), value...)
	}
	return result, nil
}

func (broker *Broker) IDs() []string {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	if broker.closed {
		return nil
	}
	ids := make([]string, 0, len(broker.values))
	for id := range broker.values {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (broker *Broker) ScopeDigest() (string, error) {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	if broker.closed {
		return "", errors.New("credential broker is closed")
	}
	ids := make([]string, 0, len(broker.values))
	for id := range broker.values {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	hash := sha256.New()
	_, _ = hash.Write([]byte("zapvm-credential-scope-v1\x00"))
	var length [8]byte
	for _, id := range ids {
		binary.BigEndian.PutUint64(length[:], uint64(len(id)))
		_, _ = hash.Write(length[:])
		_, _ = hash.Write([]byte(id))
		value := broker.values[id]
		binary.BigEndian.PutUint64(length[:], uint64(len(value)))
		_, _ = hash.Write(length[:])
		_, _ = hash.Write(value)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func (broker *Broker) Close() {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	if broker.closed {
		return
	}
	broker.closed = true
	zeroMap(broker.values)
	clear(broker.values)
}

func ValidID(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for index, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (index > 0 && char >= '0' && char <= '9') || (index > 0 && (char == '.' || char == '_' || char == '-')) {
			continue
		}
		return false
	}
	return value != "." && value != ".."
}

func ZeroValues(values map[string][]byte) {
	zeroMap(values)
}

func ZeroBytes(value []byte) {
	zero(value)
}

func readCredential(path string) ([]byte, error) {
	pathInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("credential source must be a regular file, not a symlink")
	}
	if pathInfo.Size() <= 0 || pathInfo.Size() > MaxValueSize {
		return nil, fmt.Errorf("credential size %d is outside 1-%d bytes", pathInfo.Size(), MaxValueSize)
	}
	if runtime.GOOS != "windows" && !secureCredentialMode(pathInfo.Mode().Perm()) {
		return nil, fmt.Errorf("credential source permissions %o must be 0400 or 0600", pathInfo.Mode().Perm())
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	fileInfo, err := file.Stat()
	if err != nil {
		return nil, err
	}
	currentInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !fileInfo.Mode().IsRegular() || !currentInfo.Mode().IsRegular() || currentInfo.Mode()&os.ModeSymlink != 0 || !os.SameFile(fileInfo, currentInfo) {
		return nil, errors.New("credential source changed while opening")
	}
	if runtime.GOOS != "windows" && !secureCredentialMode(currentInfo.Mode().Perm()) {
		return nil, errors.New("credential source permissions changed while opening")
	}
	limited := io.LimitReader(file, MaxValueSize+1)
	value, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if len(value) == 0 || len(value) > MaxValueSize || int64(len(value)) != fileInfo.Size() {
		zero(value)
		return nil, errors.New("credential source changed size while reading")
	}
	return value, nil
}

func secureCredentialMode(mode os.FileMode) bool {
	return mode&0o077 == 0 && mode&0o400 != 0 && mode&0o111 == 0
}

func zeroMap(values map[string][]byte) {
	for _, value := range values {
		zero(value)
	}
}

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
