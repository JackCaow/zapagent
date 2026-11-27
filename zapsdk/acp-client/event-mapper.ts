import type {
  ContentBlock, PlanEntry, SessionUpdate, ToolCallContent, ToolCallLocation, Usage,
} from "@agentclientprotocol/sdk";
import type { AgentEvent } from "../agent/events.js";
import { nextContentId } from "../agent/events.js";
import type { TokenUsage } from "../core/types.js";
import type { ToolResult } from "../tools/types.js";
import { buildDiffMeta } from "../builtin-tools/diff-meta.js";

interface ToolState {
  id: string;
  title: string;
  kind?: string;
  name?: string;
  rawInput?: unknown;
  locations: ToolCallLocation[];
  content: ToolCallContent[];
  rawOutput?: unknown;
  /** Output streamed in `_meta.terminal_output_delta` (codex-acp) when the
   * client has no terminal capability. */
  terminalOutput: string;
  announced: boolean;
  settled: boolean;
}

const TOOL_OUTPUT_MAX_CHARS = 8_000;

/** Turns a stream of ACP session updates into zap AgentEvents.
 *
 * Thinking and text stream as deltas and are sealed when the other kind or a
 * tool call starts, matching LoopAgent's ordering so the transcript reads the
 * same. Tool calls are announced once and settled on the first terminal
 * status. One mapper covers one prompt turn; `finish()` seals what is open. */
export class AcpEventMapper {
  private thinking?: { id: string; text: string };
  private text?: { id: string; text: string };
  private readonly tools = new Map<string, ToolState>();
  private step = 0;
  private readonly messageText: string[] = [];
  plan: PlanEntry[] = [];
  contextUsage?: { used: number; size: number };

  constructor(private readonly path: string[] = []) {}

  /** Agent-visible message text for this turn, in order. */
  get reportText(): string { return this.messageText.join("").trim(); }
  get toolCallCount(): number { return this.tools.size; }

  map(update: SessionUpdate): AgentEvent[] {
    const out: AgentEvent[] = [];
    switch (update.sessionUpdate) {
      case "agent_thought_chunk": {
        const piece = contentText(update.content);
        if (!piece) break;
        this.sealText(out);
        this.thinking ??= { id: nextContentId("acpth"), text: "" };
        this.thinking.text += piece;
        out.push({ type: "content_delta", kind: "thinking", id: this.thinking.id, text: piece, path: this.path });
        break;
      }
      case "agent_message_chunk": {
        const piece = contentText(update.content);
        if (!piece) break;
        this.sealThinking(out);
        this.text ??= { id: nextContentId("acptx"), text: "" };
        this.text.text += piece;
        this.messageText.push(piece);
        out.push({ type: "content_delta", kind: "text", id: this.text.id, text: piece, path: this.path });
        break;
      }
      case "tool_call": {
        const tool = this.tool(update.toolCallId);
        tool.title = update.title || tool.title;
        tool.kind = update.kind ?? tool.kind;
        tool.name = update.name ?? tool.name;
        if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
        if (update.locations) tool.locations = update.locations;
        if (update.content) tool.content = update.content;
        this.announce(tool, out);
        if (update.status === "completed" || update.status === "failed") this.settle(tool, update.status, out);
        break;
      }
      case "tool_call_update": {
        const tool = this.tool(update.toolCallId);
        if (update.title) tool.title = update.title;
        if (update.kind) tool.kind = update.kind;
        if (update.name) tool.name = update.name;
        if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
        if (update.locations) tool.locations = update.locations;
        if (update.content) tool.content = update.content;
        if (update.rawOutput !== undefined) tool.rawOutput = update.rawOutput;
        const delta = (update._meta?.terminal_output_delta as { data?: unknown } | undefined)?.data;
        if (typeof delta === "string") tool.terminalOutput += delta;
        if (update.status === "completed" || update.status === "failed") {
          this.announce(tool, out);
          this.settle(tool, update.status, out);
        } else if (update.status === "in_progress") {
          this.announce(tool, out);
        }
        break;
      }
      case "plan":
        this.plan = update.entries;
        break;
      case "usage_update":
        this.contextUsage = { used: update.used, size: update.size };
        break;
      default:
        break;
    }
    return out;
  }

  /** Seal open content and settle tools the agent never finished. */
  finish(stopped: "end_turn" | "cancelled" | "error" | string): AgentEvent[] {
    const out: AgentEvent[] = [];
    this.sealThinking(out);
    this.sealText(out);
    for (const tool of this.tools.values()) {
      if (tool.announced && !tool.settled) {
        tool.settled = true;
        out.push({ type: "content_final", kind: "tool_result", id: tool.id, step: this.step,
          toolName: toolName(tool), path: this.path,
          result: { success: false, output: "", error: stopped === "cancelled" ? "cancelled" : "agent ended the turn before the tool finished" } });
      }
    }
    return out;
  }

