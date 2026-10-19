package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"zapvm/internal/artifactcollector"
	"zapvm/internal/computer"
	"zapvm/internal/daemonrpc"
	"zapvm/internal/platform"
	"zapvm/internal/task"
)

func TestDaemonCollectsOnlyMatchingSucceededTaskArtifacts(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	output, _ := daemonrpc.ArtifactOutputPath("task-artifact")
	if err := os.MkdirAll(filepath.Join(workspace, filepath.FromSlash(output)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, filepath.FromSlash(output), "report.txt"), []byte("daemon artifact\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	computers, err := computer.Open(filepath.Join(root, "computers"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := computers.Create(computer.Record{
		ID: "computer-a", Workspace: workspace, Network: platform.NetworkOff, CPUCount: 2, MemoryMiB: 512,
	}); err != nil {
		t.Fatal(err)
	}
	tasks, err := task.Open(filepath.Join(root, "tasks"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := tasks.Create("task-artifact", "computer-a", strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := tasks.Append("task-artifact", task.Event{Type: "task.started"}); err != nil {
		t.Fatal(err)
	}
	ok := true
	if _, _, err := tasks.Append("task-artifact", task.Event{Type: "exec.result", OK: &ok}); err != nil {
		t.Fatal(err)
	}
	collector, err := artifactcollector.Open(filepath.Join(root, "spool"), artifactcollector.Options{})
	if err != nil {
		t.Fatal(err)
	}
	server := &daemonServer{computers: computers, taskStore: tasks, artifactCollector: collector}
	collection, err := server.collectComputerArtifacts(daemonrpc.ComputerArtifactCollectRequest{TaskID: "task-artifact", ComputerID: "computer-a"})
	if err != nil || len(collection.Artifacts) != 1 || collection.Artifacts[0].Path != "report.txt" || collection.Capability == "" {
		t.Fatalf("daemon Artifact collection = %#v, %v", collection, err)
	}
	var stream bytes.Buffer
	if err := server.streamComputerArtifact(daemonrpc.NewCodec(nil, &stream), "request-a", daemonrpc.ComputerArtifactOpenRequest{
		Capability: collection.Capability, ArtifactID: collection.Artifacts[0].ID,
	}); err != nil {
		t.Fatal(err)
	}
	reader := daemonrpc.NewCodec(&stream, io.Discard)
	accepted, err := reader.Read()
	if err != nil || accepted.Type != daemonrpc.TypeAccepted {
		t.Fatalf("Artifact accepted = %#v, %v", accepted, err)
	}
	chunkEnvelope, err := reader.Read()
	if err != nil || chunkEnvelope.Type != daemonrpc.TypeArtifactChunk {
		t.Fatalf("Artifact chunk envelope = %#v, %v", chunkEnvelope, err)
	}
	chunk, err := daemonrpc.DecodeArtifactChunk(chunkEnvelope.Payload)
	if err != nil || chunk.Offset != 0 || string(chunk.Data) != "daemon artifact\n" {
		t.Fatalf("Artifact chunk = %#v, %v", chunk, err)
	}
	endEnvelope, err := reader.Read()
	if err != nil || endEnvelope.Type != daemonrpc.TypeArtifactEnd {
		t.Fatalf("Artifact end envelope = %#v, %v", endEnvelope, err)
	}
	end, err := daemonrpc.DecodeArtifactEnd(endEnvelope.Payload)
	if err != nil || end.Size != uint64(len(chunk.Data)) || end.SHA256 != collection.Artifacts[0].SHA256 {
		t.Fatalf("Artifact end = %#v, %v", end, err)
	}
	if _, err := server.collectComputerArtifacts(daemonrpc.ComputerArtifactCollectRequest{TaskID: "task-artifact", ComputerID: "computer-b"}); err == nil {
		t.Fatal("daemon collected a Task through the wrong Computer")
	}
	if _, _, err := tasks.Create("task-running", "computer-a", strings.Repeat("b", 64)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := tasks.Append("task-running", task.Event{Type: "task.started"}); err != nil {
		t.Fatal(err)
	}
	if _, err := server.collectComputerArtifacts(daemonrpc.ComputerArtifactCollectRequest{TaskID: "task-running", ComputerID: "computer-a"}); err == nil {
		t.Fatal("daemon collected Artifacts before Task success")
	}
}
