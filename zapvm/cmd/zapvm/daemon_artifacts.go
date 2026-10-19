package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"zapvm/internal/daemonrpc"
	"zapvm/internal/task"
)

func (server *daemonServer) streamComputerArtifact(codec *daemonrpc.Codec, requestID string, request daemonrpc.ComputerArtifactOpenRequest) error {
	if server.artifactCollector == nil {
		return errors.New("Artifact collector is unavailable")
	}
	file, metadata, err := server.artifactCollector.OpenArtifact(request.Capability, request.ArtifactID)
	if err != nil {
		return err
	}
	defer file.Close()
	accepted, _ := daemonrpc.NewEnvelope(requestID, daemonrpc.TypeAccepted, daemonrpc.Empty{})
	if err := codec.Write(accepted); err != nil {
		return err
	}
	hasher := sha256.New()
	buffer := make([]byte, 256<<10)
	var offset uint64
	for {
		read, readErr := file.Read(buffer)
		if read > 0 {
			_, _ = hasher.Write(buffer[:read])
			chunk, err := daemonrpc.NewEnvelope(requestID, daemonrpc.TypeArtifactChunk, daemonrpc.ArtifactChunk{
				Offset: offset, Data: append([]byte(nil), buffer[:read]...),
			})
			if err != nil || codec.Write(chunk) != nil {
				return errors.New("stream Artifact chunk")
			}
			offset += uint64(read)
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				return errors.New("read Artifact snapshot")
			}
			break
		}
	}
	digest := hex.EncodeToString(hasher.Sum(nil))
	if offset != metadata.Size || digest != metadata.SHA256 {
		return errors.New("Artifact snapshot changed before upload")
	}
	end, _ := daemonrpc.NewEnvelope(requestID, daemonrpc.TypeArtifactEnd, daemonrpc.ArtifactEnd{Size: offset, SHA256: digest})
	return codec.Write(end)
}

func (server *daemonServer) sweepArtifactCapabilities(interval time.Duration) {
	if server.artifactCollector == nil {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-server.ctx.Done():
			return
		case <-ticker.C:
			if err := server.artifactCollector.CleanupExpired(); err != nil && server.ctx.Err() == nil {
				output := server.taskLog
				if output == nil {
					output = os.Stderr
				}
				fmt.Fprintln(output, "component=daemon operation=artifact_gc object_id=none result=failed code=artifact_gc_failed")
			}
		}
	}
}

func (server *daemonServer) collectComputerArtifacts(request daemonrpc.ComputerArtifactCollectRequest) (daemonrpc.ArtifactCollection, error) {
	if server.taskStore == nil || server.computers == nil || server.artifactCollector == nil {
		return daemonrpc.ArtifactCollection{}, errors.New("Artifact collector is unavailable")
	}
	current, err := server.taskStore.Inspect(request.TaskID)
	if err != nil {
		return daemonrpc.ArtifactCollection{}, err
	}
	if current.ComputerID != request.ComputerID || current.State != task.StateSucceeded {
		return daemonrpc.ArtifactCollection{}, errors.New("Artifact collection requires the matching succeeded Task")
	}
	record, err := server.computers.Get(request.ComputerID)
	if err != nil {
		return daemonrpc.ArtifactCollection{}, err
	}
	collection, err := server.artifactCollector.Collect(record.Workspace, request.TaskID)
	if err != nil {
		return daemonrpc.ArtifactCollection{}, err
	}
	result := daemonrpc.ArtifactCollection{
		Capability: collection.Capability, ExpiresAt: collection.ExpiresAt,
		Artifacts: make([]daemonrpc.CollectedArtifact, 0, len(collection.Artifacts)),
	}
	for _, artifact := range collection.Artifacts {
		result.Artifacts = append(result.Artifacts, daemonrpc.CollectedArtifact{
			ID: artifact.ID, Path: artifact.Path, ContentType: artifact.ContentType,
			Size: artifact.Size, SHA256: artifact.SHA256,
		})
	}
	return result, nil
}
