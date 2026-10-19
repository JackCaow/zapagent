//go:build !windows

package platform

import "errors"

func WindowsServiceCommand(_ []string) error {
	return errors.New("Windows service management is only available on Windows")
}
