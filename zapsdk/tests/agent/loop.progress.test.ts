import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk } from "../../core/types.js";
import { GoalWorkspaceGate } from "../../execution/goal-workspace-gate.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("LoopAgent progress observations", () => {
  it("does not resolve filesystem effects outside a workspace fence after execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "goal-progress-gate-"));
    try {
      let turns = 0, handlerRan = false, lateResolutions = 0;
      const provider: LLMProvider = { async call() { throw new Error("unexpected call"); },
        async *stream(): AsyncIterable<LLMChunk> {
          if (++turns === 1) {
            yield { type: "tool_call_start", toolCallId: "read-1", toolName: "probe" };
            yield { type: "tool_call_delta", toolCallId: "read-1", partialJson: "{}" };
          } else yield { type: "text_delta", text: "done" };
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
        } };
      const registry = new ToolRegistry();
      registry.register({ definition: { name: "probe", description: "probe", parameters: z.object({}),
        resolveEffects() { if (handlerRan) lateResolutions++; return { filesystem: [{ kind: "filesystem", operation: "read", paths: [root] }],
          network: [], process: [], external: [], workspace: { mode: "shared-readonly" }, confidence: "declared" }; } },
        async handler() { handlerRan = true; return { success: true, output: "observed" }; } });
      const executor = new ToolExecutor(registry, { cwd: root, workspace: { root }, workspaceGate: new GoalWorkspaceGate() });
      const result = await new LoopAgent({ provider, registry, executor, maxSteps: 5 }).run("inspect");
      expect(result.toolResults).toHaveLength(1);
      expect(lateResolutions).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const mode of ["native", "xml"] as const) {
    it(`reports completed ${mode} model and tool time in the next request, resetting between runs`, async () => {
      let now = 0;
      let turns = 0;
      const provider: LLMProvider = {
        async call() { throw new Error("unexpected final synthesis"); },
        async *stream(messages): AsyncIterable<LLMChunk> {
          turns++;
          const context = messages.map(message => typeof message.content === "string" ? message.content : "").join("\n");
          if (turns % 2 === 1) {
            expect(context).not.toContain("Recent completed rounds took");
            now += 2_000;
            if (mode === "xml") yield { type: "text_delta", text: "<tool_call>bash<arg_key>command</arg_key><arg_value>check</arg_value></tool_call>" };
            else {
              yield { type: "tool_call_start", toolCallId: `check-${turns}`, toolName: "bash" };
              yield { type: "tool_call_delta", toolCallId: `check-${turns}`, partialJson: '{"command":"check"}' };
            }
          } else {
            expect(context).toContain("Recent completed rounds took 5.0s");
            expect(context).toContain("historical observations, not predictions or additional limits");
            yield { type: "text_delta", text: "done" };
          }
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const registry = new ToolRegistry();
      registry.register({ definition: { name: "bash", description: "shell", parameters: z.object({ command: z.string() }) },
        handler: async () => { now += 3_000; return { success: true, output: "checked" }; } });
      const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), maxSteps: 10,
        timeoutMs: 100_000, forceFinishTimeoutMs: 1_000, now: () => now });
      for (let run = 0; run < 2; run++) {
        const result = await agent.run("check the workspace");
        expect(result.stopped).toBeUndefined();
        expect(result.toolResults).toHaveLength(1);
      }
      expect(turns).toBe(4);
    });

    it(`continues useful shell diagnostics through ${mode} tools without a stall instruction`, async () => {
      let turns = 0;
      const provider: LLMProvider = {
        async call() { throw new Error("unexpected final synthesis"); },
        async *stream(messages): AsyncIterable<LLMChunk> {
          turns++;
          expect(messages.some(message => typeof message.content === "string"
            && message.content.includes("[Harness observation — repeated tool results]"))).toBe(false);
          if (turns <= 5) {
            if (mode === "xml") yield { type: "text_delta", text: `<tool_call>bash<arg_key>command</arg_key><arg_value>diagnose ${turns}</arg_value></tool_call>` };
            else {
              yield { type: "tool_call_start", toolCallId: `diagnose-${turns}`, toolName: "bash" };
              yield { type: "tool_call_delta", toolCallId: `diagnose-${turns}`, partialJson: JSON.stringify({ command: `diagnose ${turns}` }) };
            }
          } else yield { type: "text_delta", text: "diagnosis complete, correctness unverified" };
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const registry = new ToolRegistry();
      registry.register({ definition: { name: "bash", description: "shell", parameters: z.object({ command: z.string() }) },
        handler: async (args) => ({ success: true, output: `observation from ${args.command}`, runtime: {
          command: { commandRef: `command-${turns}`, exitCode: 0, timedOut: false, aborted: false },
        } }) });
      const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), maxSteps: 10, adaptiveBudget: {} });
      const observations: Record<string, unknown>[] = [];
      agent.on("observation", event => {
        if (event.type === "observation" && event.kind === "tool_progress") observations.push(event.detail ?? {});
      });
      const result = await agent.run("investigate the incorrect output");
      expect(result.toolResults).toHaveLength(5);
      expect(observations).toHaveLength(5);
      for (const observation of observations) expect(observation).toMatchObject({
        newObservation: true, verificationPassed: false, consecutiveNoProgress: 0,
      });
      expect(result.stopped).toBeUndefined();
    });

    it(`detects successful edit stagnation through ${mode} tools`, async () => {
      let turns = 0;
      const provider: LLMProvider = {
        async call() { throw new Error("unexpected final synthesis"); },
        async *stream(messages): AsyncIterable<LLMChunk> {
          turns++;
          if (turns === 6) expect(messages.filter(message => typeof message.content === "string"
            && message.content.includes("[Harness observation — repeated tool results]"))).toHaveLength(1);
          if (turns === 6) expect(messages.some(message => typeof message.content === "string"
            && message.content.includes("Converge: stop broad exploration"))).toBe(false);
          if (turns <= 5) {
            if (mode === "xml") yield { type: "text_delta", text: "<tool_call>edit_file<arg_key>path</arg_key><arg_value>source</arg_value></tool_call>" };
            else {
              yield { type: "tool_call_start", toolCallId: `edit-${turns}`, toolName: "edit_file" };
              yield { type: "tool_call_delta", toolCallId: `edit-${turns}`, partialJson: '{"path":"source"}' };
            }
          } else yield { type: "text_delta", text: "incomplete" };
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const registry = new ToolRegistry();
      registry.register({ definition: { name: "edit_file", description: "edit", parameters: z.object({ path: z.string() }) },
        handler: async () => ({ success: true, output: "written" }) });
      const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), maxSteps: 10, adaptiveBudget: {} });
      const decisions: string[] = [];
      const progress: number[] = [];
      agent.on("observation", event => {
        if (event.type !== "observation") return;
        if (event.kind === "budget_decision") decisions.push(String(event.detail?.reasonCode));
        if (event.kind === "tool_progress") progress.push(Number(event.detail?.consecutiveNoProgress));
      });
      const result = await agent.run("make a change");
      expect(result.toolResults).toHaveLength(5);
      expect(progress).toEqual([1, 2, 3, 4, 5]);
      expect(decisions).toContain("stalled_progress");
      expect(result.stopped).toBeUndefined();
    });
  }
});