  private tool(id: string): ToolState {
    let tool = this.tools.get(id);
    if (!tool) {
      tool = { id, title: "tool", locations: [], content: [], terminalOutput: "", announced: false, settled: false };
      this.tools.set(id, tool);
    }
    return tool;
  }

  private announce(tool: ToolState, out: AgentEvent[]): void {
    if (tool.announced) return;
    this.sealThinking(out);
    this.sealText(out);
    tool.announced = true;
    this.step += 1;
    out.push({ type: "content_final", kind: "tool_call", id: tool.id, step: this.step,
      toolName: toolName(tool), arguments: toolArguments(tool), path: this.path });
  }

  private settle(tool: ToolState, status: "completed" | "failed", out: AgentEvent[]): void {
    if (tool.settled) return;
    tool.settled = true;
    out.push({ type: "content_final", kind: "tool_result", id: tool.id, step: this.step,
      toolName: toolName(tool), result: toolResult(tool, status), path: this.path });
  }

  private sealThinking(out: AgentEvent[]): void {
    if (!this.thinking) return;
    out.push({ type: "content_final", kind: "thinking", id: this.thinking.id, text: this.thinking.text, path: this.path });
    this.thinking = undefined;
  }

  private sealText(out: AgentEvent[]): void {
    if (!this.text) return;
    out.push({ type: "content_final", kind: "text", id: this.text.id, text: this.text.text, path: this.path });
    this.text = undefined;
    // Separate message segments interrupted by tools in the final report.
    this.messageText.push("\n\n");
  }
}

export function contentText(block: ContentBlock | undefined | null): string {
  if (!block) return "";
  if (block.type === "text") return block.text;
  if (block.type === "resource_link") return `[${block.name ?? block.uri}](${block.uri})`;
  if (block.type === "resource" && "text" in block.resource) return block.resource.text;
  return "";
}

/** Usage from a prompt response or `_meta`, in zap's shape. */
export function acpUsage(usage: Usage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  // Some ACP agents include cached tokens in inputTokens. Codex ACP reports
  // disjoint fresh/read/write counts, whose sum reconciles with totalTokens.
  const cached = (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0);
  const sum = usage.inputTokens + cached + usage.outputTokens;
  const disjoint = usage.inputTokens < cached || usage.totalTokens === sum
    || usage.totalTokens === sum + (usage.thoughtTokens ?? 0);
  return {
    inputTokens: disjoint ? usage.inputTokens : Math.max(0, usage.inputTokens - cached),
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cachedReadTokens ?? undefined,
    cacheCreationInputTokens: usage.cachedWriteTokens ?? undefined,
    providerUsageReported: true,
  };
}

function toolName(tool: ToolState): string {
  return tool.name || tool.kind || "tool";
}

function toolArguments(tool: ToolState): Record<string, unknown> {
  const args: Record<string, unknown> = { title: tool.title };
  if (tool.rawInput && typeof tool.rawInput === "object" && !Array.isArray(tool.rawInput)) {
    Object.assign(args, tool.rawInput as Record<string, unknown>);
  } else if (tool.rawInput !== undefined) {
    args.input = tool.rawInput;
  }
  const paths = tool.locations.map(location => location.path);
  if (paths.length === 1 && args.path === undefined) args.path = paths[0];
  else if (paths.length > 1 && args.paths === undefined) args.paths = paths;
  return args;
}

function toolResult(tool: ToolState, status: "completed" | "failed"): ToolResult {
  const parts: string[] = [];
  let meta: unknown;
  for (const item of tool.content) {
    if (item.type === "content") {
      const text = contentText(item.content);
      if (text) parts.push(text);
    } else if (item.type === "diff") {
      parts.push(`${item.oldText == null ? "Created" : "Edited"} ${item.path}`);
      meta ??= buildDiffMeta(item.oldText ?? "", item.newText, item.path);
    } else if (item.type === "terminal" && !tool.terminalOutput) {
      parts.push(`[terminal ${item.terminalId}]`);
    }
  }
  if (tool.terminalOutput) parts.push(tool.terminalOutput.trimEnd());
  if (!parts.length && tool.rawOutput !== undefined) {
    parts.push(typeof tool.rawOutput === "string" ? tool.rawOutput : JSON.stringify(tool.rawOutput));
  }
  let output = parts.join("\n");
  if (output.length > TOOL_OUTPUT_MAX_CHARS) output = `${output.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n… (truncated)`;
  return status === "failed"
    ? { success: false, output: "", error: output || "failed", meta }
    : { success: true, output, meta };
}
