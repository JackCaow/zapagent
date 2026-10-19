import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createAgentRuntime } from "../../runtime/factory.js";
import { LoopAgent } from "../../agent/loop.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { TaskStore } from "../../tasks/store.js";
import { backgroundTaskLifecycle } from "../../tasks/lifecycle.js";
import { monitorTool } from "../../builtin-tools/monitor.js";
import { executeCommandTool } from "../../builtin-tools/command.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk, LLMResponse, Message } from "../../core/types.js";

let root: string, previous: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-background-lifecycle-"));
  previous = process.env.ZAPCODE_DATA_DIR;
  process.env.ZAPCODE_DATA_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR;
  else process.env.ZAPCODE_DATA_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

function provider(mode: "stream" | "call" | "xml", name: string, args: Record<string, unknown>, inputs: Message[][], after?: () => Promise<void>): LLMProvider {
  const response = async (messages: Message[]): Promise<LLMResponse> => {
    inputs.push(structuredClone(messages));
    if (inputs.length === 1) return { type: "tool_call", text: "", toolCalls: [{ id: "start", name, arguments: args }], usage: { inputTokens: 1, outputTokens: 1 } };
    await after?.();
    return { type: "text", text: "Observed the task lifecycle.", usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const llm: LLMProvider = { call: response };
  if (mode !== "call") llm.stream = async function* (messages): AsyncIterable<LLMChunk> {
    const r = await response(messages);
    if (r.toolCalls) {
      if (mode === "xml") yield { type: "text_delta", text: `<tool_call>${name}</tool_call>` };
      else {
        yield { type: "tool_call_start", toolCallId: "start", toolName: name };
        yield { type: "tool_call_delta", toolCallId: "start", partialJson: JSON.stringify(args) };
      }
    } else yield { type: "text_delta", text: r.text };
    yield { type: "done", usage: r.usage };
  };
  return llm;
}

for (const mode of ["stream", "call", "xml"] as const) for (const policy of ["stop", "host", "absent", "other-store", "legacy"] as const) {
  it(`${mode}: Runtime lifecycle facts match the actual registry for ${policy}`, async () => {
    const store = new TaskStore({ outputDir: join(root, "tasks") });
    const other = new TaskStore({ outputDir: join(root, "other") });
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "observe_task", description: "fixture", parameters: z.object({}), backgroundTaskStoreId: store.instanceId },
      handler: async (_args, _signal, context) => ({ success: true, output: backgroundTaskLifecycle(context?.backgroundTaskOwner, store.instanceId) }) });
    const inputs: Message[][] = [];
    const expected = policy === "stop" ? "run" : policy === "host" ? "host-session" : "unknown";
    const runtime = createAgentRuntime({ threadId: `lifecycle-${mode}-${policy}`, workspace: { root }, subagent: false,
      backgroundTasks: policy === "absent" ? undefined : { store: policy === "other-store" ? other : store, disposition: policy === "host" ? "host" : "stop" },
      loopAgent: { provider: provider(mode, "observe_task", {}, inputs), registry, executor: new ToolExecutor(registry, { cwd: root }), maxSteps: 3, systemPrompt: "Custom host instructions.", promptProfile: mode === "call" ? "concise" : "standard" } });
    // Attempting to override runtime facts through run input must not succeed.
    const options = { backgroundTaskOwner: { storeId: store.instanceId, lifecycle: "host-session" as const } };
    const result = policy === "legacy" ? await runtime.run("Observe.", options) : (await runtime.runWithOutcome("Observe.", options)).loopResult;
    expect(result.toolResults[0]?.output).toBe(expected);
    expect(inputs).toHaveLength(2);
    const first = inputs[0].map(m => m.content).join("\n");
    expect(first).toContain("Managed background task lifecycle");
    expect(first).toContain(expected === "run" ? "stopped before this run" : expected === "host-session" ? "active host session" : "lifetime is unknown");
    expect(first).not.toContain(store.instanceId);
    expect(inputs[0].filter(m => m.role === "system")).toEqual(inputs[1].filter(m => m.role === "system"));
    expect(inputs[1].some(m => m.role === "tool_result" && m.content.includes(expected))).toBe(true);
    await runtime.close();
  });
}

