package egress

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type AuditEvent struct {
	Host      string   `json:"host,omitempty"`
	Port      uint16   `json:"port,omitempty"`
	Addresses []string `json:"addresses,omitempty"`
	Allowed   bool     `json:"allowed"`
	Reason    string   `json:"reason,omitempty"`
}

type DialContextFunc func(context.Context, string, string) (net.Conn, error)

type Proxy struct {
	Policy         *Policy
	Resolver       Resolver
	DialContext    DialContextFunc
	Audit          func(AuditEvent)
	MaxConcurrent  int
	ConnectTimeout time.Duration
	IdleTimeout    time.Duration
}

func (p *Proxy) Handler() http.Handler {
	maximum := p.MaxConcurrent
	if maximum <= 0 {
		maximum = 32
	}
	semaphore := make(chan struct{}, maximum)
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		select {
		case semaphore <- struct{}{}:
			defer func() { <-semaphore }()
		default:
			http.Error(writer, "proxy concurrency limit reached", http.StatusServiceUnavailable)
			return
		}
		p.serveHTTP(writer, request)
	})
}

func (p *Proxy) Serve(listener net.Listener) error {
	server := &http.Server{
		Handler:           p.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    32 * 1024,
	}
	return server.Serve(listener)
}

func (p *Proxy) serveHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodConnect {
		p.audit(AuditEvent{Allowed: false, Reason: "only CONNECT is supported"})
		http.Error(writer, "only CONNECT is supported", http.StatusMethodNotAllowed)
		return
	}
	if p.Policy == nil {
		p.audit(AuditEvent{Allowed: false, Reason: "missing policy"})
		http.Error(writer, "proxy policy is unavailable", http.StatusServiceUnavailable)
		return
	}
	target, err := p.Policy.Resolve(request.Context(), p.Resolver, request.Host)
	if err != nil {
		p.audit(AuditEvent{Allowed: false, Reason: err.Error()})
		http.Error(writer, "target denied", http.StatusForbidden)
		return
	}
	addresses := make([]string, 0, len(target.Addresses))
	for _, address := range target.Addresses {
		addresses = append(addresses, address.String())
	}
	p.audit(AuditEvent{Host: target.Host, Port: target.Port, Addresses: addresses, Allowed: true})

	ctx := request.Context()
	if p.ConnectTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, p.ConnectTimeout)
		defer cancel()
	}
	upstream, err := p.dialResolved(ctx, target)
	if err != nil {
		http.Error(writer, "upstream unavailable", http.StatusBadGateway)
		return
	}
	hijacker, ok := writer.(http.Hijacker)
	if !ok {
		_ = upstream.Close()
		http.Error(writer, "CONNECT transport unavailable", http.StatusInternalServerError)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		_ = upstream.Close()
		return
	}
	if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		_ = client.Close()
		_ = upstream.Close()
		return
	}
	if err := buffered.Flush(); err != nil {
		_ = client.Close()
		_ = upstream.Close()
		return
	}
	p.tunnel(client, buffered.Reader, upstream)
}

func (p *Proxy) dialResolved(ctx context.Context, target Target) (net.Conn, error) {
	dial := p.DialContext
	if dial == nil {
		dialer := net.Dialer{}
		dial = dialer.DialContext
	}
	var failures []error
	for _, address := range target.Addresses {
		connection, err := dial(ctx, "tcp", net.JoinHostPort(address.String(), strconv.Itoa(int(target.Port))))
		if err == nil {
			return connection, nil
		}
		failures = append(failures, err)
	}
	return nil, fmt.Errorf("dial verified target: %w", errors.Join(failures...))
}

func (p *Proxy) tunnel(client net.Conn, clientReader *bufio.Reader, upstream net.Conn) {
	if p.IdleTimeout > 0 {
		client = &activityConn{Conn: client, timeout: p.IdleTimeout}
		upstream = &activityConn{Conn: upstream, timeout: p.IdleTimeout}
	}
	var once sync.Once
	closeBoth := func() {
		once.Do(func() {
			_ = client.Close()
			_ = upstream.Close()
		})
	}
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(upstream, clientReader)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(client, upstream)
		done <- struct{}{}
	}()
	<-done
	closeBoth()
	<-done
}

type activityConn struct {
	net.Conn
	timeout time.Duration
}

func (c *activityConn) Read(buffer []byte) (int, error) {
	_ = c.Conn.SetReadDeadline(time.Now().Add(c.timeout))
	return c.Conn.Read(buffer)
}

func (c *activityConn) Write(buffer []byte) (int, error) {
	_ = c.Conn.SetWriteDeadline(time.Now().Add(c.timeout))
	return c.Conn.Write(buffer)
}

func (p *Proxy) audit(event AuditEvent) {
	if p.Audit != nil {
		p.Audit(event)
	}
}
