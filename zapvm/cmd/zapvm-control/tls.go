package main

import (
	"crypto/tls"
	"net"
)

func tlsNewListener(listener net.Listener, config *tls.Config) net.Listener {
	return tls.NewListener(listener, config)
}
