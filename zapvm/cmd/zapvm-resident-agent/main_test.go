package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseOptionsAndCredentialEnvironment(t *testing.T) {
	parsed, err := parseOptions([]string{
		"--provider-base-url", "https://api.example.test/v1",
		"--model", "model-1",
		"--api-key-credential", "model-api-key",
		"--search-key-credential", "search-api-key",
		"--artifact-output-dir", "artifacts/turn-1",
		"--continue-session",
		"--prompt", "hello",
	})
	if err != nil {
		t.Fatal(err)
	}
	if parsed.model != "model-1" || parsed.artifactOutput != "artifacts/turn-1" || parsed.prompt != "hello" || !parsed.continueSession {
		t.Fatalf("parsed = %#v", parsed)
	}
	environment := mergeEnvironment([]string{"PATH=/bin", "ZAPVM_AGENT_API_KEY=host-secret"}, map[string]string{
		"ZAPVM_AGENT_API_KEY": "guest-secret", "ZAPVM_AGENT_MODEL": "model-1",
	})
	joined := strings.Join(environment, "\n")
	if strings.Contains(joined, "host-secret") || !strings.Contains(joined, "ZAPVM_AGENT_API_KEY=guest-secret") {
		t.Fatalf("environment = %q", joined)
	}
	terminal := strings.Join(withoutAgentSecrets(environment), "\n")
	if strings.Contains(terminal, "guest-secret") || strings.Contains(terminal, "ZAPVM_AGENT_") || !strings.Contains(terminal, "PATH=/bin") {
		t.Fatalf("terminal environment = %q", terminal)
	}
}

func TestReadCredentialRejectsSymlinkAndTrimsNewline(t *testing.T) {
	root := t.TempDir()
	valuePath := filepath.Join(root, "model-api-key")
	if err := os.WriteFile(valuePath, []byte("secret-value\n"), 0o400); err != nil {
		t.Fatal(err)
	}
	value, err := readCredential(root, "model-api-key")
	if err != nil || string(value) != "secret-value" {
		t.Fatalf("credential = %q, %v", value, err)
	}
	link := filepath.Join(root, "linked-key")
	if err := os.Symlink(valuePath, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readCredential(root, "linked-key"); err == nil {
		t.Fatal("resident Agent accepted a symlink credential")
	}
}

func TestParseOptionsRejectsUnsafeProviderAndMissingPrompt(t *testing.T) {
	_, err := parseOptions([]string{
		"--provider-base-url", "http://127.0.0.1:8080/v1",
		"--model", "model-1", "--api-key-credential", "model-api-key",
		"--artifact-output-dir", "artifacts/turn-1", "--prompt", "hello",
	})
	if err == nil {
		t.Fatal("resident Agent accepted an unsafe provider URL")
	}
	_, err = parseOptions([]string{
		"--provider-base-url", "https://api.example.test/v1",
		"--model", "model-1", "--api-key-credential", "model-api-key",
		"--artifact-output-dir", "artifacts/turn-1",
	})
	if err == nil {
		t.Fatal("resident Agent accepted a missing prompt")
	}
}

func TestArtifactOutputIsRequiredAndCanonical(t *testing.T) {
	base := []string{
		"--provider-base-url", "https://api.example.test/v1", "--model", "model-1",
		"--api-key-credential", "model-api-key", "--prompt", "hello",
	}
	if _, err := parseOptions(base); err == nil {
		t.Fatal("resident Agent accepted a missing Artifact output directory")
	}
	unsafe := append(append([]string(nil), base...), "--artifact-output-dir", "../escape")
	if _, err := parseOptions(unsafe); err == nil {
		t.Fatal("resident Agent accepted an escaping Artifact output directory")
	}
}

func TestResidentPreservesPromptAndSeparatesRuntimeFacts(t *testing.T) {
	for _, prompt := range []string{"build the package", "  用户请求\nretry the network if appropriate\n"} {
		config := residentConfig(options{prompt: prompt, model: "chosen-model", continueSession: true}, "/home/agent", []string{"PATH=/bin"}, map[string]string{
			"ZAPVM_ARTIFACT_DIR": "/workspace/artifacts/turn-1",
		}, io.Discard, io.Discard)
		if config.Prompt != prompt || config.Model != "chosen-model" || !config.Continue {
			t.Fatalf("resident changed Agent input: %#v", config)
		}
		if !strings.Contains(strings.Join(config.Env, "\n"), "ZAPVM_ARTIFACT_DIR=/workspace/artifacts/turn-1") {
			t.Fatal("runtime facts were lost")
		}
	}
}
