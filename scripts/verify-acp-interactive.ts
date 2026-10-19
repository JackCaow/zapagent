/** Manual, credential-free ACP acceptance client; run inside tmux. */
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createInterface } from "node:readline"
import { Readable, Writable } from "node:stream"
import { mkdtemp, mkdir, readFile, writeFile, appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { client, ndJsonStream, PROTOCOL_VERSION, type SessionNotification } from "@agentclientprotocol/sdk"
import { createCustomProvider, getDefaultConfig } from "../src/config.js"

const binary = resolve(process.argv[2] || "dist/zap")
const root = await mkdtemp(join(tmpdir(), "zap-acp-tmux-"))
const cwd = join(root, "workspace"), data = join(root, "profile")
await mkdir(cwd); await mkdir(data)
const calls: Array<{ model: string; messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }> = []
let waiting!: () => void
let claudeSession: string | undefined
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as typeof calls[number]
  calls.push(body)
  const previousToolOutput = body.messages.filter(message => message.role === "tool").map(message => String(message.content)).join("\n")
  claudeSession ??= previousToolOutput.match(/resume_session_id="([^"]+)"/)?.[1]
  const text = JSON.stringify(body.messages.filter(item => item.role === "user").at(-1)?.content)
  if (text?.includes("ACCEPT_CANCEL")) {
    waiting?.()
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": waiting\n\n")) } }),
      { headers: { "content-type": "text/event-stream" } })
  }
  let name = "", args: unknown = {}
  if (text?.includes("ACCEPT_WRITE")) { name = "write_file"; args = { path: "accepted.txt", content: "ACP_ACCEPTED" } }
  if (text?.includes("ACCEPT_DENY")) { name = "write_file"; args = { path: "denied.txt", content: "MUST_NOT_EXIST" } }
  if (text?.includes("ACCEPT_MEMORY")) { name = "memory_save"; args = { name: "acp_forbidden", type: "project", description: "forbidden", content: "MUST_NOT_WRITE" } }
  if (text?.includes("ACCEPT_READ")) { name = "read_file"; args = { path: "accepted.txt" } }
  if (text?.includes("ACCEPT_MCP")) name = body.tools?.find(item => item.function.name === "mcp__fixture__echo")?.function.name || ""
  if (text?.includes("ACCEPT_DELEGATE")) {
    name = "delegate_agent"
    args = { provider: "claude", cwd,
      task: "In the current working directory only, create claude-delegate-proof.txt containing exactly CLAUDE_DELEGATE_OK followed by newline. Use your Write tool. Do not run shell commands or inspect unrelated paths. Respond DONE." }
    console.log(`DELEGATE_REGISTERED ${body.tools?.some(tool => tool.function.name === name)}`)
  }
  if (text?.includes("ACCEPT_RESUME_CLAUDE")) {
    name = "delegate_agent"
    args = { provider: "claude", cwd, resume_session_id: claudeSession,
      task: "Continue the previous task. Read claude-delegate-proof.txt, then create claude-resume-proof.txt containing exactly CLAUDE_RESUME_OK followed by newline. Do not change the first file, run shell commands, or inspect unrelated paths. Respond DONE." }
  }
  const delta = name && body.messages.at(-1)?.role !== "tool"
    ? { tool_calls: [{ index: 0, id: "accept-call", type: "function", function: { name, arguments: JSON.stringify(args) } }] }
    : { content: "ACP_ACCEPTANCE_REPLY" }
  const base = { id: "acceptance", object: "chat.completion.chunk", created: 1, model: "fixture" }
  return new Response(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } })
} })
const provider = createCustomProvider({ name: "Acceptance", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "local-fixture",
  models: ["fixture", "fixture-alt"], contextWindow: 128000 })
provider.visionByModel = { fixture: true, "fixture-alt": true }
await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), providers: [provider],
  active: { providerId: provider.id, model: "fixture" }, maxSteps: 6 }), { mode: 0o600 })
