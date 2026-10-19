package main

import (
	"context"
	"net"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"zapvm/internal/daemonrpc"
	"zapvm/internal/localipc"
	"zapvm/internal/remoteauth"
)

const gatewayTestPrincipal = "spiffe://example.test/tenant/acme/project/weather/client/codex"

func gatewayTestPolicy(t *testing.T, permissions ...string) *remoteauth.Policy {
	t.Helper()
	policy, err := remoteauth.CompilePolicy(remoteauth.PolicyFile{
		SchemaVersion: remoteauth.PolicySchemaVersion, TrustDomain: "example.test", NodeID: "host-a",
		Grants: []remoteauth.Grant{{
			Principal: gatewayTestPrincipal, Permissions: permissions,
			ComputerIDs: []string{"computer-a"}, CredentialIDs: []string{"github"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return policy
}

func gatewayTestIdentity() remoteauth.Identity {
	return remoteauth.Identity{URI: gatewayTestPrincipal, TenantID: "acme", ProjectID: "weather", ClientID: "codex"}
}

func TestGatewayForwardsAuthorizedComputerRequest(t *testing.T) {
	endpoint := daemonTestEndpoint(t)
	listener, err := localipc.Listen(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	requestSeen := make(chan daemonrpc.Envelope, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		codec := daemonrpc.NewCodec(connection, connection)
		request, readErr := codec.Read()
		if readErr != nil {
			return
		}
		requestSeen <- request
		response, _ := daemonrpc.NewEnvelope(request.ID, daemonrpc.TypeComputer, daemonrpc.ComputerSpec{ID: "computer-a", Workspace: "/redacted"})
		_ = codec.Write(response)
	}()
	audit, err := remoteauth.OpenAudit(filepath.Join(t.TempDir(), "audit.jsonl"), "host-a")
	if err != nil {
		t.Fatal(err)
	}
	defer audit.Close()
	server := &gatewayServer{ctx: context.Background(), policy: gatewayTestPolicy(t, daemonrpc.TypeComputerInspect), audit: audit, endpoint: endpoint}
	request, err := daemonrpc.NewEnvelope("request-a", daemonrpc.TypeComputerInspect, daemonrpc.ComputerReference{ID: "computer-a"})
	if err != nil {
		t.Fatal(err)
	}
	serverSide, clientSide := net.Pipe()
	defer clientSide.Close()
	done := make(chan struct{})
	go func() {
		server.handleRequest(daemonrpc.NewCodec(serverSide, serverSide), gatewayTestIdentity(), request)
		_ = serverSide.Close()
		close(done)
	}()
	response, err := daemonrpc.NewCodec(clientSide, clientSide).Read()
	if err != nil {
		t.Fatal(err)
	}
	if response.Type != daemonrpc.TypeComputer {
		t.Fatalf("response type = %q", response.Type)
	}
	computer, err := daemonrpc.DecodePayload[daemonrpc.ComputerSpec](response.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if computer.ID != "computer-a" || computer.Workspace != "" {
		t.Fatalf("remote Computer was not redacted: %#v", computer)
	}
	select {
	case forwarded := <-requestSeen:
		if forwarded.Type != daemonrpc.TypeComputerInspect || forwarded.ID != request.ID {
			t.Fatalf("unexpected forwarded envelope %#v", forwarded)
		}
	case <-time.After(time.Second):
		t.Fatal("authorized request was not forwarded")
	}
	<-done
}

func TestGatewayDeniesHostControlAndUnlistedCredential(t *testing.T) {
	audit, err := remoteauth.OpenAudit(filepath.Join(t.TempDir(), "audit.jsonl"), "host-a")
	if err != nil {
		t.Fatal(err)
	}
	defer audit.Close()
	server := &gatewayServer{ctx: context.Background(), policy: gatewayTestPolicy(t, daemonrpc.TypeComputerExec), audit: audit}
	tests := []struct {
		name        string
		messageType string
		payload     any
	}{
		{name: "shutdown", messageType: daemonrpc.TypeShutdown, payload: daemonrpc.Empty{}},
		{name: "runtime-credential-rpc", messageType: daemonrpc.TypeComputerTaskSubmitCredentialed, payload: daemonrpc.ComputerTaskCredentialSubmitRequest{
			Task: daemonrpc.ComputerTaskSubmitRequest{
				ID: "task-runtime-credential", ComputerID: "computer-a",
				Command: daemonrpc.Command{ID: "command-runtime-credential", SessionID: "session-runtime-credential", Argv: []string{"true"}, CredentialIDs: []string{"github"}, TimeoutMillis: 60000},
			},
			Values: map[string][]byte{"github": []byte("must-never-cross-the-remote-gateway")},
		}},
		{name: "credential", messageType: daemonrpc.TypeComputerExec, payload: daemonrpc.ComputerExecRequest{
			ID: "computer-a", Command: daemonrpc.Command{ID: "command-a", SessionID: "session-a", Argv: []string{"true"}, CredentialIDs: []string{"production"}},
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request, err := daemonrpc.NewEnvelope("request-"+test.name, test.messageType, test.payload)
			if err != nil {
				t.Fatal(err)
			}
			serverSide, clientSide := net.Pipe()
			defer clientSide.Close()
			go func() {
				server.handleRequest(daemonrpc.NewCodec(serverSide, serverSide), gatewayTestIdentity(), request)
				_ = serverSide.Close()
			}()
			response, err := daemonrpc.NewCodec(clientSide, clientSide).Read()
			if err != nil {
				t.Fatal(err)
			}
			if response.Type != daemonrpc.TypeError {
				t.Fatalf("response type = %q", response.Type)
			}
			remoteError, err := daemonrpc.DecodePayload[daemonrpc.Error](response.Payload)
			if err != nil {
				t.Fatal(err)
			}
			if remoteError.Message != "remote access denied" {
				t.Fatalf("denial leaked details: %q", remoteError.Message)
			}
		})
	}
}

func TestGatewayFiltersComputerAndTaskLists(t *testing.T) {
	computerResponse, err := daemonrpc.NewEnvelope("request-list", daemonrpc.TypeComputers, daemonrpc.ComputerList{Computers: []daemonrpc.ComputerSpec{{ID: "computer-a"}, {ID: "computer-secret"}}})
	if err != nil {
		t.Fatal(err)
	}
	filtered, err := filterGatewayResponse(daemonrpc.TypeComputerList, computerResponse, map[string]struct{}{"computer-a": {}})
	if err != nil {
		t.Fatal(err)
	}
	computers, err := daemonrpc.DecodePayload[daemonrpc.ComputerList](filtered.Payload)
	if err != nil || len(computers.Computers) != 1 || computers.Computers[0].ID != "computer-a" {
		t.Fatalf("unexpected filtered Computers %#v, %v", computers, err)
	}
	taskResponse, err := daemonrpc.NewEnvelope("request-tasks", daemonrpc.TypeComputerTasks, daemonrpc.ComputerTaskList{Tasks: []daemonrpc.ComputerTask{{ID: "task-a", ComputerID: "computer-a"}, {ID: "task-secret", ComputerID: "computer-secret"}}})
	if err != nil {
		t.Fatal(err)
	}
	filtered, err = filterGatewayResponse(daemonrpc.TypeComputerTaskList, taskResponse, map[string]struct{}{"computer-a": {}})
	if err != nil {
		t.Fatal(err)
	}
	tasks, err := daemonrpc.DecodePayload[daemonrpc.ComputerTaskList](filtered.Payload)
	if err != nil || len(tasks.Tasks) != 1 || tasks.Tasks[0].ID != "task-a" {
		t.Fatalf("unexpected filtered Tasks %#v, %v", tasks, err)
	}
}

func TestGatewaySanitizesDaemonErrors(t *testing.T) {
	response, err := daemonrpc.NewEnvelope("request-error", daemonrpc.TypeError, daemonrpc.Error{Message: "open /Users/operator/secret: permission denied"})
	if err != nil {
		t.Fatal(err)
	}
	filtered, err := filterGatewayResponse(daemonrpc.TypeComputerInspect, response, nil)
	if err != nil {
		t.Fatal(err)
	}
	remoteError, err := daemonrpc.DecodePayload[daemonrpc.Error](filtered.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if remoteError.Message != "remote daemon request failed" {
		t.Fatalf("daemon error was not sanitized: %q", remoteError.Message)
	}
}

func TestGatewayTaskLookupFailsClosed(t *testing.T) {
	server := &gatewayServer{ctx: context.Background(), policy: gatewayTestPolicy(t, daemonrpc.TypeComputerTaskInspect), endpoint: daemonTestEndpoint(t)}
	request, err := daemonrpc.NewEnvelope("request-task", daemonrpc.TypeComputerTaskInspect, daemonrpc.ComputerTaskReference{ID: "task-unknown"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = server.authorize(gatewayTestPrincipal, request)
	if err == nil || err.Error() != "remote access denied" {
		t.Fatalf("expected fail-closed Task lookup, got %v", err)
	}
}

func TestGatewayConfigArgumentsPreserveExplicitAuthority(t *testing.T) {
	serve := remoteauth.GatewayConfig{
		Mode: remoteauth.GatewayModeServe,
		Serve: &remoteauth.GatewayServeConfig{
			Listen: "127.0.0.1:9443", DaemonEndpoint: "/run/user/501/zapvm.sock",
			ClientCA: "/secure/client-ca.pem", Certificate: "/secure/node.pem", PrivateKey: "/secure/node.key",
			Policy: "/secure/policy.json", AuditLog: "/secure/audit.jsonl",
		},
	}
	mode, arguments := gatewayConfigArguments(serve)
	wantServe := []string{
		"--listen", "127.0.0.1:9443", "--client-ca", "/secure/client-ca.pem",
		"--certificate", "/secure/node.pem", "--private-key", "/secure/node.key",
		"--policy", "/secure/policy.json", "--audit-log", "/secure/audit.jsonl",
		"--daemon-endpoint", "/run/user/501/zapvm.sock",
	}
	if mode != remoteauth.GatewayModeServe || !reflect.DeepEqual(arguments, wantServe) {
		t.Fatalf("serve arguments = %q %q", mode, arguments)
	}
	tunnel := remoteauth.GatewayConfig{
		Mode: remoteauth.GatewayModeTunnel,
		Tunnel: &remoteauth.GatewayTunnelConfig{
			Endpoint: "/run/user/501/zapvm-remote.sock", Remote: "host.example.test:9443",
			ServerCA: "/secure/server-ca.pem", Certificate: "/secure/client.pem", PrivateKey: "/secure/client.key",
			NodeURI: "spiffe://example.test/node/host-a",
		},
	}
	mode, arguments = gatewayConfigArguments(tunnel)
	wantTunnel := []string{
		"--remote", "host.example.test:9443", "--server-ca", "/secure/server-ca.pem",
		"--certificate", "/secure/client.pem", "--private-key", "/secure/client.key",
		"--node-uri", "spiffe://example.test/node/host-a", "--endpoint", "/run/user/501/zapvm-remote.sock",
	}
	if mode != remoteauth.GatewayModeTunnel || !reflect.DeepEqual(arguments, wantTunnel) {
		t.Fatalf("tunnel arguments = %q %q", mode, arguments)
	}
}
