import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delegateAgentTool, buildCliArgs } from "../../builtin-tools/delegate.js";
import type { DetectedProvider } from "../../builtin-tools/delegate-detect.js";

const fakeBin: DetectedProvider[] = [{ name: "claude", bin: "/bin/echo" }];

const FIXTURES = join(import.meta.dir, "fixtures");
const FAKE_CLAUDE = join(FIXTURES, "fake-claude.sh");
const fakeProvider = (): DetectedProvider[] => [{ name: "claude", bin: FAKE_CLAUDE }];
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

describe("buildCliArgs", () => {
  it("claude fresh: flags + -p <task>", () => {
    expect(buildCliArgs("claude", "do X")).toEqual([
      "--dangerously-skip-permissions",
      "--output-format", "stream-json",
      "--verbose",
      "-p", "do X",
    ]);
  });

  it("claude resume: --resume <id> inserted before -p", () => {
    const args = buildCliArgs("claude", "follow-up", "abc-123");
    expect(args).toContain("--resume");
    const ri = args.indexOf("--resume");
    expect(args[ri + 1]).toBe("abc-123");
    expect(args[args.length - 2]).toBe("-p");
    expect(args[args.length - 1]).toBe("follow-up");
  });

  it("codex fresh: exec + flags + task", () => {
    expect(buildCliArgs("codex", "do Y")).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      "do Y",
    ]);
  });

  it("codex resume: exec resume <id> at the front, task at the end", () => {
    expect(buildCliArgs("codex", "follow-up", "thread-xyz")).toEqual([
      "exec", "resume",
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      "thread-xyz",
      "follow-up",
    ]);
  });
});

