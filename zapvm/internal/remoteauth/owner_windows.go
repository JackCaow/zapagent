//go:build windows

package remoteauth

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var privilegedWindowsSIDs = []string{"S-1-5-18", "S-1-5-32-544"}

func validateOwnerOnlyDirectory(path string, _ os.FileInfo) error {
	return validateWindowsOwnerOnlyACL(path)
}

func validateOwnerOnlyFile(path string, _ os.FileInfo) error {
	return validateWindowsOwnerOnlyACL(path)
}

func validateAuditWritable(_ string, _ os.FileInfo) error {
	return nil
}

func validateWindowsOwnerOnlyACL(path string) error {
	allowed, err := currentWindowsAuthoritySIDs()
	if err != nil {
		return err
	}
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("read Windows owner/DACL: %w", err)
	}
	owner, _, err := descriptor.Owner()
	if err != nil || owner == nil || !owner.IsValid() {
		return errors.New("Windows authority file has no valid owner")
	}
	if _, ok := allowed[strings.ToUpper(owner.String())]; !ok {
		return errors.New("Windows authority file owner is not the current user, LocalSystem, or Administrators")
	}
	dacl, _, err := descriptor.DACL()
	if err != nil || dacl == nil {
		return errors.New("Windows authority file has no bounded DACL")
	}
	for index := uint16(0); index < dacl.AceCount; index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, uint32(index), &ace); err != nil || ace == nil {
			return fmt.Errorf("read Windows authority ACE %d", index)
		}
		switch ace.Header.AceType {
		case windows.ACCESS_DENIED_ACE_TYPE:
			continue
		case windows.ACCESS_ALLOWED_ACE_TYPE:
			sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
			if sid == nil || !sid.IsValid() {
				return fmt.Errorf("Windows authority ACE %d has an invalid SID", index)
			}
			if _, ok := allowed[strings.ToUpper(sid.String())]; !ok {
				return fmt.Errorf("Windows authority DACL grants access to unexpected SID %s", sid.String())
			}
		default:
			return fmt.Errorf("Windows authority DACL contains unsupported ACE type %d", ace.Header.AceType)
		}
	}
	return nil
}

func currentWindowsAuthoritySIDs() (map[string]struct{}, error) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		return nil, err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil || !user.User.Sid.IsValid() {
		return nil, errors.New("current Windows token has no valid user SID")
	}
	allowed := map[string]struct{}{strings.ToUpper(user.User.Sid.String()): {}}
	for _, sid := range privilegedWindowsSIDs {
		allowed[strings.ToUpper(sid)] = struct{}{}
	}
	return allowed, nil
}
