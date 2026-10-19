/**
 * Turn-based conversation history. Replaces the flat `Message[]` model that
 * previously served three conflicting roles (wire shape, persistence shape,
 * in-process state) with a structured `Turn[]` whose invariants are enforced
 * at the type level — making orphan tool_use ↔ tool_result references
 * unrepresentable rather than something we clean up after the fact.
 *
 * Background: see issue #12. Bedrock-backed routes hard-reject any cross-turn
 * pairing mismatch with TOOL_USE_RESULT_MISMATCH. The previous architecture
 * accumulated turns by appending individual Messages (assistant, then each
 * tool_result) via separate `addMessage` calls, so a stream that finished
 * `processNativeToolCalls` partway through a turn — or a `pruneOrphanedToolCalls`
 * pass that dropped an assistant without re-pruning the now-orphan
 * tool_results — left history in an invalid state. Wire-level filtering is
 * a band-aid; the architectural fix is to make a turn an atomic commit unit.
 *
 * Mapping to wire format is now a pure function `turnToMessages` consumed
 * inside each provider — no provider-brand cleanup logic needed.
 */

import type { Message, ContentBlock, ImageContent, ToolCallRequest } from "./types.js";
import type { ToolResult } from "../tools/types.js";
import { formatToolResultForModel, projectToolObservation } from "../execution/failure.js";

/** A tool call that completed (successfully or with a tool-side error) and
 *  has a real ToolResult attached. By construction this CAN be paired with
 *  a tool_result on the wire. */
export interface CompletedCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: ToolResult;
  /** Legacy flat results do not prove a successful authorized read. */
  resultStatusUnknown?: true;
  /** Pre-formatted text the model sees in the tool_result block. Populated
   *  by the producer (typically loop.ts via `formatResult` so the
   *  `[✓ tool · N chars]\n…` prefix is consistent). When omitted, the wire
   *  serializer falls back to the shared model-facing result projection. */
  formattedOutput?: string;
  /** The model-facing output was folded; the underlying tool still executed. */
  formattedOutputSuppression?: "duplicate";
  executionObservation?: Message["executionObservation"];
}

/** A tool call that was streamed by the model but did not run to completion
 *  — either the streaming JSON didn't close cleanly (mid-stream cut), the
 *  executor failed before launch, or the run was aborted. The Turn builder
 *  synthesizes a failure ToolResult on the caller's behalf so the resulting
 *  Turn still satisfies the "every call has a result" invariant.
 *
 *  This is the architectural fix for issue #12: the model said it called
 *  the tool, so the assistant turn legitimately has the tool_use block; it
 *  also gets a tool_result that says "didn't run, here's why", which
 *  Bedrock accepts and the model can react to on the next step. */
export interface IncompleteCall {
  id: string;
  name: string;
  /** Best-effort args parsed from the partial JSON. May be `{}` when the
   *  stream cut before any complete key/value. */
  arguments: Record<string, unknown>;
  /** User-visible reason. Surfaces to the model as the tool_result body. */
  reason: string;
}

export type Turn =
  | { kind: "user";       content: string; images?: ImageContent[]; cache?: Message["cache"] }
  | { kind: "assistant";  text: string;     raw?: Record<string, unknown> }
  | { kind: "tool_turn";
      /** Optional preamble text that streamed before the tool calls. */
      text: string;
      raw?: Record<string, unknown>;
      /** INVARIANT (enforced by the type system + buildToolTurn): every
       *  entry has a result. Constructing a tool_turn with an unpaired
       *  call is impossible — buildToolTurn synthesizes failure results
       *  for incomplete calls. */
      calls: ReadonlyArray<CompletedCall>;
    }
  | { kind: "system";     content: string };

export interface BuildToolTurnArgs {
  text: string;
  raw?: Record<string, unknown>;
  /** Calls that have a real ToolResult. */
  completed: CompletedCall[];
  /** Calls the model emitted but that didn't complete (mid-stream cut,
   *  malformed JSON, abort). Each becomes a CompletedCall with a
   *  synthesized failure ToolResult. */
  incomplete?: IncompleteCall[];
}

/** Construct a tool_turn that's wire-valid by construction. Synthesizes
 *  failure ToolResults for any incomplete calls so the resulting Turn has
 *  a result for every call.
 *
 *  Why we don't just drop incomplete calls: the model's stream emitted
 *  tool_use blocks for them. Persisting the assistant turn with FEWER
 *  tool_use blocks than the model actually streamed loses information
 *  about what the model intended to do; surfacing the synthesized failure
 *  result lets the model retry intelligently next step ("oh that one
 *  didn't go through, let me re-issue it"). */
export function buildToolTurn(args: BuildToolTurnArgs): Turn {
  const synthesizedFromIncomplete: CompletedCall[] = (args.incomplete ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    arguments: c.arguments,
    result: {
      success: false,
      output: "",
      error: c.reason,
    },
    formattedOutput: c.reason,
  }));
  const calls = [...args.completed, ...synthesizedFromIncomplete];
  return { kind: "tool_turn", text: args.text, raw: args.raw, calls };
}

/** Pure function: serialize a Turn into the wire-shape Message[] consumed
 *  by providers. The output is paired correctly by construction. */
export function turnToMessages(turn: Turn): Message[] {
  switch (turn.kind) {
    case "system":
      return [{ role: "system", content: turn.content }];

    case "user": {
      if (turn.images?.length) {
        const blocks: ContentBlock[] = [{ type: "text", text: turn.content }, ...turn.images];
        const msg: Message = { role: "user", content: turn.content, contentBlocks: blocks };
        if (turn.cache) msg.cache = turn.cache;
        return [msg];
      }
      const msg: Message = { role: "user", content: turn.content };
      if (turn.cache) msg.cache = turn.cache;
      return [msg];
    }

    case "assistant": {
      const msg: Message = { role: "assistant", content: turn.text };
      if (turn.raw) msg.raw = turn.raw;
      return [msg];
    }

    case "tool_turn": {
      const toolCalls: ToolCallRequest[] = turn.calls.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      }));
      const assistant: Message = {
        role: "assistant",
        content: turn.text,
        toolCalls,
      };
      if (turn.raw) assistant.raw = turn.raw;

      const results: Message[] = turn.calls.map((c) => {
        const body = c.formattedOutput ?? formatToolResultForModel(c.result);
        const msg: Message = {
          role: "tool_result",
          content: body,
          toolCallId: c.id,
        };
        if (c.name === "read_file" && !c.resultStatusUnknown) msg.toolResultSuccess = c.result.success;
        const suppression = c.formattedOutputSuppression ?? c.result.runtime?.suppression;
        if (suppression) msg.toolResultSuppression = suppression;
        const observation = c.executionObservation ?? projectToolObservation(c.result);
        if (observation) msg.executionObservation = observation;
        if (c.result.contentBlocks?.length) msg.contentBlocks = c.result.contentBlocks;
        return msg;
      });

      return [assistant, ...results];
    }
  }
}

export function turnsToMessages(turns: ReadonlyArray<Turn>): Message[] {
  const out: Message[] = [];
  for (const t of turns) {
    for (const m of turnToMessages(t)) out.push(m);
  }
  return out;
}
