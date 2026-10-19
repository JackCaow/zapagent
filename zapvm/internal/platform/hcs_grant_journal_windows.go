//go:build windows

package platform

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

const hcsGrantJournalVersion = 3

var (
	procConvertSecurityDescriptorToStringSecurityDescriptorW = windows.NewLazySystemDLL("advapi32.dll").NewProc("ConvertSecurityDescriptorToStringSecurityDescriptorW")
	procSetFileSecurityW                                     = windows.NewLazySystemDLL("advapi32.dll").NewProc("SetFileSecurityW")
)

type hcsGrantJournalDocument struct {
	Version int                             `json:"version"`
	Entries map[string]hcsGrantJournalEntry `json:"entries"`
}

type hcsGrantJournalEntry struct {
	PendingPath  string   `json:"pending_path,omitempty"`
	PendingDACL  string   `json:"pending_dacl,omitempty"`
	GrantedPaths []string `json:"granted_paths"`
	GrantedDACLs []string `json:"granted_dacls"`
}

type hcsGrantJournalEnvelope struct {
	Version int             `json:"version"`
	Entries json.RawMessage `json:"entries"`
}

type hcsGrantJournalDocumentV1 struct {
	Version int                 `json:"version"`
	Entries map[string][]string `json:"entries"`
}

type hcsGrantJournal struct {
	mu      sync.Mutex
	path    string
	entries map[string]hcsGrantJournalEntry
}

func openHCSGrantJournal() (*hcsGrantJournal, error) {
	programData := os.Getenv("ProgramData")
	if programData == "" {
		return nil, errors.New("ProgramData is not set")
	}
	directory := filepath.Join(programData, "zapVM")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	if err := secureWindowsServiceDirectory(directory); err != nil {
		return nil, fmt.Errorf("secure grant journal directory: %w", err)
	}
	journal := &hcsGrantJournal{path: filepath.Join(directory, "hcs-grants.json"), entries: make(map[string]hcsGrantJournalEntry)}
	if err := journal.load(); err != nil {
		return nil, err
	}
	return journal, nil
}

