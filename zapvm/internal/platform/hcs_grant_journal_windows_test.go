//go:build windows

package platform

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestHCSGrantJournalPersistsGrantIntentBeforeCommit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hcs-grants.json")
	journal := &hcsGrantJournal{path: path, entries: make(map[string]hcsGrantJournalEntry)}
	if err := journal.Prepare("vm-one"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var prepared hcsGrantJournalDocument
	if err := json.Unmarshal(data, &prepared); err != nil {
		t.Fatal(err)
	}
	preparedEntry := prepared.Entries["vm-one"]
	if prepared.Version != 3 || preparedEntry.PendingPath != "" || preparedEntry.PendingDACL != "" ||
		preparedEntry.GrantedPaths == nil || len(preparedEntry.GrantedPaths) != 0 ||
		preparedEntry.GrantedDACLs == nil || len(preparedEntry.GrantedDACLs) != 0 {
		t.Fatalf("unexpected prepared journal: %+v", prepared)
	}
	grantPath := filepath.Join(t.TempDir(), "root.vhdx")
	if err := os.WriteFile(grantPath, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := journal.BeginGrant("vm-one", grantPath); err != nil {
		t.Fatal(err)
	}
	reloaded := &hcsGrantJournal{path: path, entries: make(map[string]hcsGrantJournalEntry)}
	if err := reloaded.load(); err != nil {
		t.Fatal(err)
	}
	pending := reloaded.entries["vm-one"]
	if pending.PendingPath != grantPath || pending.PendingDACL == "" || len(pending.GrantedPaths) != 0 {
		t.Fatalf("pending entry = %+v, want pending %s", pending, grantPath)
	}
	if err := journal.CommitGrant("vm-one", grantPath); err != nil {
		t.Fatal(err)
	}
	reloaded = &hcsGrantJournal{path: path, entries: make(map[string]hcsGrantJournalEntry)}
	if err := reloaded.load(); err != nil {
		t.Fatal(err)
	}
	committed := reloaded.entries["vm-one"]
	if committed.PendingPath != "" || committed.PendingDACL != "" || len(committed.GrantedPaths) != 1 ||
		committed.GrantedPaths[0] != grantPath || len(committed.GrantedDACLs) != 1 || committed.GrantedDACLs[0] == "" {
		t.Fatalf("committed entry = %+v, want grant %s", committed, grantPath)
	}
	if err := journal.Complete("vm-one"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("completed journal still exists: %v", err)
	}
}

func TestHCSGrantJournalLoadsVersionOneAsGrantedPaths(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hcs-grants.json")
	grantPath := filepath.Join(t.TempDir(), "legacy.vhdx")
	document := hcsGrantJournalDocumentV1{Version: 1, Entries: map[string][]string{"legacy-vm": {grantPath}}}
	data, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	journal := &hcsGrantJournal{path: path, entries: make(map[string]hcsGrantJournalEntry)}
	if err := journal.load(); err != nil {
		t.Fatal(err)
	}
	entry := journal.entries["legacy-vm"]
	if entry.PendingPath != "" || len(entry.GrantedPaths) != 1 || entry.GrantedPaths[0] != grantPath {
		t.Fatalf("legacy entry = %+v, want grant %s", entry, grantPath)
	}
}

func TestHCSGrantJournalLoadsVersionTwoWithoutBaselineDACLs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hcs-grants.json")
	grantPath := filepath.Join(t.TempDir(), "legacy-v2.vhdx")
	document := hcsGrantJournalDocument{
		Version: 2,
		Entries: map[string]hcsGrantJournalEntry{
			"legacy-vm": {GrantedPaths: []string{grantPath}},
		},
	}
	data, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	journal := &hcsGrantJournal{path: path, entries: make(map[string]hcsGrantJournalEntry)}
	if err := journal.load(); err != nil {
		t.Fatal(err)
	}
	entry := journal.entries["legacy-vm"]
	if len(entry.GrantedPaths) != 1 || entry.GrantedPaths[0] != grantPath || entry.GrantedDACLs != nil {
		t.Fatalf("version 2 entry = %+v", entry)
	}
}

