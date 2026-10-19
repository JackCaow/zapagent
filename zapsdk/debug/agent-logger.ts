import type { AgentEvent } from "../agent/events.js";
import type { AgentEventSource } from "../agent/events.js";
import { Logger } from "./logger.js";
import { computeCacheUsageStats } from "../agent/cache-metrics.js";
import type { TokenUsage } from "../core/types.js";
import type { RuntimeRecoveryReport } from "../runtime/state-types.js";

/**
 * Attaches to a LoopAgent and writes structured log entries for every event.
 * Tracks per-step and per-tool timing automatically.
 */
export class AgentLogger {
  private logger: Logger;
  private stepStartMs = 0;
  private toolStartMsById = new Map<string, number>(); // tool_call id → start ms
  private runStartMs = 0;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** Subscribe to all events on the given agent */
  attach(agent: AgentEventSource): void {
    agent.on("*", (event) => this.handle(event));
  }

  /** Flush pending log writes */
  async flush(): Promise<void> {
    await this.logger.flush();
  }

  runtimeEventStoreError(error: Error): void {
    this.logger.error("runtime_event_store_failed", { message: error.message });
  }

  runtimeRecovery(reports: RuntimeRecoveryReport[]): void {
    const dispositions: Record<string, number> = {};
    let actionCount = 0;
    for (const report of reports) {
      for (const action of report.actions) {
        actionCount++;
        dispositions[action.disposition] = (dispositions[action.disposition] ?? 0) + 1;
      }
    }
    this.logger.warn("runtime_recovery_detected", {
      threadIds: reports.map((report) => report.threadId),
      actionCount,
      dispositions,
    });
  }

  // ── Event handler ───────────────────────────────────────────────────────────

  private handle(event: AgentEvent): void {
    const now = Date.now();

    switch (event.type) {
      case "run_started":
        this.runStartMs = now;
        this.logger.info("run_started", {
          inputPreview: event.input.slice(0, 120),
          inputLen: event.input.length,
        });
        break;

      case "run_step":
        this.stepStartMs = now;
        this.logger.info("run_step", {
          step: event.step,
          messageCount: event.messageCount,
          context: event.context,
          timeBudget: event.timeBudget,
        });
        break;

      case "run_usage": {
        this.logger.info("run_usage", {
          step: event.step,
          ...formatUsageLogFields(event),
          outputTokens: event.outputTokens,
          finishReason: event.finishReason,
        });
        break;
      }

      case "provider_request": {
        const request = event.request;
        if (request.phase === "completed" || request.phase === "failed") {
          this.logger.info("provider_request", {
            step: event.step, requestId: event.requestId,
            phase: request.phase, attempt: request.attempt,
            elapsedMs: request.elapsedMs, reason: request.reason,
            requestBytes: request.requestBytes,
            requestFingerprint: request.requestFingerprint,
          });
        }
        break;
      }

      case "content_final": {
        if (event.kind === "tool_call") {
          this.toolStartMsById.set(event.id, now);
          this.logger.info("tool_call", {
            step: event.step,
            tool: event.toolName,
            args: sanitizeArgs(event.arguments),
          });
        } else if (event.kind === "tool_result") {
          const startMs = this.toolStartMsById.get(event.id) ?? now;
          this.toolStartMsById.delete(event.id);
          const fields: Record<string, unknown> = {
            step: event.step,
            tool: event.toolName,
            success: event.result.success,
            durationMs: now - startMs,
            outputLen: event.result.output.length,
          };
          if (!event.result.success && event.result.error) {
            fields.error = event.result.error.slice(0, 300);
          }
          this.logger.info("tool_result", fields);
        }
        // text / thinking finals are too noisy to log
        break;
      }

      case "run_ended": {
        this.logger.info("run_ended", {
          steps: event.steps,
          ...formatUsageLogFields(event.usage),
          outputTokens: event.usage.outputTokens,
          durationMs: now - this.runStartMs,
          stopped: event.stopped,
          finishReason: event.finishReason,
        });
        break;
      }

      case "error":
        this.logger.error("agent_error", {
          step: event.step,
          message: event.error,
        });
        break;

      case "observation":
        this.logger.warn(`observation:${event.kind}`, event.detail ?? {});
        break;

      case "tool_call_pending":
        // Helps diagnose "UI froze" complaints: we can see how long we waited
        // between tool_call_pending and content_final.tool_call.
        this.logger.info("tool_call_pending", {
          step: event.step,
          tool: event.toolName,
        });
        break;

      // content_delta: too noisy — skip
      // status, sub_agent_*: no-op for structured log
    }
  }
}

type UsageLogInput = Pick<
  TokenUsage,
  "inputTokens" | "providerUsageReported" | "cacheReadInputTokens" | "cacheCreationInputTokens"
>;

export function formatUsageLogFields(usage: UsageLogInput): Record<string, unknown> {
  const cache = computeCacheUsageStats(usage);
  const cacheReadReported = typeof usage.cacheReadInputTokens === "number";
  const cacheCreationReported = typeof usage.cacheCreationInputTokens === "number";
  return {
    inputTokens: usage.inputTokens,
    ...(typeof usage.providerUsageReported === "boolean"
      ? { providerUsageReported: usage.providerUsageReported }
      : {}),
    ...(cacheReadReported ? { cacheReadInputTokens: cache.cacheReadInputTokens } : {}),
    ...(cacheCreationReported ? { cacheCreationInputTokens: cache.cacheCreationInputTokens } : {}),
    totalPromptInputTokens: cache.totalPromptInputTokens,
    ...(cacheReadReported || cacheCreationReported
      ? {
          cacheHitRatio: cache.cacheHitRatio,
          cacheReuseRatio: cache.cacheReuseRatio,
          cacheWriteRatio: cache.cacheWriteRatio,
        }
      : {}),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip large values from tool args to keep logs compact */
function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.length > 200) {
      out[k] = v.slice(0, 200) + `…(${v.length} chars)`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
