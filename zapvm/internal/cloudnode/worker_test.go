//go:build !windows

package cloudnode

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"zapvm/internal/cloudplane"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/localipc"
)

func TestWorkerDispatchClaimsPendingWorkImmediately(t *testing.T) {
	var mu sync.Mutex
	paths := make([]string, 0, 3)
	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		paths = append(paths, request.URL.Path)
		mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		if request.URL.Path == "/v1/node/cancellations" {
			_, _ = writer.Write([]byte(`{"task_ids":[]}`))
		} else {
			_, _ = writer.Write([]byte(`{"leases":[]}`))
		}
	}))
	defer control.Close()
	worker := &Worker{
		config: Config{ControlURL: control.URL, MaxConcurrent: 1}, client: control.Client(),
		generation: "generation-00001", active: make(map[string]activeLease), activeWorkspace: make(map[string]activeWorkspaceLease),
		activeComputer: make(map[string]activeComputerOperationLease),
	}
	worker.dispatch(context.Background(), cloudplane.Node{DaemonState: cloudplane.DaemonHealthy})
	mu.Lock()
	defer mu.Unlock()
	want := []string{"/v1/node/computers/claim", "/v1/node/claim", "/v1/node/workspace/claim", "/v1/node/cancellations"}
	if strings.Join(paths, "\n") != strings.Join(want, "\n") {
		t.Fatalf("dispatch calls = %#v", paths)
	}
}

func TestWorkerStartsComputerBeforeCompletingOperation(t *testing.T) {
	temporary, err := os.MkdirTemp("/tmp", "zapvm-computer-start-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(temporary) })
	endpoint := filepath.Join(temporary, "daemon.sock")
	listener, err := localipc.ListenRecovering(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	daemonDone := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			daemonDone <- err
			return
		}
		defer connection.Close()
		codec := daemonrpc.NewCodec(connection, connection)
		envelope, err := codec.Read()
		if err != nil {
			daemonDone <- err
			return
		}
		if envelope.Type != daemonrpc.TypeComputerStart {
			daemonDone <- fmt.Errorf("daemon request type = %q", envelope.Type)
			return
		}
		reference, err := daemonrpc.DecodeComputerReference(envelope.Payload)
		if err != nil || reference.ID != "computer-start" {
			daemonDone <- fmt.Errorf("daemon Computer reference = %#v, %v", reference, err)
			return
		}
		response, err := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputer, daemonrpc.ComputerSpec{ID: reference.ID, RuntimeState: "running"})
		if err == nil {
			err = codec.Write(response)
		}
		daemonDone <- err
	}()

	completed := make(chan map[string]any, 1)
	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/node/computers/operations/start-operation/complete" {
			http.NotFound(writer, request)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode completion: %v", err)
		}
		completed <- body
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"id":"start-operation","state":"succeeded"}`))
	}))
	defer control.Close()
	worker := &Worker{
		config: Config{ControlURL: control.URL, DaemonEndpoint: endpoint}, client: control.Client(),
		generation: "generation-start-0001",
	}
	lease := cloudplane.ComputerOperationLease{
		Operation:  cloudplane.ComputerOperation{ID: "start-operation", ComputerID: "computer-start", DeadlineAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)},
		LeaseToken: "lease-token-computer-start-000000000000000000000000",
	}
	if err := worker.executeComputerOperation(context.Background(), lease); err != nil {
		t.Fatal(err)
	}
	if err := <-daemonDone; err != nil {
		t.Fatal(err)
	}
	body := <-completed
	if body["generation"] != worker.generation || body["lease_token"] != lease.LeaseToken || body["succeeded"] != true {
		t.Fatalf("Computer operation completion = %#v", body)
	}
}

func TestWorkerProvisionsSelfServiceComputerBeforeStart(t *testing.T) {
	temporary, err := os.MkdirTemp("/tmp", "zapvm-computer-provision-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(temporary) })
	endpoint := filepath.Join(temporary, "daemon.sock")
	listener, err := localipc.ListenRecovering(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	createdSpec := make(chan daemonrpc.ComputerSpec, 1)
	daemonDone := make(chan error, 1)
	go func() {
		for step := 0; step < 3; step++ {
			connection, err := listener.Accept()
			if err != nil {
				daemonDone <- err
				return
			}
			codec := daemonrpc.NewCodec(connection, connection)
			envelope, err := codec.Read()
			if err != nil {
				_ = connection.Close()
				daemonDone <- err
				return
			}
			var response daemonrpc.Envelope
			switch step {
			case 0:
				if envelope.Type != daemonrpc.TypeComputerInspect {
					err = fmt.Errorf("inspect request type = %q", envelope.Type)
					break
				}
				response, err = daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeError, daemonrpc.Error{Message: "not found"})
			case 1:
				if envelope.Type != daemonrpc.TypeComputerCreate {
					err = fmt.Errorf("create request type = %q", envelope.Type)
					break
				}
				request, decodeErr := daemonrpc.DecodeComputerCreate(envelope.Payload)
				if decodeErr != nil {
					err = decodeErr
					break
				}
				createdSpec <- request.Computer
				request.Computer.RuntimeState = "stopped"
				response, err = daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputer, request.Computer)
			case 2:
				if envelope.Type != daemonrpc.TypeComputerStart {
					err = fmt.Errorf("start request type = %q", envelope.Type)
					break
				}
				response, err = daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputer, daemonrpc.ComputerSpec{ID: "computer-self", RuntimeState: "running"})
			}
			if err == nil {
				err = codec.Write(response)
			}
			_ = connection.Close()
			if err != nil {
				daemonDone <- err
				return
			}
		}
		daemonDone <- nil
	}()

	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"id":"provision-operation","state":"succeeded"}`))
	}))
	defer control.Close()
	worker := &Worker{config: Config{ControlURL: control.URL, DaemonEndpoint: endpoint, WorkspaceRoot: filepath.Join(temporary, "workspaces")}, client: control.Client(), generation: "generation-provision-0001"}
	lease := cloudplane.ComputerOperationLease{
		Operation:  cloudplane.ComputerOperation{ID: "provision-operation", TenantID: "acme", ProjectID: "default", ComputerID: "computer-self", Kind: cloudplane.ComputerOperationStart, DeadlineAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)},
		LeaseToken: "lease-token-computer-provision-0000000000000000000",
		Provision:  &cloudplane.ComputerProvisionSpec{Agent: "zapcode@2.0.0", CPUCount: 4, MemoryMiB: 8192},
	}
	if err := worker.executeComputerOperation(context.Background(), lease); err != nil {
		t.Fatal(err)
	}
	if err := <-daemonDone; err != nil {
		t.Fatal(err)
	}
	spec := <-createdSpec
	wantWorkspace := filepath.Join(worker.config.WorkspaceRoot, "acme", "default", "computer-self")
	if spec.ID != "computer-self" || spec.Agent != "zapcode@2.0.0" || spec.CPUCount != 4 || spec.MemoryMiB != 8192 || spec.Workspace != wantWorkspace {
		t.Fatalf("provisioned Computer = %#v", spec)
	}
	if info, err := os.Stat(wantWorkspace); err != nil || !info.IsDir() {
		t.Fatalf("workspace info=%#v err=%v", info, err)
	}
}

