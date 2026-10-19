package cloudplane

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

func TestAgentSessionOpenAPIContract(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "api", "agent-session-v1.openapi.json"))
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatalf("OpenAPI contract is not valid JSON: %v", err)
	}
	if document["openapi"] != "3.1.0" {
		t.Fatalf("openapi = %#v", document["openapi"])
	}
	info := contractObject(t, document, "info")
	if info["version"] != APIVersion+".0.0" {
		t.Fatalf("contract version = %#v, API version = %q", info["version"], APIVersion)
	}
	paths := contractObject(t, document, "paths")
	expectedOperations := map[string][]string{
		"/v1/agent/sessions":                                                    {"get", "post"},
		"/v1/agent/sessions/{id}":                                               {"get", "delete"},
		"/v1/agent/sessions/{id}/events":                                        {"get"},
		"/v1/agent/sessions/{id}/retry":                                         {"post"},
		"/v1/agent/sessions/{id}/stream":                                        {"get"},
		"/v1/agent/sessions/{id}/artifacts":                                     {"get"},
		"/v1/agent/artifacts/{artifact_id}":                                     {"get"},
		"/v1/agent/artifacts/{artifact_id}/download":                            {"get"},
		"/v1/agent/computers":                                                   {"get"},
		"/v1/agent/computers/{computer_id}/workspace/operations":                {"post"},
		"/v1/agent/computers/{computer_id}/workspace/operations/{operation_id}": {"get", "delete"},
		"/v1/agent/computers/{computer_id}/git/operations":                      {"post"},
		"/v1/agent/computers/{computer_id}/git/operations/{operation_id}":       {"get", "delete"},
		"/v1/agent/git/providers":                                               {"get"},
	}
	for path, methods := range expectedOperations {
		operations := contractObject(t, paths, path)
		for _, method := range methods {
			contractObject(t, operations, method)
		}
	}
	components := contractObject(t, document, "components")
	schemas := contractObject(t, components, "schemas")
	for _, name := range []string{"CreateAgentSession", "RetryAgentSession", "AgentSession", "AgentSessionList", "AgentSessionEvents", "AgentArtifact", "AgentArtifactList", "AgentArtifactDownload", "AgentComputer", "AgentComputerList", "CreateWorkspaceOperation", "AgentWorkspaceOperation", "CreateGitOperation", "AgentGitOperation", "GitPushResult", "WorkspaceListing", "WorkspaceFile", "WorkspaceDiff", "TaskEvent", "ErrorEnvelope", "APIError"} {
		contractObject(t, schemas, name)
	}
	create := contractObject(t, schemas, "CreateAgentSession")
	if create["additionalProperties"] != false {
		t.Fatal("CreateAgentSession must reject unknown fields")
	}
	errorSchema := contractObject(t, schemas, "APIError")
	errorProperties := contractObject(t, errorSchema, "properties")
	for _, name := range []string{"code", "category", "action", "retryable"} {
		if _, exists := errorProperties[name]; !exists {
			t.Fatalf("APIError contract is missing %q", name)
		}
	}
	response := contractObject(t, schemas, "AgentSession")
	properties := contractObject(t, response, "properties")
	for _, forbidden := range []string{"prompt", "payload", "argv", "credential_ids", "node_id", "node_generation", "lease_token", "lease_token_hash"} {
		if _, exists := properties[forbidden]; exists {
			t.Fatalf("public AgentSession contract exposes %q", forbidden)
		}
	}
	artifact := contractObject(t, schemas, "AgentArtifact")
	artifactProperties := contractObject(t, artifact, "properties")
	for _, forbidden := range []string{"tenant_id", "project_id", "node_id", "node_generation", "lease_token", "object_key", "download_url"} {
		if _, exists := artifactProperties[forbidden]; exists {
			t.Fatalf("public AgentArtifact contract exposes %q", forbidden)
		}
	}
}

