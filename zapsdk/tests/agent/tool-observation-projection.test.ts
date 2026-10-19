import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopAgent } from "../../agent/loop.js";
import { SingleCallAgent } from "../../agent/single-call.js";
import { executeCommandTool } from "../../builtin-tools/command.js";
import type { LLMChunk, LLMResponse, Message } from "../../core/types.js";
import type { LLMProvider } from "../../core/llm.js";
import { buildToolTurn, turnToMessages } from "../../core/turn.js";
import { formatToolResultForModel } from "../../execution/failure.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { ToolResult } from "../../tools/types.js";
import { PERSIST_THRESHOLD_CHARS } from "../../utils/tool-result-storage.js";

const posixTest = process.platform === "win32" ? it.skip : it;

function observation(content: string) {
  const line = content.split("\n").find(line => line.startsWith("[Execution observation] "));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice("[Execution observation] ".length));
}

describe("model-facing process observations", () => {
  let root: string;
  let previous: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zap-model-observation-"));
    previous = process.env.ZAPCODE_DATA_DIR;
    process.env.ZAPCODE_DATA_DIR = root;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR;
    else process.env.ZAPCODE_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  for (const mode of ["native", "xml", "nonstreaming", "single"] as const) {
    posixTest(`delivers actual shell status without interpreting pipeline diagnostics in ${mode}`, async () => {
      const registry = new ToolRegistry();
      registry.register(executeCommandTool({ defaultCwd: root, disableBackgroundTasks: true }));
      const inputs: Message[][] = [];
      const args = { command: "(printf 'assertion failed\\n'; exit 7) | cat" };
      const reply = (messages: Message[]): LLMResponse => {
        inputs.push(structuredClone(messages));
        return inputs.length === 1
          ? { type: "tool_call", text: "", toolCalls: [{ id: "check", name: "bash", arguments: args }], usage: { inputTokens: 1, outputTokens: 1 } }
          : { type: "text", text: "Observed the shell result.", usage: { inputTokens: 1, outputTokens: 1 } };
      };
      const provider: LLMProvider = { async call(messages) { return reply(messages); } };
      if (mode === "native" || mode === "xml") provider.stream = async function* (messages): AsyncIterable<LLMChunk> {
        const response = reply(messages);
        if (response.toolCalls?.length) {
          if (mode === "xml") yield { type: "text_delta", text: `<tool_call>bash<arg_key>command</arg_key><arg_value>${args.command}</arg_value></tool_call>` };
          else {
            yield { type: "tool_call_start", toolCallId: "check", toolName: "bash" };
            yield { type: "tool_call_delta", toolCallId: "check", partialJson: JSON.stringify(args) };
          }
        } else yield { type: "text_delta", text: response.text };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      };
      const options = { provider, registry, executor: new ToolExecutor(registry, { cwd: root, onApproval: async () => true }) };
      const result = await (mode === "single" ? new SingleCallAgent(options) : new LoopAgent({ ...options, maxSteps: 3 })).run("Run the command.");
      expect(result.toolResults[0].success).toBe(true);
      expect(result.toolResults[0].runtime?.command?.exitCode).toBe(0);
      const body = inputs[1].find(m => m.role === "tool_result")!.content;
      expect(observation(body).command).toEqual({ exitCode: 0, timedOut: false, aborted: false });
      expect(observation(body).selfChecks).toBeUndefined();
      expect(body).toContain("assertion failed");
      expect(body).toContain("not task acceptance");
    });
  }

  posixTest("retains failed self-check status when diagnostic text is compressed", async () => {
    const steps = ["printf first", "exit 7", "printf never"];
    const result = await executeCommandTool({ defaultCwd: root }).handler({ command: steps.map(s => `(${s})`).join(" && "), check_steps: steps });
    expect(result.success).toBe(false);
    expect(result.output).not.toContain("never");
    const registry = new ToolRegistry();
    const agent = new LoopAgent({ registry, executor: new ToolExecutor(registry), provider: { async call() { throw new Error("unused"); } },
      resultCompressor: { compress: () => "compressed diagnostic" } as any }) as any;
    const body = agent.formatResult({ id: "check", name: "bash", arguments: {} }, result, new Map(), new Map()).formattedOutput;
    expect(observation(body).command.exitCode).toBe(7);
    expect(observation(body).selfChecks).toEqual({ passed: false, observedSteps: 2, stepExitCodes: [0, 7] });
    expect(body).toContain("compressed diagnostic");
    expect(body).toContain("[Execution failure]");
  });

  it("keeps a bounded status outside persisted output without leaking runtime internals", () => {
    const registry = new ToolRegistry();
    const agent = new LoopAgent({ registry, executor: new ToolExecutor(registry), provider: { async call() { throw new Error("unused"); } },
      storageSessionId: "projection", storageProjectCwd: root }) as any;
    const result: ToolResult = { success: true, output: "x".repeat(PERSIST_THRESHOLD_CHARS + 10), runtime: {
      command: { commandRef: "private-command-ref", timedOut: false },
      verification: { passed: true, steps: Array.from({ length: 100 }, () => ({ command: "secret command argument", exitCode: 0 })) },
      writeEvidence: { paths: [{ path: "private-artifact", before: { exists: false }, after: { exists: true } }] },
    } };
    const body = agent.formatResult({ id: "large", name: "bash", arguments: {} }, result, new Map(), new Map()).formattedOutput;
    const facts = observation(body);
    expect(facts.command.exitCode).toBeUndefined();
    expect(facts.selfChecks.observedSteps).toBe(100);
    expect(facts.selfChecks.stepExitCodes).toHaveLength(32);
    expect(body).not.toContain("private-command-ref");
    expect(body).not.toContain("secret command argument");
    expect(body).not.toContain("private-artifact");
    expect(JSON.stringify(facts).length).toBeLessThan(500);
    expect(body.length).toBeLessThan(result.output.length);
    expect(body).toContain("persisted");
  });

  it("does not fabricate observations from output or malformed metadata", () => {
    const result = { success: true, output: "exit 0; all tests passed", runtime: {
      command: { commandRef: "ref", exitCode: "0", timedOut: "false" },
      verification: { passed: "true", steps: [] },
    } } as unknown as ToolResult;
    expect(formatToolResultForModel(result)).toBe(result.output);
    expect(formatToolResultForModel({ success: true, output: "ordinary tool" })).toBe("ordinary tool");
  });

  it("uses the same projection for unformatted persisted turns", () => {
    const result: ToolResult = { success: true, output: "no matches", runtime: { command: { commandRef: "ref", exitCode: 1 } } };
    const body = turnToMessages(buildToolTurn({ text: "", completed: [{ id: "grep", name: "bash", arguments: {}, result }] }))[1].content;
    expect(observation(body).command.exitCode).toBe(1);
  });
});