func (journal *hcsGrantJournal) load() error {
	data, err := os.ReadFile(journal.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(data) == 0 || len(data) > windowsServiceMaxFrame {
		return fmt.Errorf("HCS grant journal size %d is outside 1-%d bytes", len(data), windowsServiceMaxFrame)
	}
	var envelope hcsGrantJournalEnvelope
	if err := decodeHCSGrantJournalJSON(data, &envelope); err != nil {
		return err
	}
	if len(envelope.Entries) == 0 || bytes.Equal(bytes.TrimSpace(envelope.Entries), []byte("null")) {
		return errors.New("HCS grant journal is missing entries")
	}
	var entries map[string]hcsGrantJournalEntry
	switch envelope.Version {
	case 1:
		var document hcsGrantJournalDocumentV1
		if err := decodeHCSGrantJournalJSON(data, &document); err != nil {
			return err
		}
		entries = make(map[string]hcsGrantJournalEntry, len(document.Entries))
		for vmID, paths := range document.Entries {
			entries[vmID] = hcsGrantJournalEntry{GrantedPaths: paths}
		}
	case 2, hcsGrantJournalVersion:
		var document hcsGrantJournalDocument
		if err := decodeHCSGrantJournalJSON(data, &document); err != nil {
			return err
		}
		if document.Entries == nil {
			return errors.New("HCS grant journal entries must be an object")
		}
		entries = document.Entries
	default:
		return fmt.Errorf("unsupported HCS grant journal version %d", envelope.Version)
	}
	if len(entries) > 64 {
		return errors.New("HCS grant journal contains more than 64 VMs")
	}
	sharedBaselines := make(map[string]string)
	for vmID, entry := range entries {
		if envelope.Version >= 2 && entry.GrantedPaths == nil {
			return errors.New("HCS grant journal granted_paths must be an array")
		}
		if envelope.Version == 2 && (entry.PendingDACL != "" || entry.GrantedDACLs != nil) {
			return errors.New("HCS grant journal version 2 contains version 3 DACL state")
		}
		if envelope.Version == hcsGrantJournalVersion {
			if entry.GrantedDACLs == nil || len(entry.GrantedDACLs) != len(entry.GrantedPaths) {
				return errors.New("HCS grant journal granted DACLs do not match granted paths")
			}
			if (entry.PendingPath == "") != (entry.PendingDACL == "") {
				return errors.New("HCS grant journal pending DACL does not match pending path")
			}
		}
		pathCount := len(entry.GrantedPaths)
		if entry.PendingPath != "" {
			pathCount++
		}
		if vmID == "" || len(vmID) > 64 || pathCount > 8 || (envelope.Version == 1 && pathCount == 0) {
			return errors.New("HCS grant journal contains an invalid VM entry")
		}
		paths := append([]string(nil), entry.GrantedPaths...)
		if entry.PendingPath != "" {
			paths = append(paths, entry.PendingPath)
		}
		seen := make(map[string]struct{}, len(paths))
		for _, path := range paths {
			if !validHCSGrantJournalPath(path) {
				return errors.New("HCS grant journal contains an invalid local path")
			}
			key := strings.ToLower(filepath.Clean(path))
			if _, exists := seen[key]; exists {
				return errors.New("HCS grant journal contains a duplicate path")
			}
			seen[key] = struct{}{}
		}
		if envelope.Version == hcsGrantJournalVersion {
			dacls := append([]string(nil), entry.GrantedDACLs...)
			if entry.PendingDACL != "" {
				dacls = append(dacls, entry.PendingDACL)
			}
			for index, dacl := range dacls {
				if !validHCSGrantJournalDACL(dacl) {
					return errors.New("HCS grant journal contains an invalid baseline DACL")
				}
				key := strings.ToLower(filepath.Clean(paths[index]))
				if existing, ok := sharedBaselines[key]; ok && existing != dacl {
					return errors.New("HCS grant journal contains inconsistent shared-path DACL baselines")
				}
				sharedBaselines[key] = dacl
			}
		}
		journal.entries[vmID] = cloneHCSGrantJournalEntry(entry)
	}
	return nil
}

func validHCSGrantJournalPath(path string) bool {
	return path != "" && len(path) <= 32767 && filepath.IsAbs(path) && !strings.HasPrefix(path, `\\`)
}

func validHCSGrantJournalDACL(dacl string) bool {
	if dacl == "" || len(dacl) > 65535 || !strings.HasPrefix(dacl, "D:") {
		return false
	}
	_, err := windows.SecurityDescriptorFromString(dacl)
	return err == nil
}

func cloneHCSGrantJournalEntry(entry hcsGrantJournalEntry) hcsGrantJournalEntry {
	if entry.GrantedPaths != nil {
		paths := make([]string, len(entry.GrantedPaths))
		copy(paths, entry.GrantedPaths)
		entry.GrantedPaths = paths
	}
	if entry.GrantedDACLs != nil {
		dacls := make([]string, len(entry.GrantedDACLs))
		copy(dacls, entry.GrantedDACLs)
		entry.GrantedDACLs = dacls
	}
	return entry
}

func hcsGrantEntryBaseline(entry hcsGrantJournalEntry, path string) (string, bool) {
	key := filepath.Clean(path)
	if entry.PendingPath != "" && strings.EqualFold(filepath.Clean(entry.PendingPath), key) {
		return entry.PendingDACL, true
	}
	for index, grantedPath := range entry.GrantedPaths {
		if strings.EqualFold(filepath.Clean(grantedPath), key) {
			if index < len(entry.GrantedDACLs) {
				return entry.GrantedDACLs[index], true
			}
			return "", true
		}
	}
	return "", false
}

func (journal *hcsGrantJournal) sharedBaselineLocked(vmID, path string) (string, bool, error) {
	baseline := ""
	found := false
	for otherVMID, entry := range journal.entries {
		if otherVMID == vmID {
			continue
		}
		candidate, referenced := hcsGrantEntryBaseline(entry, path)
		if !referenced {
			continue
		}
		if candidate == "" {
			return "", false, errors.New("shared HCS grant path has no recoverable DACL baseline")
		}
		if found && candidate != baseline {
			return "", false, errors.New("shared HCS grant path has inconsistent DACL baselines")
		}
		baseline = candidate
		found = true
	}
	return baseline, found, nil
}

func (journal *hcsGrantJournal) pathReferencedByOtherVMLocked(vmID, path string) bool {
	for otherVMID, entry := range journal.entries {
		if otherVMID == vmID {
			continue
		}
		if _, referenced := hcsGrantEntryBaseline(entry, path); referenced {
			return true
		}
	}
	return false
}

func (journal *hcsGrantJournal) removeGrantPathLocked(vmID, path string) error {
	entry, exists := journal.entries[vmID]
	if !exists {
		return fmt.Errorf("HCS grant journal does not contain VM %s", vmID)
	}
	previous := cloneHCSGrantJournalEntry(entry)
	removed := false
	if entry.PendingPath != "" && strings.EqualFold(filepath.Clean(entry.PendingPath), filepath.Clean(path)) {
		entry.PendingPath = ""
		entry.PendingDACL = ""
		removed = true
	} else {
		for index, grantedPath := range entry.GrantedPaths {
			if !strings.EqualFold(filepath.Clean(grantedPath), filepath.Clean(path)) {
				continue
			}
			entry.GrantedPaths = append(entry.GrantedPaths[:index], entry.GrantedPaths[index+1:]...)
			if index < len(entry.GrantedDACLs) {
				entry.GrantedDACLs = append(entry.GrantedDACLs[:index], entry.GrantedDACLs[index+1:]...)
			}
			removed = true
			break
		}
	}
	if !removed {
		return fmt.Errorf("HCS grant journal does not track path %s for VM %s", path, vmID)
	}
	journal.entries[vmID] = entry
	if err := journal.persistLocked(); err != nil {
		journal.entries[vmID] = previous
		return err
	}
	return nil
}

func hcsReadPathDACL(path string) (string, error) {
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return "", fmt.Errorf("read HCS grant path baseline DACL: %w", err)
	}
	dacl, err := hcsDACLString(descriptor)
	if err != nil {
		return "", fmt.Errorf("serialize HCS grant path baseline DACL: %w", err)
	}
	if !validHCSGrantJournalDACL(dacl) {
		return "", errors.New("HCS grant path baseline DACL is not representable as SDDL")
	}
	return dacl, nil
}

