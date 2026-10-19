//go:build !windows

package cloudnode

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"zapvm/internal/cloudplane"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/localipc"
	"zapvm/internal/remoteauth"
)

const (
	devTrustDomain = "dev.zapvm.test"
	devControlURI  = "spiffe://dev.zapvm.test/control/control"
	devNodeURI     = "spiffe://dev.zapvm.test/node/host-a"
	devClientURI   = "spiffe://dev.zapvm.test/tenant/acme/project/default/client/web-dev"
)

// TestDevelopmentE2EControlNodeDaemonAndCursorReplay is the hardware-free
// development baseline for the product path. It uses a real TLS 1.3/mTLS HTTP
// control API, persistent cloud store, cloud Node worker, owner-only local IPC,
// daemon RPC framing, Resident Agent request translation, Task events, and
// cursor replay. Only the VMM/Guest execution itself is replaced by a bounded
// fake daemon; scripts/verify-resident-agent.sh remains the real-VM gate.
func TestDevelopmentE2EControlNodeDaemonAndCursorReplay(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "zapvm-dev-e2e-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	ca, caPath := writeDevelopmentPKI(t, root)
	controlCert, controlKey := issueDevelopmentCertificate(t, root, ca, 2, "control", devControlURI, x509.ExtKeyUsageServerAuth)
	nodeCert, nodeKey := issueDevelopmentCertificate(t, root, ca, 3, "node", devNodeURI, x509.ExtKeyUsageClientAuth)
	clientCert, clientKey := issueDevelopmentCertificate(t, root, ca, 4, "client", devClientURI, x509.ExtKeyUsageClientAuth)

	store, err := cloudplane.Open(filepath.Join(root, "control-state"), []cloudplane.NodeProvision{{
		ID: "host-a", Capacity: 1, Scopes: []cloudplane.Scope{{TenantID: "acme", ProjectID: "default"}},
		Computers: []cloudplane.ComputerProvision{{ID: "computer-a", TenantID: "acme", ProjectID: "default"}},
	}}, cloudplane.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	api, err := cloudplane.NewAPI(store, devTrustDomain, []string{devClientURI})
	if err != nil {
		t.Fatal(err)
	}
	serverTLS, err := remoteauth.LoadMutualTLSServer(caPath, controlCert, controlKey, devControlURI)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(api.Handler())
	server.TLS = serverTLS
	server.StartTLS()
	defer server.Close()

	endpoint := filepath.Join(root, "daemon.sock")
	listener, err := localipc.ListenRecovering(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	daemonDone := make(chan error, 1)
	go func() { daemonDone <- serveDevelopmentDaemon(listener) }()

	worker, err := New(Config{
		SchemaVersion: 1, ControlURL: server.URL, TrustDomain: devTrustDomain, ControlID: "control", NodeID: "host-a",
		ServerCA: caPath, Certificate: nodeCert, PrivateKey: nodeKey, DaemonEndpoint: endpoint,
		PollMillis: 250, MaxConcurrent: 1, RelayMode: "required",
	}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	workerDone := make(chan error, 1)
	go func() { workerDone <- worker.Run(ctx) }()
	defer func() {
		cancel()
		if err := <-workerDone; err != nil {
			t.Errorf("worker shutdown: %v", err)
		}
	}()

	clientTLS, err := remoteauth.LoadMutualTLSClient(caPath, clientCert, clientKey, devClientURI, devControlURI)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: clientTLS}, Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	waitForDevelopmentNode(t, client, server.URL)
	var computers cloudplane.AgentComputerList
	developmentJSON(t, client, http.MethodGet, server.URL+"/v1/agent/computers", nil, http.StatusOK, &computers)
	if len(computers.Computers) != 1 || computers.Computers[0] != (cloudplane.AgentComputer{
		ID: "computer-a", State: cloudplane.NodeOnline, DesiredState: cloudplane.ComputerDesiredRunning,
		ObservedState: cloudplane.ComputerObservedReady, AssignedNodeID: "host-a",
	}) {
		t.Fatalf("Agent Computer catalog = %#v", computers.Computers)
	}

	request := map[string]any{
		"id": "dev-turn-1", "computer_id": "computer-a", "session_id": "dev-session-1",
		"prompt": "return the development fixture", "provider_base_url": "https://api.dev.invalid/v1",
		"model": "fixture-model", "model_credential_id": "model-api-key", "max_turns": 2, "timeout_ms": 60000,
	}
	var created cloudplane.AgentSession
	developmentJSON(t, client, http.MethodPost, server.URL+"/v1/agent/sessions", request, http.StatusCreated, &created)
	if created.ID != "dev-turn-1" || created.SessionID != "dev-session-1" || created.State != cloudplane.TaskPending {
		t.Fatalf("created Agent Session = %#v", created)
	}

	deadline := time.Now().Add(10 * time.Second)
	var completed cloudplane.AgentSession
	for {
		developmentJSON(t, client, http.MethodGet, server.URL+"/v1/agent/sessions/dev-turn-1", nil, http.StatusOK, &completed)
		if completed.State == cloudplane.TaskSucceeded {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("Agent Session did not complete: %#v", completed)
		}
		time.Sleep(50 * time.Millisecond)
	}

	var events cloudplane.AgentSessionEvents
	developmentJSON(t, client, http.MethodGet, server.URL+"/v1/agent/sessions/dev-turn-1/events?after=0&limit=100", nil, http.StatusOK, &events)
	if len(events.Events) != 2 || string(events.Events[0].Data) != "DEV_E2E_OK\n" || events.Events[0].Cursor == 0 ||
		events.Events[1].Type != "artifact.collect_completed" || string(events.Events[1].Data) != `{"count":0}` {
		t.Fatalf("Agent Session events = %#v", events.Events)
	}
	var replay cloudplane.AgentSessionEvents
	developmentJSON(t, client, http.MethodGet, fmt.Sprintf("%s/v1/agent/sessions/dev-turn-1/events?after=%d&limit=100", server.URL, events.Events[1].Cursor), nil, http.StatusOK, &replay)
	if len(replay.Events) != 0 {
		t.Fatalf("cursor replay returned old events: %#v", replay.Events)
	}

	cancelRequest := map[string]any{
		"id": "dev-turn-cancel", "computer_id": "computer-a", "session_id": "dev-session-cancel",
		"prompt": "wait until the cloud cancellation arrives", "provider_base_url": "https://api.dev.invalid/v1",
		"model": "fixture-model", "model_credential_id": "model-api-key", "max_turns": 2, "timeout_ms": 60000,
	}
	developmentJSON(t, client, http.MethodPost, server.URL+"/v1/agent/sessions", cancelRequest, http.StatusCreated, &created)
	waitForDevelopmentAgentState(t, client, server.URL, "dev-turn-cancel", cloudplane.TaskRunning)
	var canceling cloudplane.AgentSession
	developmentJSON(t, client, http.MethodDelete, server.URL+"/v1/agent/sessions/dev-turn-cancel", nil, http.StatusOK, &canceling)
	if canceling.State != cloudplane.TaskCanceling {
		t.Fatalf("cancel intent = %#v", canceling)
	}
	waitForDevelopmentAgentState(t, client, server.URL, "dev-turn-cancel", cloudplane.TaskCanceled)
	var cancelEvents cloudplane.AgentSessionEvents
	developmentJSON(t, client, http.MethodGet, server.URL+"/v1/agent/sessions/dev-turn-cancel/events?after=0&limit=100", nil, http.StatusOK, &cancelEvents)
	if len(cancelEvents.Events) != 2 || cancelEvents.Events[0].Type != "task.cancel_requested" || cancelEvents.Events[1].Type != "task.canceled" {
		t.Fatalf("cancel events = %#v", cancelEvents.Events)
	}
	var catalog cloudplane.AgentSessionList
	developmentJSON(t, client, http.MethodGet, server.URL+"/v1/agent/sessions?after=0&limit=100", nil, http.StatusOK, &catalog)
	if len(catalog.Sessions) != 2 || catalog.Sessions[0].ID != "dev-turn-1" || catalog.Sessions[1].ID != "dev-turn-cancel" || catalog.NextCursor == 0 {
		t.Fatalf("Agent Session catalog = %#v", catalog)
	}
	var workspaceOperation cloudplane.AgentWorkspaceOperation
	developmentJSON(t, client, http.MethodPost, server.URL+"/v1/agent/computers/computer-a/workspace/operations", map[string]any{
		"id": "dev-workspace-list", "kind": "list", "path": "",
	}, http.StatusAccepted, &workspaceOperation)
	deadline = time.Now().Add(10 * time.Second)
	for workspaceOperation.State != cloudplane.WorkspaceOperationSucceeded {
		developmentJSON(t, client, http.MethodGet, server.URL+"/v1/agent/computers/computer-a/workspace/operations/dev-workspace-list", nil, http.StatusOK, &workspaceOperation)
		if workspaceOperation.State == cloudplane.WorkspaceOperationFailed || time.Now().After(deadline) {
			t.Fatalf("workspace operation did not complete: %#v", workspaceOperation)
		}
		time.Sleep(50 * time.Millisecond)
	}
	var listing daemonrpc.WorkspaceListing
	if err := json.Unmarshal(workspaceOperation.Result, &listing); err != nil || len(listing.Entries) != 1 || listing.Entries[0].Path != "README.md" {
		t.Fatalf("workspace listing = %#v, %v", listing, err)
	}
	if err := <-daemonDone; err != nil {
		t.Fatal(err)
	}
}

func serveDevelopmentDaemon(listener net.Listener) error {
	for connectionIndex := 0; connectionIndex < 4; connectionIndex++ {
		connection, codec, envelope, err := acceptDevelopmentDaemonRequest(listener)
		if err != nil {
			return err
		}
		switch connectionIndex {
		case 0, 3:
			if envelope.Type != daemonrpc.TypeComputerTaskSubmit {
				_ = connection.Close()
				return fmt.Errorf("development daemon got %q, want Task submit", envelope.Type)
			}
			request, err := daemonrpc.DecodeComputerTaskSubmit(envelope.Payload)
			if err != nil {
				_ = connection.Close()
				return err
			}
			expectedID, expectedSession := "dev-turn-1", "dev-session-1"
			if connectionIndex == 3 {
				expectedID, expectedSession = "dev-turn-cancel", "dev-session-cancel"
			}
			if request.ID != expectedID || request.ComputerID != "computer-a" || request.Command.SessionID != expectedSession || len(request.Command.Argv) == 0 || request.Command.Argv[0] != "/usr/local/sbin/zapvm-resident-agent" {
				_ = connection.Close()
				return fmt.Errorf("unexpected Resident Agent request: %#v", request)
			}
			response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTask, daemonrpc.ComputerTask{
				ID: request.ID, ComputerID: request.ComputerID, State: "queued",
			})
			err = codec.Write(response)
		case 1:
			if envelope.Type != daemonrpc.TypeComputerTaskAttach {
				_ = connection.Close()
				return fmt.Errorf("development daemon got %q, want Task attach", envelope.Type)
			}
			accepted, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeAccepted, daemonrpc.Empty{})
			event, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTaskEvent, daemonrpc.ComputerTaskEvent{
				Cursor: 1, Timestamp: time.Now().UTC().Format(time.RFC3339Nano), TaskID: "dev-turn-1",
				Type: "exec.output", Stream: "stdout", Data: []byte("DEV_E2E_OK\n"),
			})
			end, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTaskEnd, daemonrpc.ComputerTask{
				ID: "dev-turn-1", ComputerID: "computer-a", State: "succeeded", LastCursor: 1,
			})
			err = codec.Write(accepted)
			if err == nil {
				err = codec.Write(event)
			}
			if err == nil {
				err = codec.Write(end)
			}
		case 2:
			if envelope.Type != daemonrpc.TypeComputerArtifactCollect {
				_ = connection.Close()
				return fmt.Errorf("development daemon got %q, want Artifact collect", envelope.Type)
			}
			response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeArtifactCollection, daemonrpc.ArtifactCollection{Artifacts: []daemonrpc.CollectedArtifact{}})
			err = codec.Write(response)
		}
		_ = connection.Close()
		if err != nil {
			return err
		}
	}

	attachConnection, attachCodec, attachEnvelope, err := acceptDevelopmentDaemonRequest(listener)
	if err != nil {
		return err
	}
	if attachEnvelope.Type != daemonrpc.TypeComputerTaskAttach {
		_ = attachConnection.Close()
		return fmt.Errorf("development daemon got %q, want cancel Task attach", attachEnvelope.Type)
	}
	accepted, _ := daemonrpc.NewEnvelope(attachEnvelope.ID, daemonrpc.TypeAccepted, daemonrpc.Empty{})
	if err := attachCodec.Write(accepted); err != nil {
		_ = attachConnection.Close()
		return err
	}

	cancelConnection, cancelCodec, cancelEnvelope, err := acceptDevelopmentDaemonRequest(listener)
	if err != nil {
		_ = attachConnection.Close()
		return err
	}
	if cancelEnvelope.Type != daemonrpc.TypeComputerTaskCancel {
		_ = cancelConnection.Close()
		_ = attachConnection.Close()
		return fmt.Errorf("development daemon got %q, want Task cancel", cancelEnvelope.Type)
	}
	reference, err := daemonrpc.DecodeComputerTaskReference(cancelEnvelope.Payload)
	if err != nil || reference.ID != "dev-turn-cancel" {
		_ = cancelConnection.Close()
		_ = attachConnection.Close()
		return errors.New("development daemon received the wrong Task cancellation")
	}
	cancelResponse, _ := daemonrpc.NewEnvelope(cancelEnvelope.ID, daemonrpc.TypeComputerTask, daemonrpc.ComputerTask{
		ID: reference.ID, ComputerID: "computer-a", State: "canceling",
	})
	if err := cancelCodec.Write(cancelResponse); err != nil {
		_ = cancelConnection.Close()
		_ = attachConnection.Close()
		return err
	}
	_ = cancelConnection.Close()

	now := time.Now().UTC().Format(time.RFC3339Nano)
	cancelRequested, _ := daemonrpc.NewEnvelope(attachEnvelope.ID, daemonrpc.TypeComputerTaskEvent, daemonrpc.ComputerTaskEvent{
		Cursor: 1, Timestamp: now, TaskID: "dev-turn-cancel", Type: "task.cancel_requested",
	})
	canceled, _ := daemonrpc.NewEnvelope(attachEnvelope.ID, daemonrpc.TypeComputerTaskEvent, daemonrpc.ComputerTaskEvent{
		Cursor: 2, Timestamp: now, TaskID: "dev-turn-cancel", Type: "task.canceled", Error: "user_requested",
	})
	end, _ := daemonrpc.NewEnvelope(attachEnvelope.ID, daemonrpc.TypeComputerTaskEnd, daemonrpc.ComputerTask{
		ID: "dev-turn-cancel", ComputerID: "computer-a", State: "canceled", LastCursor: 2,
	})
	for _, envelope := range []daemonrpc.Envelope{cancelRequested, canceled, end} {
		if err := attachCodec.Write(envelope); err != nil {
			_ = attachConnection.Close()
			return err
		}
	}
	_ = attachConnection.Close()

	workspaceConnection, workspaceCodec, workspaceEnvelope, err := acceptDevelopmentDaemonRequest(listener)
	if err != nil {
		return err
	}
	defer workspaceConnection.Close()
	workspaceRequest, err := daemonrpc.DecodeComputerWorkspaceRequest(workspaceEnvelope.Payload)
	if err != nil || workspaceEnvelope.Type != daemonrpc.TypeComputerWorkspaceList || workspaceRequest.ComputerID != "computer-a" || workspaceRequest.Path != "" {
		return errors.New("development daemon received the wrong workspace request")
	}
	listing, _ := daemonrpc.NewEnvelope(workspaceEnvelope.ID, daemonrpc.TypeWorkspaceListing, daemonrpc.WorkspaceListing{
		Entries: []daemonrpc.WorkspaceEntry{{Path: "README.md", Name: "README.md", Type: "file", Size: 7, ModifiedAt: time.Now().UTC().Format(time.RFC3339Nano)}},
	})
	if err := workspaceCodec.Write(listing); err != nil {
		return err
	}
	return nil
}

