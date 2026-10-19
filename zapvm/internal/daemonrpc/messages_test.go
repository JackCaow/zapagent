package daemonrpc

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"zapvm/internal/platform"
)

func validExecRequest() ExecRequest {
	return ExecRequest{
		Workspace: "/workspace", Network: platform.NetworkOff,
		Command: Command{ID: "command", SessionID: "session", Argv: []string{"/bin/true"}, TimeoutMillis: 1000},
	}
}

func TestExecRequestValidation(t *testing.T) {
	if err := validExecRequest().Validate(); err != nil {
		t.Fatal(err)
	}
	mutations := []func(*ExecRequest){
		func(request *ExecRequest) { request.ComputerID = "bad\x00id" },
		func(request *ExecRequest) { request.Workspace = "bad\x00path" },
		func(request *ExecRequest) { request.Network = "bridge" },
		func(request *ExecRequest) { request.AllowedDomains = []string{"example.com"} },
		func(request *ExecRequest) { request.Network = platform.NetworkRestricted },
		func(request *ExecRequest) { request.Command.Argv = nil },
		func(request *ExecRequest) { request.Command.Argv = []string{""} },
		func(request *ExecRequest) { request.Command.TimeoutMillis = 0 },
		func(request *ExecRequest) { request.Command.TimeoutMillis = 86400001 },
		func(request *ExecRequest) { request.Command.CredentialIDs = []string{"token", "token"} },
		func(request *ExecRequest) { request.Command.ProtectedWorkspacePaths = []string{"../escape"} },
		func(request *ExecRequest) { request.Command.ProtectedWorkspacePaths = []string{".git", ".git"} },
		func(request *ExecRequest) { request.Command.DeniedWorkspacePatterns = []string{"../escape"} },
	}
	for index, mutate := range mutations {
		request := validExecRequest()
		mutate(&request)
		if err := request.Validate(); err == nil {
			t.Fatalf("invalid mutation %d was accepted", index)
		}
	}
	restricted := validExecRequest()
	restricted.Network = platform.NetworkRestricted
	restricted.AllowedDomains = []string{"example.com"}
	if err := restricted.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestComputerRequestValidation(t *testing.T) {
	request := ComputerCreateRequest{Computer: ComputerSpec{
		ID: "project-a", Agent: "zapcode@1.12.0+arm64", Workspace: "/workspace", Network: platform.NetworkRestricted,
		AllowedDomains: []string{"github.com"}, AllowedPorts: []uint16{443},
	}}
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeComputerCreate(data); err != nil {
		t.Fatal(err)
	}
	request.Computer.Agent = "zapcode@bad/version"
	data, _ = json.Marshal(request)
	if _, err := DecodeComputerCreate(data); err == nil {
		t.Fatal("invalid Computer Agent reference was accepted")
	}
	request.Computer.Agent = "zapcode@1.12.0"
	request.Computer.RuntimeState = "running"
	data, _ = json.Marshal(request)
	if _, err := DecodeComputerCreate(data); err == nil {
		t.Fatal("client-owned runtime state was accepted")
	}
	exec := ComputerExecRequest{ID: "project-a", Command: validExecRequest().Command}
	data, _ = json.Marshal(exec)
	if _, err := DecodeComputerExec(data); err != nil {
		t.Fatal(err)
	}
	workspace := ComputerWorkspaceRequest{ComputerID: "project-a", Path: "src/main.go"}
	data, _ = json.Marshal(workspace)
	if _, err := DecodeComputerWorkspaceRequest(data); err != nil {
		t.Fatal(err)
	}
	workspace.Path = strings.Repeat("x", 4097)
	data, _ = json.Marshal(workspace)
	if _, err := DecodeComputerWorkspaceRequest(data); err == nil {
		t.Fatal("oversized workspace path was accepted")
	}
}

func TestComputerGitPushValidation(t *testing.T) {
	request := ComputerGitPushRequest{
		OperationID: "git-operation-1", ComputerID: "computer-a", Owner: "example", Repository: "repository",
		BaseBranch: "main", Branch: "zapvm/git-operation-1", HTTPSCloneURL: "https://github.com/example/repository.git",
		Token: []byte("ghs_variable_length_test_token_2026"),
	}
	encode := func(value ComputerGitPushRequest) []byte {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	if decoded, err := DecodeComputerGitPush(encode(request)); err != nil || !bytes.Equal(decoded.Token, request.Token) {
		t.Fatalf("decoded=%#v err=%v", decoded, err)
	}
	for name, mutate := range map[string]func(*ComputerGitPushRequest){
		"direct protected branch": func(candidate *ComputerGitPushRequest) { candidate.Branch = "main" },
		"credential in URL": func(candidate *ComputerGitPushRequest) {
			candidate.HTTPSCloneURL = "https://token@github.com/example/repository.git"
		},
		"wrong repository": func(candidate *ComputerGitPushRequest) {
			candidate.HTTPSCloneURL = "https://github.com/example/other.git"
		},
		"non HTTPS": func(candidate *ComputerGitPushRequest) {
			candidate.HTTPSCloneURL = "http://github.com/example/repository.git"
		},
		"short token":      func(candidate *ComputerGitPushRequest) { candidate.Token = []byte("short") },
		"token whitespace": func(candidate *ComputerGitPushRequest) { candidate.Token = []byte("ghs_token with whitespace") },
		"unsafe base":      func(candidate *ComputerGitPushRequest) { candidate.BaseBranch = "refs/../main" },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := request
			candidate.Token = append([]byte(nil), request.Token...)
			mutate(&candidate)
			if _, err := DecodeComputerGitPush(encode(candidate)); err == nil {
				t.Fatal("unsafe Git push request accepted")
			}
		})
	}
}