func hcsDACLString(descriptor *windows.SECURITY_DESCRIPTOR) (string, error) {
	var sddl *uint16
	result, _, callErr := procConvertSecurityDescriptorToStringSecurityDescriptorW.Call(
		uintptr(unsafe.Pointer(descriptor)),
		1,
		uintptr(windows.DACL_SECURITY_INFORMATION),
		uintptr(unsafe.Pointer(&sddl)),
		0,
	)
	runtime.KeepAlive(descriptor)
	if result == 0 {
		if callErr != nil && callErr != windows.ERROR_SUCCESS {
			return "", callErr
		}
		return "", errors.New("ConvertSecurityDescriptorToStringSecurityDescriptorW failed without a Windows error")
	}
	if sddl == nil {
		return "", errors.New("ConvertSecurityDescriptorToStringSecurityDescriptorW returned a nil string")
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(sddl)))
	return windows.UTF16PtrToString(sddl), nil
}

func hcsACLBytes(acl *windows.ACL) []byte {
	if acl == nil {
		return nil
	}
	type aclHeader struct {
		revision byte
		reserved byte
		size     uint16
	}
	size := (*aclHeader)(unsafe.Pointer(acl)).size
	if size == 0 {
		return nil
	}
	data := unsafe.Slice((*byte)(unsafe.Pointer(acl)), int(size))
	return append([]byte(nil), data...)
}

func hcsSetPathDACL(path string, descriptor *windows.SECURITY_DESCRIPTOR) error {
	pathPointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	result, _, callErr := procSetFileSecurityW.Call(
		uintptr(unsafe.Pointer(pathPointer)),
		uintptr(windows.DACL_SECURITY_INFORMATION),
		uintptr(unsafe.Pointer(descriptor)),
	)
	runtime.KeepAlive(descriptor)
	if result == 0 {
		if callErr != nil && callErr != windows.ERROR_SUCCESS {
			return callErr
		}
		return errors.New("SetFileSecurityW failed without a Windows error")
	}
	return nil
}