func TestPublicGitOperationHasExactRedactedShape(t *testing.T) {
	view := publicAgentGitOperation(WorkspaceOperation{
		ID: "git-operation-a", TenantID: "private-tenant", ProjectID: "private-project", ComputerID: "computer-a",
		Kind: WorkspaceOperationGitPush, TaskID: "task-a", ProviderID: "github", Branch: "zapvm/git-operation-a",
		State: WorkspaceOperationLeased, Attempt: 1, CreatedAt: "2026-08-08T01:00:00Z", UpdatedAt: "2026-08-08T01:01:00Z",
		NodeID: "private-node", NodeGeneration: "private-generation", LeaseTokenHash: "private-lease",
	})
	data, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(data)
	for _, forbidden := range []string{"private-tenant", "private-project", "private-node", "private-generation", "private-lease", "lease_token", "node_id", "tenant_id", "project_id", "token", "clone_url", "base_branch"} {
		if contains(encoded, forbidden) {
			t.Fatalf("public Git operation contains sensitive value %q: %s", forbidden, encoded)
		}
	}
}

func TestPublicWorkspaceOperationHasExactRedactedShape(t *testing.T) {
	view := publicAgentWorkspaceOperation(WorkspaceOperation{
		ID: "operation-a", TenantID: "private-tenant", ProjectID: "private-project", ComputerID: "computer-a",
		Kind: WorkspaceOperationRead, Path: "README.md", State: WorkspaceOperationLeased, Attempt: 1,
		CreatedAt: "2026-08-07T01:00:00Z", UpdatedAt: "2026-08-07T01:01:00Z",
		NodeID: "private-node", NodeGeneration: "private-generation", LeaseTokenHash: "private-lease",
	})
	data, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(data)
	for _, forbidden := range []string{"private-tenant", "private-project", "private-node", "private-generation", "private-lease", "lease_token", "node_id", "tenant_id", "project_id"} {
		if contains(encoded, forbidden) {
			t.Fatalf("public workspace operation contains sensitive value %q: %s", forbidden, encoded)
		}
	}
}

func TestPublicAgentSessionHasExactRedactedShape(t *testing.T) {
	task := Task{
		ID: "turn-1", ComputerID: "computer-a", State: TaskRunning, Attempt: 1,
		CreatedAt: "2026-08-07T01:00:00Z", UpdatedAt: "2026-08-07T01:01:00Z",
		NodeID: "private-node", NodeGeneration: "private-generation", LeaseTokenHash: "private-lease",
		CredentialIDs: []string{"model-secret"},
		Payload:       []byte(`{"id":"turn-1","computer_id":"computer-a","command":{"id":"agent-turn-1","session_id":"session-a","title":"Safe project audit","argv":["/usr/local/sbin/zapvm-resident-agent","--","-p","private prompt"],"cwd":".","timeout_ms":1000}}`),
	}
	view, err := publicAgentSession(task)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	expected := []string{"attempt", "computer_id", "created_at", "id", "session_id", "state", "title", "updated_at"}
	if !reflect.DeepEqual(keys, expected) {
		t.Fatalf("public AgentSession keys = %v, want %v", keys, expected)
	}
	encoded := string(data)
	if view.Title != "Safe project audit" {
		t.Fatalf("public AgentSession title = %q", view.Title)
	}
	for _, forbidden := range []string{"private-node", "private-generation", "private-lease", "model-secret", "private prompt", "argv", "payload"} {
		if contains(encoded, forbidden) {
			t.Fatalf("public AgentSession contains sensitive value %q: %s", forbidden, encoded)
		}
	}
}

func contractObject(t *testing.T, parent map[string]any, key string) map[string]any {
	t.Helper()
	value, ok := parent[key]
	if !ok {
		t.Fatalf("contract is missing %q", key)
	}
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("contract %q is %T, want object", key, value)
	}
	return object
}

func contains(value, part string) bool {
	for index := 0; index+len(part) <= len(value); index++ {
		if value[index:index+len(part)] == part {
			return true
		}
	}
	return false
}
