import { test, expect, spyOn } from "bun:test";
import { subagentTool } from "../../builtin-tools/subagent.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { AgentCoordinator } from "../../coordinator/coordinator.js";
import { DeferredAgentCoordinatorExecutor } from "../../coordinator/executor-bridge.js";
import { z } from "zod";
import type { LLMProvider } from "../../core/llm.js";
import type { ToolResult } from "../../tools/types.js";

// Control expiry independently of filesystem/setup latency. Real deadline
// scheduling is covered separately by executor.deadline.test.ts.
function controlledClock() {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  type Timer = ReturnType<typeof setTimeout>;
  const pending = new Map<Timer, { at: number; fire: () => void }>();
  let now = Date.now();
  const date = spyOn(Date, "now").mockImplementation(() => now);
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]
  ) => {
    const timer = nativeSetTimeout(() => {}, 2_147_483_647);
    timer.unref();
    pending.set(timer, { at: now + Math.max(0, delay), fire: () => callback(...args) });
    return timer;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
    pending.delete(timer as Timer);
    nativeClearTimeout(timer);
  });
  return {
    advance(ms: number) {
      now += ms;
      let fired = 0;
      for (const [timer, event] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (event.at > now || !pending.delete(timer)) continue;
        nativeClearTimeout(timer);
        event.fire();
        fired++;
      }
      return fired;
    },
    async untilReady(ready: Promise<void>) {
      let watchdog: Timer | undefined;
      try {
        await Promise.race([ready, new Promise<never>((_, reject) => {
          watchdog = nativeSetTimeout(() => reject(new Error("Observation precondition was not reached")), 2000);
        })]);
      } finally { nativeClearTimeout(watchdog); }
    },
    restore() {
      for (const timer of pending.keys()) nativeClearTimeout(timer);
      pending.clear();
      clear.mockRestore();
      schedule.mockRestore();
      date.mockRestore();
    },
  };
}

