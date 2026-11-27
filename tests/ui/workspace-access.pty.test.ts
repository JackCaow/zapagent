import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { writeFileAtomic } from "../../src/utils/secure-write.js"

const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
ptyTest("real App scopes implementation to the selected task and remembers only explicit project access", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-work-pty-")))
  const cwd = join(root, "project")
  mkdirSync(cwd)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { messages: Array<{ role: string; content: unknown }> }
    const task = body.messages.filter(message => message.role === "user").at(-1)?.content
    const name = String(task).match(/WRITE_(one|two|three|four|five)/)?.[1]
    const write = name && body.messages.at(-1)?.role === "user"
    const delta = write ? { role: "assistant", tool_calls: [{ index: 0, id: "edit-" + name, type: "function", function: {
      name: "write_file", arguments: JSON.stringify({ path: join(cwd, name), content: name }),
    } }] } : { role: "assistant", content: "FINISHED_" + name }
    const event = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    return new Response(event(delta, null) + event({}, write ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  writeFileAtomic(join(root, "config.json"), JSON.stringify({
    providers: [{ id: "fixture", name: "HarnessFixture", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-only", models: ["fixture"], protocol: "openai", contextWindow: 128000, contextWindowMode: "manual" }],
    active: { providerId: "fixture", model: "fixture" }, maxTokens: 1024, maxSteps: 6, mcpServers: [],
  }))
  const socket = `zap-work-${process.pid}-${Date.now()}`
  const tmux = (...args: string[]) => {
    const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr || String(result.error))
    return result.stdout
  }
  const visible = async (value: string) => {
    let screen = ""
    for (let i = 0; i < 180; i++) {
      screen = tmux("capture-pane", "-p", "-t", "work")
      if (screen.includes(value)) return
      await sleep(75)
    }
    throw new Error(`Missing ${value}:\n${screen}`)
  }
  const key = async (key: string) => { tmux("send-keys", "-t", "work", key); await sleep(200) }
  const submit = async (text: string) => {
    tmux("send-keys", "-t", "work", "-l", text)
    await visible(text); await sleep(180); await key("Enter")
  }
  try {
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
    const entry = process.env.ZAP_TEST_COMPILED_BINARY ? quote(resolve(process.env.ZAP_TEST_COMPILED_BINARY)) : `${quote(process.execPath)} ${quote(resolve("src/index.tsx"))}`
    tmux("new-session", "-d", "-s", "work", "-x", "160", "-y", "45", "-c", cwd,
      `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAP_DISABLE_UPDATE_CHECK=1 ${entry}`)
    await visible("HarnessFixture/fixture")
    await submit("/work WRITE_one"); await visible("Start implementation"); await key("Enter")
    await visible("FINISHED_one"); expect(readFileSync(join(cwd, "one"), "utf8")).toContain("one")
    await submit("WRITE_two"); await visible("FINISHED_two"); expect(existsSync(join(cwd, "two"))).toBe(false)
    await submit("/work WRITE_three"); await visible("Start implementation"); await key("Down"); await key("Enter")
    await visible("FINISHED_three"); expect(existsSync(join(cwd, "three"))).toBe(true)
    await submit("WRITE_four"); await visible("FINISHED_four"); expect(existsSync(join(cwd, "four"))).toBe(true)
    await submit("/work"); await visible("Forget project access")
    await key("Down"); await key("Down"); await key("Down"); await key("Enter")
    await submit("WRITE_five"); await visible("FINISHED_five"); expect(existsSync(join(cwd, "five"))).toBe(false)
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"])
    server.stop(); rmSync(root, { recursive: true, force: true })
  }
}, 90000)
