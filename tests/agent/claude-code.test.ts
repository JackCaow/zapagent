import { expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "../../zapsdk/agent/events.js"
import { promptClaudeCode } from "../../src/agent/claude-code.js"

it("streams native Claude output, gates tool requests and binds follow-ups to the selected session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zap-claude-fixture-"))
  try {
    const cli = join(cwd, "cli.cjs")
    await writeFile(cli, `
      const args = process.argv.slice(2)
      const session = args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1]
      const say = o => console.log(JSON.stringify(o))
      require("node:readline").createInterface({input: process.stdin}).on("line", line => {
        const m = JSON.parse(line)
        if (m.type === "user") {
          say({ type: "system", subtype: "init", session_id: session })
          if (m.message.content[0].text === "hang") return
          say({ type: "control_request", request_id: "r", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo test" } } })
        } else {
          const behavior = m.response.response.behavior
          const text = (args.includes("--resume") ? "resumed " : "new ") + behavior
          say({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } })
          say({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } })
          say({ type: "assistant", message: { content: [{ type: "text", text }] } })
          say({ type: "result", subtype: "success", result: text, usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 80 } })
        }
      })
    `)
    const events: AgentEvent[] = []
    const options = { cwd, command: process.execPath, args: [cli], text: "hello", plan: false,
      signal: AbortSignal.timeout(5000), onEvent: (event: AgentEvent) => events.push(event) }
    const first = await promptClaudeCode(options)
    expect(first.report).toBe("new deny")
    expect(first.usage).toMatchObject({ inputTokens: 7, cacheReadInputTokens: 80 })
    expect(events.map(event => event.type)).toEqual(["content_delta", "content_final"])
    expect(events[0]).toMatchObject({ id: (events[1] as { id: string }).id })
    const second = await promptClaudeCode({ ...options, resume: first.sessionId, approve: async (name, input) => {
      expect(name).toBe("bash")
      expect(input.command).toBe("echo test")
      return true
    } })
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.report).toBe("resumed allow")
    const cancel = new AbortController()
    await expect(promptClaudeCode({ ...options, text: "hang", signal: cancel.signal, onAccepted: () => cancel.abort() })).rejects.toThrow()
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