func acceptDevelopmentDaemonRequest(listener net.Listener) (net.Conn, *daemonrpc.Codec, daemonrpc.Envelope, error) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			return nil, nil, daemonrpc.Envelope{}, err
		}
		codec := daemonrpc.NewCodec(connection, connection)
		envelope, err := codec.Read()
		if err != nil {
			_ = connection.Close()
			return nil, nil, daemonrpc.Envelope{}, err
		}
		if envelope.Type != daemonrpc.TypeStatus {
			return connection, codec, envelope, nil
		}
		status, envelopeErr := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeStatus, daemonrpc.Status{
			Version: "0.1.0-development", ImageDigest: strings.Repeat("a", 64),
		})
		if envelopeErr == nil {
			envelopeErr = codec.Write(status)
		}
		_ = connection.Close()
		if envelopeErr != nil {
			return nil, nil, daemonrpc.Envelope{}, envelopeErr
		}
	}
}

func waitForDevelopmentAgentState(t *testing.T, client *http.Client, controlURL, taskID, expected string) cloudplane.AgentSession {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var session cloudplane.AgentSession
		developmentJSON(t, client, http.MethodGet, controlURL+"/v1/agent/sessions/"+taskID, nil, http.StatusOK, &session)
		if session.State == expected {
			return session
		}
		if session.State == cloudplane.TaskFailed || session.State == cloudplane.TaskSucceeded || session.State == cloudplane.TaskCanceled || time.Now().After(deadline) {
			t.Fatalf("Agent Session %s state=%q, want %q: %#v", taskID, session.State, expected, session)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func waitForDevelopmentNode(t *testing.T, client *http.Client, controlURL string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var response struct {
			Nodes []cloudplane.Node `json:"nodes"`
		}
		developmentJSON(t, client, http.MethodGet, controlURL+"/v1/admin/nodes", nil, http.StatusOK, &response)
		if len(response.Nodes) == 1 && response.Nodes[0].ID == "host-a" && response.Nodes[0].State == cloudplane.NodeOnline {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("development Node did not register: %#v", response.Nodes)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func developmentJSON(t *testing.T, client *http.Client, method, target string, body any, expectedStatus int, destination ...any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequest(method, target, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	httpResponse, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer httpResponse.Body.Close()
	data, err := io.ReadAll(io.LimitReader(httpResponse.Body, cloudplane.MaxPayloadSize+1))
	if err != nil {
		t.Fatal(err)
	}
	if httpResponse.StatusCode != expectedStatus {
		t.Fatalf("%s %s status=%d body=%s", method, target, httpResponse.StatusCode, data)
	}
	if httpResponse.Header.Get(cloudplane.APIVersionHeader) != cloudplane.APIVersion {
		t.Fatalf("%s %s API version header=%q", method, target, httpResponse.Header.Get(cloudplane.APIVersionHeader))
	}
	if len(destination) == 1 && destination[0] != nil {
		if err := json.Unmarshal(data, destination[0]); err != nil {
			t.Fatalf("decode %s %s: %v body=%s", method, target, err, data)
		}
	}
}

type developmentCA struct {
	certificate *x509.Certificate
	key         ed25519.PrivateKey
}

func writeDevelopmentPKI(t *testing.T, directory string) (developmentCA, string) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "zapVM development CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, publicKey, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "ca.crt")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	return developmentCA{certificate: certificate, key: privateKey}, path
}

func issueDevelopmentCertificate(t *testing.T, directory string, authority developmentCA, serial int64, name, identity string, usage x509.ExtKeyUsage) (string, string) {
	t.Helper()
	uri, err := url.Parse(identity)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{usage}, URIs: []*url.URL{uri},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, authority.certificate, publicKey, authority.key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	certificatePath := filepath.Join(directory, name+".crt")
	keyPath := filepath.Join(directory, name+".key")
	if err := os.WriteFile(certificatePath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return certificatePath, keyPath
}
