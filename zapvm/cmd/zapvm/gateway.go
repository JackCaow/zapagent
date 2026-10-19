package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"zapvm/internal/daemonrpc"
	"zapvm/internal/localipc"
	"zapvm/internal/remoteauth"
)

type gatewayServer struct {
	ctx      context.Context
	tls      *tls.Config
	policy   *remoteauth.Policy
	audit    *remoteauth.AuditLog
	endpoint string
}

type gatewayScope struct {
	action        string
	computerID    string
	taskID        string
	allowedIDs    map[string]struct{}
	credentialIDs []string
}

func runGateway(args []string) error {
	if len(args) == 0 {
		return errors.New("gateway requires serve, tunnel, run, or validate")
	}
	switch args[0] {
	case "serve":
		return runGatewayServe(args[1:])
	case "tunnel":
		return runGatewayTunnel(args[1:])
	case "run":
		return runGatewayConfigured(args[1:], false)
	case "validate":
		return runGatewayConfigured(args[1:], true)
	default:
		return fmt.Errorf("unknown gateway command %q", args[0])
	}
}

type gatewayValidation struct {
	SchemaVersion int    `json:"schema_version"`
	Mode          string `json:"mode"`
	NodeURI       string `json:"node_uri"`
	Principal     string `json:"principal,omitempty"`
}

func runGatewayConfigured(args []string, validateOnly bool) error {
	name := "gateway run"
	if validateOnly {
		name = "gateway validate"
	}
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	configPath := flags.String("config", "", "owner-only gateway JSON configuration")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *configPath == "" {
		return fmt.Errorf("%s requires --config and accepts no positional arguments", name)
	}
	config, err := remoteauth.LoadGatewayConfig(*configPath)
	if err != nil {
		return err
	}
	if validateOnly {
		return validateGatewayConfig(config)
	}
	mode, configuredArgs := gatewayConfigArguments(config)
	if mode == remoteauth.GatewayModeServe {
		return runGatewayServe(configuredArgs)
	}
	return runGatewayTunnel(configuredArgs)
}

func gatewayConfigArguments(config remoteauth.GatewayConfig) (string, []string) {
	if config.Mode == remoteauth.GatewayModeServe {
		serve := config.Serve
		arguments := []string{
			"--listen", serve.Listen,
			"--client-ca", serve.ClientCA,
			"--certificate", serve.Certificate,
			"--private-key", serve.PrivateKey,
			"--policy", serve.Policy,
			"--audit-log", serve.AuditLog,
		}
		if serve.DaemonEndpoint != "" {
			arguments = append(arguments, "--daemon-endpoint", serve.DaemonEndpoint)
		}
		return config.Mode, arguments
	}
	tunnel := config.Tunnel
	arguments := []string{
		"--remote", tunnel.Remote,
		"--server-ca", tunnel.ServerCA,
		"--certificate", tunnel.Certificate,
		"--private-key", tunnel.PrivateKey,
		"--node-uri", tunnel.NodeURI,
	}
	if tunnel.Endpoint != "" {
		arguments = append(arguments, "--endpoint", tunnel.Endpoint)
	}
	return config.Mode, arguments
}

func validateGatewayConfig(config remoteauth.GatewayConfig) error {
	if config.Mode == remoteauth.GatewayModeServe {
		serve := config.Serve
		policy, err := remoteauth.LoadPolicy(serve.Policy)
		if err != nil {
			return err
		}
		if _, err := remoteauth.LoadServerTLS(serve.ClientCA, serve.Certificate, serve.PrivateKey, policy); err != nil {
			return err
		}
		if err := remoteauth.ValidateAuditTarget(serve.AuditLog, policy.NodeID()); err != nil {
			return err
		}
		return printJSON(gatewayValidation{SchemaVersion: 1, Mode: config.Mode, NodeURI: policy.NodeURI()})
	}
	tunnel := config.Tunnel
	tlsConfig, err := remoteauth.LoadClientTLS(tunnel.ServerCA, tunnel.Certificate, tunnel.PrivateKey, tunnel.NodeURI)
	if err != nil {
		return err
	}
	principal := tlsConfig.Certificates[0].Leaf.URIs[0].String()
	return printJSON(gatewayValidation{SchemaVersion: 1, Mode: config.Mode, NodeURI: tunnel.NodeURI, Principal: principal})
}