func TestHCSGrantJournalRejectsDuplicateAndOverlappingIntent(t *testing.T) {
	journal := &hcsGrantJournal{path: filepath.Join(t.TempDir(), "hcs-grants.json"), entries: make(map[string]hcsGrantJournalEntry)}
	if err := journal.Prepare("vm-one"); err != nil {
		t.Fatal(err)
	}
	grantPath := filepath.Join(t.TempDir(), "root.vhdx")
	if err := os.WriteFile(grantPath, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := journal.BeginGrant("vm-one", grantPath); err != nil {
		t.Fatal(err)
	}
	if err := journal.BeginGrant("vm-one", filepath.Join(t.TempDir(), "other.vhdx")); err == nil {
		t.Fatal("second pending path was accepted")
	}
	if err := journal.CommitGrant("vm-one", grantPath); err != nil {
		t.Fatal(err)
	}
	if err := journal.BeginGrant("vm-one", grantPath); err == nil {
		t.Fatal("duplicate path was accepted")
	}
}

func TestHCSGrantJournalRejectsMismatchedCommit(t *testing.T) {
	journal := &hcsGrantJournal{path: filepath.Join(t.TempDir(), "hcs-grants.json"), entries: make(map[string]hcsGrantJournalEntry)}
	if err := journal.Prepare("vm-one"); err != nil {
		t.Fatal(err)
	}
	grantPath := filepath.Join(t.TempDir(), "root.vhdx")
	if err := os.WriteFile(grantPath, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := journal.BeginGrant("vm-one", grantPath); err != nil {
		t.Fatal(err)
	}
	if err := journal.CommitGrant("vm-one", filepath.Join(t.TempDir(), "other.vhdx")); err == nil {
		t.Fatal("mismatched path was committed")
	}
}

func TestHCSGrantJournalReusesBaselineForSharedPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shared-root.vhdx")
	if err := os.WriteFile(path, []byte("probe"), 0o600); err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid := user.User.Sid.String()
	baselineDescriptor, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;" + sid + ")")
	if err != nil {
		t.Fatal(err)
	}
	if err := hcsSetPathDACL(path, baselineDescriptor); err != nil {
		t.Fatal(err)
	}
	baseline, err := hcsReadPathDACL(path)
	if err != nil {
		t.Fatal(err)
	}
	journal := &hcsGrantJournal{path: filepath.Join(t.TempDir(), "hcs-grants.json"), entries: make(map[string]hcsGrantJournalEntry)}
	if err := journal.Prepare("vm-one"); err != nil {
		t.Fatal(err)
	}
	if err := journal.BeginGrant("vm-one", path); err != nil {
		t.Fatal(err)
	}
	if err := journal.CommitGrant("vm-one", path); err != nil {
		t.Fatal(err)
	}
	changedDescriptor, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;" + sid + ")(A;;FR;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	if err := hcsSetPathDACL(path, changedDescriptor); err != nil {
		t.Fatal(err)
	}
	changed, err := hcsReadPathDACL(path)
	if err != nil {
		t.Fatal(err)
	}
	if changed == baseline {
		t.Fatal("shared-path fixture did not change the current DACL")
	}
	if err := journal.Prepare("vm-two"); err != nil {
		t.Fatal(err)
	}
	if err := journal.BeginGrant("vm-two", path); err != nil {
		t.Fatal(err)
	}
	if got := journal.entries["vm-two"].PendingDACL; got != baseline {
		t.Fatalf("second VM baseline = %s, want original shared baseline %s", got, baseline)
	}
	journal.mu.Lock()
	referenced := journal.pathReferencedByOtherVMLocked("vm-one", path)
	journal.mu.Unlock()
	if !referenced {
		t.Fatal("shared path was not recognized as referenced by another VM")
	}
	journal.mu.Lock()
	err = journal.removeGrantPathLocked("vm-one", path)
	stillReferenced := journal.pathReferencedByOtherVMLocked("vm-two", path)
	journal.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if stillReferenced {
		t.Fatal("revoked VM path remained a shared-path reference")
	}
	reloaded := &hcsGrantJournal{path: journal.path, entries: make(map[string]hcsGrantJournalEntry)}
	if err := reloaded.load(); err != nil {
		t.Fatal(err)
	}
	if len(reloaded.entries["vm-one"].GrantedPaths) != 0 || reloaded.entries["vm-two"].PendingDACL != baseline {
		t.Fatalf("unexpected shared journal after path removal: %+v", reloaded.entries)
	}
}