func TestWorkerStopsComputerBeforeCompletingReleaseOperation(t *testing.T) {
	temporary, err := os.MkdirTemp("/tmp", "zapvm-computer-stop-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(temporary) })
	endpoint := filepath.Join(temporary, "daemon.sock")
	listener, err := localipc.ListenRecovering(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	daemonDone := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			daemonDone <- err
			return
		}
		defer connection.Close()
		codec := daemonrpc.NewCodec(connection, connection)
		envelope, err := codec.Read()
		if err != nil {
			daemonDone <- err
			return
		}
		if envelope.Type != daemonrpc.TypeComputerStop {
			daemonDone <- fmt.Errorf("daemon request type = %q", envelope.Type)
			return
		}
		reference, err := daemonrpc.DecodeComputerReference(envelope.Payload)
		if err != nil || reference.ID != "computer-stop" {
			daemonDone <- fmt.Errorf("daemon Computer reference = %#v, %v", reference, err)
			return
		}
		response, err := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerStopped, daemonrpc.ComputerSpec{ID: reference.ID, RuntimeState: "stopped"})
		if err == nil {
			err = codec.Write(response)
		}
		daemonDone <- err
	}()

	completed := make(chan map[string]any, 1)
	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/node/computers/operations/stop-operation/complete" {
			http.NotFound(writer, request)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode completion: %v", err)
		}
		completed <- body
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"id":"stop-operation","kind":"stop","state":"succeeded"}`))
	}))
	defer control.Close()
	worker := &Worker{
		config: Config{ControlURL: control.URL, DaemonEndpoint: endpoint}, client: control.Client(),
		generation: "generation-stop-00001",
	}
	lease := cloudplane.ComputerOperationLease{
		Operation: cloudplane.ComputerOperation{
			ID: "stop-operation", ComputerID: "computer-stop", Kind: cloudplane.ComputerOperationStop,
			DeadlineAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
		},
		LeaseToken: "lease-token-computer-stop-0000000000000000000000000",
	}
	if err := worker.executeComputerOperation(context.Background(), lease); err != nil {
		t.Fatal(err)
	}
	if err := <-daemonDone; err != nil {
		t.Fatal(err)
	}
	body := <-completed
	if body["generation"] != worker.generation || body["lease_token"] != lease.LeaseToken || body["succeeded"] != true {
		t.Fatalf("Computer stop completion = %#v", body)
	}
}

func TestWorkerBridgesCloudLeaseToPersistentDaemonTask(t *testing.T) {
	temporary, err := os.MkdirTemp("/tmp", "zapvm-cloudnode-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(temporary) })
	endpoint := filepath.Join(temporary, "daemon.sock")
	hostCapability := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x77}, 32))
	artifactData := []byte("abc")
	artifactDigest := sha256.Sum256(artifactData)
	artifactSHA256 := hex.EncodeToString(artifactDigest[:])
	listener, err := localipc.ListenRecovering(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	daemonDone := make(chan error, 1)
	go func() {
		for connectionIndex := 0; connectionIndex < 4; connectionIndex++ {
			connection, err := listener.Accept()
			if err != nil {
				daemonDone <- err
				return
			}
			codec := daemonrpc.NewCodec(connection, connection)
			envelope, err := codec.Read()
			if err != nil {
				_ = connection.Close()
				daemonDone <- err
				return
			}
			if connectionIndex == 0 {
				response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTask, daemonrpc.ComputerTask{
					ID: "task-a", ComputerID: "computer-a", State: "queued",
				})
				err = codec.Write(response)
			} else if connectionIndex == 1 {
				accepted, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeAccepted, daemonrpc.Empty{})
				event, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTaskEvent, daemonrpc.ComputerTaskEvent{
					Cursor: 1, Timestamp: "2026-08-07T06:00:00Z", TaskID: "task-a", Type: "exec.output", Stream: "stdout", Data: []byte("ok\n"),
				})
				end, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTaskEnd, daemonrpc.ComputerTask{
					ID: "task-a", ComputerID: "computer-a", State: "succeeded", LastCursor: 1,
				})
				err = codec.Write(accepted)
				if err == nil {
					err = codec.Write(event)
				}
				if err == nil {
					err = codec.Write(end)
				}
			} else if connectionIndex == 2 {
				if envelope.Type != daemonrpc.TypeComputerArtifactCollect {
					err = errors.New("unexpected Artifact collection request")
				} else {
					response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeArtifactCollection, daemonrpc.ArtifactCollection{
						Capability: hostCapability, ExpiresAt: "2026-08-07T06:15:00Z",
						Artifacts: []daemonrpc.CollectedArtifact{{
							ID: "artifact-a", Path: "report.txt", ContentType: "text/plain; charset=utf-8",
							Size: uint64(len(artifactData)), SHA256: artifactSHA256,
						}},
					})
					err = codec.Write(response)
				}
			} else {
				if envelope.Type != daemonrpc.TypeComputerArtifactOpen {
					err = errors.New("unexpected Artifact open request")
				} else {
					accepted, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeAccepted, daemonrpc.Empty{})
					chunk, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeArtifactChunk, daemonrpc.ArtifactChunk{Offset: 0, Data: artifactData})
					end, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeArtifactEnd, daemonrpc.ArtifactEnd{Size: uint64(len(artifactData)), SHA256: artifactSHA256})
					err = codec.Write(accepted)
					if err == nil {
						err = codec.Write(chunk)
					}
					if err == nil {
						err = codec.Write(end)
					}
				}
			}
			_ = connection.Close()
			if err != nil {
				daemonDone <- err
				return
			}
		}
		daemonDone <- nil
	}()

	var mu sync.Mutex
	paths := make([]string, 0, 3)
	bodies := make([]string, 0, 3)
	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		mu.Lock()
		paths = append(paths, request.URL.Path)
		bodies = append(bodies, string(body))
		mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusOK)
		if request.URL.Path == "/v1/node/tasks/task-a/ack" {
			_ = json.NewEncoder(writer).Encode(cloudplane.Task{ID: "task-a", State: cloudplane.TaskRunning})
		} else {
			_, _ = writer.Write([]byte("{}\n"))
		}
	}))
	defer control.Close()
	payload, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
		ID: "task-a", ComputerID: "computer-a",
		Command: daemonrpc.Command{ID: "command-a", SessionID: "session-a", Argv: []string{"echo", "ok"}, TimeoutMillis: 60000},
	})
	if err != nil {
		t.Fatal(err)
	}
	worker := &Worker{
		config: Config{ControlURL: control.URL, DaemonEndpoint: endpoint},
		client: control.Client(), generation: "generation-00001", active: make(map[string]activeLease),
	}
	lease := cloudplane.Lease{
		Task:       cloudplane.Task{ID: "task-a", ComputerID: "computer-a", Payload: payload},
		LeaseToken: "lease-token",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := worker.executeLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	if err := <-daemonDone; err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{
		"/v1/node/tasks/task-a/ack", "/v1/node/tasks/task-a/events", "/v1/node/tasks/task-a/artifacts",
		"/v1/node/tasks/task-a/artifacts/artifact-a/content", "/v1/node/tasks/task-a/events", "/v1/node/tasks/task-a/complete",
	}
	if len(paths) != len(want) {
		t.Fatalf("control calls = %#v", paths)
	}
	for index := range want {
		if paths[index] != want[index] {
			t.Fatalf("control calls = %#v", paths)
		}
	}
	if strings.Contains(strings.Join(bodies, "\n"), hostCapability) {
		t.Fatalf("Host-local Artifact capability escaped to Control: %#v", bodies)
	}
	if !strings.Contains(bodies[len(bodies)-2], `"type":"artifact.collect_completed"`) ||
		!strings.Contains(bodies[len(bodies)-2], `"data":"eyJjb3VudCI6MX0="`) {
		t.Fatalf("Artifact completion event = %s", bodies[len(bodies)-2])
	}
}

func TestWorkerRejectsProvisionedAgentMismatchBeforeTaskSubmit(t *testing.T) {
	temporary, err := os.MkdirTemp("/tmp", "zapvm-cloud-agent-mismatch-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(temporary) })
	endpoint := filepath.Join(temporary, "daemon.sock")
	listener, err := localipc.ListenRecovering(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	daemonDone := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			daemonDone <- acceptErr
			return
		}
		defer connection.Close()
		codec := daemonrpc.NewCodec(connection, connection)
		envelope, readErr := codec.Read()
		if readErr != nil {
			daemonDone <- readErr
			return
		}
		if envelope.Type != daemonrpc.TypeComputerInspect {
			daemonDone <- fmt.Errorf("unexpected daemon request %q", envelope.Type)
			return
		}
		response, responseErr := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputer, daemonrpc.ComputerSpec{ID: "computer-a", Agent: "zapcode@1.11.0"})
		if responseErr == nil {
			responseErr = codec.Write(response)
		}
		daemonDone <- responseErr
	}()
	var completeBody string
	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(request.URL.Path, "/ack") {
			_ = json.NewEncoder(writer).Encode(cloudplane.Task{ID: "task-agent", State: cloudplane.TaskRunning})
			return
		}
		body, _ := io.ReadAll(request.Body)
		completeBody = string(body)
		_, _ = writer.Write([]byte("{}\n"))
	}))
	defer control.Close()
	payload, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
		ID: "task-agent", ComputerID: "computer-a",
		Command: daemonrpc.Command{ID: "command-agent", SessionID: "session-agent", Argv: []string{"true"}, TimeoutMillis: 60000},
	})
	if err != nil {
		t.Fatal(err)
	}
	worker := &Worker{
		config: Config{ControlURL: control.URL, DaemonEndpoint: endpoint}, client: control.Client(),
		generation: "generation-00001", active: make(map[string]activeLease),
	}
	lease := cloudplane.Lease{
		Task:  cloudplane.Task{ID: "task-agent", ComputerID: "computer-a", Payload: payload},
		Agent: "zapcode@1.12.0", LeaseToken: "lease-token",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := worker.executeLease(ctx, lease); err == nil || !strings.Contains(err.Error(), "differs from provisioned Agent") {
		t.Fatalf("Agent mismatch error = %v", err)
	}
	if err := <-daemonDone; err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(completeBody, `"failure_code":"computer_agent_mismatch"`) {
		t.Fatalf("Agent mismatch completion = %s", completeBody)
	}
}

func TestWorkerRedeemsOneTimeCredentialAndUsesOwnerOnlyDaemonRPC(t *testing.T) {
	temporary, err := os.MkdirTemp("/tmp", "zapvm-cloud-credential-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(temporary) })
	endpoint := filepath.Join(temporary, "daemon.sock")
	listener, err := localipc.ListenRecovering(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	daemonDone := make(chan error, 1)
	redeemedSecret := []byte("runtime-credential-private-value")
	go func() {
		for index := 0; index < 2; index++ {
			connection, err := listener.Accept()
			if err != nil {
				daemonDone <- err
				return
			}
			codec := daemonrpc.NewCodec(connection, connection)
			envelope, err := codec.Read()
			if err == nil && index == 0 {
				if envelope.Type != daemonrpc.TypeComputerTaskSubmitCredentialed {
					err = errors.New("credentialed Task used the ordinary daemon RPC")
				} else if request, decodeErr := daemonrpc.DecodeComputerTaskCredentialSubmit(envelope.Payload); decodeErr != nil {
					err = decodeErr
				} else if !bytes.Equal(request.Values["model-key"], redeemedSecret) {
					err = errors.New("daemon received the wrong runtime Credential")
				} else {
					response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTask, daemonrpc.ComputerTask{ID: "task-credential", ComputerID: "computer-a", State: "queued"})
					err = codec.Write(response)
				}
			} else if err == nil {
				if envelope.Type != daemonrpc.TypeComputerTaskAttach {
					err = errors.New("expected credentialed Task attach")
				} else {
					accepted, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeAccepted, daemonrpc.Empty{})
					end, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTaskEnd, daemonrpc.ComputerTask{ID: "task-credential", ComputerID: "computer-a", State: "failed"})
					err = codec.Write(accepted)
					if err == nil {
						err = codec.Write(end)
					}
				}
			}
			_ = connection.Close()
			if err != nil {
				daemonDone <- err
				return
			}
		}
		daemonDone <- nil
	}()

	paths := make([]string, 0, 3)
	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		paths = append(paths, request.URL.Path)
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v1/node/tasks/task-credential/ack":
			_ = json.NewEncoder(writer).Encode(cloudplane.Task{ID: "task-credential", State: cloudplane.TaskRunning})
		case "/v1/node/tasks/task-credential/credentials":
			_ = json.NewEncoder(writer).Encode(cloudplane.CredentialBundle{Values: map[string][]byte{"model-key": redeemedSecret}})
		default:
			_, _ = writer.Write([]byte("{}\n"))
		}
	}))
	defer control.Close()
	payload, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
		ID: "task-credential", ComputerID: "computer-a",
		Command: daemonrpc.Command{ID: "command-credential", SessionID: "session-credential", Argv: []string{"/bin/false"}, CredentialIDs: []string{"model-key"}, TimeoutMillis: 60000},
	})
	if err != nil {
		t.Fatal(err)
	}
	capability := &cloudplane.CredentialCapability{ID: "credcap_credential_test", Secret: bytes.Repeat([]byte{0x72}, 32), ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)}
	worker := &Worker{
		config: Config{ControlURL: control.URL, DaemonEndpoint: endpoint}, client: control.Client(),
		generation: "generation-00001", active: make(map[string]activeLease),
	}
	lease := cloudplane.Lease{
		Task:       cloudplane.Task{ID: "task-credential", ComputerID: "computer-a", Payload: payload, CredentialIDs: []string{"model-key"}},
		LeaseToken: "lease-token", CredentialCapability: capability,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := worker.executeLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	if err := <-daemonDone; err != nil {
		t.Fatal(err)
	}
	if capability.Secret != nil {
		t.Fatal("Node retained Credential capability secret after Task admission")
	}
	want := []string{"/v1/node/tasks/task-credential/ack", "/v1/node/tasks/task-credential/credentials", "/v1/node/tasks/task-credential/complete"}
	if len(paths) != len(want) {
		t.Fatalf("Credential Control calls=%#v", paths)
	}
	for index := range want {
		if paths[index] != want[index] {
			t.Fatalf("Credential Control calls=%#v", paths)
		}
	}
}

func TestArtifactCollectionFailureIsPartialAndDoesNotFailExecution(t *testing.T) {
	temporary, err := os.MkdirTemp("/tmp", "zapvm-cloud-partial-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(temporary) })
	endpoint := filepath.Join(temporary, "daemon.sock")
	listener, err := localipc.ListenRecovering(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	daemonDone := make(chan error, 1)
	go func() {
		for index := 0; index < 3; index++ {
			connection, err := listener.Accept()
			if err != nil {
				daemonDone <- err
				return
			}
			codec := daemonrpc.NewCodec(connection, connection)
			envelope, err := codec.Read()
			if err == nil {
				switch index {
				case 0:
					response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTask, daemonrpc.ComputerTask{ID: "task-partial", ComputerID: "computer-a", State: "queued"})
					err = codec.Write(response)
				case 1:
					accepted, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeAccepted, daemonrpc.Empty{})
					event, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTaskEvent, daemonrpc.ComputerTaskEvent{
						Cursor: 1, Timestamp: "2026-08-08T05:00:00Z", TaskID: "task-partial", Type: "exec.output", Stream: "stdout", Data: []byte("ok\n"),
					})
					end, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTaskEnd, daemonrpc.ComputerTask{ID: "task-partial", ComputerID: "computer-a", State: "succeeded", LastCursor: 1})
					err = codec.Write(accepted)
					if err == nil {
						err = codec.Write(event)
					}
					if err == nil {
						err = codec.Write(end)
					}
				case 2:
					response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeError, daemonrpc.Error{Message: "unsafe output"})
					err = codec.Write(response)
				}
			}
			_ = connection.Close()
			if err != nil {
				daemonDone <- err
				return
			}
		}
		daemonDone <- nil
	}()
	var mu sync.Mutex
	paths := make([]string, 0, 4)
	bodies := make([]string, 0, 4)
	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		mu.Lock()
		paths = append(paths, request.URL.Path)
		bodies = append(bodies, string(body))
		mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(request.URL.Path, "/ack") {
			_ = json.NewEncoder(writer).Encode(cloudplane.Task{ID: "task-partial", State: cloudplane.TaskRunning})
			return
		}
		_, _ = writer.Write([]byte("{}\n"))
	}))
	defer control.Close()
	payload, err := json.Marshal(daemonrpc.ComputerTaskSubmitRequest{
		ID: "task-partial", ComputerID: "computer-a",
		Command: daemonrpc.Command{ID: "command-a", SessionID: "session-a", Argv: []string{"echo", "ok"}, TimeoutMillis: 60000},
	})
	if err != nil {
		t.Fatal(err)
	}
	worker := &Worker{
		config: Config{ControlURL: control.URL, DaemonEndpoint: endpoint}, client: control.Client(), generation: "generation-00001",
		active: make(map[string]activeLease), log: io.Discard,
	}
	lease := cloudplane.Lease{Task: cloudplane.Task{ID: "task-partial", ComputerID: "computer-a", Payload: payload}, LeaseToken: "lease-token"}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := worker.executeLease(ctx, lease); err != nil {
		t.Fatalf("successful execution was changed by Artifact collection failure: %v", err)
	}
	if err := <-daemonDone; err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{
		"/v1/node/tasks/task-partial/ack", "/v1/node/tasks/task-partial/events", "/v1/node/tasks/task-partial/events", "/v1/node/tasks/task-partial/complete",
	}
	if len(paths) != len(want) {
		t.Fatalf("partial Artifact control calls = %#v", paths)
	}
	for index := range want {
		if paths[index] != want[index] {
			t.Fatalf("partial Artifact control calls = %#v", paths)
		}
	}
	if !strings.Contains(bodies[2], `"type":"artifact.collect_failed"`) || !strings.Contains(bodies[2], `"error":"artifact_collection_failed"`) ||
		!strings.Contains(bodies[3], `"succeeded":true`) {
		t.Fatalf("partial Artifact bodies = %#v", bodies)
	}
}

func TestWorkerBridgesWorkspaceOperationToDaemon(t *testing.T) {
	temporary, err := os.MkdirTemp("/tmp", "zapvm-cloud-workspace-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(temporary) })
	endpoint := filepath.Join(temporary, "daemon.sock")
	listener, err := localipc.ListenRecovering(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	daemonDone := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			daemonDone <- err
			return
		}
		defer connection.Close()
		codec := daemonrpc.NewCodec(connection, connection)
		envelope, err := codec.Read()
		if err != nil {
			daemonDone <- err
			return
		}
		request, err := daemonrpc.DecodeComputerWorkspaceRequest(envelope.Payload)
		if err != nil || envelope.Type != daemonrpc.TypeComputerWorkspaceRead || request.ComputerID != "computer-a" || request.Path != "README.md" {
			daemonDone <- errors.New("unexpected workspace daemon request")
			return
		}
		data := []byte("hello\n")
		digest := sha256.Sum256(data)
		response, err := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeWorkspaceFile, daemonrpc.WorkspaceFile{
			Path: "README.md", Size: int64(len(data)), SHA256: hex.EncodeToString(digest[:]), ContentType: "text/plain; charset=utf-8", Data: data,
		})
		if err == nil {
			err = codec.Write(response)
		}
		daemonDone <- err
	}()

	var completion map[string]json.RawMessage
	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/node/workspace/operations/workspace-op/complete" {
			http.Error(writer, "unexpected path", http.StatusNotFound)
			return
		}
		if err := json.NewDecoder(request.Body).Decode(&completion); err != nil {
			http.Error(writer, "bad body", http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte("{}\n"))
	}))
	defer control.Close()
	worker := &Worker{
		config: Config{ControlURL: control.URL, DaemonEndpoint: endpoint}, client: control.Client(), generation: "generation-00001",
		active: make(map[string]activeLease), activeWorkspace: make(map[string]activeWorkspaceLease),
	}
	lease := cloudplane.WorkspaceOperationLease{
		Operation:  cloudplane.WorkspaceOperation{ID: "workspace-op", ComputerID: "computer-a", Kind: cloudplane.WorkspaceOperationRead, Path: "README.md"},
		LeaseToken: "workspace-token",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := worker.executeWorkspaceLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	if err := <-daemonDone; err != nil {
		t.Fatal(err)
	}
	if string(completion["succeeded"]) != "true" || !bytes.Contains(completion["result"], []byte("aGVsbG8K")) {
		t.Fatalf("workspace completion = %#v", completion)
	}
}

func TestWorkerBridgesGitCapabilityOnlyToHostDaemonAndClearsIt(t *testing.T) {
	temporary, err := os.MkdirTemp("/tmp", "zapvm-cloud-git-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(temporary) })
	endpoint := filepath.Join(temporary, "daemon.sock")
	listener, err := localipc.ListenRecovering(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	daemonDone := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			daemonDone <- err
			return
		}
		defer connection.Close()
		codec := daemonrpc.NewCodec(connection, connection)
		envelope, err := codec.Read()
		if err != nil {
			daemonDone <- err
			return
		}
		request, err := daemonrpc.DecodeComputerGitPush(envelope.Payload)
		if err != nil || envelope.Type != daemonrpc.TypeComputerGitPush || request.OperationID != "git-op" ||
			request.ComputerID != "computer-a" || string(request.Token) != "ghs_variable_length_test_token_2026" {
			daemonDone <- errors.New("unexpected Git daemon request")
			return
		}
		response, err := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeGitPushResult, daemonrpc.GitPushResult{
			OperationID: "git-op", Branch: "zapvm/git-op", CommitSHA: strings.Repeat("a", 40),
		})
		if err == nil {
			err = codec.Write(response)
		}
		daemonDone <- err
	}()

	var completion map[string]json.RawMessage
	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/node/workspace/operations/git-op/complete" {
			http.Error(writer, "unexpected path", http.StatusNotFound)
			return
		}
		if err := json.NewDecoder(request.Body).Decode(&completion); err != nil {
			http.Error(writer, "bad body", http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte("{}\n"))
	}))
	defer control.Close()
	worker := &Worker{
		config: Config{ControlURL: control.URL, DaemonEndpoint: endpoint}, client: control.Client(), generation: "generation-00001",
		active: make(map[string]activeLease), activeWorkspace: make(map[string]activeWorkspaceLease),
	}
	secret := []byte("ghs_variable_length_test_token_2026")
	lease := cloudplane.WorkspaceOperationLease{
		Operation: cloudplane.WorkspaceOperation{
			ID: "git-op", ComputerID: "computer-a", Kind: cloudplane.WorkspaceOperationGitPush,
			ProviderID: "github", Branch: "zapvm/git-op",
		},
		LeaseToken: "workspace-token",
		Git: &cloudplane.GitLeaseCapability{
			Owner: "example", Repository: "repository", BaseBranch: "main",
			HTTPSCloneURL: "https://github.com/example/repository.git", Token: secret,
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := worker.executeWorkspaceLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	if err := <-daemonDone; err != nil {
		t.Fatal(err)
	}
	if string(completion["succeeded"]) != "true" || !bytes.Contains(completion["result"], []byte(strings.Repeat("a", 40))) {
		t.Fatalf("Git completion = %#v", completion)
	}
	for _, value := range secret {
		if value != 0 {
			t.Fatal("Node retained Git capability bytes")
		}
	}
}

func TestWorkerDispatchesCloudCancellationToDaemon(t *testing.T) {
	temporary, err := os.MkdirTemp("/tmp", "zapvm-cloud-cancel-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(temporary) })
	endpoint := filepath.Join(temporary, "daemon.sock")
	listener, err := localipc.ListenRecovering(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	daemonDone := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			daemonDone <- err
			return
		}
		defer connection.Close()
		codec := daemonrpc.NewCodec(connection, connection)
		envelope, err := codec.Read()
		if err != nil {
			daemonDone <- err
			return
		}
		if envelope.Type != daemonrpc.TypeComputerTaskCancel {
			daemonDone <- errors.New("worker did not send a daemon Task cancellation")
			return
		}
		reference, err := daemonrpc.DecodeComputerTaskReference(envelope.Payload)
		if err != nil || reference.ID != "task-cancel" {
			daemonDone <- errors.New("worker sent the wrong daemon Task cancellation")
			return
		}
		response, _ := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeComputerTask, daemonrpc.ComputerTask{
			ID: reference.ID, ComputerID: "computer-a", State: "canceling",
		})
		daemonDone <- codec.Write(response)
	}()
	lease := cloudplane.Lease{Task: cloudplane.Task{ID: "task-cancel", ComputerID: "computer-a"}, LeaseToken: "lease-token"}
	worker := &Worker{
		config: Config{DaemonEndpoint: endpoint}, log: io.Discard,
		active: map[string]activeLease{lease.Task.ID: {lease: lease}},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	worker.startCancellation(ctx, lease.Task.ID)
	worker.wait.Wait()
	if err := <-daemonDone; err != nil {
		t.Fatal(err)
	}
	worker.mu.Lock()
	active := worker.active[lease.Task.ID]
	worker.mu.Unlock()
	if !active.cancelSent {
		t.Fatal("successful daemon cancellation was not deduplicated")
	}
}

func TestWorkerReportsDaemonOperabilityWithoutRawErrors(t *testing.T) {
	temporary, err := os.MkdirTemp("/tmp", "zapvm-cloud-status-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(temporary) })
	endpoint := filepath.Join(temporary, "daemon.sock")
	listener, err := localipc.ListenRecovering(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		defer connection.Close()
		codec := daemonrpc.NewCodec(connection, connection)
		envelope, err := codec.Read()
		if err != nil {
			done <- err
			return
		}
		response, err := daemonrpc.NewEnvelope(envelope.ID, daemonrpc.TypeStatus, daemonrpc.Status{
			Version: "0.2.0", ImageDigest: strings.Repeat("c", 64), Paused: true,
			StartAttempts: 3, StartFailures: 1, StartDurationMillisTotal: 3600, StartDurationMillisMax: 1400,
			ComputerRuntimes: []daemonrpc.ComputerRuntime{{ID: "computer-a", State: "stopped"}},
		})
		if err == nil {
			err = codec.Write(response)
		}
		done <- err
	}()
	worker := &Worker{config: Config{DaemonEndpoint: endpoint}, nodeVersion: "0.2.1"}
	body := worker.operationalBody(context.Background())
	if body["node_version"] != "0.2.1" || body["daemon_version"] != "0.2.0" ||
		body["image_digest"] != strings.Repeat("c", 64) || body["daemon_state"] != cloudplane.DaemonPaused ||
		body["start_attempts"] != uint64(3) || body["start_failures"] != uint64(1) ||
		body["start_duration_ms_total"] != uint64(3600) || body["start_duration_ms_max"] != uint64(1400) {
		t.Fatalf("operational body = %#v", body)
	}
	runtimes, ok := body["computer_runtimes"].([]daemonrpc.ComputerRuntime)
	if !ok || len(runtimes) != 1 || runtimes[0].ID != "computer-a" || runtimes[0].State != "stopped" {
		t.Fatalf("operational Computer runtimes = %#v", body["computer_runtimes"])
	}
	if _, exists := body["failure_code"]; exists {
		t.Fatalf("paused daemon exposed a failure code: %#v", body)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	worker.config.DaemonEndpoint = filepath.Join(temporary, "missing.sock")
	body = worker.operationalBody(context.Background())
	if body["daemon_state"] != cloudplane.DaemonUnreachable || body["failure_code"] != "daemon_unreachable" {
		t.Fatalf("unreachable operational body = %#v", body)
	}
}

func TestWorkerReusesRequestIDAcrossIdempotentRetries(t *testing.T) {
	var mu sync.Mutex
	requestIDs := make([]string, 0, 4)
	attempt := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		requestIDs = append(requestIDs, request.Header.Get(cloudplane.RequestIDHeader))
		attempt++
		current := attempt
		mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		if current < 3 {
			writer.WriteHeader(http.StatusServiceUnavailable)
			_, _ = writer.Write([]byte(`{"error":{"code":"unavailable"}}`))
			return
		}
		_, _ = writer.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	worker := &Worker{
		config: Config{ControlURL: server.URL}, client: server.Client(), generation: "generation-00001", log: io.Discard,
		active: make(map[string]activeLease), activeWorkspace: make(map[string]activeWorkspaceLease),
	}
	var response map[string]any
	if err := worker.postRetry(context.Background(), "/v1/test", map[string]any{"safe": true}, &response); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(requestIDs) != 3 || requestIDs[0] == "" || requestIDs[0] != requestIDs[1] || requestIDs[1] != requestIDs[2] ||
		!strings.HasPrefix(requestIDs[0], "node-") {
		t.Fatalf("retry request IDs = %#v", requestIDs)
	}
}
