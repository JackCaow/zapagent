package protocol

import (
	"bytes"
	"errors"
	"net"
	"testing"
)

func TestMutualAuthentication(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()
	secret := bytes.Repeat([]byte{0x42}, 32)
	serverErr := make(chan error, 1)
	go func() {
		serverErr <- AuthenticateServer(NewCodec(serverConn, serverConn), secret)
	}()
	if err := AuthenticateClient(NewCodec(clientConn, clientConn), secret); err != nil {
		t.Fatal(err)
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}
}

func TestMutualAuthenticationRejectsWrongSecret(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()
	serverErr := make(chan error, 1)
	go func() {
		serverErr <- AuthenticateServer(NewCodec(serverConn, serverConn), bytes.Repeat([]byte{1}, 32))
		_ = serverConn.Close()
	}()
	err := AuthenticateClient(NewCodec(clientConn, clientConn), bytes.Repeat([]byte{2}, 32))
	if err == nil {
		t.Fatal("client unexpectedly authenticated")
	}
	if err := <-serverErr; !errors.Is(err, ErrAuthentication) {
		t.Fatalf("server got %v, want ErrAuthentication", err)
	}
}
