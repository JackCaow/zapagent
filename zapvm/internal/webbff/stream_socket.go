package webbff

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/websocket"
)

const (
	browserStreamPathSuffix = "/stream/socket"
	browserStreamProtocol   = "zapvm.agent-stream.v1"
	maxBrowserStreamFrame   = 2 << 20
)

type browserStreamFrame struct {
	Type      string          `json:"type"`
	Cursor    uint64          `json:"cursor,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
	Code      string          `json:"code,omitempty"`
	Retryable bool            `json:"retryable,omitempty"`
}

func browserStreamTaskID(path string) (string, bool) {
	const prefix = "/api/agent/sessions/"
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, browserStreamPathSuffix) {
		return "", false
	}
	taskID := strings.TrimSuffix(strings.TrimPrefix(path, prefix), browserStreamPathSuffix)
	if !canonicalName(taskID) || strings.Contains(taskID, "/") {
		return "", false
	}
	return taskID, true
}

func (server *Server) streamAgentSession(writer http.ResponseWriter, request *http.Request, requestID string, project ProjectRuntime, claims sessionClaims, taskID string) {
	if request.Method != http.MethodGet {
		writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	release, ok := server.acquireStream(project.ID)
	if !ok {
		writeError(writer, http.StatusTooManyRequests, "rate_limited")
		return
	}
	defer release()

	handler := websocket.Server{
		Handshake: func(config *websocket.Config, handshake *http.Request) error {
			if handshake.Header.Get("Origin") != server.publicOrigin {
				return errors.New("same-origin WebSocket is required")
			}
			for _, protocol := range config.Protocol {
				if protocol == browserStreamProtocol {
					config.Protocol = []string{browserStreamProtocol}
					return nil
				}
			}
			return errors.New("Agent stream subprotocol is required")
		},
		Handler: func(connection *websocket.Conn) {
			server.audit(requestID, project.ID, claims.UserID, request.Method, request.URL.Path, "stream_connected")
			server.bridgeAgentStream(connection, requestID, project, taskID)
		},
	}
	handler.ServeHTTP(writer, request)
}

func (server *Server) bridgeAgentStream(connection *websocket.Conn, requestID string, project ProjectRuntime, taskID string) {
	connection.MaxPayloadBytes = 1024
	ctx, cancel := context.WithCancel(connection.Request().Context())
	defer cancel()
	go func() {
		var ignored []byte
		if err := websocket.Message.Receive(connection, &ignored); err != nil {
			cancel()
		}
	}()

	query := connection.Request().URL.Query()
	cursor, _ := strconv.ParseUint(query.Get("after"), 10, 64)
	client := &http.Client{Transport: project.Transport}
	for ctx.Err() == nil {
		upstreamURL := *project.ControlURL
		upstreamURL.Path = "/v1/agent/sessions/" + taskID + "/stream"
		upstreamURL.RawPath = ""
		query.Set("after", strconv.FormatUint(cursor, 10))
		upstreamURL.RawQuery = validatedStreamQuery(query)
		upstreamRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, upstreamURL.String(), nil)
		if err != nil {
			server.sendStreamError(connection, "internal_error", false)
			return
		}
		upstreamRequest.Header.Set("Accept", "text/event-stream")
		upstreamRequest.Header.Set("X-Request-ID", requestID)
		response, err := client.Do(upstreamRequest)
		if err != nil {
			if ctx.Err() == nil {
				server.logger.Printf("request_id=%s component=web_bff result=stream_upstream_error", requestID)
				server.sendStreamError(connection, "control_unavailable", true)
			}
			return
		}
		if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
			_ = response.Body.Close()
			server.logger.Printf("request_id=%s component=web_bff result=stream_upstream_rejected status=%d", requestID, response.StatusCode)
			server.sendStreamError(connection, "stream_rejected", response.StatusCode >= 500)
			return
		}
		result, relayErr := relaySSEFrames(connection, response.Body)
		_ = response.Body.Close()
		cursor = max(cursor, result.Cursor)
		if result.Terminal || ctx.Err() != nil {
			return
		}
		if relayErr != nil && !errors.Is(relayErr, io.EOF) {
			server.logger.Printf("request_id=%s component=web_bff result=stream_relay_error", requestID)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func validatedStreamQuery(query url.Values) string {
	clean := make(url.Values, 2)
	if after := query.Get("after"); after != "" {
		if value, err := strconv.ParseUint(after, 10, 64); err == nil {
			clean.Set("after", strconv.FormatUint(value, 10))
		}
	}
	if limit := query.Get("limit"); limit != "" {
		if value, err := strconv.ParseUint(limit, 10, 16); err == nil && value > 0 && value <= 1000 {
			clean.Set("limit", strconv.FormatUint(value, 10))
		}
	}
	return clean.Encode()
}

type sseRelayResult struct {
	Cursor   uint64
	Terminal bool
}

func relaySSEFrames(connection *websocket.Conn, input io.Reader) (sseRelayResult, error) {
	result := sseRelayResult{}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64<<10), maxBrowserStreamFrame)
	eventType := ""
	eventID := ""
	data := make([]string, 0, 1)
	flush := func() error {
		if eventType == "" && eventID == "" && len(data) == 0 {
			return nil
		}
		payload := strings.Join(data, "\n")
		frame := browserStreamFrame{Type: eventType}
		if eventID != "" {
			cursor, err := strconv.ParseUint(eventID, 10, 64)
			if err != nil {
				return fmt.Errorf("invalid SSE cursor: %w", err)
			}
			frame.Cursor = cursor
			result.Cursor = max(result.Cursor, cursor)
		}
		if payload != "" {
			if !json.Valid([]byte(payload)) {
				return errors.New("invalid SSE JSON payload")
			}
			frame.Data = json.RawMessage(payload)
		}
		if frame.Type == "" {
			frame.Type = "message"
		}
		if frame.Type == "session" {
			var session struct {
				State string `json:"state"`
			}
			if json.Unmarshal(frame.Data, &session) == nil {
				switch session.State {
				case "succeeded", "failed", "canceled", "interrupted":
					result.Terminal = true
				}
			}
		}
		_ = connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return websocket.JSON.Send(connection, frame)
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if err := flush(); err != nil {
				return result, err
			}
			eventType, eventID, data = "", "", data[:0]
			continue
		}
		if strings.HasPrefix(line, ":") {
			_ = connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := websocket.JSON.Send(connection, browserStreamFrame{Type: "keepalive"}); err != nil {
				return result, err
			}
			continue
		}
		if strings.HasPrefix(line, "retry:") {
			continue
		}
		name, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		value = strings.TrimPrefix(value, " ")
		switch name {
		case "event":
			eventType = value
		case "id":
			eventID = value
		case "data":
			data = append(data, value)
		}
	}
	if err := scanner.Err(); err != nil {
		return result, err
	}
	return result, flush()
}

func (server *Server) sendStreamError(connection *websocket.Conn, code string, retryable bool) {
	_ = connection.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = websocket.JSON.Send(connection, browserStreamFrame{Type: "error", Code: code, Retryable: retryable})
}
