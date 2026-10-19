import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { writeFileAtomic } from "../../src/utils/secure-write.js"

const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
for (const scope of ["session", "project"]) {
  ptyTest(`real App supports ${scope} sandbox consent and revocation`, async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-sandbox-pty-"))
    const workspace = join(root, "workspace")
    mkdirSync(workspace)
    const socket = `zap-scope-${process.pid}-${Date.now()}-${scope}`
    let calls = 0
    let phase = "initial approval"
    const commands = ["printf first > first.txt", "echo second > second.txt", "printf third > third.txt"]
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json() as { messages: Array<{ role: string; content?: string }> }
      calls++
      const messages = body.messages
      const last = messages.at(-1)
      const user = messages.findLast(message => message.role === "user")?.content ?? ""
      let index = -1
      if (last?.role === "user") index = user.includes("CHECK_AGAIN") ? 2 : user.includes("GRANT_TEST") ? 0 : -1
      else if (last?.role === "tool" && user.includes("GRANT_TEST") && messages.filter(message => message.role === "tool").length === 1) index = 1
      const delta = index >= 0 ? { role: "assistant", tool_calls: [{ index: 0, id: `scope-${calls}`, type: "function", function: {
        name: "bash", arguments: JSON.stringify({ command: commands[index], dangerouslyDisableSandbox: true }),
      } }] } : { role: "assistant", content: "SCOPE_DONE" }
      const event = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: `reply-${calls}`, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      return new Response(event(delta, null) + event({}, index >= 0 ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    } })
    writeFileAtomic(join(root, "config.json"), JSON.stringify({
      providers: [{ id: "local", name: "Fixture", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-only",
        models: ["fixture"], contextWindow: 128000, contextWindowMode: "manual", protocol: "openai" }],
      active: { providerId: "local", model: "fixture" }, maxTokens: 1024, maxSteps: 10,
      customSystemPrompt: "Follow the fixture tool calls.", permissionMode: "default", serperKey: "", mcpServers: [],
      executionBackend: "local", allowUnsandboxedCommands: true,
      compaction: { auto: false, prune: false, reserved: 20000 },
    }))
    const tmux = (...args: string[]) => {
      const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
      if (result.status !== 0) throw new Error(result.stderr || String(result.error))
      return result.stdout
    }
    const capture = () => tmux("capture-pane", "-p", "-t", "scope")
    const settle = async (condition: (screen: string) => boolean) => {
      let screen = ""
      for (let attempt = 0; attempt < 200; attempt++) {
        screen = capture()
        if (condition(screen)) return screen
        await sleep(50)
      }
      throw new Error(`Sandbox approval did not settle (${phase}; calls=${calls}):\n${screen}`)
    }
    const send = async (text: string) => {
      tmux("send-keys", "-t", "scope", "-l", text)
      await settle(screen => screen.includes(`❯ ${text}`))
      await sleep(150)
      tmux("send-keys", "-t", "scope", "Enter")
    }
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const entry = process.env.ZAP_TEST_COMPILED_BINARY ? quote(resolve(process.env.ZAP_TEST_COMPILED_BINARY))
      : `${quote(process.execPath)} ${quote(resolve("src/index.tsx"))}`
    const start = async () => {
      tmux("new-session", "-d", "-s", "scope", "-x", "170", "-y", "40", "-c", workspace,
        `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAPCODE_VM=0 ${entry}`)
      await settle(screen => screen.includes("Fixture/fixture"))
    }
    try {
      await start()
      await send("GRANT_TEST")
      const prompt = await settle(screen => screen.includes("Approve?"))
      expect(prompt).toContain("1. Yes, run outside the sandbox this once")
      expect(prompt).toContain("2. Yes, allow outside-sandbox commands for this session")
      expect(prompt).toContain("3. Yes, allow outside-sandbox commands for this project")
      expect(prompt).toContain("4. No")
      tmux("send-keys", "-t", "scope", "-l", scope === "session" ? "2" : "3")
      const finished = await settle(screen => screen.includes("SCOPE_DONE"))
      expect(finished).not.toContain("Approve?")
      expect(existsSync(join(workspace, "first.txt"))).toBe(true)
      expect(existsSync(join(workspace, "second.txt"))).toBe(true)
      if (scope === "session") {
        await send("/new")
        await settle(screen => !screen.includes("SCOPE_DONE"))
        await send("CHECK_AGAIN")
        expect(await settle(screen => screen.includes("Approve?"))).toContain("for this session")
        tmux("send-keys", "-t", "scope", "-l", "4")
        await settle(screen => screen.includes("SCOPE_DONE"))
        expect(existsSync(join(workspace, "third.txt"))).toBe(false)
      } else {
        tmux("kill-session", "-t", "scope")
        await start()
        await send("CHECK_AGAIN")
        const reused = await settle(screen => screen.includes("SCOPE_DONE"))
        expect(reused).not.toContain("Approve?")
        expect(existsSync(join(workspace, "third.txt"))).toBe(true)
        phase = "permissions dialog"
        await send("/permissions")
        const permissions = await settle(screen => screen.includes("SandboxEscape(*)"))
        expect(permissions).toContain("project grants")
        phase = "arm revoke"
        tmux("send-keys", "-t", "scope", "-l", "d")
        await settle(screen => screen.includes("Press d again"))
        tmux("send-keys", "-t", "scope", "-l", "d")
        phase = "confirm revoke"
        await settle(screen => screen.includes("No permission rules active"))
        tmux("send-keys", "-t", "scope", "Escape")
        phase = "close permissions"
        await settle(screen => !screen.includes("No permission rules active"))
        await send("CHECK_AGAIN_REVOKED")
        phase = "prompt after revoke"
        expect(await settle(screen => screen.includes("Approve?"))).toContain("for this project")
        tmux("send-keys", "-t", "scope", "-l", "4")
      }
    } finally {
      try { tmux("kill-server") } catch {}
      server.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)
}