func TestHCSRestorePathDACLRestoresExactControlBits(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dacl-control")
	if err := os.WriteFile(path, []byte("probe"), 0o600); err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid := user.User.Sid.String()
	baselineDescriptor, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;" + sid + ")")
	if err != nil {
		t.Fatal(err)
	}
	if err := hcsSetPathDACL(path, baselineDescriptor); err != nil {
		t.Fatal(err)
	}
	baseline, err := hcsReadPathDACL(path)
	if err != nil {
		t.Fatal(err)
	}
	changedDescriptor, err := windows.SecurityDescriptorFromString("D:PAI(A;;FA;;;" + sid + ")")
	if err != nil {
		t.Fatal(err)
	}
	if err := hcsSetPathDACL(path, changedDescriptor); err != nil {
		t.Fatal(err)
	}
	changed, err := hcsReadPathDACL(path)
	if err != nil {
		t.Fatal(err)
	}
	if changed == baseline {
		t.Fatal("test DACL control mutation did not change SDDL")
	}
	if err := hcsRestorePathDACL(path, baseline); err != nil {
		t.Fatal(err)
	}
	restored, err := hcsReadPathDACL(path)
	if err != nil {
		t.Fatal(err)
	}
	if restored != baseline {
		t.Fatalf("restored DACL = %s, want %s", restored, baseline)
	}
}

func TestHCSRestorePathDACLRefusesExternalACEMutation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dacl-external-change")
	if err := os.WriteFile(path, []byte("probe"), 0o600); err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid := user.User.Sid.String()
	baselineDescriptor, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;" + sid + ")")
	if err != nil {
		t.Fatal(err)
	}
	if err := hcsSetPathDACL(path, baselineDescriptor); err != nil {
		t.Fatal(err)
	}
	baseline, err := hcsReadPathDACL(path)
	if err != nil {
		t.Fatal(err)
	}
	changedDescriptor, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;" + sid + ")(A;;FR;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	if err := hcsSetPathDACL(path, changedDescriptor); err != nil {
		t.Fatal(err)
	}
	changed, err := hcsReadPathDACL(path)
	if err != nil {
		t.Fatal(err)
	}
	if changed == baseline {
		t.Fatal("test ACE mutation did not change DACL")
	}
	if err := hcsRestorePathDACL(path, baseline); err == nil {
		t.Fatal("external DACL mutation was overwritten")
	}
	after, err := hcsReadPathDACL(path)
	if err != nil {
		t.Fatal(err)
	}
	if after != changed {
		t.Fatalf("DACL after refused restore = %s, want %s", after, changed)
	}
}

func TestHCSGrantJournalRejectsMalformedVersionThreeDACLState(t *testing.T) {
	grantPath := filepath.Join(t.TempDir(), "root.vhdx")
	validDACL, err := hcsReadPathDACL(filepath.Dir(grantPath))
	if err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	differentDACL := "D:P(A;;FA;;;" + user.User.Sid.String() + ")"
	if differentDACL == validDACL {
		differentDACL = "D:P(A;;FR;;;WD)"
	}
	tests := []map[string]any{
		{"version": 3, "entries": map[string]any{"vm-one": map[string]any{"granted_paths": []string{}}}},
		{"version": 3, "entries": map[string]any{"vm-one": map[string]any{"granted_paths": []string{grantPath}, "granted_dacls": []string{}}}},
		{"version": 3, "entries": map[string]any{"vm-one": map[string]any{"pending_path": grantPath, "granted_paths": []string{}, "granted_dacls": []string{}}}},
		{"version": 3, "entries": map[string]any{"vm-one": map[string]any{"pending_dacl": validDACL, "granted_paths": []string{}, "granted_dacls": []string{}}}},
		{"version": 3, "entries": map[string]any{"vm-one": map[string]any{"granted_paths": []string{grantPath}, "granted_dacls": []string{"not-sddl"}}}},
		{"version": 3, "entries": map[string]any{
			"vm-one": map[string]any{"granted_paths": []string{grantPath}, "granted_dacls": []string{validDACL}},
			"vm-two": map[string]any{"granted_paths": []string{grantPath}, "granted_dacls": []string{differentDACL}},
		}},
	}
	for _, document := range tests {
		data, err := json.Marshal(document)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "hcs-grants.json")
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		journal := &hcsGrantJournal{path: path, entries: make(map[string]hcsGrantJournalEntry)}
		if err := journal.load(); err == nil {
			t.Fatalf("invalid version 3 journal was accepted: %s", data)
		}
	}
}