func hcsRestorePathDACL(path, baseline string) error {
	if baseline == "" {
		return nil
	}
	baselineDescriptor, err := windows.SecurityDescriptorFromString(baseline)
	if err != nil {
		return fmt.Errorf("parse HCS grant baseline DACL: %w", err)
	}
	baselineACL, _, err := baselineDescriptor.DACL()
	if err != nil {
		return fmt.Errorf("read HCS grant baseline ACL: %w", err)
	}
	currentDescriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("read HCS grant path DACL after revoke: %w", err)
	}
	currentACL, _, err := currentDescriptor.DACL()
	if err != nil {
		return fmt.Errorf("read HCS grant path ACL after revoke: %w", err)
	}
	if !bytes.Equal(hcsACLBytes(currentACL), hcsACLBytes(baselineACL)) {
		return errors.New("refusing to overwrite an HCS grant path DACL changed outside HCS")
	}
	current, err := hcsDACLString(currentDescriptor)
	if err != nil {
		return fmt.Errorf("serialize HCS grant path DACL after revoke: %w", err)
	}
	if current == baseline {
		return nil
	}
	if err := hcsSetPathDACL(path, baselineDescriptor); err != nil {
		return fmt.Errorf("restore HCS grant path baseline DACL: %w", err)
	}
	restored, err := hcsReadPathDACL(path)
	if err != nil {
		return err
	}
	if restored != baseline {
		return errors.New("HCS grant path DACL did not return to its exact baseline")
	}
	return nil
}

func hcsVMAccountSIDString(vmID string) (string, error) {
	parts := strings.Split(vmID, "-")
	if len(parts) != 5 || len(parts[0]) != 8 || len(parts[1]) != 4 || len(parts[2]) != 4 || len(parts[3]) != 4 || len(parts[4]) != 12 {
		return "", errors.New("invalid HCS VM GUID")
	}
	decoded, err := hex.DecodeString(strings.Join(parts, ""))
	if err != nil || len(decoded) != 16 {
		return "", errors.New("invalid HCS VM GUID")
	}
	data1 := binary.BigEndian.Uint32(decoded[0:4])
	data2 := binary.BigEndian.Uint16(decoded[4:6])
	data3 := binary.BigEndian.Uint16(decoded[6:8])
	data23 := uint32(data3)<<16 | uint32(data2)
	data4a := binary.LittleEndian.Uint32(decoded[8:12])
	data4b := binary.LittleEndian.Uint32(decoded[12:16])
	return fmt.Sprintf("S-1-5-83-1-%d-%d-%d-%d", data1, data23, data4a, data4b), nil
}

func hcsPathHasVMAccess(vmID, path string) (bool, error) {
	accountSIDString, err := hcsVMAccountSIDString(vmID)
	if err != nil {
		return false, err
	}
	accountSID, err := windows.StringToSid(accountSIDString)
	if err != nil {
		return false, fmt.Errorf("parse HCS VM account SID: %w", err)
	}
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false, fmt.Errorf("read HCS grant path DACL: %w", err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return false, fmt.Errorf("read HCS grant path ACL: %w", err)
	}
	if dacl == nil {
		return false, nil
	}
	for index := uint16(0); index < dacl.AceCount; index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, uint32(index), &ace); err != nil {
			return false, fmt.Errorf("read HCS grant path ACE %d: %w", index, err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			continue
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if sid.IsValid() && accountSID.Equals(sid) {
			return true, nil
		}
	}
	return false, nil
}

func decodeHCSGrantJournalJSON(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("decode HCS grant journal: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("trailing JSON")
		}
		return fmt.Errorf("decode HCS grant journal: %w", err)
	}
	return nil
}

