package hostgit

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"zapvm/internal/daemonrpc"
)

const maxCommandOutput = 1 << 20

type Failure struct{ Code string }

func (failure *Failure) Error() string { return failure.Code }

func FailureCode(err error) string {
	var failure *Failure
	if errors.As(err, &failure) {
		return failure.Code
	}
	return "git_operation_failed"
}

type commandResult struct {
	output   []byte
	exitCode int
}

type commandRunner func(context.Context, string, []string, []string) (commandResult, error)

func Push(ctx context.Context, workspace string, request daemonrpc.ComputerGitPushRequest) (daemonrpc.GitPushResult, error) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_unavailable"}
	}
	gitPath, err = filepath.Abs(gitPath)
	if err != nil {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_unavailable"}
	}
	resolved, err := filepath.EvalSymlinks(gitPath)
	if err != nil {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_unavailable"}
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_unavailable"}
	}
	runner := func(ctx context.Context, directory string, environment, arguments []string) (commandResult, error) {
		command := exec.CommandContext(ctx, resolved, arguments...)
		command.Dir = directory
		command.Env = environment
		output := &boundedBuffer{maximum: maxCommandOutput}
		command.Stdout = output
		command.Stderr = output
		err := command.Run()
		result := commandResult{output: append([]byte(nil), output.Bytes()...), exitCode: 0}
		if output.exceeded {
			return commandResult{}, &Failure{Code: "git_output_exceeded"}
		}
		if err == nil {
			return result, nil
		}
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			result.exitCode = exitError.ExitCode()
			return result, nil
		}
		return commandResult{}, err
	}
	return push(ctx, workspace, request, runner)
}

