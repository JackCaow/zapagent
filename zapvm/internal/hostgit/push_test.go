package hostgit

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"zapvm/internal/daemonrpc"
)

const (
	baseObject = "1111111111111111111111111111111111111111"
	newObject  = "2222222222222222222222222222222222222222"
)

func TestPushUsesFixedBranchProtectedPathAndEnvironment(t *testing.T) {
	workspace := realWorkspace(t)
	request := gitRequest()
	quietCalls := 0
	committed := false
	remoteCalls := 0
	runner := func(_ context.Context, directory string, environment, arguments []string) (commandResult, error) {
		if directory != workspace || len(arguments) < 4 || arguments[0] != "--no-optional-locks" || arguments[1] != "-C" || arguments[2] != workspace {
			t.Fatalf("unsafe command context: dir=%q args=%q", directory, arguments)
		}
		joinedArgs := strings.Join(arguments, " ")
		if strings.Contains(joinedArgs, string(request.Token)) || strings.Contains(joinedArgs, base64.StdEncoding.EncodeToString(request.Token)) {
			t.Fatal("credential entered Git argv")
		}
		command := arguments[3:]
		switch command[0] {
		case "rev-parse":
			if command[1] == "--show-toplevel" {
				return success(workspace + "\n"), nil
			}
			if committed {
				return success(newObject + "\n"), nil
			}
			return success(baseObject + "\n"), nil
		case "config":
			assertNoAuthorization(t, environment, request.Token)
			return commandResult{exitCode: 1}, nil
		case "symbolic-ref":
			return success("main\n"), nil
		case "diff":
			if contains(command, "--name-only") {
				return success("README.md\x00src/main.go\x00"), nil
			}
			quietCalls++
			if quietCalls == 1 {
				return commandResult{exitCode: 0}, nil
			}
			return commandResult{exitCode: 1}, nil
		case "ls-remote":
			remoteCalls++
			assertAuthorization(t, environment, request.Token)
			if strings.HasSuffix(command[len(command)-1], "/main") {
				return success(baseObject + "\trefs/heads/main\n"), nil
			}
			return success(""), nil
		case "add":
			assertNoAuthorization(t, environment, request.Token)
			joined := strings.Join(command, " ")
			if !strings.Contains(joined, ":(exclude,glob).zapcode/**") || !strings.Contains(joined, ":(exclude,glob)**/.zapcode/**") {
				t.Fatalf("protected path exclusions missing: %q", command)
			}
			return success(""), nil
		case "checkout":
			if strings.Join(command, " ") != "checkout -b zapvm/git-operation-1" {
				t.Fatalf("unexpected checkout %q", command)
			}
			return success(""), nil
		case "commit":
			if !contains(command, "--no-verify") || !contains(command, "ZapVM-Operation: git-operation-1") {
				t.Fatalf("unsafe commit command %q", command)
			}
			committed = true
			return success(""), nil
		case "push":
			assertAuthorization(t, environment, request.Token)
			if strings.Join(command, " ") != "push --porcelain https://github.com/example/repository.git HEAD:refs/heads/zapvm/git-operation-1" {
				t.Fatalf("unexpected push %q", command)
			}
			return success(""), nil
		default:
			t.Fatalf("unexpected Git command %q", command)
		}
		return commandResult{}, nil
	}
	result, err := push(context.Background(), workspace, request, runner)
	if err != nil || result.OperationID != request.OperationID || result.Branch != request.Branch || result.CommitSHA != newObject || remoteCalls != 2 {
		t.Fatalf("result=%#v remoteCalls=%d err=%v", result, remoteCalls, err)
	}
}

