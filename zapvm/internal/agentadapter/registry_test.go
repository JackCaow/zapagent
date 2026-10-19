package agentadapter

import (
	"io"
	"strings"
	"testing"
)

type testProtocol struct {
	name  string
	match bool
}

func (protocol testProtocol) Name() string      { return protocol.name }
func (protocol testProtocol) Match([]byte) bool { return protocol.match }
func (protocol testProtocol) Decode([]byte) (Request, error) {
	return Request{RequestID: protocol.name}, nil
}
func (protocol testProtocol) EncodeResult(io.Writer, Request, Result) error {
	return nil
}

func TestRegistrySelectsOneProtocol(t *testing.T) {
	registry, err := NewRegistry(testProtocol{name: "one", match: false}, testProtocol{name: "two", match: true})
	if err != nil {
		t.Fatal(err)
	}
	protocol, request, err := registry.Decode([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if protocol.Name() != "two" || request.Protocol != "two" || request.RequestID != "two" {
		t.Fatalf("unexpected registry result: %s %+v", protocol.Name(), request)
	}
	if names := registry.Names(); len(names) != 2 || names[0] != "one" || names[1] != "two" {
		t.Fatalf("unexpected protocol names: %v", names)
	}
}

func TestRegistryRejectsDuplicateAndAmbiguousProtocols(t *testing.T) {
	if _, err := NewRegistry(testProtocol{name: "same"}, testProtocol{name: "same"}); err == nil {
		t.Fatal("duplicate protocol was accepted")
	}
	registry, err := NewRegistry(testProtocol{name: "one", match: true}, testProtocol{name: "two", match: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := registry.Decode(nil); err == nil || !strings.Contains(err.Error(), "ambiguously") {
		t.Fatalf("ambiguous protocol was accepted: %v", err)
	}
}