for (const coordinated of [false, true]) for (const outcome of ["complete", "timeout", "cancel"] as const) {
  test(`${coordinated ? "coordinated" : "direct"} child ${outcome} preserves observations without another request`, async () => {
    const registry = new ToolRegistry();
    let count = 0;
    let reads = 0;
    let sawObservation = false;
    let observed!: () => void;
    const observationReady = new Promise<void>(resolve => { observed = resolve; });
    const parentAbort = new AbortController();
    registry.register({
      definition: { name: "read_file", description: "Synthetic observation", parameters: z.object({}), permission: "auto" },
      handler: async () => { reads++; return { success: true, output: "FIXTURE_OBSERVATION: 17 records inspected." }; },
    });
    const provider: LLMProvider = {
      async call(_messages, _tools, opts) {
        const n = ++count;
        if (n === 1) return { type: "tool_call", text: "UNFINISHED_PRIVATE_DRAFT", toolCalls: [{ id: "fixture-read", name: "read_file", arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
        if (n === 2) {
          sawObservation = _messages.some(message => message.role === "tool_result"
            && message.content.includes("FIXTURE_OBSERVATION: 17 records inspected."));
          observed();
          if (outcome === "complete") return { type: "text", text: "FIXTURE_OBSERVATION: 17 records inspected.", usage: { inputTokens: 1, outputTokens: 1 } };
          await new Promise((_, reject) => {
            const abort = () => reject(new Error("aborted"));
            if (opts?.signal?.aborted) abort();
            else opts?.signal?.addEventListener("abort", abort, { once: true });
          });
          throw new Error("unreachable");
        }
        // Let broken cleanup finish so the probe itself cannot leave a hang.
        return { type: "text", text: "", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const bridge = new DeferredAgentCoordinatorExecutor();
    const coordinator = new AgentCoordinator({ threadId: "synthetic-timeout", executor: bridge });
    registry.register(subagentTool({
      provider, registry, timeoutMs: 150,
      ...(coordinated ? { coordinator, coordinatorExecutorBridge: bridge } : {}),
    }));
    const executor = new ToolExecutor(registry);
    const clock = controlledClock();
    const started = performance.now();
    let result: ToolResult;
    try {
      const execution = executor.execute("agent", { task: "Inspect the synthetic record and report it.", agent_type: "explore" }, parentAbort.signal);
      // Observe rejection even if the readiness watchdog or assertion fails.
      void execution.catch(() => {});
      await clock.untilReady(observationReady);
      expect(reads).toBe(1);
      expect(sawObservation).toBe(true);
      if (outcome === "timeout") expect(clock.advance(150)).toBeGreaterThan(0);
      if (outcome === "cancel") parentAbort.abort(new Error("Synthetic user cancellation"));
      result = await execution;
    } finally {
      parentAbort.abort();
      clock.restore();
    }
    const returnedMs = performance.now() - started;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(result.output).not.toContain("UNFINISHED_PRIVATE_DRAFT");
    if (count !== 2) throw new Error("Unexpected provider request count");
    if (outcome === "complete" && (!result.success || !result.output.includes("FIXTURE_OBSERVATION"))) throw new Error("Successful control lost output");
    if (outcome !== "complete") {
      expect(result.success).toBe(false);
      expect(result.output).toContain("Partial completed tool observations");
      expect(result.output).toContain("FIXTURE_OBSERVATION: 17 records inspected.");
      expect(result.failure?.code).toBe(outcome === "timeout" ? "DEADLINE_EXCEEDED" : "CANCELLED");
      expect(returnedMs).toBeLessThan(1000);
    }
  });
}

for (const coordinated of [false, true]) {
  test(`${coordinated ? "coordinated" : "direct"} child with an expired deadline never starts a model request`, async () => {
    const registry = new ToolRegistry();
    let requests = 0;
    const provider: LLMProvider = { async call() {
      requests++;
      return { type: "text", text: "unexpected", usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    const bridge = new DeferredAgentCoordinatorExecutor();
    const coordinator = new AgentCoordinator({ threadId: "expired-child", executor: bridge });
    registry.register(subagentTool({ provider, registry, timeoutMs: 150,
      ...(coordinated ? { coordinator, coordinatorExecutorBridge: bridge } : {}),
    }));
    const result = await new ToolExecutor(registry).execute("agent", {
      task: "This must not start", agent_type: "explore",
    }, undefined, { deadlineAtMs: Date.now() - 1 });
    expect(result.success).toBe(false);
    expect(result.failure?.code).toBe("DEADLINE_EXCEEDED");
    expect(requests).toBe(0);
    expect(result.output).not.toContain("FIXTURE_OBSERVATION");
  });
}

test("concurrent coordinated children retain their own failed diagnostics without cross-talk", async () => {
  const registry = new ToolRegistry();
  const parentAbort = new AbortController();
  const waiting = new Set<string>();
  registry.register({
    definition: { name: "read_file", description: "Synthetic read", permission: "auto", parameters: z.object({ label: z.string() }) },
    handler: async args => ({ success: false, output: `OBSERVED_${args.label}`, error: `UNREADABLE_${args.label}` }),
  });
  const counts = new Map<string, number>();
  const provider: LLMProvider = {
    async call(messages, _tools, opts) {
      const label = messages.some(m => m.role === "user" && m.content.includes("ALPHA")) ? "ALPHA" : "BETA";
      const count = (counts.get(label) ?? 0) + 1;
      counts.set(label, count);
      if (count === 1) return { type: "tool_call", text: "", toolCalls: [{ id: "same-child-call-id", name: "read_file", arguments: { label } }], usage: { inputTokens: 1, outputTokens: 1 } };
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new Error("aborted"));
        if (opts?.signal?.aborted) abort();
        else opts?.signal?.addEventListener("abort", abort, { once: true });
        // Both children must have settled their tool observations before
        // interruption; a short wall timer can expire during setup on a busy host.
        waiting.add(label);
        if (waiting.size === 2) parentAbort.abort(new Error("Both observations completed"));
      });
      throw new Error("unreachable");
    },
  };
  const bridge = new DeferredAgentCoordinatorExecutor();
  const coordinator = new AgentCoordinator({ threadId: "parallel-partials", executor: bridge });
  registry.register(subagentTool({ provider, registry, timeoutMs: 5000, coordinator, coordinatorExecutorBridge: bridge }));
  const executor = new ToolExecutor(registry);
  const results = await Promise.all(["ALPHA", "BETA"].map(label => executor.execute("agent", { task: label, agent_type: "explore" }, parentAbort.signal, { toolCallId: label })));
  for (const [i, label] of ["ALPHA", "BETA"].entries()) {
    expect(results[i]!.success).toBe(false);
    expect(results[i]!.failure?.code).toBe("CANCELLED");
    expect(results[i]!.output).toContain(`OBSERVED_${label}`);
    expect(results[i]!.output).toContain(`UNREADABLE_${label}`);
    expect(results[i]!.output).not.toContain(label === "ALPHA" ? "BETA" : "ALPHA");
    expect(counts.get(label)).toBe(2);
  }
});
