import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { Resvg } from "@resvg/resvg-js"
import { writeFileAtomic } from "../../src/utils/secure-write.js"

const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
for (const mode of ["default", "bypassPermissions"] as const) {
  ptyTest(`real App ${mode} reads consecutive outside screenshots without approval`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-read-pty-")))
    const cwd = join(root, "workspace"), screenshots = join(root, "screenshots")
    mkdirSync(cwd); mkdirSync(screenshots)
    const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="3" fill="blue"/></svg>', { font: { loadSystemFonts: false } }).render().asPng()
    for (const name of ["first", "second"]) writeFileSync(join(screenshots, `${name}.png`), png)
    let calls = 0, imagesSeen = 0
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json() as { messages: Array<{ role: string; content?: string | Array<{ type: string }> }> }
      imagesSeen = Math.max(imagesSeen, body.messages.reduce((count, message) => count + (Array.isArray(message.content) ? message.content.filter(block => block.type === "image_url").length : 0), 0))
      const last = body.messages.at(-1)
      const prompt = last?.role === "user" && typeof last.content === "string" ? last.content.trim() : ""
      const tool = prompt === "READ_FIRST" || prompt === "READ_SECOND"
      const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `read-${++calls}`, type: "function", function: {
        name: "read_file", arguments: JSON.stringify({ path: join(screenshots, prompt === "READ_FIRST" ? "first.png" : "second.png") }),
      } }] } : { role: "assistant", content: `READ_DONE_${calls}` }
      const event = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      return new Response(event(delta, null) + event({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    } })
    writeFileAtomic(join(root, "config.json"), JSON.stringify({
      providers: [{ id: "fixture", name: "ReadFixture", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-only", models: ["fixture"], protocol: "openai", contextWindow: 128000, contextWindowMode: "manual" }],
      active: { providerId: "fixture", model: "fixture" }, permissionMode: mode,
      maxTokens: 1024, maxSteps: 10, mcpServers: [], executionBackend: "local",
      compaction: { auto: false, prune: false, reserved: 20000 },
    }))
    const socket = `zap-read-${process.pid}-${Date.now()}-${mode}`
    const tmux = (...args: string[]) => {
      const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
      if (result.status !== 0) throw new Error(result.stderr || String(result.error))
      return result.stdout
    }
    const visible = async (text: string) => {
      let screen = ""
      for (let i = 0; i < 200; i++) {
        screen = tmux("capture-pane", "-p", "-t", "read")
        if (screen.includes("Approve?")) throw new Error(`Unexpected read approval:\n${screen}`)
        if (screen.includes(text)) return screen
        await sleep(50)
      }
      throw new Error(`Missing ${text}:\n${screen}`)
    }
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const entry = process.env.ZAP_TEST_COMPILED_BINARY ? quote(resolve(process.env.ZAP_TEST_COMPILED_BINARY)) : `${quote(process.execPath)} ${quote(resolve("src/index.tsx"))}`
    try {
      tmux("new-session", "-d", "-s", "read", "-x", "160", "-y", "40", "-c", cwd,
        `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAPCODE_VM=0 ZAP_DISABLE_UPDATE_CHECK=1 ${entry}`)
      await visible("ReadFixture/fixture")
      for (const [index, prompt] of ["READ_FIRST", "READ_SECOND"].entries()) {
        tmux("send-keys", "-t", "read", "-l", prompt)
        await visible(`❯ ${prompt}`); await sleep(150)
        tmux("send-keys", "-t", "read", "Enter")
        const screen = await visible(`READ_DONE_${index + 1}`)
        expect(screen).toContain("Loaded image")
        expect(imagesSeen).toBe(index + 1)
        await sleep(250)
      }
      expect(calls).toBe(2)
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"])
      server.stop(); rmSync(root, { recursive: true, force: true })
    }
  }, 60000)
}