func (journal *hcsGrantJournal) Prepare(vmID string) error {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if vmID == "" || len(vmID) > 64 {
		return errors.New("refusing invalid HCS grant journal VM ID")
	}
	if _, exists := journal.entries[vmID]; exists {
		return fmt.Errorf("HCS grant journal already contains VM %s; service recovery is required", vmID)
	}
	journal.entries[vmID] = hcsGrantJournalEntry{GrantedPaths: []string{}, GrantedDACLs: []string{}}
	if err := journal.persistLocked(); err != nil {
		delete(journal.entries, vmID)
		return err
	}
	return nil
}

func (journal *hcsGrantJournal) BeginGrant(vmID, path string) error {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	entry, exists := journal.entries[vmID]
	if !exists {
		return fmt.Errorf("HCS grant journal does not contain VM %s", vmID)
	}
	if !validHCSGrantJournalPath(path) {
		return errors.New("refusing invalid HCS grant journal path")
	}
	if entry.PendingPath != "" {
		return errors.New("HCS grant journal already contains a pending path")
	}
	if len(entry.GrantedPaths) >= 8 {
		return errors.New("HCS grant journal VM entry exceeds 8 paths")
	}
	for _, existing := range entry.GrantedPaths {
		if strings.EqualFold(filepath.Clean(existing), filepath.Clean(path)) {
			return errors.New("HCS grant journal contains a duplicate path")
		}
	}
	// Multiple HCS VMs may concurrently grant the same signed image path. Keep
	// the baseline from the first journaled grant instead of snapshotting ACEs
	// introduced by another zapVM VM as though they belonged to the Host.
	baselineDACL, shared, err := journal.sharedBaselineLocked(vmID, path)
	if err != nil {
		return err
	}
	if !shared {
		baselineDACL, err = hcsReadPathDACL(path)
		if err != nil {
			return err
		}
	}
	entry.PendingPath = path
	entry.PendingDACL = baselineDACL
	journal.entries[vmID] = entry
	if err := journal.persistLocked(); err != nil {
		entry.PendingPath = ""
		entry.PendingDACL = ""
		journal.entries[vmID] = entry
		return err
	}
	return nil
}

func (journal *hcsGrantJournal) CommitGrant(vmID, path string) error {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	entry, exists := journal.entries[vmID]
	if !exists {
		return fmt.Errorf("HCS grant journal does not contain VM %s", vmID)
	}
	if entry.PendingPath == "" || !strings.EqualFold(entry.PendingPath, path) {
		return errors.New("HCS grant journal pending path does not match committed grant")
	}
	previous := cloneHCSGrantJournalEntry(entry)
	entry.GrantedPaths = append(entry.GrantedPaths, entry.PendingPath)
	entry.GrantedDACLs = append(entry.GrantedDACLs, entry.PendingDACL)
	entry.PendingPath = ""
	entry.PendingDACL = ""
	journal.entries[vmID] = entry
	if err := journal.persistLocked(); err != nil {
		journal.entries[vmID] = previous
		return err
	}
	return nil
}

func (journal *hcsGrantJournal) RevokeGrant(vmID, path string) error {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	entry, exists := journal.entries[vmID]
	if !exists {
		return fmt.Errorf("HCS grant journal does not contain VM %s", vmID)
	}
	baseline, tracked := hcsGrantEntryBaseline(entry, path)
	if !tracked {
		return fmt.Errorf("HCS grant journal does not track path %s for VM %s", path, vmID)
	}
	if err := hcsRevokeVMAccess(vmID, path); err != nil {
		return err
	}
	hasAccess, err := hcsPathHasVMAccess(vmID, path)
	if err != nil {
		return err
	}
	if hasAccess {
		return errors.New("HCS grant path still contains the revoked VM account ACE")
	}
	// A non-final reference only removes its own VM ACE. The final reference
	// restores the original shared baseline, including descriptor control bits.
	if !journal.pathReferencedByOtherVMLocked(vmID, path) {
		if err := hcsRestorePathDACL(path, baseline); err != nil {
			return err
		}
	}
	return journal.removeGrantPathLocked(vmID, path)
}

func (journal *hcsGrantJournal) Complete(vmID string) error {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	entry, exists := journal.entries[vmID]
	if !exists {
		return nil
	}
	delete(journal.entries, vmID)
	if err := journal.persistLocked(); err != nil {
		journal.entries[vmID] = entry
		return err
	}
	return nil
}

