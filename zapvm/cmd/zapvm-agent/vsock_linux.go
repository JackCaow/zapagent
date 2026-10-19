//go:build linux

package main

import (
	"net"
	"os"

	"github.com/mdlayher/vsock"
)

func listenVSock(port uint32) (net.Listener, error) {
	return vsock.Listen(port, nil)
}

func dialVSock(cid, port uint32) (net.Conn, error) {
	return vsock.Dial(cid, port, nil)
}

func configuredVSockConnectCID() (uint32, error) {
	data, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return 0, nil
	}
	return parseVSockConnectCID(string(data))
}
