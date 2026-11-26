import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import type { ToolKind } from "@agentclientprotocol/sdk"
import { nextContentId, type AgentEvent } from "../../zapsdk/agent/events.js"
import type { AcpTurnResult } from "../../zapsdk/acp-client/run.js"
import { AcpWorkspace, permissionTarget } from "../../zapsdk/acp-client/host-handlers.js"
import { makeParserCtx, parseClaudeLine } from "../../zapsdk/builtin-tools/delegate-stream.js"
import type { ImageContent, TokenUsage } from "../../zapsdk/core/types.js"
import { createLocalProcessBroker, terminateProcessTree, terminateProcessTreeWithGrace } from "../../zapsdk/execution/process.js"
import type { ApprovalCallback } from "../../zapsdk/tools/executor.js"

const toolKinds: Record<string, ToolKind> = { Bash: "execute", Write: "edit", Edit: "edit", Read: "read", Glob: "search", Grep: "search" }

interface Options {
  command: string
  args?: string[]
  cwd: string
  text: string
  images?: ImageContent[]
  resume?: string
  plan: boolean
  signal: AbortSignal
  approve?: ApprovalCallback
  onEvent: (event: AgentEvent) => void
  onAccepted?: () => void
}

/** Drive the end user's unmodified Claude Code CLI over its stdio protocol.
 * Each invocation adds one user turn to the native session. */
export async function promptClaudeCode(options: Options): Promise<AcpTurnResult & { sessionId: string }> {
  const sessionId = options.resume ?? randomUUID()
  const args = [...(options.args ?? []), "--print", "--verbose", "--include-partial-messages", "--input-format", "stream-json", "--output-format", "stream-json",
    "--permission-prompt-tool", "stdio", "--permission-mode", options.plan ? "plan" : "manual",
    options.resume ? "--resume" : "--session-id", sessionId]
  if (options.plan) args.push("--tools", "Read,Grep,Glob")
  const images = await Promise.all((options.images ?? []).map(async image => ({ type: "image", source: {
    type: "base64", media_type: image.mediaType, data: image.base64 ?? (await readFile(image.filePath)).toString("base64"),
  } })))
  options.signal.throwIfAborted()
  const child = createLocalProcessBroker(options.signal).spawnCommand(options.command, args, {
    cwd: options.cwd, hostHome: true, stdin: "pipe",
  })
  const onExit = () => { if (child.pid) terminateProcessTree(child, "SIGKILL") }
  process.once("exit", onExit)
  const abort = new AbortController()
  const signal = AbortSignal.any([options.signal, abort.signal])
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", code => { abort.abort(); resolve(code) })
  })
  void exited.catch(() => abort.abort())
  const stdin = child.stdin!
  stdin.on("error", () => {})
  let stderr = ""
  child.stderr!.setEncoding("utf8").on("data", text => { stderr = (stderr + text).slice(-2048) })
  const workspace = new AcpWorkspace(options.cwd)
  const parser = makeParserCtx("claude", [])
  let accepted = false
  let completed = false
  let failure: string | undefined
  let usage: TokenUsage | undefined
  const send = (message: unknown) => stdin.write(JSON.stringify(message) + "\n")
  try {
    send({ type: "user", message: { role: "user", content: [{ type: "text", text: options.text }, ...images] } })
    const blocks = new Map<number, { id: string; kind: "text" | "thinking" }>()
    const finalIds: { id: string; kind: "text" | "thinking" }[] = []
    for await (const line of createInterface({ input: child.stdout!, crlfDelay: Infinity })) {
      if (!line.trim()) continue
      const event = JSON.parse(line)
      if (!accepted && (event.type === "assistant" || event.type === "system" && event.subtype === "init")) {
        accepted = true
        options.onAccepted?.()
      }
      if (event.type === "control_request") {
        const request = event.request
        let allowed = false
        if (request?.subtype === "can_use_tool" && options.approve) {
          const kind = Object.hasOwn(toolKinds, request.tool_name) ? toolKinds[request.tool_name] : "other"
          const file = request.input?.file_path
          const target = permissionTarget("claude", { sessionId, options: [], toolCall: {
            toolCallId: String(event.request_id), title: String(request.tool_name), kind: kind ?? "other",
            rawInput: request.input, locations: typeof file === "string" ? [{ path: file }] : [],
          } }, workspace)
          const decision = options.approve.precheck?.(target.name, target.args, target.context)
            ?? await options.approve(target.name, target.args, signal, target.context)
          allowed = decision === true && !signal.aborted
        }
        send({ type: "control_response", response: { subtype: "success", request_id: event.request_id,
          response: allowed ? { behavior: "allow", updatedInput: request.input } : { behavior: "deny", message: "Permission denied" } } })
        continue
      }
      if (event.type === "stream_event" && !event.parent_tool_use_id) {
        const part = event.event
        if (part.type === "message_start") { blocks.clear(); finalIds.length = 0 }
        if (part.type === "content_block_start" && ["text", "thinking"].includes(part.content_block.type)) {
          const block = { id: nextContentId("claude"), kind: part.content_block.type as "text" | "thinking" }
          blocks.set(part.index, block)
          finalIds.push(block)
        }
        const block = blocks.get(part.index)
        if (part.type === "content_block_delta" && block) {
          const text = block.kind === "text" ? part.delta.text : part.delta.thinking
          if (typeof text === "string") options.onEvent({ type: "content_delta", ...block, text })
        }
        continue
      }
      if (!event.parent_tool_use_id) for (const parsed of parseClaudeLine(line, parser)) {
        if (parsed.type !== "content_final") continue
        const index = finalIds.findIndex(block => block.kind === parsed.kind)
        const id = index === -1 ? parsed.id : finalIds.splice(index, 1)[0].id
        options.onEvent({ ...parsed, id, path: [] })
      }
      if (event.type === "result") {
        completed = true
        if (event.is_error || event.subtype !== "success") failure = String(event.result || event.subtype)
        if (event.usage) usage = {
          inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens, providerUsageReported: true,
          cacheReadInputTokens: event.usage.cache_read_input_tokens, cacheCreationInputTokens: event.usage.cache_creation_input_tokens,
        }
        stdin.end()
      }
    }
    const code = await exited
    options.signal.throwIfAborted()
    if (code !== 0 || !completed || failure) throw new Error(failure || stderr.trim() || "Claude Code exited before returning a result.")
    return { sessionId, stopReason: "end_turn", report: parser.finalText, toolCalls: parser.stepCounter.value, plan: [], usage }
  } finally {
    process.off("exit", onExit)
    abort.abort()
    if (child.pid && child.exitCode === null && child.signalCode === null) terminateProcessTreeWithGrace(child)
  }
}
