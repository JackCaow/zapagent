package main

import "testing"

func TestConfiguredImageDefaults(t *testing.T) {
	t.Setenv(imageRootEnvironment, " /opt/zapvm/images ")
	t.Setenv(imagePublicKeyEnvironment, " /opt/zapvm/image-public.pem\n")
	root, publicKey := configuredImageDefaults()
	if root != "/opt/zapvm/images" || publicKey != "/opt/zapvm/image-public.pem" {
		t.Fatalf("defaults = %q, %q", root, publicKey)
	}
}

func TestVerifyRequiresInstalledAgentComputer(t *testing.T) {
	t.Setenv(imageRootEnvironment, "")
	t.Setenv(imagePublicKeyEnvironment, "")
	if err := runVerify(nil); err == nil {
		t.Fatal("verify without an installed image unexpectedly succeeded")
	}
}