it("does not add lifecycle claims to a registry without managed background tools", async () => {
  const inputs: Message[][] = [];
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "inspect", description: "fixture", parameters: z.object({}) }, handler: async () => ({ success: true, output: "seen" }) });
  await new LoopAgent({ provider: provider("call", "inspect", {}, inputs), registry, executor: new ToolExecutor(registry), maxSteps: 3 }).run("Inspect.");
  expect(inputs[0].map(m => m.content).join("\n")).not.toContain("Managed background task lifecycle");
});

it("missing, different and malformed owner facts remain unknown in both builtin results", async () => {
  const store = new TaskStore({ outputDir: root });
  const spawn = store.spawnShell.bind(store);
  store.spawnShell = () => ({ taskId: "fixture", outputFile: "fixture.log", pid: 123, kind: "shell", command: "fixture", description: "fixture", startedAt: 1 });
  try {
    for (const owner of [undefined, { storeId: "other", lifecycle: "run" }, { storeId: store.instanceId, lifecycle: "invalid" }]) {
      for (const tool of [monitorTool({ store }).tool, executeCommandTool({ store })]) {
        const result = await tool.handler({ command: "fixture", description: "fixture", run_in_background: true }, undefined, { backgroundTaskOwner: owner as any });
        expect(result.success).toBe(true);
        const receipt = JSON.parse(result.output);
        expect(receipt.lifecycle).toBe("unknown");
        expect(receipt.lifecycleHint).toContain("lifetime is unknown");
      }
    }
  } finally { store.spawnShell = spawn; }
});

const localTest = process.platform === "win32" ? it.skip : it;
for (const kind of ["monitor", "bash"] as const) for (const disposition of ["stop", "host"] as const) {
  localTest(`${kind}: real HTTP process matches ${disposition} receipt after outcome publication`, async () => {
    const script = join(root, "server.ts");
    writeFileSync(script, 'const server = Bun.serve({port:0, hostname:"127.0.0.1", fetch:()=>new Response("owned")}); console.log(server.port);');
    const store = new TaskStore({ outputDir: join(root, "tasks") });
    const registry = new ToolRegistry();
    registry.register(kind === "monitor" ? monitorTool({ store, projectCwd: root }).tool : executeCommandTool({ store, defaultCwd: root }));
    const command = `"${process.execPath}" "${script}"`;
    const args = { command, description: "neutral HTTP fixture", ...(kind === "bash" ? { run_in_background: true } : {}) };
    const inputs: Message[][] = [];
    let port = 0;
    const ownership = { store, disposition };
    const llm = provider("call", kind, args, inputs, async () => {
      const until = Date.now() + 3000;
      while (!port && Date.now() < until) {
        port = Number(readFileSync(store.list()[0]!.outputFile, "utf8").trim());
        if (!port) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(port).toBeGreaterThan(0);
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("owned");
      // A caller mutating the original options object cannot change sealing
      // after Runtime has already described the configured lifecycle.
      ownership.disposition = disposition === "stop" ? "host" : "stop";
    });
    const runtime = createAgentRuntime({ threadId: `real-${kind}-${disposition}`, workspace: { root }, subagent: false,
      backgroundTasks: ownership, loopAgent: { provider: llm, registry, executor: new ToolExecutor(registry, { cwd: root, onApproval: async () => true }), maxSteps: 3 } });
    try {
      const { loopResult, outcome } = await runtime.runWithOutcome("Start the fixture.");
      expect(inputs).toHaveLength(2);
      expect(loopResult.toolResults[0]?.success).toBe(true);
      expect(JSON.parse(loopResult.toolResults[0]!.output).lifecycle).toBe(disposition === "stop" ? "run" : "host-session");
      expect(outcome.execution.backgroundTasks).toEqual([{ taskId: store.list()[0]!.taskId, disposition: disposition === "stop" ? "stopped" : "host_owned" }]);
      if (disposition === "stop") {
        await expect(fetch(`http://127.0.0.1:${port}`, { keepalive: false })).rejects.toThrow();
        expect(store.list({ running: true })).toHaveLength(0);
      } else {
        expect(await (await fetch(`http://127.0.0.1:${port}`, { keepalive: false })).text()).toBe("owned");
        expect(store.list({ running: true })).toHaveLength(1);
      }
    } finally { await store.settle(store.list({ running: true }).map(task => task.taskId)); await runtime.close(); }
    expect(store.list({ running: true })).toHaveLength(0);
  });
}
