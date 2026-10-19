//go:build linux

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/mdlayher/vsock"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "zapvm-proxy-bridge:", err)
		os.Exit(1)
	}
}

func run() error {
	listenAddress := flag.String("listen", "127.0.0.1:3128", "guest TCP proxy address")
	hostPort := flag.Uint("host-port", 19091, "Host VSOCK proxy port")
	maxConcurrent := flag.Int("max-concurrent", 64, "maximum simultaneous tunnels")
	flag.Parse()
	if *hostPort == 0 || *hostPort > 65535 || *maxConcurrent <= 0 {
		return errors.New("invalid host port or concurrency")
	}
	listener, err := net.Listen("tcp4", *listenAddress)
	if err != nil {
		return err
	}
	defer listener.Close()
	log.Printf("listening on %s and forwarding to Host VSOCK port %d", listener.Addr(), *hostPort)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	semaphore := make(chan struct{}, *maxConcurrent)
	for {
		connection, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		select {
		case semaphore <- struct{}{}:
			go func() {
				defer func() { <-semaphore }()
				bridge(connection, uint32(*hostPort))
			}()
		default:
			_ = connection.Close()
		}
	}
}

func bridge(client net.Conn, port uint32) {
	defer client.Close()
	host, err := vsock.Dial(vsock.Host, port, nil)
	if err != nil {
		log.Printf("dial Host VSOCK port %d: %v", port, err)
		return
	}
	defer host.Close()
	done := make(chan struct{}, 2)
	var once sync.Once
	copyStream := func(destination io.Writer, source io.Reader) {
		_, _ = io.Copy(destination, source)
		once.Do(func() {
			_ = client.Close()
			_ = host.Close()
		})
		done <- struct{}{}
	}
	go copyStream(host, client)
	go copyStream(client, host)
	<-done
	<-done
}
