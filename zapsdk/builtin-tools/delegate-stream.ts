import type { AgentEvent } from "../agent/events.js";
import type { ToolResult } from "../tools/types.js";
import { nextContentId } from "../agent/events.js";

export interface ParserCtx {
  subagentId: string;
  parentPath: string[];
  stepCounter: { value: number };
  textBlockId: string | null;
  finalText: string;
  startedEmitted: boolean;
  finishedEmitted: boolean;
  /** Captured from the first event that carries it:
   *  - claude `system.subtype:init.session_id`
   *  - codex  `thread.started.thread_id`
   *  Used by the handler to surface in ToolResult so the main agent can
   *  pass it back as `resume_session_id` for follow-up calls. */
  sessionId: string | null;
}

export function makeParserCtx(subagentId: string, parentPath: string[]): ParserCtx {
  return {
    subagentId,
    parentPath,
    stepCounter: { value: 0 },
    textBlockId: null,
    finalText: "",
    startedEmitted: false,
    finishedEmitted: false,
    sessionId: null,
  };
}

function childPath(ctx: ParserCtx): string[] {
  return [...ctx.parentPath, ctx.subagentId];
}

function safeParse(line: string): unknown | null {
  try { return JSON.parse(line); } catch { return null; }
}

function emitStarted(ctx: ParserCtx, agentType: "claude" | "codex", task?: string): AgentEvent | null {
  if (ctx.startedEmitted) return null;
  ctx.startedEmitted = true;
  return {
    type: "sub_agent_started",
    subagentId: ctx.subagentId,
    agentType,
    task,
    path: ctx.parentPath,
  };
}

function emitFinished(ctx: ParserCtx, agentType: "claude" | "codex", success: boolean): AgentEvent | null {
  if (ctx.finishedEmitted) return null;
  ctx.finishedEmitted = true;
  return {
    type: "sub_agent_finished",
    subagentId: ctx.subagentId,
    agentType,
    success,
    path: ctx.parentPath,
  };
}

