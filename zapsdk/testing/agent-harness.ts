import type { AgentEvent, AgentEventHandler } from "../agent/events.js";
import {
  LoopAgent,
  type LoopAgentOptions,
  type LoopAgentResult,
  type RunOptions,
} from "../agent/loop.js";
import {
  ToolExecutor,
  type ToolExecutorOptions,
} from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import {
  createScriptedProvider,
  type ScriptedProviderController,
  type ScriptedProviderOptions,
  type ScriptedProviderRequest,
} from "./scripted-provider.js";

export interface AgentHarnessOptions extends ScriptedProviderOptions {
  registry?: ToolRegistry;
  executorOptions?: ToolExecutorOptions;
  agentOptions?: Omit<LoopAgentOptions, "provider" | "registry" | "executor">;
  /** Hard safety timeout around each harness run. Defaults to 5 seconds. */
  runTimeoutMs?: number;
  onEvent?: AgentEventHandler;
}

export interface HarnessToolTrace {
  id: string;
  step: number;
  name: string;
  arguments: Record<string, unknown>;
  result?: ToolResult;
  path?: string[];
}

export interface AgentHarnessRun {
  result: LoopAgentResult;
  events: AgentEvent[];
  providerRequests: ScriptedProviderRequest[];
  toolTrace: HarnessToolTrace[];
  durationMs: number;
}

export interface AgentScenarioOptions extends AgentHarnessOptions {
  input: string;
  runOptions?: RunOptions;
  /** Set false when a scenario intentionally leaves future scripted turns. */
  assertScriptConsumed?: boolean;
}

export class AgentHarnessTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Agent harness exceeded its ${timeoutMs}ms run timeout`);
    this.name = "AgentHarnessTimeoutError";
  }
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function buildToolTrace(events: AgentEvent[]): HarnessToolTrace[] {
  const traces: HarnessToolTrace[] = [];
  const byId = new Map<string, HarnessToolTrace>();
  for (const event of events) {
    if (event.type !== "content_final") continue;
    if (event.kind === "tool_call") {
      const trace: HarnessToolTrace = {
        id: event.id,
        step: event.step,
        name: event.toolName,
        arguments: cloneValue(event.arguments),
        path: cloneValue(event.path),
      };
      traces.push(trace);
      byId.set(`${event.path?.join("/") ?? ""}:${event.id}`, trace);
    } else if (event.kind === "tool_result") {
      const key = `${event.path?.join("/") ?? ""}:${event.id}`;
      const trace = byId.get(key);
      if (trace) trace.result = cloneValue(event.result);
    }
  }
  return traces;
}

/** Scripted regression fixture. Production hosts use createAgentRuntime. */
export class AgentHarness {
  readonly agent: LoopAgent;
  readonly registry: ToolRegistry;
  readonly scriptedProvider: ScriptedProviderController;

  private readonly events: AgentEvent[] = [];
  private readonly runTimeoutMs: number;
  private running = false;

  constructor(options: AgentHarnessOptions) {
    this.registry = options.registry ?? new ToolRegistry();
    this.scriptedProvider = createScriptedProvider(options);
    const executor = new ToolExecutor(this.registry, options.executorOptions);
    this.agent = new LoopAgent({
      ...options.agentOptions,
      provider: this.scriptedProvider.provider,
      registry: this.registry,
      executor,
    });
    this.runTimeoutMs = options.runTimeoutMs ?? 5_000;
    if (!Number.isFinite(this.runTimeoutMs) || this.runTimeoutMs <= 0) {
      throw new Error("AgentHarness runTimeoutMs must be a positive finite number");
    }
    this.agent.on("*", (event) => {
      const snapshot = cloneValue(event);
      this.events.push(snapshot);
      options.onEvent?.(cloneValue(snapshot));
    });
  }

  async run(input: string, options?: RunOptions): Promise<AgentHarnessRun> {
    if (this.running) throw new Error("AgentHarness does not support concurrent run() calls");
    this.running = true;
    const eventStart = this.events.length;
    const requestStart = this.scriptedProvider.requests().length;
    const startedAt = performance.now();
    const controller = new AbortController();
    let timedOut = false;
    const forwardAbort = () => controller.abort(options?.signal?.reason);
    if (options?.signal?.aborted) forwardAbort();
    else options?.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.runTimeoutMs);

    try {
      const result = await this.agent.run(input, {
        ...options,
        signal: controller.signal,
      });
      const events = cloneValue(this.events.slice(eventStart));
      const providerRequests = this.scriptedProvider.requests().slice(requestStart);
      return {
        result: cloneValue(result),
        events,
        providerRequests,
        toolTrace: buildToolTrace(events),
        durationMs: performance.now() - startedAt,
      };
    } catch (error) {
      if (timedOut) throw new AgentHarnessTimeoutError(this.runTimeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", forwardAbort);
      this.running = false;
    }
  }

  allEvents(): AgentEvent[] {
    return cloneValue(this.events);
  }

  assertComplete(): void {
    this.scriptedProvider.assertConsumed();
  }
}

export async function runAgentScenario(
  options: AgentScenarioOptions,
): Promise<AgentHarnessRun> {
  const harness = new AgentHarness(options);
  const run = await harness.run(options.input, options.runOptions);
  if (options.assertScriptConsumed !== false) harness.assertComplete();
  return run;
}

/** Explicit name for the scripted testing fixture; AgentHarness remains compatible. */
export { AgentHarness as ScriptedAgentHarness };
