package auditlog

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	SchemaVersion = 1
	maxFileSize   = 64 << 20
	maxRecordSize = 4 << 10
)

type Record struct {
	SchemaVersion  int    `json:"schema_version"`
	Timestamp      string `json:"timestamp"`
	RunID          string `json:"run_id"`
	RunSequence    uint64 `json:"run_sequence"`
	VMIDSHA256     string `json:"vm_id_sha256"`
	Event          string `json:"event"`
	Phase          string `json:"phase,omitempty"`
	PreviousSHA256 string `json:"previous_sha256,omitempty"`
	SHA256         string `json:"sha256"`
}

type Log struct {
	mu          sync.Mutex
	file        *os.File
	runID       string
	vmIDHash    string
	runSequence uint64
	lastHash    string
	knownSize   int64
	closed      bool
}

func Open(path, vmID string) (*Log, error) {
	if !filepath.IsAbs(path) || len(path) > 32767 || strings.IndexByte(path, 0) >= 0 {
		return nil, errors.New("audit log path must be an absolute non-NUL path")
	}
	if vmID == "" || len(vmID) > 256 || strings.IndexByte(vmID, 0) >= 0 {
		return nil, errors.New("audit log VM ID must contain 1-256 non-NUL bytes")
	}
	parent := filepath.Dir(path)
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return nil, err
	}
	if !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("audit log parent must be a real directory")
	}
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("audit log must be a regular file")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	failed := true
	defer func() {
		if failed {
			_ = file.Close()
		}
	}()
	pathInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	fileInfo, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 || !os.SameFile(pathInfo, fileInfo) {
		return nil, errors.New("audit log path changed while opening")
	}
	if runtime.GOOS != "windows" && (fileInfo.Mode().Perm()&0o077 != 0 || fileInfo.Mode().Perm()&0o200 == 0) {
		return nil, fmt.Errorf("audit log permissions %o must be owner-writable with no group/other access", fileInfo.Mode().Perm())
	}

	runBytes := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, runBytes); err != nil {
		return nil, err
	}
	vmHash := sha256.Sum256([]byte(vmID))
	log := &Log{file: file, runID: hex.EncodeToString(runBytes), vmIDHash: hex.EncodeToString(vmHash[:])}
	if err := lockFile(file); err != nil {
		return nil, fmt.Errorf("lock audit log: %w", err)
	}
	scanErr := log.scanLocked()
	unlockErr := unlockFile(file)
	if err := errors.Join(scanErr, unlockErr); err != nil {
		return nil, err
	}
	failed = false
	return log, nil
}

func (log *Log) Append(event, phase string) (returnErr error) {
	if !validToken(event) || (phase != "" && !validToken(phase)) {
		return errors.New("audit event and phase must be lowercase identifier tokens")
	}
	log.mu.Lock()
	defer log.mu.Unlock()
	if log.closed {
		return errors.New("audit log is closed")
	}
	if err := lockFile(log.file); err != nil {
		return fmt.Errorf("lock audit log: %w", err)
	}
	defer func() { returnErr = errors.Join(returnErr, unlockFile(log.file)) }()
	info, err := log.file.Stat()
	if err != nil {
		return err
	}
	if info.Size() != log.knownSize {
		if err := log.scanLocked(); err != nil {
			return err
		}
	}
	record := Record{
		SchemaVersion:  SchemaVersion,
		Timestamp:      time.Now().UTC().Format(time.RFC3339Nano),
		RunID:          log.runID,
		RunSequence:    log.runSequence + 1,
		VMIDSHA256:     log.vmIDHash,
		Event:          event,
		Phase:          phase,
		PreviousSHA256: log.lastHash,
	}
	recordHash, err := hashRecord(record)
	if err != nil {
		return err
	}
	record.SHA256 = recordHash
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if len(data) > maxRecordSize {
		return errors.New("audit record exceeds size limit")
	}
	if log.knownSize+int64(len(data)) > maxFileSize {
		return errors.New("audit log reached its 64 MiB rotation limit")
	}
	written, err := log.file.Write(data)
	if err != nil {
		log.knownSize = -1
		return err
	}
	if written != len(data) {
		log.knownSize = -1
		return io.ErrShortWrite
	}
	if err := log.file.Sync(); err != nil {
		log.knownSize = -1
		return err
	}
	log.runSequence = record.RunSequence
	log.lastHash = record.SHA256
	log.knownSize += int64(written)
	return nil
}

