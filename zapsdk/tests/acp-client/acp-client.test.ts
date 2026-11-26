import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "../../agent/events.js";
import type { ApprovalCallback } from "../../tools/executor.js";
import { acpUsage, AcpEventMapper } from "../../acp-client/event-mapper.js";
import { inProcessTransport, stdioTransport } from "../../acp-client/connection.js";
import { createAcpHostHandlers } from "../../acp-client/host-handlers.js";
import { runAcpTask } from "../../acp-client/run.js";
import { AcpClientError } from "../../acp-client/types.js";
import { acpAgentTool } from "../../builtin-tools/acp-agent.js";
import { fakeAgent, text, thought } from "./fake-agent.js";

const spec = { id: "fake", command: "fake-agent" };

async function tempDir(): Promise<string> {
  return realpathSync(await mkdtemp(join(tmpdir(), "zap-acp-client-")));
}

function approver(decide: (name: string, args: Record<string, unknown>) => boolean) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const approve = (async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return decide(name, args) ? true : { approved: false, source: "approval", reason: "user said no" };
  }) as ApprovalCallback;
  return { approve, calls };
}

describe("AcpEventMapper", () => {
  it("preserves both disjoint and inclusive ACP cache counters", () => {
    const counts = { totalTokens: 104, outputTokens: 4, cachedReadTokens: 88, cachedWriteTokens: 9 };
    for (const inputTokens of [3, 100]) expect(acpUsage({ ...counts, inputTokens })).toMatchObject({
      inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 88, cacheCreationInputTokens: 9,
    });
  });
  it("streams thinking and text, seals in order, and pairs tool calls", () => {
    const mapper = new AcpEventMapper(["sub"]);
    const events = [
      ...mapper.map(thought("plan ")),
      ...mapper.map(thought("it")),
      ...mapper.map(text("Looking.")),
      ...mapper.map({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a.ts", kind: "read",
        status: "pending", locations: [{ path: "/w/a.ts" }] }),
      ...mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed",
        content: [{ type: "content", content: { type: "text", text: "file body" } }] }),
      ...mapper.map({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit b.ts", kind: "edit", status: "in_progress" }),
      ...mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed",
        content: [{ type: "diff", path: "/w/b.ts", oldText: "a\n", newText: "b\n" }] }),
      ...mapper.map(text("Done.")),
      ...mapper.finish("end_turn"),
    ];
    const shape = events.map(event => event.type === "content_delta" || event.type === "content_final"
      ? `${event.type === "content_delta" ? "d" : "f"}:${event.kind}` : event.type);
    expect(shape).toEqual([
      "d:thinking", "d:thinking", "f:thinking", "d:text", "f:text",
      "f:tool_call", "f:tool_result", "f:tool_call", "f:tool_result", "d:text", "f:text",
    ]);
    expect(events.every(event => (event as { path?: string[] }).path?.[0] === "sub")).toBe(true);
    const finalThinking = events.find(event => event.type === "content_final" && event.kind === "thinking");
    expect(finalThinking && "text" in finalThinking ? finalThinking.text : "").toBe("plan it");
    const call = events.find(event => event.type === "content_final" && event.kind === "tool_call");
    expect(call && "arguments" in call ? call.arguments : {}).toEqual({ title: "Read a.ts", path: "/w/a.ts" });
    const results = events.filter(event => event.type === "content_final" && event.kind === "tool_result");
    const [readResult, editResult] = results.map(event => "result" in event ? event.result : undefined);
    expect(readResult).toMatchObject({ success: true, output: "file body" });
    expect(editResult?.output).toBe("Edited /w/b.ts");
    expect((editResult?.meta as { diff: string }).diff).toContain("+b");
    expect(mapper.reportText).toBe("Looking.\n\nDone.");
  });

  it("uses terminal output streamed in _meta when the client has no terminal capability", () => {
    const mapper = new AcpEventMapper();
    mapper.map({ sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute", status: "in_progress",
      content: [{ type: "terminal", terminalId: "exec-1" }] });
    mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "t1", _meta: { terminal_output_delta: { data: "a.txt\n" } } });
    const [result] = mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed",
      _meta: { terminal_output_delta: { data: "b.txt\n" } } });
    expect(result).toMatchObject({ kind: "tool_result", result: { success: true, output: "a.txt\nb.txt" } });
  });

  it("settles tools the agent left open when the turn ends", () => {
    const mapper = new AcpEventMapper();
    mapper.map({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Run tests", kind: "execute", status: "in_progress" });
    const events = mapper.finish("cancelled");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "content_final", kind: "tool_result", id: "t1",
      result: { success: false, error: "cancelled" } });
  });
});

