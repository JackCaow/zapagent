package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"zapvm/internal/acpclient"
	"zapvm/internal/credential"
)

const layeredACPAgent = "/opt/zapvm-agent/bin/agent"

type options struct {
	providerBaseURL  string
	model            string
	apiKeyCredential string
	searchCredential string
	continueSession  bool
	artifactOutput   string
	prompt           string
}

func main() {
	if err := run(context.Background(), os.Args[1:], os.Environ(), os.Getenv, os.Stdout, os.Stderr); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "zapvm-resident-agent: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, arguments, environment []string, getenv func(string) string, stdout, stderr io.Writer) error {
	parsed, err := parseOptions(arguments)
	if err != nil {
		return err
	}
	credentialRoot := getenv("ZAPVM_CREDENTIAL_DIR")
	apiKey, err := readCredential(credentialRoot, parsed.apiKeyCredential)
	if err != nil {
		return fmt.Errorf("load model credential: %w", err)
	}
	defer credential.ZeroBytes(apiKey)
	artifactDirectory, err := prepareArtifactOutput(parsed.artifactOutput)
	if err != nil {
		return err
	}
	agentValues := map[string]string{
		"ZAPVM_AGENT_PROVIDER_BASE_URL": parsed.providerBaseURL,
		"ZAPVM_AGENT_MODEL":             parsed.model,
		"ZAPVM_AGENT_API_KEY":           string(apiKey),
		"ZAPVM_ARTIFACT_DIR":            artifactDirectory,
	}
	if parsed.searchCredential != "" {
		searchKey, err := readCredential(credentialRoot, parsed.searchCredential)
		if err != nil {
			return fmt.Errorf("load search credential: %w", err)
		}
		defer credential.ZeroBytes(searchKey)
		agentValues["ZAPVM_AGENT_SEARCH_KEY"] = string(searchKey)
	}
	home := getenv("HOME")
	if !filepath.IsAbs(home) {
		return errors.New("Resident Agent HOME must be absolute")
	}
	_, err = acpclient.Run(ctx, residentConfig(parsed, home, environment, agentValues, stdout, stderr))
	return err
}

// Transport configuration is not an Agent policy. Preserve the user's prompt
// exactly; runtime facts travel separately in the package environment.
func residentConfig(parsed options, home string, environment []string, agentValues map[string]string, stdout, stderr io.Writer) acpclient.Config {
	return acpclient.Config{
		AgentPath:   layeredACPAgent,
		Workspace:   "/workspace",
		StateDir:    filepath.Join(home, ".zapvm", "acp"),
		Prompt:      parsed.prompt,
		Continue:    parsed.continueSession,
		Model:       parsed.model,
		Env:         mergeEnvironment(environment, agentValues),
		TerminalEnv: withoutAgentSecrets(environment),
		Output:      stdout,
		Stderr:      stderr,
	}
}

func parseOptions(arguments []string) (options, error) {
	flags := flag.NewFlagSet("zapvm-resident-agent", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var result options
	flags.StringVar(&result.providerBaseURL, "provider-base-url", "", "provider HTTPS base URL")
	flags.StringVar(&result.model, "model", "", "provider model")
	flags.StringVar(&result.apiKeyCredential, "api-key-credential", "", "credential ID containing the model API key")
	flags.StringVar(&result.searchCredential, "search-key-credential", "", "optional credential ID containing the search API key")
	flags.BoolVar(&result.continueSession, "continue-session", false, "resume this zapVM Session through ACP")
	flags.StringVar(&result.artifactOutput, "artifact-output-dir", "", "workspace-relative Host-collected Artifact output directory")
	flags.StringVar(&result.prompt, "prompt", "", "Agent prompt")
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 {
		return options{}, errors.New("invalid resident Agent arguments")
	}
	parsedURL, err := url.Parse(result.providerBaseURL)
	if err != nil || parsedURL.Scheme != "https" || parsedURL.Host == "" || parsedURL.User != nil || parsedURL.RawQuery != "" || parsedURL.Fragment != "" {
		return options{}, errors.New("provider base URL is invalid")
	}
	if len(result.providerBaseURL) > 2048 || result.model == "" || len(result.model) > 256 || strings.IndexByte(result.model, 0) >= 0 {
		return options{}, errors.New("provider model is invalid")
	}
	if result.prompt == "" || len(result.prompt) > acpclient.MaxPromptSize/2 || strings.IndexByte(result.prompt, 0) >= 0 {
		return options{}, errors.New("Agent prompt is invalid")
	}
	if !credential.ValidID(result.apiKeyCredential) || (result.searchCredential != "" && (!credential.ValidID(result.searchCredential) || result.searchCredential == result.apiKeyCredential)) {
		return options{}, errors.New("credential ID is invalid")
	}
	if result.artifactOutput == "" || len(result.artifactOutput) > 512 || path.Clean(result.artifactOutput) != result.artifactOutput ||
		strings.HasPrefix(result.artifactOutput, "/") || strings.HasPrefix(result.artifactOutput, "../") || strings.Contains(result.artifactOutput, "\\") ||
		strings.IndexByte(result.artifactOutput, 0) >= 0 {
		return options{}, errors.New("Artifact output directory is invalid")
	}
	return result, nil
}

func prepareArtifactOutput(relative string) (string, error) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		return "", errors.New("resolve Resident Agent workspace")
	}
	destination := filepath.Join(workingDirectory, filepath.FromSlash(relative))
	if err := os.MkdirAll(destination, 0o700); err != nil {
		return "", errors.New("create Artifact output directory")
	}
	info, err := os.Lstat(destination)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("Artifact output directory is not a real directory")
	}
	return destination, nil
}

func readCredential(root, id string) ([]byte, error) {
	if !filepath.IsAbs(root) || !credential.ValidID(id) {
		return nil, errors.New("credential directory or ID is invalid")
	}
	valuePath := filepath.Join(root, id)
	info, err := os.Lstat(valuePath)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > credential.MaxValueSize {
		return nil, errors.New("credential must be a bounded regular file")
	}
	value, err := os.ReadFile(valuePath)
	if err != nil {
		return nil, err
	}
	value = []byte(strings.TrimSpace(string(value)))
	if len(value) == 0 {
		return nil, errors.New("credential is empty")
	}
	return value, nil
}

func mergeEnvironment(current []string, values map[string]string) []string {
	result := make([]string, 0, len(current)+len(values))
	for _, entry := range current {
		key, _, found := strings.Cut(entry, "=")
		if found {
			if _, replaced := values[key]; replaced {
				continue
			}
		}
		result = append(result, entry)
	}
	for key, value := range values {
		result = append(result, key+"="+value)
	}
	return result
}

func withoutAgentSecrets(current []string) []string {
	result := make([]string, 0, len(current))
	for _, entry := range current {
		key, _, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		upper := strings.ToUpper(key)
		if strings.HasPrefix(upper, "ZAPVM_") || strings.HasPrefix(upper, "DIMCODE_") ||
			strings.Contains(upper, "CREDENTIAL") || strings.Contains(upper, "API_KEY") || strings.Contains(upper, "TOKEN") || upper == "OPENAI_BASE_URL" {
			continue
		}
		result = append(result, entry)
	}
	return result
}
