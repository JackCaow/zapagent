package agent

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

// waitCgroupEmpty accepts only the kernel's explicit populated 0 observation.
// Missing, malformed and unreadable events are never treated as an empty group.
func waitCgroupEmpty(path string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		state, err := parseCgroupPopulated(data)
		if err != nil {
			return err
		}
		if !state {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("cgroup remained populated")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func parseCgroupPopulated(data []byte) (bool, error) {
	found := false
	populated := false
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.Fields(line)
		if len(parts) == 0 || parts[0] != "populated" {
			continue
		}
		if found || len(parts) != 2 || (parts[1] != "0" && parts[1] != "1") {
			return false, errors.New("invalid cgroup populated event")
		}
		found = true
		populated = parts[1] == "1"
	}
	if !found {
		return false, fmt.Errorf("cgroup populated event missing")
	}
	return populated, nil
}
