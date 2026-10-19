package relayprotocol

import (
	"bytes"
	"testing"

	"zapvm/internal/daemonrpc"
)

func TestRelayFramesAreStrictAndTaskScoped(t *testing.T) {
	open := Open{SchemaVersion: SchemaVersion, Type: TypeOpen, Generation: "generation-a", LeaseToken: "lease-a", FirstBatchID: 7}
	data, err := Encode(open)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Open
	if err := Decode(data, &decoded); err != nil || decoded.Validate() != nil {
		t.Fatalf("decoded open=%#v err=%v", decoded, err)
	}
	if err := Decode(append(bytes.TrimSuffix(data, []byte("}")), []byte(`,"extra":true}`)...), &decoded); err == nil {
		t.Fatal("unknown Relay field was accepted")
	}
	batch := EventBatch{SchemaVersion: SchemaVersion, Type: TypeEventBatch, BatchID: 7, Events: []daemonrpc.ComputerTaskEvent{{
		Cursor: 1, TaskID: "task-a", Type: "exec.output", Stream: "stdout", Data: []byte("ok\n"),
	}}}
	if err := batch.Validate("task-a", 7); err != nil {
		t.Fatal(err)
	}
	batch.Events[0].TaskID = "task-b"
	if err := batch.Validate("task-a", 7); err == nil {
		t.Fatal("cross-Task Relay event was accepted")
	}
}
