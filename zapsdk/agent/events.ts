import type { TokenUsage } from "../core/types.js";
import type { ToolResult } from "../tools/types.js";
import type { AgentRunSnapshot } from "./run-state.js";
import type { ProviderRequestEvent } from "../core/llm.js";

/**
 * Common fields on every event. `path` identifies which subagent emitted it:
 *   - omitted / empty → root agent
 *   - ["sa_1"]        → direct subagent
 *   - ["sa_1","sa_2"] → nested subagent (sa_2 spawned by sa_1)
 */
export type EventPath = { path?: string[] };

// ─── Status ─────────────────────────────────────────────────────────────────
// Coarse state machine. One "current" status at a time. LoopAgent is the
// authoritative publisher — consumers must not derive status from other events.

export type AgentStatus =
  | "idle"         // between runs
  | "thinking"     // LLM producing reasoning content
  | "writing"      // LLM producing response text
  | "tool"         // a tool is executing (detail = tool name)
  | "compacting";  // context being compacted

/** A self-managed wall-clock budget snapshot for the current root run. */
export interface RuntimeTimeBudget {
  totalMs: number;
  elapsedMs: number;
  remainingMs: number;
  remainingPercent: number;
  /** Remaining time available to model/tool steps before final synthesis. */
  executionRemainingMs?: number;
  /** Portion of remainingMs reserved for the final response without tools. */
  finalizationReserveMs?: number;
  /** Completed model/tool rounds, oldest first; observations, not deadline estimates. */
  recentRoundDurationsMs?: number[];
  stage: "execute" | "converge" | "finalize";
}

// ─── Context Diagnostics ────────────────────────────────────────────────────

export interface ContextSegmentDiagnostics {
  name: string;
  chars: number;
  estimatedTokens: number;
  hash: string;
  meta?: Record<string, unknown>;
}

export interface ContextDiagnostics {
  totalChars: number;
  estimatedTokens: number;
  hash: string;
  segments: ContextSegmentDiagnostics[];
  /** App-level conversation prefix selected by cache-placement hints. The
   *  leading system message is excluded because prompt diagnostics track it
   *  separately. Per-message hashes let hosts distinguish append-only growth
   *  from rewrites of already-cacheable history without logging content. */
  conversationCache?: ConversationCacheDiagnostics;
}

export interface ConversationCacheSliceDiagnostics {
  messageCount: number;
  chars: number;
  estimatedTokens: number;
  hash: string;
}

export interface ConversationCacheDiagnostics {
  prefix: ConversationCacheSliceDiagnostics & { messageHashes: string[] };
  tail: ConversationCacheSliceDiagnostics;
}

// ─── Content ────────────────────────────────────────────────────────────────
// Every assistant-produced piece is a content block with a stable id and a
// phase. Streamable kinds (thinking, text) fire deltas during streaming and
// a final when the piece is sealed. Discrete kinds (tool_call, tool_result)
// only fire final. The id correlates deltas with their final; for tool_call
// / tool_result the id is the LLM-provided tool-use id so consumers can pair
// requests with settlements.
//
// Consumer decision tree:
//   phase=delta  → update live preview for id (never write to log)
//   phase=final  → commit to log for id; clear any preview for id
//
// This replaces the old grab-bag of thinking_delta / text_delta /
// assistant_message / tool_call / tool_result events.

export type ContentKind = "thinking" | "text" | "tool_call" | "tool_result";

type ContentDeltaThinking = {
  type: "content_delta";
  kind: "thinking";
  id: string;
  text: string;
};

type ContentDeltaText = {
  type: "content_delta";
  kind: "text";
  id: string;
  text: string;
};

type ContentFinalThinking = {
  type: "content_final";
  kind: "thinking";
  id: string;
  text: string;
};

type ContentFinalText = {
  type: "content_final";
  kind: "text";
  id: string;
  text: string; // cleaned (cleanOutput applied)
};

type ContentFinalToolCall = {
  type: "content_final";
  kind: "tool_call";
  id: string;
  step: number;
  toolName: string;
  arguments: Record<string, unknown>;
};

type ContentFinalToolResult = {
  type: "content_final";
  kind: "tool_result";
  id: string; // same id as the tool_call this settles
  step: number;
  toolName: string;
  result: ToolResult;
};

// ─── Observation ────────────────────────────────────────────────────────────
// Non-protocol side channels for telemetry/debug. UI should not render these
// as part of the conversation; agent-logger and metrics consume them.

export type ObservationKind =
  | "prune_start"
  | "prune_done"
  | "prune_skipped"
  | "request_cache_shape"
  | "autocompact_start"
  | "autocompact_done"
  | "reactive_compact"
  | "historical_images_retired"
  | "request_recovered"
  | "provider_fallback"
  | "provider_stream_continuation"
  | "max_tokens_recovery"
  | "prompt_leak_blocked"
  | "snapshot_created"
  | "snapshot_evicted"
  | "rewind_done"
  | "checkpoint_error"
  | "tool_result_storage_failed"
  | "duplicate_tool_suppressed"
  | "execution_checkpoint"
  | "runtime_lifecycle"
  | "runtime_sealing"
  | "budget_decision"
  | "tool_progress"
  | "force_finish_timeout"
  | "turn_end_guard_fired"
  | "image_strip_self_heal";

