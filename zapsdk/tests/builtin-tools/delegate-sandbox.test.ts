import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { delegateAgentTool } from "../../builtin-tools/delegate.js";
import { createPlatformSandbox } from "../../execution/sandbox.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { createCapabilityGrant } from "../../policy/engine.js";

const sandbox = createPlatformSandbox();
const acceptance = process.platform !== "win32" && sandbox.status().available ? describe : describe.skip;
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

acceptance("sandboxed Claude delegate runtime", () => {
  it("stages, commits and merges in a linked worktree without writing common config or hooks", async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-linked-delegate-"));
    const main = join(root, "main"), cwd = join(root, "linked"), stateDir = join(root, "state");
    const git = (args: string[]) => {
      const r = spawnSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
      expect(r.status).toBe(0); return r.stdout.trim();
    };
    try {
      git(["init", "-q", main]);
      git(["-C", main, "-c", "user.name=T", "-c", "user.email=t@localhost", "commit", "--allow-empty", "-qm", "init"]);
      git(["-C", main, "worktree", "add", "-qb", "delegate-test", cwd]);
      const config = readFileSync(join(main, ".git", "config"), "utf8");
      const bin = join(cwd, "fake-claude.sh");
      writeFileSync(bin, ["#!/bin/sh", "set -eu", "printf test > proof.txt", "git add proof.txt",
        "git -c user.name=T -c user.email=t@localhost commit -qm implemented",
        "git checkout -qb integration-test", "printf merged > merged.txt", "git add merged.txt",
        "git -c user.name=T -c user.email=t@localhost commit -qm followup",
        "git checkout -q delegate-test", "git merge --ff-only integration-test",
        `if printf bad >> ${quote(join(main, ".git", "config"))} 2>/dev/null; then exit 30; fi`,
        `if printf bad > ${quote(join(main, ".git", "hooks", "post-commit"))} 2>/dev/null; then exit 31; fi`,
        'printf \'%s\\n\' \'{"type":"system","subtype":"init","session_id":"linked-session"}\' \'{"type":"result","subtype":"success","result":"LINKED_OK"}\'',
      ].join("\n")); chmodSync(bin, 0o755);
      const tool = delegateAgentTool({ providers: [{ name: "claude", bin }], stateDir, defaultCwd: cwd, timeoutMs: 10000 })!;
      const registry = new ToolRegistry(); registry.register(tool);
      const executor = new ToolExecutor(registry, { cwd, onApproval: async () => true,
        executionBroker: new DefaultExecutionBroker({ sandbox, sandboxMode: "required" }) });
      const result = await executor.execute("delegate_agent", { provider: "claude", task: "develop" });
      expect(result.error).toBeUndefined(); expect(result.success).toBe(true);
      expect(readFileSync(join(cwd, "merged.txt"), "utf8")).toBe("merged");
      expect(readFileSync(join(main, ".git", "config"), "utf8")).toBe(config);
      expect(existsSync(join(main, ".git", "hooks", "post-commit"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30000);
  (process.platform === "darwin" ? it : it.skip)("allows approved delegate Git integration and zsh heredocs without exposing host auth or unrelated paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-delegate-git-"));
    const cwd = join(root, "workspace"), stateDir = join(root, "state"), credentials = join(root, "credentials");
    const originalHome = process.env.CODEX_HOME;
    mkdirSync(cwd); mkdirSync(credentials); mkdirSync(join(cwd, ".zapcode"));
    writeFileSync(join(credentials, "auth.json"), "host-secret");
    writeFileSync(join(cwd, ".zapcode", "config.json"), "protected");
    process.env.CODEX_HOME = credentials;
    const bin = join(cwd, "fake-codex.sh");
    const git = spawnSync("git", ["init", "-q", cwd]);
    expect(git.status).toBe(0);
    writeFileSync(bin, [
      "#!/bin/zsh", "set -eu",
      'test "$(cat "$CODEX_HOME/auth.json")" = host-secret',
      'if printf changed > "$CODEX_HOME/auth.json" 2>/dev/null; then exit 30; fi',
      'if printf changed > .zapcode/config.json 2>/dev/null; then exit 31; fi',
      `if printf forbidden > ${quote(join(root, "outside"))} 2>/dev/null; then exit 32; fi`,
      'if [ "$2" = resume ]; then test "$(cat "$CODEX_HOME/session")" = persisted; fi',
      'printf persisted > "$CODEX_HOME/session"',
      // zsh must create a temporary file for this heredoc (not just a pipe).
      `cat > proof.txt <<'EOF'\n${"heredoc-regression\n".repeat(1000)}EOF`,
      'git add proof.txt',
      'git -c user.name=Test -c user.email=test@localhost commit --allow-empty -qm delegate',
      'printf \'%s\\n\' \'{"type":"thread.started","thread_id":"private-codex-session"}\' \'{"type":"item.completed","item":{"type":"agent_message","text":"DONE"}}\'',
    ].join("\n"));
    chmodSync(bin, 0o755);
    const tool = delegateAgentTool({ providers: [{ name: "codex", bin }], stateDir, defaultCwd: cwd, timeoutMs: 10000 })!;
    const registry = new ToolRegistry(); registry.register(tool);
    const executor = new ToolExecutor(registry, { cwd, onApproval: async () => true,
      executionBroker: new DefaultExecutionBroker({ sandbox, sandboxMode: "required" }) });
    try {
      const first = await executor.execute("delegate_agent", { provider: "codex", task: "first" });
      expect(first.error).toBeUndefined();
      expect(first.success).toBe(true);
      expect(first.error).toBeUndefined();
      expect(first.runtime?.broker?.sandboxEnforced).toBe(true);
      expect(first.output).toContain("temporary files were cleaned up");
      expect(readFileSync(join(cwd, "proof.txt"), "utf8")).toBe("heredoc-regression\n".repeat(1000));
      expect(readFileSync(join(credentials, "auth.json"), "utf8")).toBe("host-secret");
      expect(readFileSync(join(cwd, ".zapcode", "config.json"), "utf8")).toBe("protected");
      expect(existsSync(join(root, "outside"))).toBe(false);
      // A fresh process sees the same private session state, not host CODEX_HOME.
      writeFileSync(join(cwd, "proof.txt"), "changed");
      const resumed = await executor.execute("delegate_agent", { provider: "codex", task: "resume", resume_session_id: "private-codex-session" });
      expect(resumed.success).toBe(true);
      expect((resumed.meta as { resumed: boolean }).resumed).toBe(true);
      const log = spawnSync("git", ["-C", cwd, "log", "-1", "--format=%s"], { encoding: "utf8" });
      expect(log.stdout.trim()).toBe("delegate");
      // Even an explicit filesystem write grant cannot silently grant Git
      // control-plane access to an ordinary shell process.
      const effects = tool.definition.resolveEffects!({ provider: "codex" }, { cwd, toolName: "delegate_agent" });
      const context = sandbox.createContext({ executionId: "ordinary-shell", workspace: { root: cwd }, effects,
        grant: createCapabilityGrant("ordinary", effects, Date.now() + 10000) });
      const prepared = context.prepareShell("touch .git/ordinary-shell-must-fail", { cwd });
      try {
        const denied = spawnSync(prepared.executable, prepared.args, { cwd, env: prepared.env });
        expect(denied.status).not.toBe(0);
        expect(existsSync(join(cwd, ".git", "ordinary-shell-must-fail"))).toBe(false);
      } finally { prepared.release(); }
    } finally {
      if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
  it("persists only private CLI state across resume, maps temp, and denies unrelated/control-plane writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-delegate-sandbox-"));
    const cwd = join(root, "workspace"), stateDir = join(root, "private-state");
    const outside = join(root, "forbidden.txt"), bin = join(cwd, "fake-claude.sh");
    mkdirSync(cwd); mkdirSync(join(cwd, ".zapcode"));
    writeFileSync(join(cwd, ".zapcode", "settings.json"), "original");
    writeFileSync(bin, [
      "#!/bin/sh", "set -eu",
      '[ "$CLAUDE_CODE_TMPDIR" = "$TMPDIR" ]',
      '[ -z "$CLAUDE_SECURESTORAGE_CONFIG_DIR" ]',
      'printf temp > "$CLAUDE_CODE_TMPDIR/claude-runtime"',
      'if [ "$5" = "--resume" ]; then test "$(cat "$CLAUDE_CONFIG_DIR/session")" = persisted; fi',
      'printf persisted > "$CLAUDE_CONFIG_DIR/session"',
      `if printf forbidden > ${quote(outside)} 2>/dev/null; then exit 30; fi`,
      'if printf forbidden > .zapcode/settings.json 2>/dev/null; then exit 31; fi',
      'printf workspace > proof.txt',
      'printf \'%s\\n\' \'{"type":"system","subtype":"init","session_id":"sandbox-session"}\' \'{"type":"result","subtype":"success","result":"DONE"}\'',
    ].join("\n"));
    chmodSync(bin, 0o755);
    const events: string[] = [];
    const tool = delegateAgentTool({ providers: [{ name: "claude", bin }], stateDir, defaultCwd: cwd,
      timeoutMs: 5000, onEvent: e => events.push(e.type) })!;
    const registry = new ToolRegistry(); registry.register(tool);
    const executor = new ToolExecutor(registry, { cwd, onApproval: async () => true,
      executionBroker: new DefaultExecutionBroker({ sandbox, sandboxMode: "required" }) });
    try {
      const first = await executor.execute("delegate_agent", { provider: "claude", task: "first" });
      expect(first.error).toBeUndefined();
      expect(first.success).toBe(true);
      expect(first.runtime?.broker?.sandboxEnforced).toBe(true);
      expect(first.output).toContain("temporary files were cleaned up");
      const resumed = await executor.execute("delegate_agent", { provider: "claude", task: "second",
        resume_session_id: "sandbox-session" });
      expect(resumed.success).toBe(true);
      expect((resumed.meta as { resumed: boolean }).resumed).toBe(true);
      expect(readFileSync(join(cwd, "proof.txt"), "utf8")).toBe("workspace");
      expect(readFileSync(join(cwd, ".zapcode", "settings.json"), "utf8")).toBe("original");
      expect(existsSync(outside)).toBe(false);
      expect(events.filter(e => e === "sub_agent_finished").length).toBe(2);
      const effects = tool.definition.resolveEffects!({ provider: "claude" }, { cwd, toolName: "delegate_agent" });
      const writes = effects.filesystem.filter(e => e.operation !== "read").flatMap(e => e.paths);
      expect(writes).not.toContain("/tmp");
      expect(writes.some(p => p.endsWith("/.claude") || p.endsWith("/.claude.json") || p.endsWith("/Keychains"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15000);
});
