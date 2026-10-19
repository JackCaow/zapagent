import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import { executeCommandTool } from "../../builtin-tools/command.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk, Message } from "../../core/types.js";
import { buildToolTurn, turnToMessages } from "../../core/turn.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { PERSIST_THRESHOLD_CHARS, readPersistedOutput } from "../../utils/tool-result-storage.js";
import { resolveProjectDataSegment } from "../../utils/project-paths.js";

describe("failed tool observations", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  beforeEach(() => {
    previousDataDir = process.env.ZAPCODE_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "zap-failure-observations-"));
    process.env.ZAPCODE_DATA_DIR = dataDir;
  });
  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR;
    else process.env.ZAPCODE_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  for (const mode of ["native", "xml", "nonstreaming"] as const) {
    it(`delivers both the failure and diagnostic output on the next ${mode} request`, async () => {
      let requests = 0;
      let executions = 0;
      const observe = (messages: Message[]) => {
        requests++;
        if (requests === 2) {
          const result = messages.find(message => message.role === "tool_result");
          expect(result?.content).toContain("expected 7, observed 9");
          expect(result?.content).toContain("validation exited 1");
          expect(result?.content).toContain('"code":"EXECUTION_FAILED"');
        }
      };
      const provider: LLMProvider = {
        async call(messages) {
          observe(messages);
          return requests === 1
            ? { type: "tool_call", text: "", toolCalls: [{ id: "check", name: "check", arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } }
            : { type: "text", text: "Validation failed; diagnostics received.", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      if (mode !== "nonstreaming") provider.stream = async function* (messages): AsyncIterable<LLMChunk> {
        observe(messages);
        if (requests === 1) {
          if (mode === "xml") yield { type: "text_delta", text: "<tool_call>check</tool_call>" };
          else {
            yield { type: "tool_call_start", toolCallId: "check", toolName: "check" };
            yield { type: "tool_call_delta", toolCallId: "check", partialJson: "{}" };
          }
        } else yield { type: "text_delta", text: "Validation failed; diagnostics received." };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      };
      const registry = new ToolRegistry();
      registry.register({ definition: { name: "check", description: "Run a diagnostic", parameters: z.object({}) },
        handler: async () => { executions++; return { success: false, output: "expected 7, observed 9", error: "validation exited 1" }; } });
      const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), maxSteps: 3 });
      const result = await agent.run("Run the diagnostic and report the result.");
      expect(executions).toBe(1);
      expect(requests).toBe(2);
      expect(result.toolResults[0]?.success).toBe(false);
    });
  }

  it("preserves output in tool turns serialized without a preformatted result", () => {
    const result = { success: false, output: "partial diagnostic evidence", error: "execution interrupted" };
    const messages = turnToMessages(buildToolTurn({ text: "", completed: [
      { id: "check", name: "check", arguments: {}, result },
    ] }));
    const content = messages.find(message => message.role === "tool_result")!.content;
    expect(content).toContain("partial diagnostic evidence");
    expect(content).toContain("execution interrupted");
    expect(content).toContain('"code":"EXECUTION_FAILED"');
    expect(result.output).toBe("partial diagnostic evidence");
  });

  it("retains stdout and stderr beyond the shell error summary", async () => {
    const tool = executeCommandTool();
    const command = "printf 'stdout evidence\\n'; i=0; while [ $i -lt 20 ]; do printf 'stderr detail %s\\n' \"$i\" >&2; i=$((i+1)); done; printf 'stderr tail evidence\\n' >&2; exit 1";
    const result = await tool.handler({ command });
    expect(result.success).toBe(false);
    expect(result.output).toContain("stdout evidence");
    expect(result.output).toContain("stderr detail 0");
    expect(result.output).toContain("stderr tail evidence");
    expect(result.error).toContain("Exit code: 1");
  });

  it("stores oversized failure output before producing a bounded model preview", () => {
    const registry = new ToolRegistry();
    const provider: LLMProvider = { async call() { throw new Error("unused"); } };
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry),
      storageSessionId: "failure-output", storageProjectCwd: dataDir }) as any;
    const output = `HEAD:${"evidence ".repeat(PERSIST_THRESHOLD_CHARS)}:TAIL`;
    const formatted = agent.formatResult({ id: "failed-check", name: "check", arguments: {} },
      { success: false, output, error: "validation exited 1" }, new Map(), new Map()).formattedOutput as string;
    const storedPath = join(dataDir, "projects", resolveProjectDataSegment(dataDir), "tool-outputs", "failure-output", "failed-check.txt");
    const stored = readPersistedOutput(storedPath);
    expect(stored).toContain(output);
    expect(stored).toContain("validation exited 1");
    expect(formatted).toContain(storedPath);
    expect(formatted).toContain('"code":"EXECUTION_FAILED"');
    expect(formatted.length).toBeLessThan(output.length);
  });
});
