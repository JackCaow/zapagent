import { describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { delimiter, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { client, ndJsonStream, PROTOCOL_VERSION, type SessionNotification } from "@agentclientprotocol/sdk"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"
import { createPlatformSandbox } from "../../zapsdk/execution/sandbox.js"

function chunks(delta: unknown, finishReason: string) {
  const base = { id: "completion-1", object: "chat.completion.chunk", created: 1, model: "fixture-model" }
  return `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`
}

describe("real ACP stdio + shared AgentRuntime", () => {
  it("creates a file through approved tools, restores multi-turn history after restart, and separates cwd sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "zap-acp-stdio-"))
    const data = join(root, "data")
    const cwd = join(root, "repo")
    const cwd2 = join(root, "repo2")
    await mkdir(data); await mkdir(cwd); await mkdir(cwd2)
    // PATH detection is asynchronous. Exercise delegation on the very first
    // cold-worker prompt, with a fake CLI (never a developer's paid account).
    await writeFile(join(cwd, "claude"), ["#!/bin/sh",
      'printf delegate-ok > delegated.txt',
      'printf \'%s\\n\' \'{"type":"system","subtype":"init","session_id":"fixture-session"}\' \'{"type":"assistant","message":{"content":[{"type":"tool_use","id":"external-write","name":"Write","input":{"file_path":"delegated.txt"}}]}}\' \'{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"external-write","content":"written"}]}}\' \'{"type":"result","subtype":"success","result":"DELEGATED"}\'',
    ].join("\n"), { mode: 0o700 })
    const calls: Array<{ model: string; messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }> = []
    const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      const body = await request.json() as typeof calls[number]
      calls.push(body)
      const last = body.messages.at(-1)
      const user = body.messages.filter(message => message.role === "user").at(-1)
      if (typeof user?.content === "string" && user.content.includes("slow cancellation")) {
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(": pending\n\n"))
        } }), { headers: { "content-type": "text/event-stream" } })
      }
      const wantsWrite = typeof user?.content === "string" && user.content.includes("create marker")
      const wantsDelegate = typeof user?.content === "string" && user.content.includes("invoke delegate")
      const mcpTool = body.tools?.find(tool => tool.function.name.includes("echo"))
      const wantsMcp = typeof user?.content === "string" && user.content.includes("invoke MCP")
      const delta = wantsDelegate && last?.role !== "tool" ? { tool_calls: [{ index: 0, id: "delegate-call", type: "function",
        function: { name: "delegate_agent", arguments: JSON.stringify({ provider: "claude", task: "fixture delegation" }) } }] }
        : wantsMcp && mcpTool && last?.role !== "tool" ? { tool_calls: [{ index: 0, id: "mcp-call", type: "function",
        function: { name: mcpTool.function.name, arguments: "{}" } }] }
        : wantsWrite && last?.role !== "tool" ? { tool_calls: [{ index: 0, id: "write-call", type: "function",
        function: { name: "write_file", arguments: JSON.stringify({ path: "marker.txt", content: "ACP_RUNTIME_OK" }) } }] }
        : { content: "ACP_REPLY_OK" }
      return new Response(chunks(delta, "tool_calls" in delta ? "tool_calls" : "stop"), { headers: { "content-type": "text/event-stream" } })
    } })
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture-key",
      models: ["fixture-model"], contextWindow: 128000 })
    provider.visionByModel = { "fixture-model": true }
    const config = { ...getDefaultConfig(), providers: [provider], active: { providerId: provider.id, model: "fixture-model" }, maxSteps: 6 }
    await writeFile(join(data, "config.json"), JSON.stringify(config), { mode: 0o600 })
    const updates: SessionNotification[] = []
    let approvals = 0
    const launch = () => {
      const process = spawn("bun", [resolve("src/index.tsx"), "acp"], {
        env: { ...globalThis.process.env, PATH: `${cwd}${delimiter}${globalThis.process.env.PATH ?? ""}`,
          ZAPCODE_DATA_DIR: data, ZAPCODE_DEVTOOLS_PORT: "", ZAP_DISABLE_FILE_CHECKPOINTING: "" },
        stdio: ["pipe", "pipe", "pipe"],
      })
      let stderr = ""
      process.stderr.on("data", chunk => { stderr += String(chunk) })
      const connection = client({ name: "integration" })
        .onNotification("session/update", ({ params }) => { updates.push(params) })
        .onRequest("session/request_permission", () => {
          approvals++
          return { outcome: { outcome: "selected", optionId: "allow-once" } }
        })
        .connect(ndJsonStream(Writable.toWeb(process.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>))
      const close = async () => {
        const exited = new Promise<void>(resolve => { if (process.exitCode !== null) resolve(); else process.once("close", () => resolve()) })
        process.stdin.end()
        await exited
        connection.close()
      }
      return { connection, close, stderr: () => stderr }
    }
    let host = launch()
    try {
      await host.connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION })
      const { sessionId } = await host.connection.agent.request("session/new", { cwd, mcpServers: [] })
      if (globalThis.process.platform !== "win32" && createPlatformSandbox().status().available) {
        await host.connection.agent.request("session/prompt", { sessionId,
          prompt: [{ type: "text", text: "invoke delegate then finish" }] })
        expect(calls[0]!.tools?.some(tool => tool.function.name === "delegate_agent")).toBe(true)
        expect(await readFile(join(cwd, "delegated.txt"), "utf8")).toBe("delegate-ok")
        expect(updates.some(item => item.update.sessionUpdate === "tool_call_update"
          && item.update.toolCallId.includes("da_claude_") && item.update.status === "completed")).toBe(true)
      }
      const response = await host.connection.agent.request("session/prompt", { sessionId,
        prompt: [{ type: "text", text: "create marker with write_file then finish" }] })
      // Unverified task output still ends the execution normally.
      expect(response.stopReason).toBe("end_turn")
      expect(await readFile(join(cwd, "marker.txt"), "utf8")).toBe("ACP_RUNTIME_OK")
      expect(approvals).toBeGreaterThan(0)
      expect(updates.some(item => item.update.sessionUpdate === "tool_call_update" && item.update.status === "completed")).toBe(true)
      expect(updates.some(item => item.update.sessionUpdate === "agent_message_chunk")).toBe(true)
      await host.close()
      host = launch()
      await host.connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION })
      await host.connection.agent.request("session/load", { sessionId, cwd, mcpServers: [] })
      const result = await host.connection.agent.request("session/prompt", { sessionId,
        prompt: [{ type: "text", text: "second turn: report done" }] })
      expect(result.stopReason).toBe("end_turn")
      const last = calls.at(-1)!
      expect(JSON.stringify(last.messages)).toContain("create marker")
      expect(JSON.stringify(last.messages)).toContain("second turn")
      const second = await host.connection.agent.request("session/new", { cwd: cwd2, mcpServers: [] })
      await host.connection.agent.request("session/prompt", { sessionId: second.sessionId,
        prompt: [{ type: "text", text: "independent session" }] })
      expect(JSON.stringify(calls.at(-1)!.messages)).not.toContain("create marker")
      expect(host.stderr()).not.toContain("bad --cwd")
      const before = calls.length
      const pending = host.connection.agent.request("session/prompt", { sessionId: second.sessionId,
        prompt: [{ type: "text", text: "slow cancellation" }] })
      for (let i = 0; calls.length === before && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20))
      expect(calls.length).toBeGreaterThan(before)
      await host.connection.agent.notify("session/cancel", { sessionId: second.sessionId })
      expect((await pending).stopReason).toBe("cancelled")
      const mcpSession = await host.connection.agent.request("session/new", { cwd, mcpServers: [{ name: "fixture",
        command: globalThis.process.execPath, args: [resolve("tests/acp/fixtures/mcp-server.ts")], env: [] }] })
      const mcpResult = await host.connection.agent.request("session/prompt", { sessionId: mcpSession.sessionId,
        prompt: [{ type: "text", text: "invoke MCP echo once and finish" }] })
      // Legacy MCP echo has unknown effects and no host acceptance verifier.
      expect(mcpResult.stopReason).toBe("end_turn")
      expect(JSON.stringify(calls.at(-1)?.messages)).toContain("ACP_MCP_OK")
      const imageSession = await host.connection.agent.request("session/new", { cwd, mcpServers: [] })
      const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVZkAAAAASUVORK5CYII="
      await host.connection.agent.request("session/prompt", { sessionId: imageSession.sessionId,
        prompt: [{ type: "image", mimeType: "image/png", data: image }] })
      await host.connection.agent.request("session/prompt", { sessionId: imageSession.sessionId,
        prompt: [{ type: "text", text: "describe the previous image" }] })
      expect(JSON.stringify(calls.at(-1)?.messages)).toContain(`data:image/png;base64,${image}`)
      await host.close()
      host = launch()
      await host.connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION })
      await host.connection.agent.request("session/load", { sessionId: imageSession.sessionId, cwd, mcpServers: [] })
      await host.connection.agent.request("session/prompt", { sessionId: imageSession.sessionId,
        prompt: [{ type: "text", text: "describe image after restart" }] })
      expect(JSON.stringify(calls.at(-1)?.messages)).toContain(`data:image/png;base64,${image}`)
      await rm(join(data, "acp", "sessions", imageSession.sessionId, "images"), { recursive: true })
      await host.connection.agent.request("session/prompt", { sessionId: imageSession.sessionId,
        prompt: [{ type: "text", text: "image no longer exists" }] })
      expect(JSON.stringify(calls.at(-1)?.messages)).toContain("[Saved conversation image unavailable]")
      expect(host.stderr()).toContain("saved conversation image could not be loaded")
    } finally {
      await host.close()
      model.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