func (journal *hcsGrantJournal) Recover() error {
	if err := loadHCS(); err != nil {
		return err
	}
	journal.mu.Lock()
	vmIDs := make([]string, 0, len(journal.entries))
	for vmID := range journal.entries {
		vmIDs = append(vmIDs, vmID)
	}
	journal.mu.Unlock()
	sort.Strings(vmIDs)
	for _, vmID := range vmIDs {
		journal.mu.Lock()
		entry := cloneHCSGrantJournalEntry(journal.entries[vmID])
		journal.mu.Unlock()
		paths := append([]string(nil), entry.GrantedPaths...)
		baselines := append([]string(nil), entry.GrantedDACLs...)
		for len(baselines) < len(paths) {
			baselines = append(baselines, "")
		}
		if entry.PendingPath != "" {
			paths = append(paths, entry.PendingPath)
			baselines = append(baselines, entry.PendingDACL)
		}
		var revokeErr error
		for index := len(paths) - 1; index >= 0; index-- {
			if _, err := os.Lstat(paths[index]); errors.Is(err, os.ErrNotExist) {
				continue
			} else if err != nil {
				revokeErr = errors.Join(revokeErr, fmt.Errorf("inspect stale HCS grant path: %w", err))
				continue
			}
			hasAccess, err := hcsPathHasVMAccess(vmID, paths[index])
			if err != nil {
				revokeErr = errors.Join(revokeErr, err)
				continue
			}
			if hasAccess {
				if err := hcsRevokeVMAccess(vmID, paths[index]); err != nil {
					revokeErr = errors.Join(revokeErr, err)
					continue
				}
				stillHasAccess, err := hcsPathHasVMAccess(vmID, paths[index])
				if err != nil {
					revokeErr = errors.Join(revokeErr, err)
					continue
				}
				if stillHasAccess {
					revokeErr = errors.Join(revokeErr, errors.New("HCS recovery path still contains the revoked VM account ACE"))
					continue
				}
				if err := windowsServiceFaultPoint("after-recovery-revoke", index); err != nil {
					return errors.Join(fmt.Errorf("recover stale HCS grant for VM %s", vmID), err)
				}
			}
			journal.mu.Lock()
			shared := journal.pathReferencedByOtherVMLocked(vmID, paths[index])
			var pathErr error
			if !shared {
				pathErr = hcsRestorePathDACL(paths[index], baselines[index])
			}
			if pathErr == nil {
				pathErr = journal.removeGrantPathLocked(vmID, paths[index])
			}
			journal.mu.Unlock()
			if pathErr != nil {
				revokeErr = errors.Join(revokeErr, pathErr)
			}
		}
		if revokeErr != nil {
			return fmt.Errorf("recover stale HCS grants for VM %s: %w", vmID, revokeErr)
		}
		if err := journal.Complete(vmID); err != nil {
			return err
		}
	}
	return nil
}

func (journal *hcsGrantJournal) persistLocked() error {
	if len(journal.entries) == 0 {
		if err := os.Remove(journal.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	entries := make(map[string]hcsGrantJournalEntry, len(journal.entries))
	for vmID, entry := range journal.entries {
		entries[vmID] = cloneHCSGrantJournalEntry(entry)
	}
	document := hcsGrantJournalDocument{Version: hcsGrantJournalVersion, Entries: entries}
	data, err := json.Marshal(document)
	if err != nil {
		return err
	}
	if len(data) > windowsServiceMaxFrame {
		return errors.New("HCS grant journal exceeds 1 MiB")
	}
	temporary := journal.path + fmt.Sprintf(".tmp-%d", os.Getpid())
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	cleanup := true
	defer func() {
		_ = file.Close()
		if cleanup {
			_ = os.Remove(temporary)
		}
	}()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	from, err := windows.UTF16PtrFromString(temporary)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(journal.path)
	if err != nil {
		return err
	}
	if err := windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH); err != nil {
		return err
	}
	cleanup = false
	return nil
}
