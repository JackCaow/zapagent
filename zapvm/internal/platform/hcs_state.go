package platform

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func parseHCSStopped(document string) (bool, error) {
	if len(document) == 0 || len(document) > 1<<20 {
		return false, errors.New("HCS properties document is empty or exceeds 1 MiB")
	}
	var properties struct {
		State   string `json:"State"`
		Stopped bool   `json:"Stopped"`
	}
	if err := json.Unmarshal([]byte(document), &properties); err != nil {
		return false, fmt.Errorf("decode HCS VM properties: %w", err)
	}
	if properties.Stopped {
		return true, nil
	}
	switch strings.ToLower(strings.TrimSpace(properties.State)) {
	case "stopped":
		return true, nil
	case "created", "starting", "running", "paused", "pausing", "resuming", "stopping":
		return false, nil
	case "":
		return false, errors.New("HCS VM properties are missing State")
	default:
		return false, fmt.Errorf("unrecognized HCS VM state %q", properties.State)
	}
}