func TestComputerTaskRequestValidation(t *testing.T) {
	submit := ComputerTaskSubmitRequest{ComputerID: "project-a", Command: validExecRequest().Command}
	data, _ := json.Marshal(submit)
	if _, err := DecodeComputerTaskSubmit(data); err != nil {
		t.Fatal(err)
	}
	submit.ID = "../escape"
	data, _ = json.Marshal(submit)
	if _, err := DecodeComputerTaskSubmit(data); err == nil {
		t.Fatal("unsafe Task ID was accepted")
	}
	attach := ComputerTaskAttachRequest{ID: "task-a", AfterCursor: 100001, Follow: true}
	data, _ = json.Marshal(attach)
	if _, err := DecodeComputerTaskAttach(data); err == nil {
		t.Fatal("oversized Task cursor was accepted")
	}
	retry := ComputerTaskRetryRequest{SourceID: "task-a", ID: "task-b", Command: validExecRequest().Command}
	data, _ = json.Marshal(retry)
	if _, err := DecodeComputerTaskRetry(data); err != nil {
		t.Fatal(err)
	}
	retry.ID = retry.SourceID
	data, _ = json.Marshal(retry)
	if _, err := DecodeComputerTaskRetry(data); err == nil {
		t.Fatal("retry reused the source Task ID")
	}
	prune := ComputerTaskPruneRequest{RetentionMillis: uint64(time.Hour.Milliseconds()), Limit: 100}
	data, _ = json.Marshal(prune)
	if _, err := DecodeComputerTaskPrune(data); err != nil {
		t.Fatal(err)
	}
	prune.RetentionMillis = 1
	data, _ = json.Marshal(prune)
	if _, err := DecodeComputerTaskPrune(data); err == nil {
		t.Fatal("unsafe Task retention was accepted")
	}
}

