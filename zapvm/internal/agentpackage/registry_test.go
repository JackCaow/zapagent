package agentpackage

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestInstallActivateAndResolveAgent(t *testing.T) {
	source, publicKey, _ := testPackage(t, "zapcode", "1.12.0", runtime.GOARCH)
	root := filepath.Join(t.TempDir(), "agents")
	installed, err := Install(root, filepath.Join(source, ManifestName), filepath.Join(source, SignatureName), publicKey)
	if err != nil {
		t.Fatal(err)
	}
	if installed.Reference != "zapcode@1.12.0" || installed.Manifest.Entrypoint != "/opt/zapvm-agent/bin/agent" || installed.Digest == "" {
		t.Fatalf("installed = %+v", installed)
	}
	contract := RuntimeContract{Protocol: 1, StateSchema: 3, AgentAdapter: "acp-resident-v1"}
	activation, err := Activate(root, installed.Reference, publicKey, runtime.GOOS, runtime.GOARCH, contract)
	if err != nil {
		t.Fatal(err)
	}
	if activation.Generation != 1 || activation.ID != "zapcode" {
		t.Fatalf("activation = %+v", activation)
	}
	active, err := ResolveActive(root, publicKey, runtime.GOOS, runtime.GOARCH, contract)
	if err != nil || active.Reference != installed.Reference || active.DiskPath == "" {
		t.Fatalf("active = %+v, %v", active, err)
	}
	listed, err := List(root, publicKey, runtime.GOOS, runtime.GOARCH)
	if err != nil || len(listed) != 1 || listed[0].Reference != installed.Reference {
		t.Fatalf("list = %+v, %v", listed, err)
	}
}

func TestAgentRejectsTamperAndIncompatibleRuntime(t *testing.T) {
	source, publicKey, _ := testPackage(t, "zapcode", "1.12.0", runtime.GOARCH)
	if _, _, _, err := Verify(filepath.Join(source, ManifestName), filepath.Join(source, SignatureName), publicKey, source); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "agent.raw"), []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := Verify(filepath.Join(source, ManifestName), filepath.Join(source, SignatureName), publicKey, source); err == nil {
		t.Fatal("tampered Agent disk was accepted")
	}

	source, publicKey, _ = testPackage(t, "zapcode", "1.12.0", runtime.GOARCH)
	root := filepath.Join(t.TempDir(), "agents")
	if _, err := Install(root, filepath.Join(source, ManifestName), filepath.Join(source, SignatureName), publicKey); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(root, "zapcode@1.12.0", publicKey, runtime.GOOS, runtime.GOARCH, RuntimeContract{Protocol: 2, StateSchema: 3, AgentAdapter: "acp-resident-v1"}); err == nil {
		t.Fatal("Agent with incompatible Runtime protocol was accepted")
	}
	if _, err := Resolve(root, "zapcode@1.12.0", publicKey, runtime.GOOS, runtime.GOARCH, RuntimeContract{Protocol: 1, StateSchema: 4, AgentAdapter: "acp-resident-v1"}); err == nil {
		t.Fatal("Agent with incompatible state schema was accepted")
	}
	if _, err := Resolve(root, "zapcode@1.12.0", publicKey, runtime.GOOS, runtime.GOARCH, RuntimeContract{Protocol: 1, StateSchema: 3}); err == nil {
		t.Fatal("Agent without a matching Runtime adapter was accepted")
	}
}

func TestAgentRejectsVersionCollisionAndCorruptActivation(t *testing.T) {
	source, publicKey, privateKey := testPackage(t, "zapcode", "1.12.0", runtime.GOARCH)
	root := filepath.Join(t.TempDir(), "agents")
	if _, err := Install(root, filepath.Join(source, ManifestName), filepath.Join(source, SignatureName), publicKey); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(source, ManifestName)
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.CreatedAt = "2026-08-13T00:00:01Z"
	data, _ = json.Marshal(manifest)
	if err := os.WriteFile(manifestPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, SignatureName), ed25519.Sign(privateKey, data), 0o644); err != nil {
		t.Fatal(err)
	}
	// The source is now a different, validly signed manifest under the same
	// immutable identity; installation must not replace the existing package.
	if _, err := Install(root, manifestPath, filepath.Join(source, SignatureName), publicKey); err == nil {
		t.Fatal("different bytes under an installed id@version were accepted")
	}
	if err := os.WriteFile(filepath.Join(root, ActivationName), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Activate(root, "zapcode@1.12.0", publicKey, runtime.GOOS, runtime.GOARCH, RuntimeContract{Protocol: 1, StateSchema: 3, AgentAdapter: "acp-resident-v1"}); err == nil {
		t.Fatal("corrupt activation state was silently replaced")
	}
}

func TestValidateRegistryRejectsMissingRootAndKey(t *testing.T) {
	root := filepath.Join(t.TempDir(), "missing")
	if _, err := ValidateRegistry(root, filepath.Join(t.TempDir(), "missing.pem"), runtime.GOOS, runtime.GOARCH); err == nil {
		t.Fatal("missing Agent registry was accepted")
	}
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateRegistry(root, filepath.Join(t.TempDir(), "missing.pem"), runtime.GOOS, runtime.GOARCH); err == nil {
		t.Fatal("missing Agent public key was accepted")
	}
}

func TestParseReference(t *testing.T) {
	for _, invalid := range []string{"", "zapcode", "zap@", "../zap@1", "zap@1@2"} {
		if _, _, err := ParseReference(invalid); err == nil {
			t.Fatalf("invalid reference %q was accepted", invalid)
		}
	}
}

func testPackage(t *testing.T, id, version, architecture string) (string, string, ed25519.PrivateKey) {
	t.Helper()
	directory := t.TempDir()
	files := map[string][]byte{
		"agent.raw":  []byte("raw-agent-disk"),
		"agent.vhdx": []byte("vhdx-agent-disk"),
	}
	provenance := Provenance{SchemaVersion: 1, AgentVersion: version, SourceCommit: "0123456789abcdef0123456789abcdef01234567", BuildTarget: "test", BuilderVersion: "1", BinarySHA256: hex.EncodeToString(make([]byte, 32))}
	provenanceData, _ := json.Marshal(provenance)
	files["agent-provenance.json"] = provenanceData
	manifest := Manifest{SchemaVersion: 1, ID: id, Version: version, Architecture: architecture, CreatedAt: "2026-08-13T00:00:00Z", RuntimeProtocol: 1, Adapter: "acp-resident-v1", MinStateSchema: 3, MaxStateSchema: 3, Entrypoint: "/opt/zapvm-agent/bin/agent"}
	for _, name := range []string{"agent.raw", "agent.vhdx", "agent-provenance.json"} {
		digest := sha256Bytes(files[name])
		manifest.Files = append(manifest.Files, ManifestFile{Name: name, Size: int64(len(files[name])), SHA256: digest})
		if err := os.WriteFile(filepath.Join(directory, name), files[name], 0o644); err != nil {
			t.Fatal(err)
		}
	}
	manifestData, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(directory, ManifestName), manifestData, 0o644); err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, SignatureName), ed25519.Sign(private, manifestData), 0o644); err != nil {
		t.Fatal(err)
	}
	publicDER, _ := x509.MarshalPKIXPublicKey(public)
	publicPath := filepath.Join(directory, "agent-public.pem")
	if err := os.WriteFile(publicPath, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER}), 0o644); err != nil {
		t.Fatal(err)
	}
	return directory, publicPath, private
}

func sha256Bytes(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}
