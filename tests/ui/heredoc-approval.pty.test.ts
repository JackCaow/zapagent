import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { writeFileAtomic } from "../../src/utils/secure-write.js"

const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
for (const lifetime of ["session", "project"] as const) {
  ptyTest(`real App reuses ${lifetime} consent across heredoc and loop writes`, async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-heredoc-pty-")), workspace = join(root, "workspace")
    mkdirSync(workspace)
    const socket = `zap-heredoc-${process.pid}-${Date.now()}-${lifetime}`
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const bodyText = "<!doctype html><script>render(0)</script>\n$(printf stays-literal)\n"
    let calls = 0
    const started = Date.now(), frames: Array<[number, "o", string]> = []
    const record = (screen: string) => frames.push([(Date.now() - started) / 1000, "o", `\x1b[2J\x1b[H${screen.replaceAll(root, "/tmp/zap-heredoc-fixture").replaceAll("\n", "\r\n")}`])
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const input = await request.json() as { messages: Array<{ role: string; content?: string }> }
      const user = input.messages.findLast(message => message.role === "user")?.content ?? ""
      const execute = input.messages.at(-1)?.role === "user" && user.startsWith("HEREDOC_WRITE_")
      const filename = user.includes("SECOND") ? "second.html" : "first.html"
      calls++
      const delta = execute ? { role: "assistant", tool_calls: [{ index: 0, id: `heredoc-${calls}`, type: "function", function: {
        name: "bash", arguments: JSON.stringify({ command: filename === "first.html"
          ? `cd ${quote(workspace)} && cat > ${filename} <<'EOF'\n${bodyText}EOF`
          : `for target in second.html; do printf '%s' ${quote(bodyText)} > "$target"; done` }),
      } }] } : { role: "assistant", content: "HEREDOC_DONE" }
      const event = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: `reply-${calls}`, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      return new Response(event(delta, null) + event({}, execute ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    } })
    writeFileAtomic(join(root, "config.json"), JSON.stringify({
      providers: [{ id: "local", name: "Fixture", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-only", models: ["fixture"], contextWindow: 128000, contextWindowMode: "manual", protocol: "openai" }],
      active: { providerId: "local", model: "fixture" }, maxTokens: 1024, maxSteps: 10, customSystemPrompt: "Follow fixture calls.",
      permissionMode: "default", autoAllowSandboxedCommands: false, serperKey: "", mcpServers: [], executionBackend: "local",
      compaction: { auto: false, prune: false, reserved: 20000 },
    }))
    const tmux = (...args: string[]) => {
      const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
      if (result.status !== 0) throw new Error(result.stderr || String(result.error))
      return result.stdout
    }
    const capture = () => tmux("capture-pane", "-p", "-t", "heredoc")
    const settle = async (condition: (screen: string) => boolean) => {
      let screen = ""
      for (let attempt = 0; attempt < 200; attempt++) {
        screen = capture(); if (condition(screen)) return screen
        await sleep(50)
      }
      throw new Error(`Heredoc authorization did not settle (calls=${calls}):\n${screen}`)
    }
    const send = async (text: string) => {
      tmux("send-keys", "-t", "heredoc", "-l", text)
      await settle(screen => screen.includes(`❯ ${text}`)); await sleep(150)
      tmux("send-keys", "-t", "heredoc", "Enter")
    }
    const entry = process.env.ZAP_TEST_COMPILED_BINARY ? quote(resolve(process.env.ZAP_TEST_COMPILED_BINARY)) : `${quote(process.execPath)} ${quote(resolve("src/index.tsx"))}`
    const start = async () => {
      tmux("new-session", "-d", "-s", "heredoc", "-x", "170", "-y", "40", "-c", workspace, `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAPCODE_VM=0 ${entry}`)
      await settle(screen => screen.includes("Fixture/fixture"))
    }
    try {
      await start(); await send("HEREDOC_WRITE_FIRST")
      const approval = await settle(screen => screen.includes("Approve?"))
      expect(approval).toContain("this session")
      expect(approval).toContain("this project")
      expect(approval).toContain("g customize scope")
      expect(approval).toContain("Bash (entire tool)")
      record(approval)
      tmux("send-keys", "-t", "heredoc", lifetime === "session" ? "2" : "3")
      record(await settle(screen => screen.includes("HEREDOC_DONE") && !screen.includes("Esc twice to stop")))
      expect(readFileSync(join(workspace, "first.html"), "utf8")).toBe(bodyText)
      if (lifetime === "project") { tmux("kill-session", "-t", "heredoc"); await start() }
      await send("HEREDOC_WRITE_SECOND")
      const done = await settle(screen => screen.includes("second.html") && screen.includes("HEREDOC_DONE") && !screen.includes("Esc twice to stop") && existsSync(join(workspace, "second.html")))
      expect(done).not.toContain("Approve?")
      expect(readFileSync(join(workspace, "second.html"), "utf8")).toBe(bodyText)
      record(done)
      if (lifetime === "session" && process.env.ZAPCODE_TUI_EVIDENCE_FILE) {
        const header = { version: 2, width: 170, height: 40, timestamp: Math.floor(started / 1000), title: "Whole-tool authorization across heredoc and loop (isolated local fixture; temporary paths normalized)", env: { TERM: "xterm-256color" } }
        writeFileAtomic(resolve(process.env.ZAPCODE_TUI_EVIDENCE_FILE), [header, ...frames].map(frame => JSON.stringify(frame)).join("\n") + "\n")
      }
    } finally {
      try { tmux("kill-server") } catch {}
      server.stop(); rmSync(root, { recursive: true, force: true })
    }
  }, 60000)
}
