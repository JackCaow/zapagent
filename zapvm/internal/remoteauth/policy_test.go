package remoteauth

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

const testPrincipal = "spiffe://example.test/tenant/acme/project/weather/client/codex"

func testPolicyFile() PolicyFile {
	return PolicyFile{
		SchemaVersion: PolicySchemaVersion, TrustDomain: "example.test", NodeID: "host-a",
		Grants: []Grant{{
			Principal:   testPrincipal,
			Permissions: []string{"computer.list", "computer.inspect", "computer.exec", "computer.task.submit"},
			ComputerIDs: []string{"computer-a", "computer-b"}, CredentialIDs: []string{"github"},
		}},
	}
}

func TestCompilePolicyAuthorizesExactScope(t *testing.T) {
	policy, err := CompilePolicy(testPolicyFile())
	if err != nil {
		t.Fatal(err)
	}
	if policy.NodeURI() != "spiffe://example.test/node/host-a" || policy.NodeID() != "host-a" {
		t.Fatalf("unexpected node identity %q", policy.NodeURI())
	}
	identity, ok := policy.Identity(testPrincipal)
	if !ok || identity.TenantID != "acme" || identity.ProjectID != "weather" || identity.ClientID != "codex" {
		t.Fatalf("unexpected identity %#v", identity)
	}
	if err := policy.Authorize(testPrincipal, "computer.exec", "computer-a", []string{"github"}); err != nil {
		t.Fatal(err)
	}
	for name, authorize := range map[string]func() error{
		"principal": func() error {
			return policy.Authorize("spiffe://example.test/tenant/acme/project/weather/client/other", "computer.exec", "computer-a", nil)
		},
		"permission": func() error { return policy.Authorize(testPrincipal, "computer.stop", "computer-a", nil) },
		"computer":   func() error { return policy.Authorize(testPrincipal, "computer.exec", "computer-c", nil) },
		"credential": func() error {
			return policy.Authorize(testPrincipal, "computer.exec", "computer-a", []string{"production"})
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := authorize(); err == nil || err.Error() != "remote access denied" {
				t.Fatalf("expected uniform denial, got %v", err)
			}
		})
	}
}

func TestCompilePolicyRejectsWildcardAndUnknownPermission(t *testing.T) {
	file := testPolicyFile()
	file.Grants[0].ComputerIDs = []string{"*"}
	if _, err := CompilePolicy(file); err == nil {
		t.Fatal("expected wildcard Computer ID rejection")
	}
	file = testPolicyFile()
	file.Grants[0].Permissions = []string{"daemon.shutdown"}
	if _, err := CompilePolicy(file); err == nil {
		t.Fatal("expected unknown permission rejection")
	}
}

func TestIdentityParsingIsCanonical(t *testing.T) {
	identity, err := ParseClientIdentity(testPrincipal, "example.test")
	if err != nil || identity.URI != testPrincipal {
		t.Fatalf("parse identity: %#v %v", identity, err)
	}
	invalid := []string{
		"https://example.test/tenant/acme/project/weather/client/codex",
		"spiffe://other.test/tenant/acme/project/weather/client/codex",
		"spiffe://example.test/tenant/acme/project/weather/client/codex/extra",
		"spiffe://example.test/tenant/acme/project/weather/client/%63odex",
	}
	for _, raw := range invalid {
		if _, err := ParseClientIdentity(raw, "example.test"); err == nil {
			t.Fatalf("expected %q to be rejected", raw)
		}
	}
	if trustDomain, nodeID, err := ParseNodeIdentity("spiffe://example.test/node/host-a"); err != nil || trustDomain != "example.test" || nodeID != "host-a" {
		t.Fatalf("parse node identity: %q %q %v", trustDomain, nodeID, err)
	}
}

func TestLoadPolicyRequiresOwnerOnlyFile(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "policy.json")
	data := []byte(`{"schema_version":1,"trust_domain":"example.test","node_id":"host-a","grants":[{"principal":"spiffe://example.test/tenant/acme/project/weather/client/codex","permissions":["computer.inspect"],"computer_ids":["computer-a"]}]}`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadPolicy(path); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadPolicy(path); err == nil {
			t.Fatal("expected group-readable policy rejection")
		}
		if err := os.Chmod(path, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(path, append(data[:len(data)-1], []byte(`,"unknown":true}`)...), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadPolicy(path); err == nil {
		t.Fatal("expected unknown policy field rejection")
	}
}
