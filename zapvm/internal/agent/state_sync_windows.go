//go:build windows

package agent

import "errors"

func flushState() error {
	return errors.New("state flush is only supported by the Linux guest agent")
}
