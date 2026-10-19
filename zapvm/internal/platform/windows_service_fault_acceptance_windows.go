//go:build windows && acceptance_fault_injection

package platform

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"golang.org/x/sys/windows"
)

const windowsServiceFaultInjectionEnabled = true

const (
	windowsServiceFaultConfigName   = "acceptance-fault.json"
	windowsServiceFaultConsumedName = "acceptance-fault-consumed.json"
	windowsServiceFaultMarkerName   = "acceptance-fault-hit.json"
)

var windowsServiceFaultNoncePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

type windowsServiceFaultDocument struct {
	Version    int    `json:"version"`
	Point      string `json:"point"`
	GrantIndex int    `json:"grant_index"`
	Nonce      string `json:"nonce"`
}

func windowsServiceFaultPoint(point string, grantIndex int) error {
	programData := os.Getenv("ProgramData")
	if programData == "" {
		return errors.New("ProgramData is not set for acceptance fault injection")
	}
	directory := filepath.Join(programData, "zapVM")
	configPath := filepath.Join(directory, windowsServiceFaultConfigName)
	data, err := os.ReadFile(configPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read acceptance fault injection config: %w", err)
	}
	if len(data) == 0 || len(data) > 4096 {
		return fmt.Errorf("acceptance fault injection config size %d is outside 1-4096 bytes", len(data))
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var document windowsServiceFaultDocument
	if err := decoder.Decode(&document); err != nil {
		return fmt.Errorf("decode acceptance fault injection config: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("trailing JSON")
		}
		return fmt.Errorf("decode acceptance fault injection config: %w", err)
	}
	if document.Version != 1 || !windowsServiceFaultNoncePattern.MatchString(document.Nonce) {
		return errors.New("invalid acceptance fault injection version or nonce")
	}
	validPoint := false
	switch document.Point {
	case "after-journal-prepare", "after-hcs-create", "after-hcs-start":
		validPoint = document.GrantIndex == -1
	case "after-grant-intent", "after-grant-call", "after-grant", "after-recovery-revoke":
		validPoint = document.GrantIndex >= 0 && document.GrantIndex < 8
	}
	if !validPoint {
		return errors.New("invalid acceptance fault injection point or grant index")
	}
	if document.Point != point || document.GrantIndex != grantIndex {
		return nil
	}
	consumedPath := filepath.Join(directory, windowsServiceFaultConsumedName)
	configUTF16, err := windows.UTF16PtrFromString(configPath)
	if err != nil {
		return fmt.Errorf("encode acceptance fault injection config path: %w", err)
	}
	consumedUTF16, err := windows.UTF16PtrFromString(consumedPath)
	if err != nil {
		return fmt.Errorf("encode consumed acceptance fault injection path: %w", err)
	}
	if err := windows.MoveFileEx(configUTF16, consumedUTF16, windows.MOVEFILE_WRITE_THROUGH); err != nil {
		return fmt.Errorf("consume acceptance fault injection config: %w", err)
	}
	markerPath := filepath.Join(directory, windowsServiceFaultMarkerName)
	marker, err := os.OpenFile(markerPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create acceptance fault injection marker: %w", err)
	}
	markerData, err := json.Marshal(document)
	if err == nil {
		_, err = marker.Write(markerData)
	}
	if err == nil {
		err = marker.Sync()
	}
	closeErr := marker.Close()
	if err != nil || closeErr != nil {
		return fmt.Errorf("persist acceptance fault injection marker: %w", errors.Join(err, closeErr))
	}
	if err := windows.TerminateProcess(windows.CurrentProcess(), 197); err != nil {
		return fmt.Errorf("terminate acceptance fault service: %w", err)
	}
	return errors.New("TerminateProcess unexpectedly returned")
}
