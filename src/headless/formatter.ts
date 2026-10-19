import type { AgentOutcomeV1 } from "../../zapsdk/runtime/outcome.js"
import type { InlineAcceptanceRecord } from "../../zapsdk/runtime/inline-acceptance.js"
// Output formatters for headless runs. Three modes, all sharing one observer
// that ingests AgentEvent + per-tool timing and emits to stdout / stderr.
//
//   text          — silent during run (stderr progress unless --quiet),
//                   prints final assistant text to stdout at end.
//   json          — silent during run, prints one JSON object on completion.
//   stream-json   — emits one JSON event per line during the run (NDJSON),
//                   then a final `{"type":"result", ...}` line.
//
// All formatters share a `finalize(summary)` entry point so the runner can
// call it uniformly regardless of mode.

import type { AgentEvent, ExecutionObservation, OperationFailure } from "../../zapsdk/index.js"
import type { ToolResult } from "../../zapsdk/tools/types.js"
import type { CompletionAssessment } from "../../zapsdk/harness/completion.js"
import type { TokenUsage } from "../../zapsdk/core/types.js"
import type { OutputFormat } from "./args.js"
import { collectSourceUrls, NETWORK_RESULT_TOOLS, type SourceUrlEvidence } from "./source-urls.js"
import { getToolAlias } from "../ui/transcript-format.js"
import { countCodePoints, sliceHeadCodePoints } from "../utils/logicalLines.js"

export type StopReason =
  | "incomplete"
  | "end_turn"
  | "max_steps"
  | "max_tokens"
  | "budget"
  | "timeout"
  | "max_repeat"
  | "aborted"
  | "error"
  | "permission_denied"
  | "input_required"
  | "capability_unavailable"

export interface ToolCallRecord {
  name: string
  args: Record<string, unknown>
  ok: boolean
  ms: number
  error?: string
  failure?: OperationFailure
  execution?: ExecutionObservation
  command?: NonNullable<ToolResult["runtime"]>["command"]
  verification?: NonNullable<ToolResult["runtime"]>["verification"]
  service?: NonNullable<ToolResult["runtime"]>["service"]
  serviceOperation?: NonNullable<ToolResult["runtime"]>["serviceOperation"]
  sourceUrls?: SourceUrlEvidence
  resultSourcePolicy?: NonNullable<ToolResult["runtime"]>["resultSourcePolicy"]
}

export interface RunSummary {
  outcome?: AgentOutcomeV1
  publicChecks?: { status: "passed" | "stopped"; code: string;
    usage: { modelCalls: number; toolCalls: number; deadlineAt: number };
    attempts: Array<{ attemptId: string; recordId: string; snapshotId?: string; report: InlineAcceptanceRecord["report"] }> }
  ok: boolean
  text: string
  sessionId: string
  turns: number
  usage: TokenUsage
  toolCalls: ToolCallRecord[]
  stopReason: StopReason
  error?: string | null
  completion?: CompletionAssessment
}

export interface HeadlessFormatter {
  /** Emitted by runHeadless once provider/model/session are bound.
   *  `resumedFrom` is set when --continue / --session-id loaded a prior
   *  session — the new fork id is in `sessionId`, the source in `resumedFrom`. */
  init(detail: { sessionId: string; model: string; provider: string; resumedFrom?: string }): void
  /** Stream JSON retains scoped child tool evidence separately from root
   * accounting; nested text, thinking and context chatter remain suppressed. */
  onEvent(event: AgentEvent): void
  /** Stderr progress line (skipped in --quiet text mode and in JSON modes). */
  progress(line: string): void
  /** Print final result. Called exactly once at end of run, even on error. */
  finalize(summary: RunSummary): void
  failure?(error: { code: string; message: string }): void
}

function jline(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n")
}

/** Compact a tool result preview (first 200 chars, single line). */
function previewOutput(s: string): string {
  if (!s) return ""
  const oneline = s.replace(/\s+/g, " ").trim()
  return countCodePoints(oneline) > 200
    ? sliceHeadCodePoints(oneline, 199) + "…"
    : oneline
}

