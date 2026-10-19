import type { SessionUpdate, StopReason, ToolKind } from "@agentclientprotocol/sdk"
import type { AgentEvent } from "../../zapsdk/agent/events.js"

export function acpStopReason(reason: string): StopReason {
  if (reason === "end_turn") return "end_turn"
  if (reason === "aborted") return "cancelled"
  if (reason === "max_tokens") return "max_tokens"
  if (["max_steps", "budget", "timeout", "max_repeat"].includes(reason)) return "max_turn_requests"
  return "refusal"
}

export function toolKind(name: string): ToolKind {
  if (/^(bash|execute_command|task_)/.test(name)) return "execute"
  if (/(delete|remove)/.test(name)) return "delete"
  if (/move/.test(name)) return "move"
  if (/(write|edit|create_file)/.test(name)) return "edit"
  if (/(search|glob|list_tree)/.test(name)) return "search"
  if (/(read|fetch)/.test(name)) return "read"
  return "other"
}

/** Delta IDs and tool IDs survive unchanged, including nested agent paths. */
export class AcpEventMapper {
  private streamed = new Set<string>()
  constructor(private readonly prefix: string) {}
  map(event: AgentEvent): SessionUpdate[] {
    const id = (value: string) => `${this.prefix}:${(event.path ?? []).join("/")}:${value}`
    if (event.type === "content_abandoned") {
      return [{ sessionUpdate: "agent_thought_chunk", messageId: id(event.id),
        content: { type: "text", text: "\n[Interrupted attempt abandoned; retrying.]\n" } }]
    }
    if ((event.type === "content_delta" || event.type === "content_final")
      && (event.kind === "text" || event.kind === "thinking")) {
      const messageId = id(event.id)
      if (event.type === "content_final" && this.streamed.has(messageId)) return []
      if (event.type === "content_delta") this.streamed.add(messageId)
      return [{ sessionUpdate: event.kind === "text" ? "agent_message_chunk" : "agent_thought_chunk",
        messageId, content: { type: "text", text: event.text } }]
    }
    if (event.type === "content_final" && event.kind === "tool_call") {
      const locations = [event.arguments.path, event.arguments.file_path]
        .filter((path): path is string => typeof path === "string" && /^(\/|[a-z]:[\\/])/i.test(path))
        .map(path => ({ path }))
      return [{ sessionUpdate: "tool_call", toolCallId: id(event.id), title: event.toolName,
        name: event.toolName, kind: toolKind(event.toolName), status: "pending", rawInput: event.arguments, locations }]
    }
    if (event.type === "content_final" && event.kind === "tool_result") {
      const text = typeof event.result.output === "string" ? event.result.output : JSON.stringify(event.result.output ?? "")
      return [{ sessionUpdate: "tool_call_update", toolCallId: id(event.id),
        status: event.result.success === false ? "failed" : "completed", rawOutput: event.result,
        content: [{ type: "content", content: { type: "text", text: event.result.error ?? text } }] }]
    }
    return []
  }
}