func TestHCSGrantJournalRejectsMissingEntries(t *testing.T) {
	for _, data := range []string{
		`{"version":2}`,
		`{"version":2,"entries":null}`,
		`{"version":2,"entries":{"vm-one":{}}}`,
		`{"version":2,"entries":{"vm-one":{"granted_paths":null}}}`,
	} {
		path := filepath.Join(t.TempDir(), "hcs-grants.json")
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		journal := &hcsGrantJournal{path: path, entries: make(map[string]hcsGrantJournalEntry)}
		if err := journal.load(); err == nil {
			t.Fatalf("invalid journal was accepted: %s", data)
		}
	}
}

func TestHCSGrantJournalRejectsInvalidVMIDOnPrepare(t *testing.T) {
	journal := &hcsGrantJournal{path: filepath.Join(t.TempDir(), "hcs-grants.json"), entries: make(map[string]hcsGrantJournalEntry)}
	for _, vmID := range []string{"", string(make([]byte, 65))} {
		if err := journal.Prepare(vmID); err == nil {
			t.Fatalf("invalid VM ID was accepted: %q", vmID)
		}
	}
}

func TestHCSVMAccountSIDDerivation(t *testing.T) {
	got, err := hcsVMAccountSIDString("82d88d94-f8c6-5a69-a0a8-f2cc27e06826")
	if err != nil {
		t.Fatal(err)
	}
	want := "S-1-5-83-1-2195230100-1516894406-3438454944-644407335"
	if got != want {
		t.Fatalf("VM account SID = %s, want %s", got, want)
	}
	for _, invalid := range []string{"", "82d88d94-f8c6-5a69-a0a8-f2cc27e0682z", "82d88d94-f8c6-5a69-a0a8-f2cc27e068260"} {
		if _, err := hcsVMAccountSIDString(invalid); err == nil {
			t.Fatalf("invalid VM GUID was accepted: %q", invalid)
		}
	}
}

func TestHCSPathHasExactVMAccountACE(t *testing.T) {
	path := filepath.Join(t.TempDir(), "acl-probe")
	if err := os.WriteFile(path, []byte("probe"), 0o600); err != nil {
		t.Fatal(err)
	}
	vmID := "82d88d94-f8c6-5a69-a0a8-f2cc27e06826"
	hasAccess, err := hcsPathHasVMAccess(vmID, path)
	if err != nil {
		t.Fatal(err)
	}
	if hasAccess {
		t.Fatal("fresh test file unexpectedly has the VM account ACE")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	vmSID, err := hcsVMAccountSIDString(vmID)
	if err != nil {
		t.Fatal(err)
	}
	descriptor, err := windows.SecurityDescriptorFromString(
		"D:P(A;;FA;;;" + user.User.Sid.String() + ")(A;;FA;;;" + vmSID + ")",
	)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(
		path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil,
	); err != nil {
		t.Fatal(err)
	}
	hasAccess, err = hcsPathHasVMAccess(vmID, path)
	if err != nil {
		t.Fatal(err)
	}
	if !hasAccess {
		t.Fatal("exact VM account ACE was not detected")
	}
	otherAccess, err := hcsPathHasVMAccess("00000000-0000-0000-0000-000000000001", path)
	if err != nil {
		t.Fatal(err)
	}
	if otherAccess {
		t.Fatal("an unrelated VM account ACE matched")
	}
}
