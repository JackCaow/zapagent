//go:build linux

package platform

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

type linuxSysctlReader func(string) ([]byte, error)

func validateLinuxVirtioFSDSandbox(read linuxSysctlReader) error {
	checks := []struct {
		path        string
		invalid     string
		remediation string
	}{
		{
			path:        "/proc/sys/kernel/unprivileged_userns_clone",
			invalid:     "0",
			remediation: "kernel.unprivileged_userns_clone must be enabled",
		},
		{
			path:        "/proc/sys/user/max_user_namespaces",
			invalid:     "0",
			remediation: "user.max_user_namespaces must be greater than zero",
		},
		{
			path:        "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
			invalid:     "1",
			remediation: "Ubuntu AppArmor restricts unprivileged user namespaces; install a userns-enabled profile for the signed virtiofsd path or set kernel.apparmor_restrict_unprivileged_userns=0",
		},
	}
	for _, check := range checks {
		data, err := read(check.path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return fmt.Errorf("read %s: %w", check.path, err)
		}
		if strings.TrimSpace(string(data)) == check.invalid {
			return errors.New(check.remediation)
		}
	}
	return nil
}
