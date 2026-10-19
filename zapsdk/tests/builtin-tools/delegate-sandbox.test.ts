import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegateAgentTool } from "../../builtin-tools/delegate.js";
import { createPlatformSandbox } from "../../execution/sandbox.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";

const sandbox = createPlatformSandbox();
const acceptance = process.platform !== "win32" && sandbox.status().available ? describe : describe.skip;
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

acceptance("sandboxed Claude delegate runtime", () => {
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
      expect(first.success).toBe(true);
      expect(first.runtime?.broker?.sandboxEnforced).toBe(true);
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
