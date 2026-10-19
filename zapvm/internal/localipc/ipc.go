package localipc

import (
	"context"
	"net"
)

func Listen(endpoint string) (net.Listener, error) {
	return listen(endpoint)
}

// ListenRecovering serializes daemon ownership of an endpoint and may reclaim
// only a provably stale platform endpoint. Ordinary Listen remains strictly
// non-replacing for callers that do not need crash recovery.
func ListenRecovering(endpoint string) (net.Listener, error) {
	return listenRecovering(endpoint)
}

func Dial(ctx context.Context, endpoint string) (net.Conn, error) {
	return dial(ctx, endpoint)
}

func DefaultEndpoint() (string, error) {
	return defaultEndpoint()
}
