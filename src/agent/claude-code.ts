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
import { claudeWorkspaceShell, type WorkspaceCommand } from "./claude-workspace-shell.js"

const toolKinds: Record<string, ToolKind> = { Bash: "execute", Write: "edit", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", Read: "read", Glob: "search", Grep: "search" }

export interface ClaudeModelIdentity { provider: string; model: string }

const providerLabels = new Map([
  ["firstParty", "Anthropic"], ["bedrock", "Amazon Bedrock"], ["vertex", "Google Vertex AI"], ["foundry", "Microsoft Foundry"],
])

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
  workspaceCommand?: WorkspaceCommand
  onEvent: (event: AgentEvent) => void
  onModel?: (identity: ClaudeModelIdentity) => void
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
  const shell = !options.plan && options.workspaceCommand ? claudeWorkspaceShell(sessionId, options.workspaceCommand) : undefined
  try {
    return await runClaudeCode(options, sessionId, shell)
  } catch (error) {
    if (!(error instanceof NativeShellRequired)) throw error
    options.signal.throwIfAborted()
    return runClaudeCode(options, sessionId)
  }
}

class NativeShellRequired extends Error {}

/** A Bash-specific Claude rule or hook cannot constrain an MCP tool. Keep
 * Claude's native executor whenever its own shell policy must be applied. */
function requiresNativeShell(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return true
  const data = settings as { permissions?: { ask?: unknown; deny?: unknown }; hooks?: Record<string, unknown>; sandbox?: { enabled?: boolean } }
  if (data.sandbox?.enabled || data.hooks?.PreToolUse || data.hooks?.PermissionRequest || data.hooks?.PostToolUse) return true
  return [data.permissions?.ask, data.permissions?.deny].some(rules => rules !== undefined && (
    !Array.isArray(rules) || rules.some(rule => typeof rule !== "string" || /^(?:Bash|\*)(?:$|\()/i.test(rule))))
}

async function runClaudeCode(options: Options, sessionId: string, shell?: ReturnType<typeof claudeWorkspaceShell>): Promise<AcpTurnResult & { sessionId: string }> {
  const args = [...(options.args ?? []), "--print", "--verbose", "--include-partial-messages", "--input-format", "stream-json", "--output-format", "stream-json",
    "--permission-prompt-tool", "stdio", "--permission-mode", options.plan ? "plan" : "manual",
    options.resume ? "--resume" : "--session-id", sessionId]
  if (options.plan) args.push("--tools", "Read,Grep,Glob")
  if (shell) args.push(...shell.args)
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
  const pending = new Map<string, { rpcId: unknown; controller: AbortController; done: Promise<void> }>()
  const setupTimeout = shell && setTimeout(() => terminateProcessTreeWithGrace(child), 30_000)
  const send = (message: unknown) => stdin.write(JSON.stringify(message) + "\n")
  try {
    const sendUser = () => send({ type: "user", message: { role: "user", content: [{ type: "text", text: options.text }, ...images] } })
    const settingsId = randomUUID()
    let shellReady = false
    let apiProvider: string | undefined
    let servedByAnthropic: boolean | undefined
    let model: string | undefined
    let reported: ClaudeModelIdentity | undefined
    const reportModel = (value?: unknown) => {
      if (typeof value === "string" && value.trim() && !value.startsWith("<")) model = value.trim()
      if (!model || signal.aborted) return
      const provider = apiProvider === "firstParty" && servedByAnthropic === false ? "Custom endpoint"
        : apiProvider ? providerLabels.get(apiProvider) ?? apiProvider : servedByAnthropic ? "Anthropic" : "Claude Code"
      if (reported?.model === model && reported.provider === provider) return
      reported = { provider, model }
      options.onModel?.(reported)
    }
    let initializing = shell || options.onModel ? randomUUID() : undefined
    if (initializing) send({ type: "control_request", request_id: initializing, request: { subtype: "initialize" } })
    if (!shell) sendUser()
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
        if (!shell) continue
        if (event.response.subtype !== "success" || event.response.response?.sandbox_enabled) throw new NativeShellRequired()
        send({ type: "control_request", request_id: settingsId, request: { subtype: "get_settings" } })
        continue
      }
      if (shell && !shellReady && event.type === "control_response" && event.response?.request_id === settingsId) {
        if (event.response.subtype !== "success" || requiresNativeShell(event.response.response?.effective)) throw new NativeShellRequired()
        shellReady = true
        clearTimeout(setupTimeout)
        sendUser()
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
      if (event.type === "control_cancel_request") {
        pending.get(event.request_id)?.controller.abort()
        continue
      }
      if (event.type === "control_request") {
        const request = event.request
        if (request?.subtype === "mcp_message" && shell && request.server_name === shell.name) {
          const message = request.message
          const reply = (mcp_response: unknown) => {
            if (!signal.aborted && !stdin.writableEnded) send({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response: { mcp_response } } })
          }
          if (message?.method === "notifications/cancelled") {
            for (const call of pending.values()) if (call.rpcId === message.params?.requestId) call.controller.abort()
          }
          if (message?.method === "tools/call" && shellReady && !completed) {
            const controller = new AbortController()
            const done = shell.request(message, AbortSignal.any([signal, controller.signal]))
              .then(reply).finally(() => pending.delete(event.request_id))
            pending.set(event.request_id, { rpcId: message.id, controller, done })
            continue
          }
          const mcp_response = request.message?.method === "tools/call"
            ? { jsonrpc: "2.0", id: request.message.id, error: { code: -32600, message: "Project commands are unavailable" } }
            : await shell.request(request.message, signal)
          reply(mcp_response)
          continue
        }
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
        if (shell && parsed.kind === "tool_call" && parsed.toolName === shell.toolName) {
          options.onEvent({ ...parsed, toolName: "bash", path: [] })
          continue
        }
        const index = finalIds.findIndex(block => block.kind === parsed.kind)
        const id = index === -1 ? parsed.id : finalIds.splice(index, 1)[0].id
        options.onEvent({ ...parsed, id, path: [] })
      }
      if (event.type === "result") {
        completed = true
        for (const call of pending.values()) call.controller.abort()
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
    if (shell && !shellReady) throw new NativeShellRequired()
    if (code !== 0 || !completed || failure) throw new Error(failure || stderr.trim() || `Claude Code exited before returning a result (exit code ${code ?? "unknown"}).`)
    return { sessionId, stopReason: "end_turn", report: parser.finalText, toolCalls: parser.stepCounter.value, plan: [], usage }
  } finally {
    clearTimeout(setupTimeout)
    process.off("exit", onExit)
    abort.abort()
    if (child.pid && child.exitCode === null && child.signalCode === null) terminateProcessTreeWithGrace(child)
    await Promise.allSettled([exited, ...[...pending.values()].map(call => call.done)])
  }
}