describe("runAcpTask (in-process agent)", () => {
  it("initializes with fs capabilities, applies setup, maps updates and returns the report", async () => {
    const cwd = await tempDir();
    try {
      const { app, log } = fakeAgent({ async script(turn) {
        await turn.update(thought("thinking"));
        await turn.update(text(`echo: ${turn.prompt[0]?.type === "text" ? turn.prompt[0].text : ""}`));
      } });
      const events: AgentEvent[] = [];
      const result = await runAcpTask({
        spec: { ...spec, mode: "code", config: { thought_level: "high" } }, task: "hello", cwd,
        transport: inProcessTransport(app),
        handlers: createAcpHostHandlers({ agentId: "fake", cwd, approve: approver(() => true).approve }),
        onEvent: event => events.push(event), path: ["acp_x"],
      });
      expect(log.initialize[0]).toMatchObject({ clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } });
      expect(log.calls.map(call => call.method)).toEqual(["session/new", "session/set_config_option", "session/set_mode", "session/prompt"]);
      expect(log.calls[0]!.params.cwd).toBe(cwd);
      expect(result).toMatchObject({ agentName: "fake-agent", sessionId: "s1", stopReason: "end_turn", report: "echo: hello",
        usage: { inputTokens: 60, outputTokens: 20, cacheReadInputTokens: 40 }, resumable: false, warnings: [] });
      expect(events.some(event => event.type === "content_delta" && event.kind === "thinking")).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("routes fs writes through write_file approval and the checkpoint hook", async () => {
    const cwd = await tempDir();
    try {
      const target = join(cwd, "src", "new.txt");
      const { app } = fakeAgent({ async script(turn) {
        await turn.client.request("fs/write_text_file", { sessionId: turn.sessionId, path: target, content: "hi\n" });
        const read = await turn.client.request("fs/read_text_file", { sessionId: turn.sessionId, path: target });
        await turn.update(text(`read back ${JSON.stringify(read.content)}`));
      } });
      const { approve, calls } = approver(() => true);
      const tracked: string[][] = [];
      const handlers = createAcpHostHandlers({ agentId: "fake", cwd, approve, trackEdit: async (paths) => { tracked.push(paths); } });
      const result = await runAcpTask({ spec, task: "write", cwd, transport: inProcessTransport(app), handlers });
      expect(await readFile(target, "utf8")).toBe("hi\n");
      expect(calls.map(call => call.name)).toEqual(["write_file", "read_file"]);
      expect(calls[0]!.args).toEqual({ path: target, content: "hi\n" });
      expect(tracked).toEqual([[target]]);
      expect([...handlers.written]).toEqual([target]);
      expect(result.report).toBe('read back "hi\\n"');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("refuses denied writes and tells the agent why", async () => {
    const cwd = await tempDir();
    try {
      const target = join(cwd, "blocked.txt");
      const { app } = fakeAgent({ async script(turn) {
        try {
          await turn.client.request("fs/write_text_file", { sessionId: turn.sessionId, path: target, content: "x" });
          await turn.update(text("wrote"));
        } catch (error) {
          await turn.update(text(`write failed: ${(error as Error).message}`));
        }
      } });
      const handlers = createAcpHostHandlers({ agentId: "fake", cwd, approve: approver(() => false).approve });
      const result = await runAcpTask({ spec, task: "write", cwd, transport: inProcessTransport(app), handlers });
      expect(result.report).toContain("write failed");
      expect(result.report).toContain("user said no");
      expect(handlers.written.size).toBe(0);
      await expect(readFile(target, "utf8")).rejects.toThrow();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("maps permission requests: commands become bash, others are namespaced; zap never grants 'always'", async () => {
    const cwd = await tempDir();
    try {
      const outcomes: unknown[] = [];
      const options = [
        { optionId: "always", name: "Always", kind: "allow_always" as const },
        { optionId: "once", name: "Once", kind: "allow_once" as const },
        { optionId: "no", name: "No", kind: "reject_once" as const },
      ];
      const { app } = fakeAgent({ async script(turn) {
        for (const toolCall of [
          { toolCallId: "a", title: "Run tests", kind: "execute" as const, rawInput: { command: ["bun", "test"] } },
          { toolCallId: "c", title: "ls", kind: "execute" as const, rawInput: { CommandLine: "ls -la" } },
          { toolCallId: "b", title: "Fetch docs", kind: "fetch" as const, rawInput: { url: "https://example.com" } },
        ]) {
          const response = await turn.client.request<RequestPermissionResponse>("session/request_permission", { sessionId: turn.sessionId, toolCall, options });
          outcomes.push(response.outcome);
        }
      } });
      const { approve, calls } = approver(name => name === "bash");
      const handlers = createAcpHostHandlers({ agentId: "fake", cwd, approve });
      await runAcpTask({ spec, task: "go", cwd, transport: inProcessTransport(app), handlers });
      expect(calls).toEqual([
        { name: "bash", args: { command: "bun test", description: "Run tests" } },
        { name: "bash", args: { command: "ls -la", description: "ls" } },
        { name: "acp_fake_fetch", args: { title: "Fetch docs", input: { url: "https://example.com" } } },
      ]);
      expect(outcomes).toEqual([{ outcome: "selected", optionId: "once" }, { outcome: "selected", optionId: "once" }, { outcome: "selected", optionId: "no" }]);
      expect(handlers.decisions).toEqual([
        { title: "Run tests", kind: "execute", allowed: true },
        { title: "ls", kind: "execute", allowed: true },
        { title: "Fetch docs", kind: "fetch", allowed: false },
      ]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("sends session/cancel on abort and returns the agent's cancelled stop", async () => {
    const cwd = await tempDir();
    try {
      const controller = new AbortController();
      const { app, log } = fakeAgent({ async script(turn) {
        await turn.update(text("working"));
        controller.abort();
        await turn.cancelled;
        return "cancelled";
      } });
      const result = await runAcpTask({ spec, task: "slow", cwd, transport: inProcessTransport(app),
        handlers: createAcpHostHandlers({ agentId: "fake", cwd }), signal: controller.signal });
      expect(result.stopReason).toBe("cancelled");
      expect(log.calls.some(call => call.method === "session/cancel")).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("answers a pending permission request 'cancelled' when the turn is cancelled", async () => {
    const cwd = await tempDir();
    try {
      const controller = new AbortController();
      let outcome: unknown;
      const { app } = fakeAgent({ async script(turn) {
        const pending = turn.client.request<RequestPermissionResponse>("session/request_permission", { sessionId: turn.sessionId,
          toolCall: { toolCallId: "t", title: "Fetch", kind: "fetch" },
          options: [{ optionId: "y", name: "Yes", kind: "allow_once" }, { optionId: "n", name: "No", kind: "reject_once" }] });
        controller.abort();
        outcome = (await pending).outcome;
        await turn.cancelled;
        return "cancelled";
      } });
      // An approval that only settles when its signal aborts, like the TUI prompt.
      const approve = ((_name: string, _args: Record<string, unknown>, signal?: AbortSignal) => new Promise<boolean>((resolve) => {
        signal?.addEventListener("abort", () => resolve(false), { once: true });
      })) as unknown as ApprovalCallback;
      const result = await runAcpTask({ spec, task: "x", cwd, transport: inProcessTransport(app), signal: controller.signal,
        handlers: createAcpHostHandlers({ agentId: "fake", cwd, approve, signal: () => controller.signal }) });
      expect(outcome).toEqual({ outcome: "cancelled" });
      expect(result.stopReason).toBe("cancelled");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("resumes with session/load only when the agent supports it", async () => {
    const cwd = await tempDir();
    try {
      const resumable = fakeAgent({ loadSession: true, async script(turn) { await turn.update(text("again")); } });
      const result = await runAcpTask({ spec, task: "more", cwd, sessionId: "old", transport: inProcessTransport(resumable.app),
        handlers: createAcpHostHandlers({ agentId: "fake", cwd }) });
      expect(resumable.log.calls.map(call => call.method)).toEqual(["session/load", "session/prompt"]);
      expect(result).toMatchObject({ sessionId: "old", resumed: true, resumable: true });

      const fresh = fakeAgent({ async script() {} });
      await expect(runAcpTask({ spec, task: "more", cwd, sessionId: "old", transport: inProcessTransport(fresh.app),
        handlers: createAcpHostHandlers({ agentId: "fake", cwd }) })).rejects.toThrow("cannot resume");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});

describe("stdio transport", () => {
  const script = (body: string) => `
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
const app = agent({ name: "child" })
  .onRequest("initialize", () => ({ protocolVersion: 1, agentInfo: { name: "child-agent", version: "1" } }))
  .onRequest("session/new", () => ({ sessionId: "c1" }))
  .onRequest("session/prompt", async ({ params, client }) => { ${body} });
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
`;

  async function childAgent(body: string) {
    const dir = await mkdtemp(join(process.cwd(), ".acp-child-"));
    const file = join(dir, "agent.ts");
    await writeFile(file, script(body));
    const child = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "pipe"] });
    return { dir, child };
  }

  it("talks to a real child process over newline-delimited JSON-RPC", async () => {
    const { dir, child } = await childAgent(`
      await client.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "from child" } } });
      return { stopReason: "end_turn" };`);
    try {
      const result = await runAcpTask({ spec, task: "hi", cwd: dir, transport: stdioTransport(child),
        handlers: createAcpHostHandlers({ agentId: "fake", cwd: dir }) });
      expect(result).toMatchObject({ agentName: "child-agent", report: "from child", stopReason: "end_turn" });
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("fails fast with stderr when the agent exits mid-turn", async () => {
    const { dir, child } = await childAgent(`console.error("model quota exhausted"); process.exit(3);`);
    try {
      const failure = await runAcpTask({ spec, task: "hi", cwd: dir, transport: stdioTransport(child),
        handlers: createAcpHostHandlers({ agentId: "fake", cwd: dir }) }).catch(error => error);
      expect(failure).toBeInstanceOf(AcpClientError);
      expect((failure as AcpClientError).code).toBe("exited");
      expect((failure as Error).message).toContain("model quota exhausted");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("acp_agent tool", () => {
  it("runs the agent, nests its events under a subagent, and reports writes and session", async () => {
    const cwd = await tempDir();
    try {
      const { app } = fakeAgent({ loadSession: true, async script(turn) {
        await turn.client.request("fs/write_text_file", { sessionId: turn.sessionId, path: join(cwd, "out.md"), content: "# out\n" });
        await turn.update(text("All done."));
      } });
      const events: AgentEvent[] = [];
      const tool = acpAgentTool({ agents: [{ ...spec, description: "test agent" }], defaultCwd: cwd,
        approve: approver(() => true).approve, onEvent: event => events.push(event),
        transportFactory: () => inProcessTransport(app) })!;
      expect(tool.definition.name).toBe("acp_agent");
      expect(tool.definition.description).toContain("`fake` (test agent)");
      const result = await tool.handler({ agent: "fake", task: "write out.md" });
      expect(result.success).toBe(true);
      expect(result.output).toContain("All done.");
      expect(result.output).toContain("Written through zap: out.md");
      expect(result.output).toContain('session_id="s1"');
      const started = events.find(event => event.type === "sub_agent_started");
      const finished = events.find(event => event.type === "sub_agent_finished");
      expect(started).toMatchObject({ agentType: "fake", task: "write out.md" });
      expect(finished).toMatchObject({ agentType: "fake", success: true });
      const subagentId = started && "subagentId" in started ? started.subagentId : "";
      expect((result.meta as { subagentId?: string }).subagentId).toBe(subagentId);
      expect(subagentId).toMatch(/^acp_fake_[a-z0-9]+_[a-z0-9]{4}$/);
      expect(events.filter(event => event.type === "content_final").every(event => event.path?.[0] === subagentId)).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("reports a timeout as a failure even when the agent cancels cooperatively", async () => {
    const cwd = await tempDir();
    try {
      const { app } = fakeAgent({ async script(turn) {
        await turn.update(text("partial work"));
        await turn.cancelled;
        return "cancelled";
      } });
      const tool = acpAgentTool({ agents: [spec], defaultCwd: cwd, timeoutMs: 150, transportFactory: () => inProcessTransport(app) })!;
      const result = await tool.handler({ agent: "fake", task: "slow" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
      expect(result.output).toContain("partial work");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("is not registered without agents and rejects unknown agents", async () => {
    expect(acpAgentTool({ agents: [] })).toBeNull();
    const tool = acpAgentTool({ agents: [spec], transportFactory: () => { throw new Error("unreachable"); } })!;
    expect((await tool.handler({ agent: "other", task: "x" })).error).toContain("not configured");
  });
});