func runGatewayTunnel(args []string) error {
	flags := flag.NewFlagSet("gateway tunnel", flag.ContinueOnError)
	endpoint := flags.String("endpoint", "", "owner-only local endpoint exposed to Agent clients (default daemon endpoint)")
	remoteAddress := flags.String("remote", "", "remote gateway TCP address")
	caPath := flags.String("server-ca", "", "PEM CA bundle for the remote server certificate")
	certificatePath := flags.String("certificate", "", "PEM client certificate with a client SPIFFE URI")
	keyPath := flags.String("private-key", "", "owner-only PEM client private key")
	nodeURI := flags.String("node-uri", "", "exact SPIFFE URI expected from the remote Host node")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("gateway tunnel does not accept positional arguments")
	}
	if *remoteAddress == "" || *caPath == "" || *certificatePath == "" || *keyPath == "" || *nodeURI == "" {
		return errors.New("gateway tunnel requires --remote, --server-ca, --certificate, --private-key, and --node-uri")
	}
	var err error
	if *endpoint == "" {
		*endpoint, err = localipc.DefaultEndpoint()
		if err != nil {
			return err
		}
	}
	for _, path := range []*string{caPath, certificatePath, keyPath} {
		if *path, err = filepath.Abs(*path); err != nil {
			return err
		}
	}
	tlsConfig, err := remoteauth.LoadClientTLS(*caPath, *certificatePath, *keyPath, *nodeURI)
	if err != nil {
		return err
	}
	listener, err := localipc.ListenRecovering(*endpoint)
	if err != nil {
		return err
	}
	defer listener.Close()
	signalCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	fmt.Fprintf(os.Stderr, "zapVM gateway tunnel listening on %s for %s\n", *endpoint, *nodeURI)
	return serveGatewayTunnel(signalCtx, listener, *remoteAddress, tlsConfig)
}

func serveGatewayTunnel(parentCtx context.Context, listener net.Listener, remoteAddress string, tlsConfig *tls.Config) error {
	ctx, cancel := context.WithCancel(parentCtx)
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	semaphore := make(chan struct{}, 64)
	var wait sync.WaitGroup
	defer wait.Wait()
	defer cancel()
	for {
		localConnection, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		select {
		case semaphore <- struct{}{}:
			wait.Add(1)
			go func() {
				defer wait.Done()
				defer func() { <-semaphore }()
				proxyGatewayTunnel(ctx, localConnection, remoteAddress, tlsConfig)
			}()
		default:
			_ = localConnection.Close()
		}
	}
}

func proxyGatewayTunnel(ctx context.Context, localConnection net.Conn, remoteAddress string, tlsConfig *tls.Config) {
	defer localConnection.Close()
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	rawConnection, err := (&net.Dialer{}).DialContext(dialCtx, "tcp", remoteAddress)
	if err != nil {
		cancel()
		return
	}
	remoteConnection := tls.Client(rawConnection, tlsConfig.Clone())
	if err := remoteConnection.HandshakeContext(dialCtx); err != nil {
		cancel()
		_ = rawConnection.Close()
		return
	}
	cancel()
	defer remoteConnection.Close()
	stopLocal := context.AfterFunc(ctx, func() { _ = localConnection.Close() })
	defer stopLocal()
	stopRemote := context.AfterFunc(ctx, func() { _ = remoteConnection.Close() })
	defer stopRemote()
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(remoteConnection, localConnection)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(localConnection, remoteConnection)
		done <- struct{}{}
	}()
	<-done
	_ = localConnection.Close()
	_ = remoteConnection.Close()
	<-done
}

