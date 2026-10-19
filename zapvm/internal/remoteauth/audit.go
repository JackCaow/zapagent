package remoteauth

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	AuditSchemaVersion = 1
	maxAuditFileSize   = 64 << 20
	maxAuditRecordSize = 4 << 10
)

type AuditEvent struct {
	RequestID  string
	Principal  string
	TenantID   string
	ProjectID  string
	Action     string
	ComputerID string
	TaskID     string
	Decision   string
	Outcome    string
}

type AuditRecord struct {
	SchemaVersion  int    `json:"schema_version"`
	Sequence       uint64 `json:"sequence"`
	Timestamp      string `json:"timestamp"`
	NodeID         string `json:"node_id"`
	RequestID      string `json:"request_id"`
	Principal      string `json:"principal"`
	TenantID       string `json:"tenant_id"`
	ProjectID      string `json:"project_id"`
	Action         string `json:"action"`
	ComputerID     string `json:"computer_id,omitempty"`
	TaskID         string `json:"task_id,omitempty"`
	Decision       string `json:"decision"`
	Outcome        string `json:"outcome"`
	PreviousSHA256 string `json:"previous_sha256,omitempty"`
	SHA256         string `json:"sha256"`
}

type AuditLog struct {
	mu        sync.Mutex
	file      *os.File
	nodeID    string
	sequence  uint64
	lastHash  string
	knownSize int64
	closed    bool
}

func OpenAudit(path, nodeID string) (*AuditLog, error) {
	if err := validateAuditTarget(path, nodeID); err != nil {
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
		return nil, errors.New("remote audit path changed while opening")
	}
	if err := validateOwnerOnlyFile(path, fileInfo); err != nil {
		return nil, fmt.Errorf("remote audit file: %w", err)
	}
	if err := validateAuditWritable(path, fileInfo); err != nil {
		return nil, err
	}
	log := &AuditLog{file: file, nodeID: nodeID}
	if err := lockAuditFile(file); err != nil {
		return nil, fmt.Errorf("lock remote audit log: %w", err)
	}
	scanErr := log.scanLocked()
	unlockErr := unlockAuditFile(file)
	if err := errors.Join(scanErr, unlockErr); err != nil {
		return nil, err
	}
	failed = false
	return log, nil
}

func ValidateAuditTarget(path, nodeID string) error {
	return validateAuditTarget(path, nodeID)
}