func TestPushRetryDoesNotCreateDuplicateCommitOrPush(t *testing.T) {
	workspace := realWorkspace(t)
	request := gitRequest()
	commands := make([]string, 0)
	runner := func(_ context.Context, _ string, environment, arguments []string) (commandResult, error) {
		command := arguments[3:]
		commands = append(commands, command[0])
		switch command[0] {
		case "rev-parse":
			if command[1] == "--show-toplevel" {
				return success(workspace + "\n"), nil
			}
			return success(newObject + "\n"), nil
		case "config":
			return commandResult{exitCode: 1}, nil
		case "symbolic-ref":
			return success(request.Branch + "\n"), nil
		case "log":
			return success("zapVM Agent operation\n\nZapVM-Operation: " + request.OperationID + "\n"), nil
		case "ls-remote":
			assertAuthorization(t, environment, request.Token)
			return success(newObject + "\trefs/heads/" + request.Branch + "\n"), nil
		default:
			t.Fatalf("retry executed mutating command %q", command)
		}
		return commandResult{}, nil
	}
	result, err := push(context.Background(), workspace, request, runner)
	if err != nil || result.CommitSHA != newObject || contains(commands, "commit") || contains(commands, "push") {
		t.Fatalf("result=%#v commands=%v err=%v", result, commands, err)
	}
}

func TestPushRejectsUnsafeConfigBeforeUsingCredential(t *testing.T) {
	workspace := realWorkspace(t)
	request := gitRequest()
	authorized := false
	runner := func(_ context.Context, _ string, environment, arguments []string) (commandResult, error) {
		if environmentHasAuthorization(environment) {
			authorized = true
		}
		command := arguments[3:]
		if command[0] == "rev-parse" {
			return success(workspace + "\n"), nil
		}
		if command[0] == "config" {
			return success("filter.evil.clean\n"), nil
		}
		t.Fatalf("unexpected command %q", command)
		return commandResult{}, nil
	}
	_, err := push(context.Background(), workspace, request, runner)
	if FailureCode(err) != "unsafe_git_config" || authorized {
		t.Fatalf("failure=%v authorized=%t", err, authorized)
	}
}

func TestProtectedNameDetection(t *testing.T) {
	for _, value := range []string{".zapcode/secret\x00", "nested/.git/config\x00", "nested/.zapcode\x00"} {
		if !containsProtectedName([]byte(value)) {
			t.Fatalf("protected name accepted: %q", value)
		}
	}
	if containsProtectedName([]byte("src/git/client.go\x00")) {
		t.Fatal("ordinary name rejected")
	}
}

func TestGitMetadataSymlinkIsRejected(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation may require Windows developer mode")
	}
	workspace := realWorkspace(t)
	if err := os.Symlink(filepath.Join(workspace, "outside"), filepath.Join(workspace, ".git", "objects")); err != nil {
		t.Fatal(err)
	}
	if code := FailureCode(validateGitDirectory(filepath.Join(workspace, ".git"))); code != "unsafe_git_metadata" {
		t.Fatalf("failure code=%q", code)
	}
}

func gitRequest() daemonrpc.ComputerGitPushRequest {
	return daemonrpc.ComputerGitPushRequest{
		OperationID: "git-operation-1", ComputerID: "computer-a", Owner: "example", Repository: "repository",
		BaseBranch: "main", Branch: "zapvm/git-operation-1", HTTPSCloneURL: "https://github.com/example/repository.git",
		Token: []byte("ghs_variable_length_test_token_2026"),
	}
}

func realWorkspace(t *testing.T) string {
	t.Helper()
	path, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(path, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func success(output string) commandResult { return commandResult{output: []byte(output), exitCode: 0} }

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func environmentHasAuthorization(environment []string) bool {
	for _, value := range environment {
		if strings.Contains(value, "Authorization: Basic ") {
			return true
		}
	}
	return false
}

func assertAuthorization(t *testing.T, environment []string, token []byte) {
	t.Helper()
	expected := "Authorization: Basic " + base64.StdEncoding.EncodeToString(append([]byte("x-access-token:"), token...))
	if !containsEnvironmentValue(environment, expected) || containsEnvironmentValue(environment, string(token)) {
		t.Fatalf("authorization environment boundary failed")
	}
}

func assertNoAuthorization(t *testing.T, environment []string, token []byte) {
	t.Helper()
	if environmentHasAuthorization(environment) || containsEnvironmentValue(environment, string(token)) {
		t.Fatal("local Git command received credential")
	}
}

func containsEnvironmentValue(environment []string, target string) bool {
	for _, value := range environment {
		if strings.Contains(value, target) {
			return true
		}
	}
	return false
}
