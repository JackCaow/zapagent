import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { integrationGitWriteRoots } from "./workspace-runtime.js";

/** Deliberately smaller than shell syntax: never evaluate substitutions, chains,
 * redirections or environment assignments with elevated Git metadata access. */
export function rootGitArguments(command: string): string[] | undefined {
  if (/[\r\n$`\0]/.test(command)) return;
  const words: string[] = [];
  let word = "", quote = "", active = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = "";
      else if (ch === "\\" && quote === '"') {
        const next = command[++i]; if (next === undefined || !['"', "\\"].includes(next)) return;
        word += next;
      } else word += ch;
    } else if (ch === "'" || ch === '"') { quote = ch; active = true; }
    else if (/\s/.test(ch)) { if (active) { words.push(word); word = ""; active = false; } }
    else if (/[;&|<>()[\]{}*?!#\\]/.test(ch)) return;
    else { word += ch; active = true; }
  }
  if (quote) return;
  if (active) words.push(word);
  if (words.shift() !== "git") return;
  const op = words.shift();
  if (!op || !["add", "commit", "stash", "rebase"].includes(op)) return;
  const flags: Record<string, Set<string>> = {
    add: new Set(["-A", "--all", "-u", "--update", "-f", "--force", "-v", "--verbose"]),
    commit: new Set(["-a", "--all", "--amend", "--no-edit", "--allow-empty", "-q", "--quiet", "-v", "--verbose"]),
    stash: new Set(["-u", "--include-untracked", "-a", "--all", "-k", "--keep-index", "-q", "--quiet", "--index"]),
    rebase: new Set(["--onto", "--root", "--autostash", "--no-autostash", "-q", "--quiet", "-v", "--verbose"]),
  };
  let paths = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--" && op !== "rebase") { paths = true; continue; }
    if (paths) continue;
    if ((op === "commit" || op === "stash") && ["-m", "--message", ...(op === "commit" ? ["-am", "-ma", "-qm"] : [])].includes(word)) {
      if (words[++i] === undefined) return;
      continue;
    }
    if (word.startsWith("-")) { if (!flags[op]!.has(word)) return; }
    else if (op === "rebase" && !/^[A-Za-z0-9_][A-Za-z0-9_./~^@{}-]*$/.test(word)) return;
  }
  if (op === "stash" && words[0] && !words[0].startsWith("-") && !["push", "pop", "apply", "drop", "list"].includes(words[0])) return;
  // Never permit commit to enter an editor or rebase to consume an existing
  // todo containing exec instructions. Fresh non-interactive rebase only.
  if (op === "commit" && !words.some(word => ["-m", "--message", "-am", "-ma", "-qm", "--no-edit"].includes(word))) return;
  if (op === "rebase" && !words.length) return;
  return [op, ...words];
}

export function trustedGitExecutable(): string {
  let path = process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe") : "/usr/bin/git";
  if (process.platform === "darwin") path = execFileSync("/usr/bin/xcrun", ["--find", "git"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  path = realpathSync(path);
  const file = statSync(path);
  if (!file.isFile() || (process.platform !== "win32" && (file.uid !== 0 || (file.mode & 0o022)))) throw new Error("Git integration requires a trusted system Git executable");
  return path;
}

export function rootGitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const empty = process.platform === "win32" ? "NUL" : "/dev/null";
  return { ...env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}

/** No Git helper may execute arbitrary code while Git metadata is writable.
 * Fail back to the ordinary sandbox for unsupported/executable repository config. */
export function prepareRootGit(command: string, workspace: string, cwd: string): { executable: string; args: string[]; environment: NodeJS.ProcessEnv } | undefined {
  const args = rootGitArguments(command);
  if (!args) return;
  const roots = integrationGitWriteRoots(workspace);
  if (!roots.length) return;
  const metadata = roots[0]!;
  if (["rebase-merge", "rebase-apply", "sequencer"].some(name => existsSync(join(metadata, name)))) return;
  // Nested repositories are not implicitly the authorized root repository.
  const executable = trustedGitExecutable();
  const environment = rootGitEnvironment();
  const top = execFileSync(executable, ["rev-parse", "--show-toplevel"], { cwd, env: environment, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (realpathSync(top) !== realpathSync(workspace)) return;
  const keys = execFileSync(executable, ["config", "--local", "--no-includes", "--null", "--name-only", "--list"], { cwd, env: environment, encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
  const safe = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|quotepath|autocrlf|safecrlf|symlinks|abbrev|hookspath|fsmonitor|editor)|user\.(?:name|email)|remote\..+\.(?:url|fetch|pushurl|glab-resolved-head)|branch\..+\.(?:remote|merge|rebase|vscode-merge-base)|commit\.gpgsign|tag\.gpgsign|extensions\.objectformat)$/i;
  if (keys.some(key => !safe.test(key))) return;
  // Preserve identity without loading executable global config into the Git
  // sandbox. Git config queries do not execute hooks, aliases or helpers.
  for (const field of ["name", "email"] as const) {
    let fallback: string | undefined;
    if (!keys.some(key => key.toLowerCase() === `user.${field}`)) {
      const host = { ...environment };
      delete host.GIT_CONFIG_GLOBAL;
      try { fallback = execFileSync(executable, ["config", "--global", "--null", "--get", `user.${field}`], { cwd, env: host, encoding: "utf8", timeout: 3000, maxBuffer: 8192, stdio: ["ignore", "pipe", "ignore"] }).replace(/\0$/, ""); }
      catch { /* Git reports a missing identity normally if none is configured. */ }
    }
    for (const role of ["AUTHOR", "COMMITTER"]) {
      const key = `GIT_${role}_${field.toUpperCase()}`;
      const value = process.env[key] ?? fallback;
      if (value !== undefined) environment[key] = value;
    }
  }
  const empty = process.platform === "win32" ? "NUL" : "/dev/null";
  return { executable, environment, args: ["--no-pager", "-c", `core.hooksPath=${empty}`, "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.editor=false", "-c", "sequence.editor=false", "-c", "submodule.recurse=false", "-c", "rebase.backend=apply", ...args] };
}