func validateAuditTarget(path, nodeID string) error {
	if !filepath.IsAbs(path) || len(path) > 32767 || strings.IndexByte(path, 0) >= 0 {
		return errors.New("remote audit path must be absolute and non-NUL")
	}
	if !validToken(nodeID, 128) {
		return errors.New("remote audit node ID is invalid")
	}
	parentInfo, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return err
	}
	if !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("remote audit parent must be a real directory")
	}
	if err := validateOwnerOnlyDirectory(filepath.Dir(path), parentInfo); err != nil {
		return fmt.Errorf("remote audit parent: %w", err)
	}
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("remote audit path must be a regular file")
		}
		if err := validateOwnerOnlyFile(path, info); err != nil {
			return fmt.Errorf("remote audit file: %w", err)
		}
		if err := validateAuditWritable(path, info); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (log *AuditLog) Append(event AuditEvent) (returnErr error) {
	if log == nil {
		return errors.New("remote audit log is required")
	}
	if !validToken(event.RequestID, 128) || !validToken(event.TenantID, 128) || !validToken(event.ProjectID, 128) ||
		!validAction(event.Action) || (event.ComputerID != "" && !validToken(event.ComputerID, 128)) ||
		(event.TaskID != "" && !validToken(event.TaskID, 128)) || !validDecision(event.Decision) || !validOutcome(event.Outcome) ||
		len(event.Principal) < 1 || len(event.Principal) > 1024 || strings.IndexByte(event.Principal, 0) >= 0 {
		return errors.New("remote audit event contains invalid fields")
	}
	log.mu.Lock()
	defer log.mu.Unlock()
	if log.closed {
		return errors.New("remote audit log is closed")
	}
	if err := lockAuditFile(log.file); err != nil {
		return fmt.Errorf("lock remote audit log: %w", err)
	}
	defer func() { returnErr = errors.Join(returnErr, unlockAuditFile(log.file)) }()
	info, err := log.file.Stat()
	if err != nil {
		return err
	}
	if info.Size() != log.knownSize {
		if err := log.scanLocked(); err != nil {
			return err
		}
	}
	record := AuditRecord{
		SchemaVersion: AuditSchemaVersion, Sequence: log.sequence + 1,
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano), NodeID: log.nodeID,
		RequestID: event.RequestID, Principal: event.Principal, TenantID: event.TenantID, ProjectID: event.ProjectID,
		Action: event.Action, ComputerID: event.ComputerID, TaskID: event.TaskID,
		Decision: event.Decision, Outcome: event.Outcome, PreviousSHA256: log.lastHash,
	}
	record.SHA256, err = hashAuditRecord(record)
	if err != nil {
		return err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if len(data) > maxAuditRecordSize {
		return errors.New("remote audit record exceeds size limit")
	}
	if log.knownSize+int64(len(data)) > maxAuditFileSize {
		return errors.New("remote audit log reached its 64 MiB rotation limit")
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
	log.sequence = record.Sequence
	log.lastHash = record.SHA256
	log.knownSize += int64(written)
	return nil
}

func (log *AuditLog) Close() error {
	if log == nil {
		return nil
	}
	log.mu.Lock()
	defer log.mu.Unlock()
	if log.closed {
		return nil
	}
	log.closed = true
	return errors.Join(log.file.Sync(), log.file.Close())
}

func (log *AuditLog) scanLocked() error {
	info, err := log.file.Stat()
	if err != nil {
		return err
	}
	if info.Size() < 0 || info.Size() > maxAuditFileSize {
		return fmt.Errorf("remote audit size %d exceeds limit", info.Size())
	}
	if info.Size() > 0 {
		last := []byte{0}
		if _, err := log.file.ReadAt(last, info.Size()-1); err != nil {
			return err
		}
		if last[0] != '\n' {
			return errors.New("remote audit log ends with a partial record")
		}
	}
	if _, err := log.file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	scanner := bufio.NewScanner(log.file)
	scanner.Buffer(make([]byte, 1024), maxAuditRecordSize)
	var sequence uint64
	previousHash := ""
	line := 0
	for scanner.Scan() {
		line++
		record, err := decodeAuditRecord(scanner.Bytes())
		if err != nil {
			return fmt.Errorf("remote audit record %d: %w", line, err)
		}
		if record.NodeID != log.nodeID || record.Sequence != sequence+1 || record.PreviousSHA256 != previousHash {
			return fmt.Errorf("remote audit record %d breaks node, sequence, or hash chain", line)
		}
		sequence = record.Sequence
		previousHash = record.SHA256
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	log.sequence = sequence
	log.lastHash = previousHash
	log.knownSize = info.Size()
	_, err = log.file.Seek(0, io.SeekEnd)
	return err
}

func decodeAuditRecord(data []byte) (AuditRecord, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var record AuditRecord
	if err := decoder.Decode(&record); err != nil {
		return AuditRecord{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return AuditRecord{}, errors.New("record contains trailing JSON")
	}
	if record.SchemaVersion != AuditSchemaVersion || record.Sequence == 0 || !validToken(record.NodeID, 128) {
		return AuditRecord{}, errors.New("record schema, sequence, or node ID is invalid")
	}
	expected, err := hashAuditRecord(record)
	if err != nil {
		return AuditRecord{}, err
	}
	if record.SHA256 != expected {
		return AuditRecord{}, errors.New("record hash is invalid")
	}
	return record, nil
}

func hashAuditRecord(record AuditRecord) (string, error) {
	record.SHA256 = ""
	data, err := json.Marshal(record)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func validAction(value string) bool {
	if value == "request.unsupported" {
		return true
	}
	_, ok := knownPermissions[value]
	return ok
}

func validDecision(value string) bool {
	return value == "allow" || value == "deny"
}

func validOutcome(value string) bool {
	switch value {
	case "authorized", "rejected", "success", "daemon_error", "transport_error":
		return true
	default:
		return false
	}
}
