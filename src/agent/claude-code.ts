import { randomUUID } from "node:crypto"
import { resolveToolPath } from "../../zapsdk/builtin-tools/filesystem.js"
import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import type { ToolKind } from "@agentclientprotocol/sdk"
import { nextContentId, type AgentEvent } from "../../zapsdk/agent/events.js"
import type { AcpTurnResult } from "../../zapsdk/acp-client/run.js"
import { AcpWorkspace, permissionTarget } from "../../zapsdk/acp-client/host-handlers.js"
import { makeParserCtx, parseClaudeLine } from "../../zapsdk/builtin-tools/delegate-stream.js"
import type { ImageContent, TokenUsage } from "../../zapsdk/core/types.js"
import { createLocalProcessBroker, terminateProcessTree, terminateProcessTreeWithGrace } from "../../zapsdk/execution/process.js"
import type { ApprovalCallback, ApprovalResponse } from "../../zapsdk/tools/executor.js"
import { claudeProviderLabel } from "./claude-models.js"
import type { ExternalModelIdentity } from "./startup-model-cache.js"

const toolKinds: Record<string, ToolKind> = { Bash: "execute", Write: "edit", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", Read: "read", Glob: "search", Grep: "search" }

interface Options {
  command: string
  args?: string[]
  cwd: string
  text: string
  images?: ImageContent[]
  resume?: string
  model?: string
  plan: boolean
  signal: AbortSignal
  approve?: ApprovalCallback
  appInstructions?: string
  onEvent: (event: AgentEvent) => void
  onModel?: (identity: ExternalModelIdentity) => void
  onAccepted?: () => void
}

async function approveClaudeTool(
  name: string, input: Record<string, unknown>, workspace: AcpWorkspace, signal: AbortSignal,
  approve?: ApprovalCallback,
): Promise<ApprovalResponse> {
  if (!approve || signal.aborted) return false
  const kind = Object.hasOwn(toolKinds, name) ? toolKinds[name] : "other"
  const file = name === "NotebookEdit" ? input.notebook_path : input.file_path
  let path: string | undefined
  if (kind === "edit" || kind === "read") {
    if (typeof file !== "string" || !file.trim()) return { approved: false, source: "policy", reason: "Missing file path" }
    const absolute = resolveToolPath(file, workspace.root)
    path = workspace.resolve(absolute)
    input[name === "NotebookEdit" ? "notebook_path" : "file_path"] = path
    if (kind === "edit" && (workspace.isProtected(absolute) || workspace.isProtected(path))) {
      return { approved: false, source: "policy", reason: "Writing to Zap or Git control files is prohibited" }
    }
  }
  const target = permissionTarget("claude", { sessionId: "", options: [], toolCall: {
    toolCallId: "", title: name, kind, rawInput: input, locations: path ? [{ path }] : [],
  } }, workspace)
  if (path && workspace.contains(path) && kind === "edit" && name !== "Write") {
    target.name = name === "MultiEdit" ? "multi_edit" : "edit_file"
    target.args = { ...input, path }
  }
  return approve.precheck?.(target.name, target.args, target.context)
    ?? approve(target.name, target.args, signal, target.context)
}

/** Drive the end user's unmodified Claude Code CLI over its stdio protocol.
 * Each invocation adds one user turn to the native session. */
export async function promptClaudeCode(options: Options): Promise<AcpTurnResult & { sessionId: string }> {
  const sessionId = options.resume ?? randomUUID()
  const args = [...(options.args ?? []), "--print", "--verbose", "--include-partial-messages", "--input-format", "stream-json", "--output-format", "stream-json",
    "--permission-prompt-tool", "stdio", "--permission-mode", options.plan ? "plan" : "manual",
    options.resume ? "--resume" : "--session-id", sessionId]
  if (options.model) args.push(`--model=${options.model}`)
  if (options.appInstructions) args.push("--append-system-prompt", options.appInstructions)
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
    const sendUser = () => send({ type: "user", message: { role: "user", content: [{ type: "text", text: options.text }, ...images] } })
    let apiProvider: string | undefined
    let servedByAnthropic: boolean | undefined
    let model: string | undefined
    let reported: ExternalModelIdentity | undefined
    const reportModel = (value?: unknown) => {
      if (typeof value === "string" && value.trim() && !value.startsWith("<")) model = value.trim()
      if (!model || signal.aborted) return
      const provider = claudeProviderLabel(apiProvider, servedByAnthropic)
      if (reported?.model === model && reported.provider === provider) return
      reported = { provider, model }
      options.onModel?.(reported)
    }
    let initializing = options.onModel ? randomUUID() : undefined
    if (initializing) send({ type: "control_request", request_id: initializing, request: { subtype: "initialize" } })
    sendUser()
    const blocks = new Map<number, { id: string; kind: "text" | "thinking"; streamed: boolean }>()
    const finalIds: { id: string; kind: "text" | "thinking" }[] = []
    for await (const line of createInterface({ input: child.stdout!, crlfDelay: Infinity })) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (!event || typeof event !== "object") continue
      if (initializing && event.type === "control_response" && event.response?.request_id === initializing) {
        initializing = undefined
        const provider = event.response.response?.account?.apiProvider
        if (typeof provider === "string" && provider.trim()) apiProvider = provider.trim()
        reportModel()
        continue
      }
      if (!event.parent_tool_use_id) {
        if (event.type === "system" && event.subtype === "init") {
          servedByAnthropic = event.served_by_anthropic
          reportModel(event.model)
        } else if (event.type === "stream_event" && event.event?.type === "message_start") {
          reportModel(event.event.message?.model)
        } else if (event.type === "assistant") {
          reportModel(event.message?.model)
        }
      }
      if (!accepted && (event.type === "assistant" || event.type === "system" && event.subtype === "init")) {
        accepted = true
        options.onAccepted?.()
      }
      if (event.type === "control_request") {
        const request = event.request
        const input = request?.input ?? {}
        const decision = request?.subtype === "can_use_tool"
          ? await approveClaudeTool(request.tool_name, input, workspace, signal, options.approve) : false
        const response = decision === true && !signal.aborted
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: typeof decision === "object" ? decision.reason : "Permission denied" }
        send({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response } })
        continue
      }
      if (event.type === "stream_event" && !event.parent_tool_use_id) {
        const part = event.event
        if (part.type === "message_start") { blocks.clear(); finalIds.length = 0 }
        if (part.type === "content_block_start" && ["text", "thinking"].includes(part.content_block.type)) {
          const block = { id: nextContentId("claude"), streamed: false, kind: part.content_block.type as "text" | "thinking" }
          blocks.set(part.index, block)
        }
        const block = blocks.get(part.index)
        if (part.type === "content_block_delta" && block) {
          const text = block.kind === "text" ? part.delta.text : part.delta.thinking
          if (typeof text === "string" && text.length) {
            if (!block.streamed) finalIds.push(block)
            block.streamed = true
            options.onEvent({ type: "content_delta", kind: block.kind, id: block.id, text })
          }
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
    if (code !== 0 || !completed || failure) throw new Error(failure || stderr.trim() || `Claude Code exited before returning a result (exit code ${code ?? "unknown"}).`)
    return { sessionId, stopReason: "end_turn", report: parser.finalText, toolCalls: parser.stepCounter.value, plan: [], usage }
  } finally {
    process.off("exit", onExit)
    abort.abort()
    if (child.pid && child.exitCode === null && child.signalCode === null) terminateProcessTreeWithGrace(child)
    await exited.catch(() => {})
  }
}