export function createFormatter(format: OutputFormat, quiet: boolean, resultSchema: "outcome-v1" | "legacy" = "legacy"): HeadlessFormatter {
  const toolCalls: ToolCallRecord[] = []
  // Map content_final.tool_call id → { startedAt, name, args } so tool_result
  // can compute latency AND recover args for the json/stream-json record.
  const toolStart = new Map<string, { startedAt: number; name: string; args: Record<string, unknown> }>()

  const isStream = format === "stream-json"

  return {
    init({ sessionId, model, provider, resumedFrom }) {
      if (isStream) jline({ type: "system", subtype: "init", ...(resultSchema === "outcome-v1" ? { schema: "zap.outcome", schemaVersion: 1 } : {}), sessionId, model, provider, resumedFrom: resumedFrom ?? null })
    },

    onEvent(event) {
      const nested = Boolean(event.path?.length)
      if (nested && (!isStream || event.type !== "content_final"
        || (event.kind !== "tool_call" && event.kind !== "tool_result"))) return
      if (event.type === "content_abandoned" && isStream) {
        jline(event)
        return
      }

      if (event.type === "content_delta" && event.kind === "text" && isStream) {
        jline({ type: "assistant", delta: event.text })
        return
      }
      if (event.type === "run_step" && (event.context || event.timeBudget) && isStream) {
        jline({
          type: "context",
          step: event.step,
          messageCount: event.messageCount,
          ...(event.context ? { context: event.context } : {}),
          ...(event.timeBudget ? { timeBudget: event.timeBudget } : {}),
        })
        return
      }
      if (event.type === "content_final" && event.kind === "tool_call") {
        const key = JSON.stringify([event.path ?? [], event.id])
        toolStart.set(key, { startedAt: Date.now(), name: event.toolName, args: event.arguments })
        if (isStream) {
          jline({
            type: nested ? "subagent_tool_use" : "tool_use",
            ...(nested ? { path: event.path } : {}),
            id: event.id,
            name: event.toolName,
            alias: getToolAlias(event.toolName),
            args: event.arguments,
            step: event.step,
          })
        }
        return
      }
      if (event.type === "content_final" && event.kind === "tool_result") {
        const key = JSON.stringify([event.path ?? [], event.id])
        const started = toolStart.get(key)
        toolStart.delete(key)
        const ms = started ? Date.now() - started.startedAt : 0
        const ok = event.result.success !== false
        const errMsg = !ok
          ? (event.result.error ?? (typeof event.result.output === "string" ? event.result.output : ""))
          : undefined
        const audit = {
          ...(event.result.runtime?.service ? { service: event.result.runtime.service } : {}),
          ...(event.result.runtime?.serviceOperation ? { serviceOperation: event.result.runtime.serviceOperation } : {}),
          ...(event.result.runtime?.resultSourcePolicy ? { resultSourcePolicy: event.result.runtime.resultSourcePolicy } : {}),
          ...(NETWORK_RESULT_TOOLS.has(event.toolName) ? { sourceUrls: collectSourceUrls(typeof event.result.output === "string" ? event.result.output : "") } : {}),
          ...(event.result.failure ? { failure: event.result.failure } : {}),
          ...(event.result.runtime?.execution ? { execution: event.result.runtime.execution } : {}),
          ...(event.result.runtime?.command ? { command: event.result.runtime.command } : {}),
          ...(event.result.runtime?.verification ? { verification: event.result.runtime.verification } : {}),
        }
        if (!nested) toolCalls.push({
          name: event.toolName,
          args: started?.args ?? {},
          ok,
          ms,
          error: errMsg,
          ...audit,
        })
        if (isStream) {
          jline({
            type: nested ? "subagent_tool_result" : "tool_result",
            ...(nested ? { path: event.path } : {}),
            id: event.id,
            name: event.toolName,
            ok,
            ms,
            preview: previewOutput(typeof event.result.output === "string" ? event.result.output : ""),
            error: errMsg,
            ...audit,
          })
        }
        return
      }
      if (event.type === "error" && isStream) {
        jline({ type: "error", step: event.step, message: event.error })
        return
      }
      if (event.type === "provider_request" && isStream) {
        jline({ type: "observation", kind: "provider_request", detail: { step: event.step, ...event.request } })
        return
      }
      if (event.type === "observation" && isStream) {
        // Surface observations one-shot. UI suppressed these but for a
        // headless run they're useful for diagnostics (autocompact, etc.).
        jline({ type: "observation", kind: event.kind, detail: event.detail ?? null })
        return
      }
    },

    progress(line) {
      if (format !== "text" || quiet) return
      process.stderr.write(line + "\n")
    },

    failure(error) {
      if (format === "text") process.stderr.write(`error: ${error.code}: ${error.message}\n`)
      else jline({ type: "error", ...error })
    },
    finalize(summary) {
      if (format === "text") {
        if (summary.publicChecks) process.stderr.write(`Public checks: ${summary.publicChecks.status} (${summary.publicChecks.code})\n`)
        if (summary.text) {
          process.stdout.write(summary.text)
          if (!summary.text.endsWith("\n")) process.stdout.write("\n")
        }
        const error = summary.outcome?.execution.error?.message ?? summary.error
        if (error) process.stderr.write(`error: ${error}\n`)
        return
      }
      // Attach the live toolCalls accumulator (formatter's view) onto the
      // summary so json/stream-json reflect timing observed during the run.
      const { outcome, ...legacy } = summary
      const enriched = outcome
        ? { type: "result", ...outcome, ok: outcome.execution.status === "finished" && (!summary.publicChecks || summary.publicChecks.status === "passed"), text: outcome.execution.finalResponse,
            ...(summary.publicChecks ? { publicChecks: summary.publicChecks } : {}),
            sessionId: summary.sessionId, turns: summary.turns, usage: summary.usage, toolCalls,
            stopReason: outcome.execution.stopReason, ...(outcome.execution.error ? { error: outcome.execution.error } : {}) }
        : { ...legacy, toolCalls }
      if (format === "json") {
        process.stdout.write(JSON.stringify(enriched, null, 2) + "\n")
        return
      }
      // stream-json
      jline({ type: "result", ...enriched })
    },
  }
}
