//go:build !linux

package main

import "errors"

func mountPlan9(mountConfig) error {
	return errors.New("Plan9 VSOCK mount is only available in the Linux guest")
}
