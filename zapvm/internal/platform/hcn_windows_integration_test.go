//go:build windows && integration

package platform

import "testing"

func TestHCNNATNetworkAndEndpoint(t *testing.T) {
	manager := newHCNManager()
	t.Cleanup(func() {
		if err := manager.Close(); err != nil {
			t.Errorf("close HCN manager: %v", err)
		}
	})
	attachment, cleanup, err := manager.CreateEndpoint(deterministicVMID(t.Name()), t.Name())
	if err != nil {
		t.Fatal(err)
	}
	if attachment.EndpointID == "" || attachment.NICID == "" || attachment.MACAddress == "" ||
		attachment.IPAddress == "" || attachment.PrefixBits == 0 || attachment.Gateway == "" {
		t.Fatalf("incomplete HCN attachment: %+v", attachment)
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
}