func (log *Log) Close() error {
	log.mu.Lock()
	defer log.mu.Unlock()
	if log.closed {
		return nil
	}
	log.closed = true
	return errors.Join(log.file.Sync(), log.file.Close())
}

func (log *Log) scanLocked() error {
	info, err := log.file.Stat()
	if err != nil {
		return err
	}
	if info.Size() < 0 || info.Size() > maxFileSize {
		return fmt.Errorf("audit log size %d exceeds limit", info.Size())
	}
	if info.Size() > 0 {
		last := []byte{0}
		if _, err := log.file.ReadAt(last, info.Size()-1); err != nil {
			return err
		}
		if last[0] != '\n' {
			return errors.New("audit log ends with a partial record")
		}
	}
	if _, err := log.file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	scanner := bufio.NewScanner(log.file)
	scanner.Buffer(make([]byte, 1024), maxRecordSize)
	previousHash := ""
	runSequences := make(map[string]uint64)
	line := 0
	for scanner.Scan() {
		line++
		record, err := decodeRecord(scanner.Bytes())
		if err != nil {
			return fmt.Errorf("audit record %d: %w", line, err)
		}
		if record.PreviousSHA256 != previousHash {
			return fmt.Errorf("audit record %d breaks the hash chain", line)
		}
		expectedHash, err := hashRecord(record)
		if err != nil {
			return err
		}
		if record.SHA256 != expectedHash {
			return fmt.Errorf("audit record %d has an invalid hash", line)
		}
		if record.RunSequence != runSequences[record.RunID]+1 {
			return fmt.Errorf("audit record %d has a non-monotonic run sequence", line)
		}
		runSequences[record.RunID] = record.RunSequence
		previousHash = record.SHA256
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	log.lastHash = previousHash
	log.runSequence = runSequences[log.runID]
	log.knownSize = info.Size()
	return nil
}

func decodeRecord(data []byte) (Record, error) {
	if len(data) == 0 || len(data) >= maxRecordSize {
		return Record{}, errors.New("record is empty or oversized")
	}
	var record Record
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&record); err != nil {
		return Record{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Record{}, errors.New("record contains trailing JSON")
	}
	if record.SchemaVersion != SchemaVersion || record.RunSequence == 0 || !validToken(record.Event) || (record.Phase != "" && !validToken(record.Phase)) {
		return Record{}, errors.New("record has invalid schema, sequence, event, or phase")
	}
	if _, err := time.Parse(time.RFC3339Nano, record.Timestamp); err != nil {
		return Record{}, errors.New("record has an invalid timestamp")
	}
	if !validHex(record.RunID, 32) || !validHex(record.VMIDSHA256, 64) || !validHex(record.SHA256, 64) {
		return Record{}, errors.New("record has an invalid identifier or hash")
	}
	if record.PreviousSHA256 != "" && !validHex(record.PreviousSHA256, 64) {
		return Record{}, errors.New("record has an invalid previous hash")
	}
	return record, nil
}

func hashRecord(record Record) (string, error) {
	record.SHA256 = ""
	data, err := json.Marshal(record)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]), nil
}

func validToken(value string) bool {
	if value == "" || len(value) > 64 || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for _, char := range value[1:] {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '_' {
			return false
		}
	}
	return true
}

func validHex(value string, length int) bool {
	if len(value) != length {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && value == strings.ToLower(value)
}
