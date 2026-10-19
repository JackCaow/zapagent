//go:build !linux

package main

import (
	"fmt"
	"net"
)

func listenVSock(port uint32) (net.Listener, error) {
	return nil, fmt.Errorf("vsock guest listener is only available on Linux (port %d)", port)
}

func dialVSock(cid, port uint32) (net.Conn, error) {
	return nil, fmt.Errorf("vsock guest dialer is only available on Linux (cid %d port %d)", cid, port)
}

func configuredVSockConnectCID() (uint32, error) { return 0, nil }