type ObservationEvent = {
  type: "observation";
  kind: ObservationKind;
  detail?: Record<string, unknown>;
};

// ─── Union ──────────────────────────────────────────────────────────────────

export type AgentEvent =
  // Status
  | ({ type: "status"; status: AgentStatus; detail?: string } & EventPath)
  | ({ type: "provider_request"; step: number; requestId?: string; request: ProviderRequestEvent } & EventPath)

  // Content
  | (ContentDeltaThinking & EventPath)
  | (ContentDeltaText & EventPath)
  | ({ type: "content_abandoned"; kind: "thinking"; id: string; step: number;
      attempt: number; reason: string; usageUnknown: true } & EventPath)
  | (ContentFinalThinking & EventPath)
  | (ContentFinalText & EventPath)
  | (ContentFinalToolCall & EventPath)
  | (ContentFinalToolResult & EventPath)

  // Lifecycle
  | ({ type: "run_started"; input: string } & EventPath)
  | ({
      type: "run_step"
      step: number
      messageCount: number
      /** Diagnostics for the transient per-call context suffix, if present. */
      context?: ContextDiagnostics
      /** Self-managed run deadline state, when the host configured one. */
      timeBudget?: RuntimeTimeBudget
    } & EventPath)
  | ({
      type: "run_usage"
      /** Maintenance usage contributes to totals, not active context occupancy. */
      purpose?: "main" | "maintenance"
      step: number
      /** Fresh prompt tokens that were NOT served from prompt cache. */
      inputTokens: number
      /** False when usage was synthesized because the provider omitted usage. */
      providerUsageReported?: boolean
      usageIncomplete?: boolean
      /** Tokens served from the prompt cache this call. Absent when the
       *  provider doesn't expose cache accounting. Counts against the
       *  context window even though they cost less. */
      cacheReadInputTokens?: number
      /** Tokens written to the prompt cache this call. Counts against the
       *  context window the same way input_tokens does. */
      cacheCreationInputTokens?: number
      /** Provider-reported prompt-cache misses. For automatic disk caches,
       * these are the cache prefixes constructed by the request. */
      cacheMissInputTokens?: number
      outputTokens: number
      finishReason?: string
    } & EventPath)
  | ({ type: "run_ended"; steps: number; usage: TokenUsage; stopped?: string; finishReason?: string } & EventPath)
  | ({ type: "error"; step: number; error: string } & EventPath)

  // Authoritative state for one independently observable subagent run.
  // Unlike transcript lifecycle events, this carries the host tool-call id
  // and a monotonic sequence so UI/store consumers never need task matching.
  | ({ type: "agent_run_state"; run: AgentRunSnapshot } & EventPath)

  // Fires when the LLM begins streaming a tool call's name, before the JSON
  // body finishes arriving. For large tool_call payloads (e.g. write_file
  // with a full document) the gap between tool_call_start and the eventual
  // content_final.tool_call can be 30s+ — without this event the UI looks
  // frozen. `argsPreview` is a partial args object (e.g. {path: "x.md"})
  // extracted cheaply from the partial JSON before the full body arrives,
  // letting the UI render `write_file(x.md)` almost immediately.
  | ({ type: "tool_call_pending"; id: string; step: number; toolName: string; argsPreview?: Record<string, unknown>; bytesHint?: number } & EventPath)

  // Observations
  | (ObservationEvent & EventPath)

  // Subagent lifecycle (emitted by the parent that spawned them).
  // `task` remains for compatibility with old hosts. New consumers should use
  // agent_run_state.run.toolCallId instead of matching task text.
  | ({ type: "sub_agent_started"; subagentId: string; agentType: string; task?: string } & EventPath)
  | ({ type: "sub_agent_finished"; subagentId: string; agentType: string; success: boolean; steps?: number; usage?: TokenUsage } & EventPath);

export type AgentEventType = AgentEvent["type"];

export type AgentEventHandler = (event: AgentEvent) => void;

/** Minimal event surface shared by LoopAgent, AgentRuntime, devtools and hosts.
 * Consumers should depend on this contract instead of the concrete loop
 * implementation so the runtime can remain the single assembly boundary. */
export interface AgentEventSource {
  on(type: AgentEventType | "*", handler: AgentEventHandler): void;
  off(type: AgentEventType | "*", handler: AgentEventHandler): void;
}

export class AgentEventEmitter implements AgentEventSource {
  private listeners = new Map<string, Set<AgentEventHandler>>();

  on(type: AgentEventType | "*", handler: AgentEventHandler): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler);
  }

  off(type: AgentEventType | "*", handler: AgentEventHandler): void {
    this.listeners.get(type)?.delete(handler);
  }

  emit(event: AgentEvent): void {
    this.listeners.get(event.type)?.forEach((h) => h(event));
    this.listeners.get("*")?.forEach((h) => h(event));
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let _contentIdCounter = 0;
export function nextContentId(prefix: string): string {
  _contentIdCounter = (_contentIdCounter + 1) & 0x7fffffff;
  return `${prefix}_${_contentIdCounter.toString(36)}`;
}
