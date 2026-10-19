package platform

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCloudHypervisorAPIContract(t *testing.T) {
	requests := make(chan string, 6)
	api := serveCloudHypervisorAPI(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests <- request.Method + " " + request.URL.Path
		switch request.URL.Path {
		case "/api/v1/vmm.ping":
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"version":"v52.0","build_version":"test","pid":123}`))
		case "/api/v1/vm.info":
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"state":"Running","config":{}}`))
		case "/api/v1/vm.pause", "/api/v1/vm.resume", "/api/v1/vm.shutdown", "/api/v1/vmm.shutdown":
			response.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(response, request)
		}
	}))

	ctx := context.Background()
	ping, err := api.ping(ctx)
	if err != nil || ping.Version != "v52.0" || ping.PID != 123 {
		t.Fatalf("ping = %+v, %v", ping, err)
	}
	info, err := api.vmInfo(ctx)
	if err != nil || info.State != "Running" {
		t.Fatalf("vmInfo = %+v, %v", info, err)
	}
	if err := api.shutdownVM(ctx); err != nil {
		t.Fatalf("shutdownVM: %v", err)
	}
	if err := api.pauseVM(ctx); err != nil {
		t.Fatalf("pauseVM: %v", err)
	}
	if err := api.resumeVM(ctx); err != nil {
		t.Fatalf("resumeVM: %v", err)
	}
	if err := api.shutdownVMM(ctx); err != nil {
		t.Fatalf("shutdownVMM: %v", err)
	}

	want := []string{
		"GET /api/v1/vmm.ping",
		"GET /api/v1/vm.info",
		"PUT /api/v1/vm.shutdown",
		"PUT /api/v1/vm.pause",
		"PUT /api/v1/vm.resume",
		"PUT /api/v1/vmm.shutdown",
	}
	for _, expected := range want {
		if actual := <-requests; actual != expected {
			t.Fatalf("request = %q, want %q", actual, expected)
		}
	}
}

func TestCloudHypervisorAPIRejectsErrorsAndOversizedResponses(t *testing.T) {
	t.Run("status", func(t *testing.T) {
		api := serveCloudHypervisorAPI(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			http.Error(response, "not running", http.StatusMethodNotAllowed)
		}))
		_, err := api.vmInfo(context.Background())
		if err == nil || !strings.Contains(err.Error(), "HTTP 405: not running") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("oversized", func(t *testing.T) {
		api := serveCloudHypervisorAPI(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			_, _ = response.Write(make([]byte, cloudHypervisorMaxResponseBytes+1))
		}))
		_, err := api.vmInfo(context.Background())
		if err == nil || !strings.Contains(err.Error(), "response exceeds") {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestCloudHypervisorAPIRequiresPingVersionAndVMState(t *testing.T) {
	api := serveCloudHypervisorAPI(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`{}`))
	}))
	if _, err := api.ping(context.Background()); err == nil || !strings.Contains(err.Error(), "missing version") {
		t.Fatalf("unexpected ping error: %v", err)
	}
	if _, err := api.vmInfo(context.Background()); err == nil || !strings.Contains(err.Error(), "missing state") {
		t.Fatalf("unexpected vmInfo error: %v", err)
	}
}

func serveCloudHypervisorAPI(t *testing.T, handler http.Handler) *cloudHypervisorAPI {
	t.Helper()
	directory := t.TempDir()
	socketPath := filepath.Join(directory, "api.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Skipf("Unix sockets are unavailable: %v", err)
	}
	server := &http.Server{Handler: handler}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() {
		_ = server.Close()
		_ = listener.Close()
		_ = os.Remove(socketPath)
	})
	return newCloudHypervisorAPI(socketPath)
}
