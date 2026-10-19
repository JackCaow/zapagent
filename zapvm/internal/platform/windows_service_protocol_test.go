package platform

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

type shortWindowsServiceWriter struct{ bytes.Buffer }

func (writer *shortWindowsServiceWriter) Write(payload []byte) (int, error) {
	if len(payload) > 3 {
		payload = payload[:3]
	}
	return writer.Buffer.Write(payload)
}

func TestWindowsServiceFrameRoundTrip(t *testing.T) {
	request := windowsServiceRequest{
		Version: windowsServiceProtocolVersion, Operation: windowsServiceOpStart,
		Spec: &Spec{ID: "test", CPUCount: 2, MemoryBytes: 512 * MiB, KernelPath: "/kernel", RootDiskPath: "/root"},
	}
	var frame bytes.Buffer
	if err := writeWindowsServiceFrame(&frame, request); err != nil {
		t.Fatal(err)
	}
	var decoded windowsServiceRequest
	if err := readWindowsServiceFrame(&frame, &decoded); err != nil {
		t.Fatal(err)
	}
	if err := decoded.validate(); err != nil {
		t.Fatal(err)
	}
	if decoded.Spec == nil || decoded.Spec.ID != "test" {
		t.Fatalf("decoded request = %#v", decoded)
	}
}

func TestWindowsServiceFrameHandlesShortWrites(t *testing.T) {
	var frame shortWindowsServiceWriter
	response := windowsServiceResponse{Version: windowsServiceProtocolVersion, OK: true}
	if err := writeWindowsServiceFrame(&frame, response); err != nil {
		t.Fatal(err)
	}
	var decoded windowsServiceResponse
	if err := readWindowsServiceFrame(&frame.Buffer, &decoded); err != nil {
		t.Fatal(err)
	}
	if !decoded.OK || decoded.Version != windowsServiceProtocolVersion {
		t.Fatalf("decoded response = %#v", decoded)
	}
}

func TestWindowsServiceFrameRejectsUnknownFields(t *testing.T) {
	payload := []byte(`{"version":1,"operation":"ping","unexpected":true}`)
	var frame bytes.Buffer
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(payload)))
	frame.Write(header[:])
	frame.Write(payload)
	var request windowsServiceRequest
	if err := readWindowsServiceFrame(&frame, &request); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("read error = %v, want unknown field", err)
	}
}

func TestWindowsServiceFrameRejectsTrailingJSON(t *testing.T) {
	payload := []byte(`{"version":1,"operation":"ping"} {}`)
	var frame bytes.Buffer
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(payload)))
	frame.Write(header[:])
	frame.Write(payload)
	var request windowsServiceRequest
	if err := readWindowsServiceFrame(&frame, &request); err == nil || !strings.Contains(err.Error(), "trailing JSON") {
		t.Fatalf("read error = %v, want trailing JSON", err)
	}
}

func TestWindowsServiceFrameRejectsOversize(t *testing.T) {
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], windowsServiceMaxFrame+1)
	var request windowsServiceRequest
	if err := readWindowsServiceFrame(bytes.NewReader(header[:]), &request); err == nil {
		t.Fatal("oversize frame unexpectedly accepted")
	}
}

func TestWindowsServiceRequestValidation(t *testing.T) {
	tests := []windowsServiceRequest{
		{},
		{Version: 1, Operation: windowsServiceOpStart},
		{Version: 1, Operation: windowsServiceOpStop},
		{Version: 1, Operation: windowsServiceOpQuery, VMID: "vm", Spec: &Spec{}},
		{Version: 1, Operation: "delete-everything"},
	}
	for _, request := range tests {
		if err := request.validate(); err == nil {
			t.Fatalf("invalid request accepted: %#v", request)
		}
	}
	if err := (windowsServiceRequest{Version: 1, Operation: windowsServiceOpPing}).validate(); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsServiceResponseValidation(t *testing.T) {
	spec := &Spec{ID: "vm-one"}
	tests := []struct {
		name     string
		request  windowsServiceRequest
		response windowsServiceResponse
		valid    bool
	}{
		{"ping", windowsServiceRequest{Operation: windowsServiceOpPing}, windowsServiceResponse{Version: 1, OK: true}, true},
		{"ping-vm-fields", windowsServiceRequest{Operation: windowsServiceOpPing}, windowsServiceResponse{Version: 1, OK: true, VMID: "x"}, false},
		{"start", windowsServiceRequest{Operation: windowsServiceOpStart, Spec: spec}, windowsServiceResponse{Version: 1, OK: true, VMID: "guid", ID: "vm-one", State: StateRunning}, true},
		{"start-empty", windowsServiceRequest{Operation: windowsServiceOpStart, Spec: spec}, windowsServiceResponse{Version: 1, OK: true}, false},
		{"query", windowsServiceRequest{Operation: windowsServiceOpQuery, VMID: "guid"}, windowsServiceResponse{Version: 1, OK: true, VMID: "guid", ID: "vm-one", State: StateStopping}, true},
		{"pause", windowsServiceRequest{Operation: windowsServiceOpPause, VMID: "guid"}, windowsServiceResponse{Version: 1, OK: true, VMID: "guid", ID: "vm-one", State: StatePaused}, true},
		{"resume", windowsServiceRequest{Operation: windowsServiceOpResume, VMID: "guid"}, windowsServiceResponse{Version: 1, OK: true, VMID: "guid", ID: "vm-one", State: StateRunning}, true},
		{"query-wrong-vm", windowsServiceRequest{Operation: windowsServiceOpQuery, VMID: "guid"}, windowsServiceResponse{Version: 1, OK: true, VMID: "other", ID: "vm-one", State: StateRunning}, false},
		{"query-unknown-state", windowsServiceRequest{Operation: windowsServiceOpQuery, VMID: "guid"}, windowsServiceResponse{Version: 1, OK: true, VMID: "guid", ID: "vm-one", State: State("surprise")}, false},
		{"error", windowsServiceRequest{Operation: windowsServiceOpPing}, windowsServiceResponse{Version: 1, Error: "failed"}, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.response.validateFor(test.request)
			if test.valid && err != nil {
				t.Fatal(err)
			}
			if !test.valid && err == nil {
				t.Fatal("invalid response was accepted")
			}
		})
	}
}