func push(ctx context.Context, workspace string, request daemonrpc.ComputerGitPushRequest, runner commandRunner) (daemonrpc.GitPushResult, error) {
	if ctx == nil || runner == nil || !filepath.IsAbs(workspace) || len(workspace) > 32767 || strings.IndexByte(workspace, 0) >= 0 {
		return daemonrpc.GitPushResult{}, &Failure{Code: "invalid_worktree"}
	}
	info, err := os.Lstat(workspace)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return daemonrpc.GitPushResult{}, &Failure{Code: "invalid_worktree"}
	}
	workspace, err = filepath.EvalSymlinks(workspace)
	if err != nil {
		return daemonrpc.GitPushResult{}, &Failure{Code: "invalid_worktree"}
	}
	if err := validateGitDirectory(filepath.Join(workspace, ".git")); err != nil {
		return daemonrpc.GitPushResult{}, err
	}
	temporary, err := os.MkdirTemp("", "zapvm-git-operation-*")
	if err != nil {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_operation_failed"}
	}
	defer os.RemoveAll(temporary)
	if err := os.Chmod(temporary, 0o700); err != nil {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_operation_failed"}
	}
	hooks := filepath.Join(temporary, "hooks")
	if err := os.Mkdir(hooks, 0o700); err != nil {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_operation_failed"}
	}
	localEnvironment := gitEnvironment(temporary, hooks, nil)
	authEnvironment := gitEnvironment(temporary, hooks, request.Token)
	run := func(environment []string, arguments ...string) (commandResult, error) {
		select {
		case <-ctx.Done():
			return commandResult{}, ctx.Err()
		default:
		}
		return runner(ctx, workspace, environment, append([]string{"--no-optional-locks", "-C", workspace}, arguments...))
	}
	require := func(environment []string, code string, arguments ...string) ([]byte, error) {
		result, runErr := run(environment, arguments...)
		if runErr != nil || result.exitCode != 0 {
			return nil, &Failure{Code: code}
		}
		return bytes.TrimSpace(result.output), nil
	}
	root, err := require(localEnvironment, "invalid_worktree", "rev-parse", "--show-toplevel")
	if err != nil {
		return daemonrpc.GitPushResult{}, err
	}
	resolvedRoot, err := filepath.EvalSymlinks(string(root))
	if err != nil || !samePath(workspace, resolvedRoot) {
		return daemonrpc.GitPushResult{}, &Failure{Code: "invalid_worktree"}
	}
	unsafe, unsafeErr := run(localEnvironment, "config", "--local", "--name-only", "--get-regexp", `^(filter\..*\.(clean|process|smudge|required)|url\..*\.(insteadof|pushinsteadof)|http\..*|credential\..*|include(if)?\..*|core\.(worktree|attributesfile|askpass|sshcommand|gitproxy))$`)
	if unsafeErr != nil || (unsafe.exitCode != 0 && unsafe.exitCode != 1) || len(bytes.TrimSpace(unsafe.output)) != 0 {
		return daemonrpc.GitPushResult{}, &Failure{Code: "unsafe_git_config"}
	}
	currentBranch, _ := require(localEnvironment, "invalid_worktree", "symbolic-ref", "--short", "HEAD")
	originalBranch := string(currentBranch)
	marker := "ZapVM-Operation: " + request.OperationID
	if string(currentBranch) == request.Branch {
		message, messageErr := require(localEnvironment, "git_branch_conflict", "log", "-1", "--format=%B")
		if messageErr != nil || !containsLine(string(message), marker) {
			return daemonrpc.GitPushResult{}, &Failure{Code: "git_branch_conflict"}
		}
		sha, shaErr := require(localEnvironment, "git_operation_failed", "rev-parse", "HEAD")
		if shaErr != nil || !validObjectID(string(sha)) {
			return daemonrpc.GitPushResult{}, &Failure{Code: "git_operation_failed"}
		}
		return ensureRemote(ctx, request, string(sha), authEnvironment, run)
	}
	staged, stagedErr := run(localEnvironment, "diff", "--cached", "--quiet", "--no-ext-diff", "--")
	if stagedErr != nil || (staged.exitCode != 0 && staged.exitCode != 1) || staged.exitCode == 1 {
		return daemonrpc.GitPushResult{}, &Failure{Code: "dirty_git_index"}
	}
	base, baseErr := require(authEnvironment, "git_remote_unavailable", "ls-remote", "--exit-code", request.HTTPSCloneURL, "refs/heads/"+request.BaseBranch)
	if baseErr != nil {
		return daemonrpc.GitPushResult{}, baseErr
	}
	baseSHA, ok := singleRemoteObject(base, "refs/heads/"+request.BaseBranch)
	if !ok {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_remote_invalid"}
	}
	head, headErr := require(localEnvironment, "invalid_worktree", "rev-parse", "HEAD")
	if headErr != nil || string(head) != baseSHA {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_base_mismatch"}
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = run(localEnvironment, "reset", "--mixed", "HEAD", "--")
			if originalBranch != "" {
				_, _ = run(localEnvironment, "checkout", originalBranch)
			} else {
				_, _ = run(localEnvironment, "checkout", "--detach", baseSHA)
			}
			_, _ = run(localEnvironment, "branch", "-D", request.Branch)
		}
	}()
	added, addErr := run(localEnvironment, "add", "-A", "--", ".", ":(exclude,glob).zapcode/**", ":(exclude,glob)**/.zapcode/**")
	if addErr != nil || added.exitCode != 0 {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_stage_failed"}
	}
	names, err := require(localEnvironment, "git_stage_failed", "diff", "--cached", "--name-only", "-z", "--no-ext-diff", "--")
	if err != nil || containsProtectedName(names) {
		return daemonrpc.GitPushResult{}, &Failure{Code: "protected_path_staged"}
	}
	changed, changedErr := run(localEnvironment, "diff", "--cached", "--quiet", "--no-ext-diff", "--")
	if changedErr != nil || (changed.exitCode != 0 && changed.exitCode != 1) {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_operation_failed"}
	}
	if changed.exitCode == 0 {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_no_changes"}
	}
	if _, err := require(localEnvironment, "git_branch_conflict", "checkout", "-b", request.Branch); err != nil {
		return daemonrpc.GitPushResult{}, err
	}
	commitMessage := "zapVM Agent operation " + request.OperationID
	created, createErr := run(localEnvironment, "commit", "--no-verify", "-m", commitMessage, "-m", marker)
	if createErr != nil || created.exitCode != 0 {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_commit_failed"}
	}
	committed = true
	sha, err := require(localEnvironment, "git_operation_failed", "rev-parse", "HEAD")
	if err != nil || !validObjectID(string(sha)) {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_operation_failed"}
	}
	return ensureRemote(ctx, request, string(sha), authEnvironment, run)
}

