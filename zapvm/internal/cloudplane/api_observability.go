package cloudplane

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const RequestIDHeader = "X-Request-ID"

type requestIDContextKey struct{}

type apiMetric struct {
	Count             uint64 `json:"count"`
	DurationTotalMS   uint64 `json:"duration_total_ms"`
	DurationMaximumMS uint64 `json:"duration_maximum_ms"`
}

type apiMetrics struct {
	mu     sync.Mutex
	routes map[string]apiMetric
}

func newAPIMetrics() *apiMetrics { return &apiMetrics{routes: make(map[string]apiMetric)} }

func (metrics *apiMetrics) record(method, route string, status int, duration time.Duration) {
	key := method + " " + route + " " + strconv.Itoa(status)
	milliseconds := uint64(duration / time.Millisecond)
	metrics.mu.Lock()
	metric := metrics.routes[key]
	metric.Count++
	metric.DurationTotalMS += milliseconds
	if milliseconds > metric.DurationMaximumMS {
		metric.DurationMaximumMS = milliseconds
	}
	metrics.routes[key] = metric
	metrics.mu.Unlock()
}

func (metrics *apiMetrics) snapshot() map[string]apiMetric {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	result := make(map[string]apiMetric, len(metrics.routes))
	for key, metric := range metrics.routes {
		result[key] = metric
	}
	return result
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (writer *statusWriter) WriteHeader(status int) {
	if writer.status != 0 {
		return
	}
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *statusWriter) Write(data []byte) (int, error) {
	if writer.status == 0 {
		writer.WriteHeader(http.StatusOK)
	}
	return writer.ResponseWriter.Write(data)
}

func (writer *statusWriter) Flush() {
	if writer.status == 0 {
		writer.WriteHeader(http.StatusOK)
	}
	if flusher, ok := writer.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (writer *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := writer.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("HTTP response does not support hijacking")
	}
	if writer.status == 0 {
		writer.status = http.StatusSwitchingProtocols
	}
	return hijacker.Hijack()
}

var fallbackRequestID atomic.Uint64

func newRequestID() string {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err == nil {
		return hex.EncodeToString(random)
	}
	return fmt.Sprintf("fallback-%016x", fallbackRequestID.Add(1))
}

func validRequestID(value string) bool {
	if len(value) < 8 || len(value) > 128 {
		return false
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') &&
			(char < '0' || char > '9') && char != '-' && char != '_' && char != '.' {
			return false
		}
	}
	return true
}

func requestID(request *http.Request) string {
	value, _ := request.Context().Value(requestIDContextKey{}).(string)
	return value
}

func (api *API) observeRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		id := request.Header.Get(RequestIDHeader)
		if !validRequestID(id) {
			id = newRequestID()
		}
		writer.Header().Set(RequestIDHeader, id)
		started := time.Now()
		captured := &statusWriter{ResponseWriter: writer}
		next.ServeHTTP(captured, request.WithContext(context.WithValue(request.Context(), requestIDContextKey{}, id)))
		if captured.status == 0 {
			captured.status = http.StatusOK
		}
		duration := time.Since(started)
		route := normalizedRoute(request.URL.Path)
		api.metrics.record(request.Method, route, captured.status, duration)
		if shouldLogRequest(route, captured.status) {
			api.logger.Printf("request_id=%s component=control method=%s route=%s status=%d duration_ms=%d", id, request.Method, route, captured.status, duration/time.Millisecond)
		}
	})
}

func shouldLogRequest(route string, status int) bool {
	if status >= http.StatusBadRequest {
		return true
	}
	switch route {
	case "/v1/node/heartbeat", "/v1/node/cancellations", "/v1/node/claim", "/v1/node/computers/claim", "/v1/node/workspace/claim":
		return false
	default:
		return true
	}
}

func normalizedRoute(path string) string {
	switch {
	case path == "/healthz", path == "/readyz", path == "/v1/tasks", path == "/v1/agent/sessions",
		path == "/v1/agent/computers", path == "/v1/agent/git/providers", path == "/v1/audit", path == "/v1/admin/nodes", path == "/v1/admin/metrics",
		path == "/v1/node/register", path == "/v1/node/heartbeat", path == "/v1/node/cancellations",
		path == "/v1/node/claim", path == "/v1/node/computers/claim", path == "/v1/node/workspace/claim":
		return path
	case strings.HasPrefix(path, "/v1/node/computers/operations/"):
		return "/v1/node/computers/operations/:id/:action"
	case strings.HasPrefix(path, "/v1/node/tasks/"):
		return "/v1/node/tasks/:id/:action"
	case strings.HasPrefix(path, "/v1/node/workspace/operations/"):
		return "/v1/node/workspace/operations/:id/:action"
	case strings.HasPrefix(path, "/v1/agent/sessions/"):
		return "/v1/agent/sessions/:id/:action"
	case strings.HasPrefix(path, "/v1/agent/artifacts/"):
		return "/v1/agent/artifacts/:id"
	case strings.HasPrefix(path, "/v1/agent/computers/"):
		if strings.HasSuffix(path, "/lifecycle") {
			return "/v1/agent/computers/:id/lifecycle"
		}
		if strings.Contains(path, "/git/operations") {
			return "/v1/agent/computers/:id/git/operations/:operation"
		}
		return "/v1/agent/computers/:id/workspace"
	case strings.HasPrefix(path, "/v1/admin/nodes/"):
		return "/v1/admin/nodes/:id/drain"
	case strings.HasPrefix(path, "/v1/tasks/"):
		return "/v1/tasks/:id/:action"
	default:
		return "/unmatched"
	}
}

func (api *API) adminMetrics(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeAPIError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !api.isAdministrator(request) {
		writeAPIError(writer, http.StatusForbidden, "administrator_required")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"schema_version": 1,
		"store":          api.store.OperationalSnapshot(),
		"http":           map[string]any{"routes": api.metrics.snapshot()},
	})
}