func runGatewayServe(args []string) error {
	flags := flag.NewFlagSet("gateway serve", flag.ContinueOnError)
	listenAddress := flags.String("listen", "", "TCP address for the remote mTLS gateway")
	endpoint := flags.String("daemon-endpoint", "", "owner-only local daemon endpoint")
	caPath := flags.String("client-ca", "", "PEM CA bundle for remote client certificates")
	certificatePath := flags.String("certificate", "", "PEM server certificate with the configured node SPIFFE URI")
	keyPath := flags.String("private-key", "", "owner-only PEM server private key")
	policyPath := flags.String("policy", "", "owner-only remote authorization policy JSON")
	auditPath := flags.String("audit-log", "", "owner-only append-only remote audit JSONL")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("gateway serve does not accept positional arguments")
	}
	if *listenAddress == "" || *caPath == "" || *certificatePath == "" || *keyPath == "" || *policyPath == "" || *auditPath == "" {
		return errors.New("gateway serve requires --listen, --client-ca, --certificate, --private-key, --policy, and --audit-log")
	}
	var err error
	for _, path := range []*string{caPath, certificatePath, keyPath, policyPath, auditPath} {
		if *path, err = filepath.Abs(*path); err != nil {
			return err
		}
	}
	policy, err := remoteauth.LoadPolicy(*policyPath)
	if err != nil {
		return err
	}
	tlsConfig, err := remoteauth.LoadServerTLS(*caPath, *certificatePath, *keyPath, policy)
	if err != nil {
		return err
	}
	audit, err := remoteauth.OpenAudit(*auditPath, policy.NodeID())
	if err != nil {
		return err
	}
	defer audit.Close()
	listener, err := net.Listen("tcp", *listenAddress)
	if err != nil {
		return err
	}
	defer listener.Close()
	signalCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	server := &gatewayServer{ctx: signalCtx, tls: tlsConfig, policy: policy, audit: audit, endpoint: *endpoint}
	fmt.Fprintf(os.Stderr, "zapVM remote gateway listening on %s as %s\n", listener.Addr(), policy.NodeURI())
	return server.serve(listener)
}

