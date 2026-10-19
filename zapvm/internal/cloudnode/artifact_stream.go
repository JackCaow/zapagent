package cloudnode

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"zapvm/internal/cloudplane"
	"zapvm/internal/daemonrpc"
)

type artifactContentStream struct {
	connection net.Conn
	codec      *daemonrpc.Codec
	requestID  string
	expected   daemonrpc.CollectedArtifact
	hasher     hash.Hash
	offset     uint64
	buffer     []byte
	ended      bool
	closeOnce  sync.Once
	closeErr   error
}

func (worker *Worker) openArtifact(ctx context.Context, capability string, artifact daemonrpc.CollectedArtifact) (*artifactContentStream, error) {
	connection, err := worker.dialDaemon(ctx)
	if err != nil {
		return nil, err
	}
	requestID := rpcID("artifact-open", artifact.ID)
	envelope, err := daemonrpc.NewEnvelope(requestID, daemonrpc.TypeComputerArtifactOpen, daemonrpc.ComputerArtifactOpenRequest{
		Capability: capability, ArtifactID: artifact.ID,
	})
	if err != nil {
		_ = connection.Close()
		return nil, err
	}
	codec := daemonrpc.NewCodec(connection, connection)
	if err := codec.Write(envelope); err != nil {
		_ = connection.Close()
		return nil, err
	}
	response, err := codec.Read()
	if err != nil {
		_ = connection.Close()
		return nil, err
	}
	if response.ID != requestID || response.Type != daemonrpc.TypeAccepted || daemonrpc.DecodeEmpty(response.Payload) != nil {
		_ = connection.Close()
		return nil, errors.New("daemon rejected Artifact capability")
	}
	return &artifactContentStream{
		connection: connection, codec: codec, requestID: requestID, expected: artifact, hasher: sha256.New(),
	}, nil
}

func (stream *artifactContentStream) receiveFrame() error {
	envelope, err := stream.codec.Read()
	if err != nil {
		return err
	}
	if envelope.ID != stream.requestID {
		return errors.New("Artifact stream request ID mismatch")
	}
	switch envelope.Type {
	case daemonrpc.TypeArtifactChunk:
		chunk, err := daemonrpc.DecodeArtifactChunk(envelope.Payload)
		if err != nil || len(chunk.Data) == 0 || chunk.Offset != stream.offset || stream.offset+uint64(len(chunk.Data)) > stream.expected.Size {
			return errors.New("Artifact stream chunk is invalid")
		}
		_, _ = stream.hasher.Write(chunk.Data)
		stream.offset += uint64(len(chunk.Data))
		stream.buffer = chunk.Data
	case daemonrpc.TypeArtifactEnd:
		end, err := daemonrpc.DecodeArtifactEnd(envelope.Payload)
		digest := hex.EncodeToString(stream.hasher.Sum(nil))
		if err != nil || end.Size != stream.offset || end.Size != stream.expected.Size || end.SHA256 != digest || end.SHA256 != stream.expected.SHA256 {
			return errors.New("Artifact stream terminal digest is invalid")
		}
		stream.ended = true
	case daemonrpc.TypeError:
		return errors.New("daemon Artifact stream failed")
	default:
		return fmt.Errorf("unexpected daemon Artifact stream response %q", envelope.Type)
	}
	return nil
}

func (stream *artifactContentStream) Read(destination []byte) (int, error) {
	if len(destination) == 0 {
		return 0, nil
	}
	for len(stream.buffer) == 0 && !stream.ended {
		if err := stream.receiveFrame(); err != nil {
			return 0, err
		}
	}
	if len(stream.buffer) > 0 {
		copied := copy(destination, stream.buffer)
		stream.buffer = stream.buffer[copied:]
		// net/http may stop reading as soon as Content-Length bytes have been
		// returned. Consume and validate the terminal frame before exposing the
		// final bytes so the daemon can finish the stream before Close runs.
		if len(stream.buffer) == 0 && stream.offset == stream.expected.Size && !stream.ended {
			if err := stream.receiveFrame(); err != nil {
				return copied, err
			}
			if !stream.ended {
				return copied, errors.New("Artifact stream did not end after declared content")
			}
		}
		return copied, nil
	}
	return 0, io.EOF
}

func (stream *artifactContentStream) Close() error {
	stream.closeOnce.Do(func() {
		if stream.connection != nil {
			stream.closeErr = stream.connection.Close()
		}
	})
	return stream.closeErr
}

func (worker *Worker) uploadArtifact(ctx context.Context, lease cloudplane.Lease, capability string, artifact daemonrpc.CollectedArtifact) error {
	worker.clientMu.RLock()
	client := worker.uploadClient
	if client == nil {
		client = worker.client
	}
	worker.clientMu.RUnlock()
	if client == nil {
		return errors.New("Artifact upload client is unavailable")
	}
	path := "/v1/node/tasks/" + lease.Task.ID + "/artifacts/" + artifact.ID + "/content"
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		stream, err := worker.openArtifact(ctx, capability, artifact)
		if err != nil {
			return err
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPut, strings.TrimSuffix(worker.config.ControlURL, "/")+path, stream)
		if err != nil {
			_ = stream.Close()
			return err
		}
		request.ContentLength = int64(artifact.Size)
		request.Header.Set("Content-Type", artifact.ContentType)
		request.Header.Set("X-ZapVM-Artifact-SHA256", artifact.SHA256)
		request.Header.Set("X-ZapVM-Node-Generation", worker.generation)
		request.Header.Set("X-ZapVM-Lease-Token", lease.LeaseToken)
		request.Header.Set(cloudplane.RequestIDHeader, rpcID("artifact-upload", artifact.ID))
		response, err := client.Do(request)
		_ = stream.Close()
		if err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK || response.StatusCode == http.StatusCreated {
				return nil
			}
			if response.StatusCode < 500 {
				return fmt.Errorf("Artifact upload returned HTTP %d", response.StatusCode)
			}
			lastErr = fmt.Errorf("Artifact upload returned HTTP %d", response.StatusCode)
		} else {
			lastErr = err
		}
		if attempt < 2 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt+1) * 100 * time.Millisecond):
			}
		}
	}
	return lastErr
}