describe("delegateAgentTool factory", () => {
  it("returns null when no providers are detected", () => {
    const tool = delegateAgentTool({ providers: [] });
    expect(tool).toBeNull();
  });

  it("registers tool with name delegate_agent and confirm permission", () => {
    const tool = delegateAgentTool({ providers: fakeBin });
    expect(tool).not.toBeNull();
    expect(tool!.definition.name).toBe("delegate_agent");
    expect(tool!.definition.permission).toBe("confirm");
  });

  it("rejects task > 100KB without spawning", async () => {
    const tool = delegateAgentTool({ providers: fakeBin })!;
    const giant = "x".repeat(100_001);
    const r = await tool.handler({ provider: "claude", task: giant });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Task is too long");
  });

  it("rejects unknown provider with a clear error", async () => {
    const tool = delegateAgentTool({ providers: fakeBin })!;
    const r = await tool.handler({ provider: "codex", task: "hi" });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/codex.*not available/i);
  });

  it("resolves relative cwd against defaultCwd", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "zap-delegate-project-"));
    const otherDir = mkdtempSync(join(tmpdir(), "zap-delegate-other-"));
    const script = join(projectDir, "fake-delegate.sh");
    const pwdOut = join(projectDir, "pwd.txt");
    const fixture = join(FIXTURES, "claude-simple.ndjson");
    try {
      mkdirSync(join(projectDir, "packages", "app"), { recursive: true });
      mkdirSync(join(otherDir, "packages", "app"), { recursive: true });
      writeFileSync(script, [
        "#!/bin/sh",
        `pwd > ${shellQuote(pwdOut)}`,
        `cat ${shellQuote(fixture)}`,
        "exit 0",
        "",
      ].join("\n"));
      chmodSync(script, 0o755);

      const tool = delegateAgentTool({
        providers: [{ name: "claude", bin: script }],
        defaultCwd: projectDir,
        timeoutMs: 5_000,
      })!;
      const r = await tool.handler({
        provider: "claude",
        task: "hi",
        cwd: "packages/app",
      });

      expect(r.success).toBe(true);
      expect(readFileSync(pwdOut, "utf-8").trim()).toBe(realpathSync(join(projectDir, "packages", "app")));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe("delegateAgentTool handler — fake claude integration", () => {
  it("emits sub_agent_started/finished and returns finalText", async () => {
    const fixture = join(FIXTURES, "claude-simple.ndjson");
    const events: any[] = [];
    const tool = delegateAgentTool({
      providers: fakeProvider(),
      timeoutMs: 5_000,
      onEvent: (e) => events.push(e),
    })!;
    process.env.ZAPCODE_DELEGATE_FAKE_FIXTURE = fixture;
    process.env.ZAPCODE_DELEGATE_FAKE_EXIT = "0";
    try {
      const r = await tool.handler({ provider: "claude", task: "hi" });
      expect(r.success).toBe(true);
      expect(r.output).toContain("done");
      const types = events.map((e) => e.type);
      expect(types[0]).toBe("sub_agent_started");
      expect(types[types.length - 1]).toBe("sub_agent_finished");
    } finally {
      delete process.env.ZAPCODE_DELEGATE_FAKE_FIXTURE;
      delete process.env.ZAPCODE_DELEGATE_FAKE_EXIT;
    }
  });

  it("captures sessionId in meta and appends a 'Session resumable' line to output", async () => {
    const fixture = join(FIXTURES, "claude-simple.ndjson");
    const tool = delegateAgentTool({ providers: fakeProvider(), timeoutMs: 5_000 })!;
    process.env.ZAPCODE_DELEGATE_FAKE_FIXTURE = fixture;
    process.env.ZAPCODE_DELEGATE_FAKE_EXIT = "0";
    try {
      const r = await tool.handler({ provider: "claude", task: "hi" });
      expect(r.success).toBe(true);
      const meta = r.meta as { sessionId: string | null; resumed: boolean };
      expect(meta.sessionId).toBe("490c4b78-d15a-4b35-98e0-6481b744de01");
      expect(meta.resumed).toBe(false);
      expect(r.output).toContain("Session resumable");
      expect(r.output).toContain("490c4b78-d15a-4b35-98e0-6481b744de01");
    } finally {
      delete process.env.ZAPCODE_DELEGATE_FAKE_FIXTURE;
      delete process.env.ZAPCODE_DELEGATE_FAKE_EXIT;
    }
  });

  it("marks meta.resumed=true when resume_session_id is passed", async () => {
    const fixture = join(FIXTURES, "claude-simple.ndjson");
    const tool = delegateAgentTool({ providers: fakeProvider(), timeoutMs: 5_000 })!;
    process.env.ZAPCODE_DELEGATE_FAKE_FIXTURE = fixture;
    process.env.ZAPCODE_DELEGATE_FAKE_EXIT = "0";
    try {
      const r = await tool.handler({ provider: "claude", task: "follow", resume_session_id: "abc-123" });
      const meta = r.meta as { resumed: boolean };
      expect(meta.resumed).toBe(true);
    } finally {
      delete process.env.ZAPCODE_DELEGATE_FAKE_FIXTURE;
      delete process.env.ZAPCODE_DELEGATE_FAKE_EXIT;
    }
  });

  it("returns aborted when cancellation precedes delegate launch", async () => {
    const tool = delegateAgentTool({ providers: fakeProvider(), timeoutMs: 5_000 })!;
    const ac = new AbortController();
    ac.abort();
    const result = await tool.handler({ provider: "claude", task: "hi" }, ac.signal);
    expect(result.success).toBe(false);
    expect(result.error).toBe("aborted");
  });

  it("returns aborted when the handler is signaled", async () => {
    const fixture = join(FIXTURES, "claude-simple.ndjson");
    const tool = delegateAgentTool({ providers: fakeProvider(), timeoutMs: 5_000 })!;
    process.env.ZAPCODE_DELEGATE_FAKE_FIXTURE = fixture;
    process.env.ZAPCODE_DELEGATE_FAKE_EXIT = "0";
    process.env.ZAPCODE_DELEGATE_FAKE_DELAY = "1";
    try {
      const ac = new AbortController();
      const promise = tool.handler({ provider: "claude", task: "hi" }, ac.signal);
      setTimeout(() => ac.abort(), 80);
      const r = await promise;
      expect(r.success).toBe(false);
      expect(r.error).toBe("aborted");
    } finally {
      delete process.env.ZAPCODE_DELEGATE_FAKE_FIXTURE;
      delete process.env.ZAPCODE_DELEGATE_FAKE_EXIT;
      delete process.env.ZAPCODE_DELEGATE_FAKE_DELAY;
    }
  });

  it("returns failure with stderr tail on non-zero exit", async () => {
    const fixture = join(FIXTURES, "claude-simple.ndjson");
    const tool = delegateAgentTool({ providers: fakeProvider(), timeoutMs: 5_000 })!;
    process.env.ZAPCODE_DELEGATE_FAKE_FIXTURE = fixture;
    process.env.ZAPCODE_DELEGATE_FAKE_EXIT = "1";
    try {
      const r = await tool.handler({ provider: "claude", task: "hi" });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/exited with code 1/);
    } finally {
      delete process.env.ZAPCODE_DELEGATE_FAKE_FIXTURE;
      delete process.env.ZAPCODE_DELEGATE_FAKE_EXIT;
    }
  });
});