func (server *gatewayServer) serve(listener net.Listener) error {
	serveCtx, cancel := context.WithCancel(server.ctx)
	go func() {
		<-serveCtx.Done()
		_ = listener.Close()
	}()
	semaphore := make(chan struct{}, 64)
	var wait sync.WaitGroup
	defer wait.Wait()
	defer cancel()
	for {
		connection, err := listener.Accept()
		if err != nil {
			if serveCtx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		select {
		case semaphore <- struct{}{}:
			wait.Add(1)
			go func(connection net.Conn) {
				defer wait.Done()
				defer func() { <-semaphore }()
				server.handleTLS(serveCtx, connection)
			}(connection)
		default:
			_ = connection.Close()
		}
	}
}

func (server *gatewayServer) handleTLS(ctx context.Context, connection net.Conn) {
	defer connection.Close()
	stopClose := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stopClose()
	tlsConnection := tls.Server(connection, server.tls)
	handshakeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	identity, err := remoteauth.ClientIdentity(tlsConnection, server.policy, handshakeCtx)
	cancel()
	if err != nil {
		return
	}
	_ = tlsConnection.SetDeadline(time.Now().Add(10 * time.Second))
	codec := daemonrpc.NewCodec(tlsConnection, tlsConnection)
	envelope, err := codec.Read()
	if err != nil {
		return
	}
	_ = tlsConnection.SetDeadline(time.Time{})
	server.handleRequest(codec, identity, envelope)
}

func (server *gatewayServer) handleRequest(codec *daemonrpc.Codec, identity remoteauth.Identity, envelope daemonrpc.Envelope) {
	scope, err := server.authorize(identity.URI, envelope)
	if err != nil {
		action := scope.action
		if action == "" {
			action = "request.unsupported"
		}
		_ = server.audit.Append(remoteauth.AuditEvent{
			RequestID: envelope.ID, Principal: identity.URI, TenantID: identity.TenantID, ProjectID: identity.ProjectID,
			Action: action, ComputerID: scope.computerID, TaskID: scope.taskID, Decision: "deny", Outcome: "rejected",
		})
		writeGatewayError(codec, envelope.ID, errors.New("remote access denied"))
		return
	}
	auditEvent := remoteauth.AuditEvent{
		RequestID: envelope.ID, Principal: identity.URI, TenantID: identity.TenantID, ProjectID: identity.ProjectID,
		Action: scope.action, ComputerID: scope.computerID, TaskID: scope.taskID, Decision: "allow", Outcome: "authorized",
	}
	if err := server.audit.Append(auditEvent); err != nil {
		writeGatewayError(codec, envelope.ID, errors.New("remote audit unavailable"))
		return
	}
	outcome := "transport_error"
	defer func() {
		auditEvent.Outcome = outcome
		_ = server.audit.Append(auditEvent)
	}()
	localConnection, localCodec, err := dialDaemon(server.endpoint)
	if err != nil {
		writeGatewayError(codec, envelope.ID, errors.New("local daemon unavailable"))
		return
	}
	defer localConnection.Close()
	if err := localCodec.Write(envelope); err != nil {
		writeGatewayError(codec, envelope.ID, errors.New("local daemon unavailable"))
		return
	}
	wroteResponse := false
	for {
		response, readErr := localCodec.Read()
		if errors.Is(readErr, io.EOF) {
			if wroteResponse && outcome == "transport_error" {
				outcome = "success"
			}
			return
		}
		if readErr != nil {
			outcome = "transport_error"
			if !wroteResponse {
				writeGatewayError(codec, envelope.ID, errors.New("local daemon unavailable"))
			}
			return
		}
		if response.ID != envelope.ID {
			writeGatewayError(codec, envelope.ID, errors.New("local daemon response mismatch"))
			return
		}
		response, err = filterGatewayResponse(envelope.Type, response, scope.allowedIDs)
		if err != nil {
			writeGatewayError(codec, envelope.ID, errors.New("local daemon response invalid"))
			return
		}
		if err := codec.Write(response); err != nil {
			return
		}
		wroteResponse = true
		if response.Type == daemonrpc.TypeError {
			outcome = "daemon_error"
		} else {
			outcome = "success"
		}
	}
}

func (server *gatewayServer) authorize(principal string, envelope daemonrpc.Envelope) (gatewayScope, error) {
	var scope gatewayScope
	switch envelope.Type {
	case daemonrpc.TypeComputerList:
		if err := daemonrpc.DecodeEmpty(envelope.Payload); err != nil {
			return scope, err
		}
		scope.action = daemonrpc.TypeComputerList
	case daemonrpc.TypeComputerInspect, daemonrpc.TypeComputerStart, daemonrpc.TypeComputerStop:
		request, err := daemonrpc.DecodeComputerReference(envelope.Payload)
		if err != nil {
			return scope, err
		}
		scope.action, scope.computerID = envelope.Type, request.ID
	case daemonrpc.TypeComputerExec:
		request, err := daemonrpc.DecodeComputerExec(envelope.Payload)
		if err != nil {
			return scope, err
		}
		scope.action, scope.computerID, scope.credentialIDs = envelope.Type, request.ID, request.Command.CredentialIDs
	case daemonrpc.TypeComputerTaskSubmit:
		request, err := daemonrpc.DecodeComputerTaskSubmit(envelope.Payload)
		if err != nil {
			return scope, err
		}
		scope.action, scope.computerID, scope.taskID, scope.credentialIDs = envelope.Type, request.ComputerID, request.ID, request.Command.CredentialIDs
	case daemonrpc.TypeComputerTaskList:
		request, err := daemonrpc.DecodeComputerTaskList(envelope.Payload)
		if err != nil {
			return scope, err
		}
		scope.action, scope.computerID = envelope.Type, request.ComputerID
	case daemonrpc.TypeComputerTaskInspect, daemonrpc.TypeComputerTaskCancel:
		request, err := daemonrpc.DecodeComputerTaskReference(envelope.Payload)
		if err != nil {
			return scope, err
		}
		scope.action, scope.taskID = envelope.Type, request.ID
	case daemonrpc.TypeComputerTaskAttach:
		request, err := daemonrpc.DecodeComputerTaskAttach(envelope.Payload)
		if err != nil {
			return scope, err
		}
		scope.action, scope.taskID = envelope.Type, request.ID
	case daemonrpc.TypeComputerTaskRetry:
		request, err := daemonrpc.DecodeComputerTaskRetry(envelope.Payload)
		if err != nil {
			return scope, err
		}
		scope.action, scope.taskID, scope.credentialIDs = envelope.Type, request.SourceID, request.Command.CredentialIDs
	default:
		return scope, errors.New("remote request type is not exposed")
	}

	if scope.taskID != "" && scope.computerID == "" {
		response, err := daemonRequest(server.endpoint, daemonrpc.TypeComputerTaskInspect, daemonrpc.ComputerTaskReference{ID: scope.taskID})
		if err != nil || response.Type != daemonrpc.TypeComputerTask {
			return scope, errors.New("remote access denied")
		}
		task, err := daemonrpc.DecodePayload[daemonrpc.ComputerTask](response.Payload)
		if err != nil {
			return scope, errors.New("remote access denied")
		}
		scope.computerID = task.ComputerID
	}
	if scope.computerID == "" {
		allowed, err := server.policy.ComputerIDs(principal, scope.action)
		if err != nil {
			return scope, err
		}
		scope.allowedIDs = make(map[string]struct{}, len(allowed))
		for _, id := range allowed {
			scope.allowedIDs[id] = struct{}{}
		}
		return scope, nil
	}
	if err := server.policy.Authorize(principal, scope.action, scope.computerID, scope.credentialIDs); err != nil {
		return scope, err
	}
	if scope.action == daemonrpc.TypeComputerTaskList {
		scope.allowedIDs = map[string]struct{}{scope.computerID: {}}
	}
	return scope, nil
}

func filterGatewayResponse(requestType string, response daemonrpc.Envelope, allowed map[string]struct{}) (daemonrpc.Envelope, error) {
	if response.Type == daemonrpc.TypeError {
		return daemonrpc.NewEnvelope(response.ID, daemonrpc.TypeError, daemonrpc.Error{Message: "remote daemon request failed"})
	}
	if response.Type == daemonrpc.TypeComputer || response.Type == daemonrpc.TypeComputerStopped {
		computer, err := daemonrpc.DecodePayload[daemonrpc.ComputerSpec](response.Payload)
		if err != nil {
			return daemonrpc.Envelope{}, err
		}
		computer.Workspace = ""
		return daemonrpc.NewEnvelope(response.ID, response.Type, computer)
	}
	if allowed == nil {
		return response, nil
	}
	switch requestType {
	case daemonrpc.TypeComputerList:
		if response.Type != daemonrpc.TypeComputers {
			return daemonrpc.Envelope{}, errors.New("unexpected Computer list response")
		}
		list, err := daemonrpc.DecodePayload[daemonrpc.ComputerList](response.Payload)
		if err != nil {
			return daemonrpc.Envelope{}, err
		}
		filtered := list.Computers[:0]
		for _, computer := range list.Computers {
			if _, ok := allowed[computer.ID]; ok {
				computer.Workspace = ""
				filtered = append(filtered, computer)
			}
		}
		return daemonrpc.NewEnvelope(response.ID, response.Type, daemonrpc.ComputerList{Computers: filtered})
	case daemonrpc.TypeComputerTaskList:
		if response.Type != daemonrpc.TypeComputerTasks {
			return daemonrpc.Envelope{}, errors.New("unexpected Task list response")
		}
		list, err := daemonrpc.DecodePayload[daemonrpc.ComputerTaskList](response.Payload)
		if err != nil {
			return daemonrpc.Envelope{}, err
		}
		filtered := list.Tasks[:0]
		for _, task := range list.Tasks {
			if _, ok := allowed[task.ComputerID]; ok {
				filtered = append(filtered, task)
			}
		}
		return daemonrpc.NewEnvelope(response.ID, response.Type, daemonrpc.ComputerTaskList{Tasks: filtered})
	default:
		return response, nil
	}
}

func writeGatewayError(codec *daemonrpc.Codec, requestID string, err error) {
	response, envelopeErr := daemonrpc.NewEnvelope(requestID, daemonrpc.TypeError, daemonrpc.Error{Message: err.Error()})
	if envelopeErr == nil {
		_ = codec.Write(response)
	}
}
