import { expect, it } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
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
      console.log("fixture wrapper banner")
      const say = o => console.log(JSON.stringify(o))
      require("node:readline").createInterface({input: process.stdin}).on("line", line => {
        const m = JSON.parse(line)
        if (m.type === "control_request") {
          say({ type: "control_response", response: { request_id: m.request_id, subtype: "success", response: { account: { apiProvider: "bedrock" } } } })
        } else if (m.type === "user") {
          say({ type: "system", subtype: "init", session_id: session, model: "configured-model" })
          if (m.message.content[0].text === "hang") return
          if (m.message.content[0].text.startsWith("{")) {
            say({type:"control_request", request_id:"r", request:JSON.parse(m.message.content[0].text)})
            return
          }
          say({ type: "control_request", request_id: "r", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo test" } } })
        } else {
          const behavior = m.response.response.behavior
          const text = (args.includes("--resume") ? "resumed " : "new ") + behavior + (m.response.response.message || "")
          say({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } })
          say({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text" } } })
          say({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } } })
          say({ type: "assistant", message: { content: [{ type: "text", text: "" }, { type: "text", text }] } })
          say({ type: "stream_event", event: { type: "message_start", message: { model: "actual-model" } } })
          say({ type: "assistant", parent_tool_use_id: "child", message: { model: "child-model", content: [] } })
          say({ type: "assistant", message: { model: "<synthetic>", content: [] } })
          say({ type: "result", subtype: "success", result: text, usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 80 } })
        }
      })
    `)
    const events: AgentEvent[] = []
    const options = { cwd, command: process.execPath, args: [cli], text: "hello", plan: false,
      signal: AbortSignal.timeout(5000), onEvent: (event: AgentEvent) => events.push(event) }
    const models: unknown[] = []
    const first = await promptClaudeCode({ ...options, onModel: model => models.push(model) })
    expect(models).toEqual([
      { provider: "Amazon Bedrock", model: "configured-model" },
      { provider: "Amazon Bedrock", model: "actual-model" },
    ])
    expect(first.report).toBe("new denyPermission denied")
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
    for (const [tool, expected] of [["Edit", "edit_file"], ["MultiEdit", "multi_edit"], ["NotebookEdit", "edit_file"], ["Read", "read_file"], ["Write", "write_file"]]) {
      const key = tool === "NotebookEdit" ? "notebook_path" : "file_path"
      const text = JSON.stringify({ subtype: "can_use_tool", tool_name: tool, input: { [key]: "sample.txt", ...(tool === "Write" ? { content: "change" } : { old_string: "old", new_string: "new" }) } })
      const r = await promptClaudeCode({ ...options, text, approve: async (name, input) => {
        expect(name).toBe(expected)
        expect(input.path).toBe(join(await realpath(cwd), "sample.txt"))
        return { approved: false, source: "policy", reason: "fixture rule" }
      } })
      expect(r.report).toContain("denyfixture rule")
    }
    let prompted = false
    const protectedEdit = await promptClaudeCode({ ...options, text: JSON.stringify({ subtype: "can_use_tool", tool_name: "Edit", input: { file_path: ".zapcode/settings.json" } }),
      approve: async () => { prompted = true; return true } })
    expect(prompted).toBe(false)
    expect(protectedEdit.report).toContain("prohibited")
    const cancel = new AbortController()
    await expect(promptClaudeCode({ ...options, text: "hang", signal: cancel.signal, onAccepted: () => cancel.abort() })).rejects.toThrow()
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
