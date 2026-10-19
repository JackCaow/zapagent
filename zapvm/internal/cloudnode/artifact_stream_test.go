package cloudnode

import (
	"net"
	"sync"
	"testing"
)

func TestArtifactContentStreamCloseIsConcurrentSafe(t *testing.T) {
	client, server := net.Pipe()
	defer server.Close()

	stream := &artifactContentStream{connection: client}
	const closers = 16
	var wait sync.WaitGroup
	wait.Add(closers)
	errors := make(chan error, closers)
	for range closers {
		go func() {
			defer wait.Done()
			errors <- stream.Close()
		}()
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatalf("Close() returned %v", err)
		}
	}
}