func TestCredentialedComputerTaskRequiresExactBoundValues(t *testing.T) {
	task := ComputerTaskSubmitRequest{
		ID: "task-credential", ComputerID: "project-a",
		Command: Command{ID: "command-credential", SessionID: "session-credential", Argv: []string{"/bin/true"}, CredentialIDs: []string{"model-key", "search-key"}, TimeoutMillis: 1000},
	}
	request := ComputerTaskCredentialSubmitRequest{Task: task, Values: map[string][]byte{"model-key": []byte("model-secret"), "search-key": []byte("search-secret")}}
	encode := func(candidate ComputerTaskCredentialSubmitRequest) []byte {
		data, err := json.Marshal(candidate)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	decoded, err := DecodeComputerTaskCredentialSubmit(encode(request))
	if err != nil || !bytes.Equal(decoded.Values["model-key"], request.Values["model-key"]) {
		t.Fatalf("credentialed Task decoded=%#v err=%v", decoded, err)
	}
	for name, mutate := range map[string]func(*ComputerTaskCredentialSubmitRequest){
		"missing": func(candidate *ComputerTaskCredentialSubmitRequest) { delete(candidate.Values, "search-key") },
		"extra":   func(candidate *ComputerTaskCredentialSubmitRequest) { candidate.Values["other-key"] = []byte("secret") },
		"empty":   func(candidate *ComputerTaskCredentialSubmitRequest) { candidate.Values["model-key"] = nil },
		"mismatch": func(candidate *ComputerTaskCredentialSubmitRequest) {
			candidate.Task.Command.CredentialIDs = []string{"other-key", "search-key"}
		},
	} {
		t.Run(name, func(t *testing.T) {
			candidate := ComputerTaskCredentialSubmitRequest{Task: request.Task, Values: map[string][]byte{}}
			for id, value := range request.Values {
				candidate.Values[id] = append([]byte(nil), value...)
			}
			mutate(&candidate)
			if _, err := DecodeComputerTaskCredentialSubmit(encode(candidate)); err == nil {
				t.Fatal("invalid credentialed Task was accepted")
			}
		})
	}
}

func TestArtifactOutputAndCollectionRequestAreTaskBound(t *testing.T) {
	output, err := ArtifactOutputPath("task-a")
	if err != nil || output != "artifacts/task-a" {
		t.Fatalf("Artifact output = %q, %v", output, err)
	}
	if _, err := ArtifactOutputPath("../escape"); err == nil {
		t.Fatal("escaping Artifact Task ID was accepted")
	}
	encoded, err := json.Marshal(ComputerArtifactCollectRequest{TaskID: "task-a", ComputerID: "computer-a"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeComputerArtifactCollect(encoded); err != nil {
		t.Fatal(err)
	}
	encoded, _ = json.Marshal(ComputerArtifactCollectRequest{TaskID: "task-a", ComputerID: "../escape"})
	if _, err := DecodeComputerArtifactCollect(encoded); err == nil {
		t.Fatal("unsafe Artifact collection Computer ID was accepted")
	}
	collection := ArtifactCollection{
		Capability: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32)), ExpiresAt: "2026-08-08T05:15:00Z",
		Artifacts: []CollectedArtifact{{
			ID: "artifact-a", Path: "report.txt", ContentType: "text/plain; charset=utf-8", Size: 3,
			SHA256: strings.Repeat("a", 64),
		}},
	}
	encoded, _ = json.Marshal(collection)
	if _, err := DecodeArtifactCollection(encoded); err != nil {
		t.Fatal(err)
	}
	collection.Capability = "not-a-capability"
	encoded, _ = json.Marshal(collection)
	if _, err := DecodeArtifactCollection(encoded); err == nil {
		t.Fatal("invalid Artifact capability was accepted")
	}
}

func TestDecodeExecRejectsUnknownFields(t *testing.T) {
	request := validExecRequest()
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeExec(data); err != nil {
		t.Fatal(err)
	}
	unknown := strings.TrimSuffix(string(data), "}") + `,"unknown":true}`
	if _, err := DecodeExec([]byte(unknown)); err == nil {
		t.Fatal("unknown exec field was accepted")
	}
}

func FuzzExecRequestValidation(f *testing.F) {
	seed, _ := json.Marshal(validExecRequest())
	f.Add(seed)
	f.Add([]byte(`{"workspace":"/w","network":"off","command":{}}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > MaxFrameSize {
			data = data[:MaxFrameSize]
		}
		request, err := DecodeExec(data)
		if err == nil {
			if err := request.Validate(); err != nil {
				t.Fatalf("DecodeExec accepted invalid request: %v", err)
			}
		}
	})
}
