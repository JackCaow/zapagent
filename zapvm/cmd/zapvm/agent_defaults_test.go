package main

import "testing"

func TestAgentDefaultsFollowInstalledImageRoot(t *testing.T) {
	t.Setenv(agentRootEnvironment, "")
	t.Setenv(agentPublicKeyEnvironment, "")
	t.Setenv(imageRootEnvironment, "/opt/zapvm/images")
	t.Setenv(imagePublicKeyEnvironment, "/opt/zapvm/image-public.pem")
	root, key := agentDefaults()
	if root != "/opt/zapvm/agents" || key != "/opt/zapvm/agent-public.pem" {
		t.Fatalf("Agent defaults = %q, %q", root, key)
	}
}

func TestAgentDefaultsPreferExplicitEnvironment(t *testing.T) {
	t.Setenv(agentRootEnvironment, " /srv/zapvm/agents ")
	t.Setenv(agentPublicKeyEnvironment, " /srv/zapvm/agent.pem ")
	t.Setenv(imageRootEnvironment, "/opt/zapvm/images")
	root, key := agentDefaults()
	if root != "/srv/zapvm/agents" || key != "/srv/zapvm/agent.pem" {
		t.Fatalf("Agent defaults = %q, %q", root, key)
	}
}

func TestAgentDefaultsFillMissingValueFromImageInstall(t *testing.T) {
	t.Setenv(agentRootEnvironment, "/srv/zapvm/agents")
	t.Setenv(agentPublicKeyEnvironment, "")
	t.Setenv(imageRootEnvironment, "/opt/zapvm/images")
	root, key := agentDefaults()
	if root != "/srv/zapvm/agents" || key != "/opt/zapvm/agent-public.pem" {
		t.Fatalf("Agent defaults = %q, %q", root, key)
	}
}
