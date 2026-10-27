import { writeFileSync } from "node:fs";
import { z } from "zod";
import { LoopAgent } from "../zapsdk/agent/loop.js";
import { ConversationManager } from "../zapsdk/memory/conversation.js";
import { ToolRegistry } from "../zapsdk/tools/registry.js";
import { ToolExecutor } from "../zapsdk/tools/executor.js";
import { OpenAICompatibleProvider } from "../zapsdk/core/providers/openai-compatible.js";
import { TokenCounter } from "../zapsdk/context/token-counter.js";
import { compactBudget } from "../zapsdk/context/compact-budget.js";
import { computeCacheUsageStats } from "../zapsdk/agent/cache-metrics.js";
import type { Message, TokenUsage } from "../zapsdk/core/types.js";

/** Deterministic local HTTP benchmark, including synthetic provider accounting.
 * Validates request-prefix behavior and bookkeeping, never real cache hit rate. */
export async function benchmarkContextMaintenance() {
  const rows: any[] = [], counter = new TokenCounter();
  let wire: any, previous: any[] = [], reported = true;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    wire = await request.json();
    const messages = wire.messages as any[];
    let common = 0;
    while (common < Math.min(messages.length, previous.length)
      && JSON.stringify(messages[common]) === JSON.stringify(previous[common])) common++;
    const total = counter.countText(JSON.stringify(messages));
    const cached = counter.countText(JSON.stringify(messages.slice(0, common)));
    previous = structuredClone(messages);
    const round = messages.filter(message => message.role === "tool" && message.tool_call_id?.startsWith("observe-")).length;
    const delta = round < 4 ? { role: "assistant", tool_calls: [{ index: 0, id: `observe-${round}`, type: "function", function: { name: "observe", arguments: JSON.stringify({ round }) } }] }
      : { role: "assistant", content: "TASK_VERIFIED: all four observations and CURRENT_CONSTRAINT retained." };
    const event = (delta: any, finish: any) => `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const usage = { prompt_tokens: total, completion_tokens: 20,
      ...(reported ? { prompt_tokens_details: { cached_tokens: common ? cached : 0 } } : {}) };
    return new Response(event(delta, null) + event({}, round < 4 ? "tool_calls" : "stop")
      + `data: ${JSON.stringify({ id: "fixture", choices: [], usage })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    for (const prune of [false, true]) {
      previous = []; reported = true;
      const conversation = new ConversationManager({ maxMessages: Infinity, imageRetention: false });
      conversation.add({ role: "user", content: "Historical task" });
      for (let i = 0; i < 8; i++) {
        conversation.add({ role: "assistant", content: "", toolCalls: [{ id: `old-${i}`, name: "read", arguments: { path: `${i}.txt` } }] });
        conversation.add({ role: "tool_result", toolCallId: `old-${i}`, toolResultSuccess: true, content: "OLD_SOURCE " + "a ".repeat(1200) + " OLD_TAIL" });
      }
      const registry = new ToolRegistry(); let tools = 0;
      registry.register({ definition: { name: "observe", description: "Observe deterministic fixture", parameters: z.object({ round: z.number() }) },
        handler: async ({ round }) => { tools++; return { success: true, output: round === 0 ? "OBSERVE_0 " + "b ".repeat(1600) + " OBSERVATION_TAIL" : `OBSERVE_${round}: verified` }; } });
      const provider = new OpenAICompatibleProvider({ baseURL: `http://127.0.0.1:${server.port}/v1`, model: "fixture", apiKey: "test-only" });
      const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), conversation, contextWindow: 20000,
        reservedOutputTokens: 1000, autoCompactEnabled: false, pruneEnabled: prune, maxSteps: 8,
        autoCompactTokenThreshold: compactBudget({ contextWindow: 20000, reservedOutputTokens: 1000 })!.compactAt });
      const observations: any[] = [], usage: Array<TokenUsage & { purpose: string }> = [];
      agent.on("observation", event => { if (event.type === "observation") observations.push({ kind: event.kind, ...event.detail }); });
      agent.on("run_usage", event => { if (event.type === "run_usage") usage.push({ ...event, purpose: event.purpose ?? "main" }); });
      const started = performance.now();
      const result = await agent.run("CURRENT_CONSTRAINT: observe four times, preserve evidence, do not publish.");
      const stats = usage.reduce((out, value) => {
        const cache = computeCacheUsageStats(value);
        out.totalInput += cache.totalPromptInputTokens; out.fresh += cache.freshInputTokens;
        out.cacheRead += cache.cacheReadInputTokens; out.cacheWrite += cache.cacheCreationInputTokens;
        out[value.purpose === "maintenance" ? "maintenanceCalls" : "mainCalls"]++;
        return out;
      }, { totalInput: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, maintenanceCalls: 0, mainCalls: 0 });
      rows.push({ prune, accounting: "synthetic provider fixture", ...stats, durationMs: Math.round(performance.now() - started),
        maintenanceInput: usage.filter(u => u.purpose === "maintenance").reduce((n, u) => n + computeCacheUsageStats(u).totalPromptInputTokens, 0),
        maintenanceOutput: usage.filter(u => u.purpose === "maintenance").reduce((n, u) => n + u.outputTokens, 0),
        tools, quality: result.text.includes("TASK_VERIFIED") && wire.messages.some((m: any) => String(m.content).includes("CURRENT_CONSTRAINT")),
        prefixChanges: observations.filter(o => o.kind === "request_cache_shape"), pruneEvents: observations.filter(o => o.kind === "prune_done") });
    }
    return { mockOnly: true, scenarios: rows };
  } finally { server.stop(); }
}
if (import.meta.main) {
  const report = await benchmarkContextMaintenance();
  console.log(JSON.stringify(report, null, 2));
  if (process.env.ZAP_CONTEXT_BENCHMARK_REPORT) writeFileSync(process.env.ZAP_CONTEXT_BENCHMARK_REPORT, JSON.stringify(report, null, 2), { mode: 0o600 });
}