export function parseClaudeLine(line: string, ctx: ParserCtx): AgentEvent[] {
  const obj = safeParse(line);
  if (!obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  const out: AgentEvent[] = [];

  if (o.type === "system" && (o as Record<string, unknown>).subtype === "init") {
    const sid = (o as Record<string, unknown>).session_id;
    if (typeof sid === "string" && sid) ctx.sessionId = sid;
    const ev = emitStarted(ctx, "claude");
    if (ev) out.push(ev);
    return out;
  }

  if (o.type === "assistant") {
    const msg = (o as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (!msg || !Array.isArray(msg.content)) return out;
    const startEv = emitStarted(ctx, "claude");
    if (startEv) out.push(startEv);

    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type === "text") {
        const text = String(block.text ?? "");
        if (!text) continue;
        ctx.finalText = text;
        const id = ctx.textBlockId ?? nextContentId("dt");
        ctx.textBlockId = null;
        out.push({
          type: "content_final",
          kind: "text",
          id,
          text,
          path: childPath(ctx),
        });
      } else if (block.type === "thinking") {
        // Claude's extended-thinking blocks. The stream-json mode sends
        // the full thinking block at once (no streaming deltas), so we
        // emit a single content_final{kind:"thinking"} per block. The
        // `signature` field on the block is for thinking-integrity
        // verification — irrelevant to the UI, so we drop it.
        const thinkingText = String(block.thinking ?? "");
        if (!thinkingText) continue;
        out.push({
          type: "content_final",
          kind: "thinking",
          id: nextContentId("dk"),
          text: thinkingText,
          path: childPath(ctx),
        });
      } else if (block.type === "tool_use") {
        ctx.stepCounter.value += 1;
        out.push({
          type: "content_final",
          kind: "tool_call",
          id: String(block.id ?? nextContentId("tu")),
          step: ctx.stepCounter.value,
          toolName: String(block.name ?? "unknown"),
          arguments: (block.input as Record<string, unknown>) ?? {},
          path: childPath(ctx),
        });
      }
    }
    return out;
  }

  if (o.type === "user") {
    const msg = (o as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (!msg || !Array.isArray(msg.content)) return out;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result") continue;
      const id = String(block.tool_use_id ?? "");
      if (!id) continue;
      const isError = block.is_error === true;
      const content = typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? (block.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
          : "";
      const result: ToolResult = isError
        ? { success: false, output: "", error: content }
        : { success: true, output: content };
      out.push({
        type: "content_final",
        kind: "tool_result",
        id,
        step: ctx.stepCounter.value,
        toolName: "external",
        result,
        path: childPath(ctx),
      });
    }
    return out;
  }

  if (o.type === "result") {
    const success = (o as Record<string, unknown>).subtype === "success";
    if (success && typeof (o as Record<string, unknown>).result === "string") {
      ctx.finalText = (o as Record<string, unknown>).result as string;
    }
    const ev = emitFinished(ctx, "claude", success);
    if (ev) out.push(ev);
    return out;
  }

  return out;
}

// Codex 0.125+ uses a two-level event/item shape: top-level events
// (thread.started / turn.started / item.started / item.completed /
// turn.completed) wrap a nested `item` whose `type` discriminates the kind
// of activity (command_execution / agent_message / file_change / web_search /
// reasoning, …). Item ids are stable across started→completed so we pair
// them by `item.id`.
export function parseCodexLine(line: string, ctx: ParserCtx): AgentEvent[] {
  const obj = safeParse(line);
  if (!obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  const out: AgentEvent[] = [];

  switch (o.type) {
    case "thread.started": {
      const tid = (o as Record<string, unknown>).thread_id;
      if (typeof tid === "string" && tid) ctx.sessionId = tid;
      const ev = emitStarted(ctx, "codex");
      if (ev) out.push(ev);
      return out;
    }

    case "turn.started":
      // Sub-marker inside a thread; nothing actionable for the UI.
      return out;

    case "item.started": {
      const startEv = emitStarted(ctx, "codex");
      if (startEv) out.push(startEv);
      const item = o.item as Record<string, unknown> | undefined;
      if (!item || typeof item !== "object") return out;
      const itemType = String(item.type ?? "");
      const id = String(item.id ?? nextContentId("ci"));

      if (itemType === "command_execution") {
        ctx.stepCounter.value += 1;
        out.push({
          type: "content_final",
          kind: "tool_call",
          id,
          step: ctx.stepCounter.value,
          toolName: "bash",
          arguments: { command: item.command },
          path: childPath(ctx),
        });
      } else if (itemType === "file_change") {
        ctx.stepCounter.value += 1;
        out.push({
          type: "content_final",
          kind: "tool_call",
          id,
          step: ctx.stepCounter.value,
          toolName: "edit",
          arguments: { path: item.path, changes: item.changes ?? item.diff ?? {} },
          path: childPath(ctx),
        });
      } else if (itemType !== "agent_message" && itemType !== "reasoning") {
        // Generic fallback for unknown tool-call-like items so the UI still
        // shows something — better than silently dropping.
        ctx.stepCounter.value += 1;
        out.push({
          type: "content_final",
          kind: "tool_call",
          id,
          step: ctx.stepCounter.value,
          toolName: itemType || "unknown",
          arguments: item as Record<string, unknown>,
          path: childPath(ctx),
        });
      }
      return out;
    }

    case "item.completed": {
      const startEv = emitStarted(ctx, "codex");
      if (startEv) out.push(startEv);
      const item = o.item as Record<string, unknown> | undefined;
      if (!item || typeof item !== "object") return out;
      const itemType = String(item.type ?? "");
      const id = String(item.id ?? nextContentId("ci"));

      if (itemType === "agent_message") {
        const text = String(item.text ?? "");
        if (!text) return out;
        ctx.finalText = text;
        out.push({
          type: "content_final",
          kind: "text",
          id,
          text,
          path: childPath(ctx),
        });
        return out;
      }

      if (itemType === "command_execution") {
        const exitCode = Number(item.exit_code ?? 0);
        const output = String(item.aggregated_output ?? "");
        const success = exitCode === 0;
        out.push({
          type: "content_final",
          kind: "tool_result",
          id,
          step: ctx.stepCounter.value,
          toolName: "bash",
          result: success
            ? { success: true, output }
            : { success: false, output, error: `exit ${exitCode}` },
          path: childPath(ctx),
        });
        return out;
      }

      if (itemType === "file_change") {
        const success = item.status !== "failed";
        out.push({
          type: "content_final",
          kind: "tool_result",
          id,
          step: ctx.stepCounter.value,
          toolName: "edit",
          result: success
            ? { success: true, output: "patch applied" }
            : { success: false, output: "", error: String(item.error ?? "patch failed") },
          path: childPath(ctx),
        });
        return out;
      }

      if (itemType === "reasoning") {
        // Codex's internal reasoning blocks — informational, not a user-facing
        // tool call. Skip for now; could be surfaced later as content_final{kind:"thinking"}.
        return out;
      }

      // Fallback for unknown item types — pair with the started event if any.
      out.push({
        type: "content_final",
        kind: "tool_result",
        id,
        step: ctx.stepCounter.value,
        toolName: itemType || "unknown",
        result: { success: true, output: JSON.stringify(item) },
        path: childPath(ctx),
      });
      return out;
    }

    case "turn.completed": {
      const ev = emitFinished(ctx, "codex", true);
      if (ev) out.push(ev);
      return out;
    }

    case "turn.failed":
    case "thread.failed":
    case "error": {
      const ev = emitFinished(ctx, "codex", false);
      if (ev) out.push(ev);
      return out;
    }

    default:
      return out;
  }
}