await writeFile(join(root, "binary.txt"), binary)
if (process.argv[3] === "--tui") {
  console.log(`CLAUDE DELEGATE TUI\nARTIFACTS ${root}`)
  const child = spawn(binary, [], { cwd, env: { ...process.env, ZAPCODE_DATA_DIR: data }, stdio: "inherit" })
  const code = await new Promise<number | null>(resolve => child.once("close", resolve))
  model.stop(); process.exit(code ?? 1)
}
const updates: SessionNotification[] = []
let permissions = 0, decision = "allow-once"
const launch = () => {
  const child = spawn(binary, ["acp"], { cwd, env: { ...process.env, ZAPCODE_DATA_DIR: data,
    ZAPCODE_DEVTOOLS_PORT: "", ZAPCODE_HOST_PROTOCOL_PORT: "" }, stdio: ["pipe", "pipe", "pipe"] })
  child.stdout.on("data", chunk => { void appendFile(join(root, "protocol.ndjson"), chunk) })
  child.stderr.on("data", chunk => { void appendFile(join(root, "stderr.log"), chunk) })
  const connection = client({ name: "tmux-acceptance" })
    .onNotification("session/update", ({ params }) => {
      updates.push(params)
      if (params.update.sessionUpdate === "tool_call" || params.update.sessionUpdate === "tool_call_update") {
        console.log(`TOOL ${params.update.toolCallId}: ${params.update.status}`)
      }
    })
    .onRequest("session/request_permission", ({ params }) => {
      permissions++
      console.log(`PERMISSION ${params.toolCall.title}: ${decision}`)
      if (decision === "hang") { waiting?.(); return new Promise<never>(() => {}) }
      return { outcome: { outcome: "selected", optionId: decision } }
    }).onRequest("fs/read_text_file", () => ({ content: "UNSAVED_EDITOR_BUFFER" }))
    .connect(ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>))
  const close = async () => {
    const done = new Promise<void>(resolve => child.exitCode !== null ? resolve() : child.once("close", () => resolve()))
    child.stdin.end(); await done; connection.close()
  }
  return { child, connection, close }
}
let host = launch(), sessionId = "", imageSession = ""
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVZkAAAAASUVORK5CYII="
const api = () => host.connection.agent
const init = () => api().request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true } } })
const prompt = (text: string, id = sessionId) => api().request("session/prompt", { sessionId: id, prompt: [{ type: "text", text }] })
const mode = (modeId: string) => api().request("session/set_mode", { sessionId, modeId })
const checks: Array<{ command: string; ok: boolean; detail?: string }> = []
console.log(`ACP TMUX ACCEPTANCE\nBINARY ${binary}\nARTIFACTS ${root}`)
console.log("Commands: init new write deny plan read config resource image restart mcp cancel cancel-permission errors isolate list close delegate claude-resume quit")
const lines = createInterface({ input: process.stdin })
try {
  for await (const line of lines) {
    const command = line.trim()
    if (!command) continue
    console.log(`BEGIN ${command}`)
    try {
      if (command === "init") assert.equal((await init()).protocolVersion, PROTOCOL_VERSION)
      else if (command === "new") sessionId = (await api().request("session/new", { cwd, mcpServers: [] })).sessionId
      else if (command === "write") {
        assert.equal((await prompt("ACCEPT_WRITE")).stopReason, "end_turn")
        assert.equal(await readFile(join(cwd, "accepted.txt"), "utf8"), "ACP_ACCEPTED")
      } else if (command === "deny") {
        decision = "reject-once"; await prompt("ACCEPT_DENY"); decision = "allow-once"
        await assert.rejects(readFile(join(cwd, "denied.txt")))
      } else if (command === "plan") {
        await mode("plan"); const before = permissions, start = updates.length
        await prompt("ACCEPT_MEMORY")
        assert.equal(permissions, before)
        assert(updates.slice(start).some(item => item.update.sessionUpdate === "tool_call_update" && item.update.status === "failed"))
      } else if (command === "read") {
        await prompt("ACCEPT_READ")
        assert(JSON.stringify(calls.at(-1)?.messages).includes("ACP_ACCEPTED"))
      } else if (command === "config") {
        await mode("default")
        await api().request("session/set_config_option", { sessionId, configId: "model", value: JSON.stringify([provider.id, "fixture-alt"]) })
        await prompt("model switched")
        assert.equal(calls.at(-1)?.model, "fixture-alt")
      } else if (command === "resource") {
        await api().request("session/prompt", { sessionId, prompt: [{ type: "resource_link", name: "unsaved", uri: `file://${cwd}/unsaved.ts` }] })
        assert(JSON.stringify(calls.at(-1)?.messages).includes("UNSAVED_EDITOR_BUFFER"))
      } else if (command === "image") {
        imageSession = (await api().request("session/new", { cwd, mcpServers: [] })).sessionId
        await api().request("session/prompt", { sessionId: imageSession, prompt: [{ type: "image", mimeType: "image/png", data: image }] })
        await prompt("previous image", imageSession)
        assert(JSON.stringify(calls.at(-1)?.messages).includes(image))
      } else if (command === "restart") {
        await host.close(); host = launch(); await init()
        const before = updates.length
        await api().request("session/load", { sessionId: imageSession, cwd, mcpServers: [] })
        assert(updates.length > before)
        await prompt("image after process restart", imageSession)
        assert(JSON.stringify(calls.at(-1)?.messages).includes(image))
        await api().request("session/resume", { sessionId, cwd })
      } else if (command === "mcp") {
        const mcp = await api().request("session/new", { cwd, mcpServers: [{ name: "fixture", command: process.execPath,
          args: [resolve(import.meta.dir, "../tests/acp/fixtures/mcp-server.ts")], env: [] }] })
        await prompt("ACCEPT_MCP", mcp.sessionId)
        assert(JSON.stringify(calls.at(-1)?.messages).includes("ACP_MCP_OK"))
      } else if (command === "delegate" || command === "claude-resume") {
        const begin = updates.length
        if (command === "claude-resume") assert(claudeSession, "No resumable Claude session captured")
        await prompt(command === "delegate" ? "ACCEPT_DELEGATE" : "ACCEPT_RESUME_CLAUDE")
        const toolOutput = calls.at(-1)?.messages.filter(message => message.role === "tool").map(message => String(message.content)).join("\n") ?? ""
        await writeFile(join(root, `${command}-output.txt`), toolOutput, { mode: 0o600 })
        console.log(`DELEGATE_OUTPUT ${toolOutput.slice(-1800)}`)
        claudeSession = toolOutput.match(/resume_session_id="([^"]+)"/)?.[1]
        console.log(`CLAUDE_SESSION ${claudeSession ?? "missing"}`)
        console.log(`NESTED_TOOL_EVENTS ${updates.slice(begin).filter(item =>
          (item.update.sessionUpdate === "tool_call" || item.update.sessionUpdate === "tool_call_update")
          && item.update.toolCallId.includes("da_claude_")).length}`)
        assert.equal(await readFile(join(cwd, command === "delegate" ? "claude-delegate-proof.txt" : "claude-resume-proof.txt"), "utf8"),
          command === "delegate" ? "CLAUDE_DELEGATE_OK\n" : "CLAUDE_RESUME_OK\n")
        assert(claudeSession, "No resumable Claude session captured")
      } else if (command === "errors") {
        await assert.rejects(api().request("session/new", { cwd: "relative", mcpServers: [] }))
        await assert.rejects(api().request("session/set_mode", { sessionId, modeId: "invalid-mode" }))
        await assert.rejects(api().request("session/prompt", { sessionId,
          prompt: [{ type: "audio", mimeType: "audio/wav", data: "AA==" }] }))
        await assert.rejects(prompt("unknown", "missing-session"))
      } else if (command === "isolate") {
        const other = join(root, "other-workspace")
        await mkdir(other, { recursive: true })
        const independent = await api().request("session/new", { cwd: other, mcpServers: [] })
        await prompt("independent workspace context", independent.sessionId)
        assert(!JSON.stringify(calls.at(-1)?.messages).includes("ACCEPT_WRITE"))
        await assert.rejects(readFile(join(other, "accepted.txt")))
      } else if (command === "cancel" || command === "cancel-permission") {
        const entered = new Promise<void>(resolve => { waiting = resolve })
        if (command === "cancel-permission") decision = "hang"
        const pending = prompt(command === "cancel" ? "ACCEPT_CANCEL" : "ACCEPT_DENY")
        await entered
        await assert.rejects(prompt("overlapping turn"))
        const workers = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")
          .map(row => row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(row => row && Number(row[2]) === host.child.pid)
          .map(row => Number(row![1]))
        assert(workers.length > 0)
        console.log(`IN_PROGRESS cancel workers=${workers.join(",")}`)
        await api().notify("session/cancel", { sessionId })
        assert.equal((await pending).stopReason, "cancelled")
        decision = "allow-once"
        for (const pid of workers) assert.throws(() => process.kill(pid, 0))
        console.log("WORKERS_EXITED")
      } else if (command === "list") assert((await api().request("session/list", { cwd })).sessions.length >= 2)
      else if (command === "close") {
        await api().request("session/close", { sessionId })
        await assert.rejects(prompt("closed session"))
      } else if (command === "quit") { console.log("DONE"); break }
      else throw new Error("Unknown command")
      checks.push({ command, ok: true }); console.log(`PASS ${command}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      checks.push({ command, ok: false, detail }); console.log(`FAIL ${command}: ${detail}`)
    }
    await writeFile(join(root, "result.json"), JSON.stringify({ binary, checks }, null, 2), { mode: 0o600 })
    console.log("READY")
  }
} finally { lines.close(); await host.close(); model.stop() }
process.exitCode = checks.some(check => !check.ok) ? 1 : 0
