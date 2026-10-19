//go:build linux

package platform

import (
	"errors"
	"os"
	"strings"
	"testing"
)

func TestValidateLinuxVirtioFSDSandbox(t *testing.T) {
	base := map[string]string{
		"/proc/sys/kernel/unprivileged_userns_clone":             "1\n",
		"/proc/sys/user/max_user_namespaces":                     "1024\n",
		"/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0\n",
	}
	reader := func(values map[string]string) linuxSysctlReader {
		return func(path string) ([]byte, error) {
			value, ok := values[path]
			if !ok {
				return nil, os.ErrNotExist
			}
			return []byte(value), nil
		}
	}
	if err := validateLinuxVirtioFSDSandbox(reader(base)); err != nil {
		t.Fatalf("valid sandbox prerequisites were rejected: %v", err)
	}

	for name, mutation := range map[string]struct {
		path  string
		value string
		want  string
	}{
		"disabled user namespaces": {"/proc/sys/kernel/unprivileged_userns_clone", "0", "unprivileged_userns_clone"},
		"zero namespace quota":     {"/proc/sys/user/max_user_namespaces", "0", "max_user_namespaces"},
		"AppArmor restriction":     {"/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "1", "AppArmor"},
	} {
		t.Run(name, func(t *testing.T) {
			values := make(map[string]string, len(base))
			for path, value := range base {
				values[path] = value
			}
			values[mutation.path] = mutation.value
			err := validateLinuxVirtioFSDSandbox(reader(values))
			if err == nil || !strings.Contains(err.Error(), mutation.want) {
				t.Fatalf("got %v, want an error containing %q", err, mutation.want)
			}
		})
	}

	readFailure := errors.New("read failure")
	err := validateLinuxVirtioFSDSandbox(func(string) ([]byte, error) { return nil, readFailure })
	if !errors.Is(err, readFailure) {
		t.Fatalf("got %v, want wrapped read failure", err)
	}
}
