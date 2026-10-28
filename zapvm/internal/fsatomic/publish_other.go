//go:build !darwin && !linux && !windows

package fsatomic

import "errors"

func publish(source, destination string) error {
	return errors.New("atomic no-replace publication unsupported")
}