func ensureRemote(_ context.Context, request daemonrpc.ComputerGitPushRequest, sha string, environment []string, run func([]string, ...string) (commandResult, error)) (daemonrpc.GitPushResult, error) {
	remote, err := run(environment, "ls-remote", request.HTTPSCloneURL, "refs/heads/"+request.Branch)
	if err != nil || remote.exitCode != 0 {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_remote_unavailable"}
	}
	if len(bytes.TrimSpace(remote.output)) != 0 {
		remoteSHA, ok := singleRemoteObject(remote.output, "refs/heads/"+request.Branch)
		if !ok || remoteSHA != sha {
			return daemonrpc.GitPushResult{}, &Failure{Code: "git_remote_branch_conflict"}
		}
		return daemonrpc.GitPushResult{OperationID: request.OperationID, Branch: request.Branch, CommitSHA: sha}, nil
	}
	pushed, pushErr := run(environment, "push", "--porcelain", request.HTTPSCloneURL, "HEAD:refs/heads/"+request.Branch)
	if pushErr != nil || pushed.exitCode != 0 {
		return daemonrpc.GitPushResult{}, &Failure{Code: "git_push_failed"}
	}
	return daemonrpc.GitPushResult{OperationID: request.OperationID, Branch: request.Branch, CommitSHA: sha}, nil
}

func gitEnvironment(temporary, hooks string, token []byte) []string {
	environment := []string{
		"PATH=" + os.Getenv("PATH"), "HOME=" + temporary, "XDG_CONFIG_HOME=" + temporary,
		"TMPDIR=" + temporary, "TMP=" + temporary, "TEMP=" + temporary,
		"LANG=C", "LC_ALL=C", "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=Never",
	}
	settings := [][2]string{
		{"core.hooksPath", hooks}, {"credential.helper", ""}, {"commit.gpgSign", "false"}, {"core.fsmonitor", "false"},
		{"protocol.file.allow", "never"}, {"protocol.ext.allow", "never"}, {"http.followRedirects", "false"},
		{"http.sslVerify", "true"}, {"http.proxy", ""}, {"user.name", "zapVM Agent"},
		{"user.email", "zapvm-agent@users.noreply.github.com"},
	}
	if len(token) != 0 {
		authority := []byte("x-access-token:")
		authority = append(authority, token...)
		settings = append(settings, [2]string{"http.extraHeader", "Authorization: Basic " + base64.StdEncoding.EncodeToString(authority)})
		for index := range authority {
			authority[index] = 0
		}
	}
	environment = append(environment, fmt.Sprintf("GIT_CONFIG_COUNT=%d", len(settings)))
	for index, setting := range settings {
		environment = append(environment, fmt.Sprintf("GIT_CONFIG_KEY_%d=%s", index, setting[0]), fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", index, setting[1]))
	}
	return environment
}

type boundedBuffer struct {
	bytes.Buffer
	maximum  int
	exceeded bool
}

func (buffer *boundedBuffer) Write(data []byte) (int, error) {
	if buffer.exceeded {
		return len(data), nil
	}
	remaining := buffer.maximum - buffer.Len()
	if remaining <= 0 {
		buffer.exceeded = true
		return len(data), nil
	}
	toWrite := data
	if len(toWrite) > remaining {
		toWrite = toWrite[:remaining]
		buffer.exceeded = true
	}
	_, _ = buffer.Buffer.Write(toWrite)
	return len(data), nil
}

func samePath(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
	}
	return filepath.Clean(left) == filepath.Clean(right)
}

func containsLine(value, expected string) bool {
	for _, line := range strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n") {
		if line == expected {
			return true
		}
	}
	return false
}

func validObjectID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func singleRemoteObject(output []byte, reference string) (string, bool) {
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) != 1 {
		return "", false
	}
	fields := strings.Fields(lines[0])
	returnValue := ""
	if len(fields) == 2 && fields[1] == reference && validObjectID(fields[0]) {
		returnValue = fields[0]
	}
	return returnValue, returnValue != ""
}

func containsProtectedName(names []byte) bool {
	for _, name := range bytes.Split(names, []byte{0}) {
		clean := filepath.ToSlash(string(name))
		if clean == ".git" || clean == ".zapcode" || strings.HasPrefix(clean, ".git/") || strings.HasPrefix(clean, ".zapcode/") ||
			strings.HasSuffix(clean, "/.git") || strings.HasSuffix(clean, "/.zapcode") || strings.Contains(clean, "/.git/") || strings.Contains(clean, "/.zapcode/") {
			return true
		}
	}
	return false
}

func validateGitDirectory(root string) error {
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return &Failure{Code: "invalid_worktree"}
	}
	entries := 0
	err = filepath.WalkDir(root, func(_ string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		entries++
		if entries > 100000 {
			return errors.New("Git metadata entry limit exceeded")
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("Git metadata contains a symlink")
		}
		return nil
	})
	if err != nil {
		return &Failure{Code: "unsafe_git_metadata"}
	}
	return nil
}
