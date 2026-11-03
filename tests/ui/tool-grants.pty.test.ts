import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { writeFileAtomic } from "../../src/utils/secure-write.js"

const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
for (const scenario of ["session", "project", "custom", "folder", "folder-retarget", "folder-menu-retarget"]) {
  ptyTest(`real App ${scenario} tool grants preview, apply, and expire/revoke`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-tool-grants-pty-")))
    const workspace = join(root, "workspace"); mkdirSync(join(workspace, "src"), { recursive: true })
    const folderScenario = scenario.startsWith("folder"), retarget = scenario.endsWith("retarget")
    const fromMenu = scenario === "folder-menu-retarget"
    const outputDirectory = folderScenario ? join(root, "outside") : join(workspace, "src")
    mkdirSync(outputDirectory, { recursive: true })
    const alias = join(root, "folder-alias"), other = join(root, "unreviewed")
    if (retarget) { mkdirSync(other); symlinkSync(outputDirectory, alias, "junction") }
    const ruleScope = folderScenario ? `${outputDirectory}{,/**}` : "src/**"
    const socket = `zap-tools-${process.pid}-${Date.now()}-${scenario}`
    const frames: string[] = []
    let phase = "start", calls = 0
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json() as { messages: Array<{ role: string; content?: string }> }
      calls++
      const user = body.messages.findLast(message => message.role === "user")?.content ?? ""
      const tool = body.messages.at(-1)?.role === "user" && /^WRITE_(TEST|AGAIN|REVOKED)$/.test(user.trim())
      const name = user.includes("AGAIN") ? "again.txt" : user.includes("REVOKED") ? "revoked.txt" : "result.txt"
      const path = folderScenario ? join(retarget ? alias : outputDirectory, name) : `src/${name}`
      const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `write-${calls}`, type: "function", function: {
        name: "write_file", arguments: JSON.stringify({ path, content: "fixture-only\n" }),
      } }] } : { role: "assistant", content: "BATCH_DONE" }
      const event = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: `reply-${calls}`, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      return new Response(event(delta, null) + event({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    } })
    writeFileAtomic(join(root, "config.json"), JSON.stringify({
      providers: [{ id: "local", name: "Fixture", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-only", models: ["fixture"], contextWindow: 128000, contextWindowMode: "manual", protocol: "openai" }],
      active: { providerId: "local", model: "fixture" }, maxTokens: 1024, maxSteps: 10,
      customSystemPrompt: "Follow fixture calls.", permissionMode: "default", serperKey: "", mcpServers: [], executionBackend: "local",
      compaction: { auto: false, prune: false, reserved: 20000 },
    }))
    const tmux = (...args: string[]) => {
      const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
      if (result.status !== 0) throw new Error(result.stderr || String(result.error))
      return result.stdout
    }
    const capture = () => tmux("capture-pane", "-p", "-t", "tools")
    const settle = async (condition: (screen: string) => boolean) => {
      let screen = ""
      for (let attempt = 0; attempt < 200; attempt++) {
        screen = capture()
        if (condition(screen)) {
          if (scenario === "folder" && process.env.ZAP_TOOL_GRANT_RECORDING) frames.push(tmux("capture-pane", "-e", "-p", "-t", "tools"))
          return screen
        }
        await sleep(50)
      }
      throw new Error(`Tool grant did not settle (${phase}; calls=${calls}):\n${screen}`)
    }
    const key = (value: string) => tmux("send-keys", "-t", "tools", value)
    const text = (value: string) => tmux("send-keys", "-t", "tools", "-l", value)
    const send = async (value: string) => {
      text(value); await settle(screen => screen.includes(`❯ ${value}`)); await sleep(150); key("Enter")
    }
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const entry = process.env.ZAP_TEST_COMPILED_BINARY ? quote(resolve(process.env.ZAP_TEST_COMPILED_BINARY)) : `${quote(process.execPath)} ${quote(resolve("src/index.tsx"))}`
    const start = async () => {
      tmux("new-session", "-d", "-s", "tools", "-x", "170", "-y", "40", "-c", workspace, `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAPCODE_VM=0 ${entry}`)
      await settle(screen => screen.includes("Fixture/fixture"))
    }
    const closePermissions = async () => {
      key("Escape"); await settle(screen => !screen.includes("d delete") && !screen.includes("No permission rules active"))
    }
    try {
      await start()
      if (scenario === "custom" || folderScenario && !fromMenu) {
        phase = "waiting approval"; await send("WRITE_TEST"); await settle(screen => screen.includes("Approve?"))
        if (folderScenario) expect(capture()).toContain("d authorize folder / select tools")
        text(folderScenario ? "d" : "g")
      } else {
        phase = "open permissions"; await send("/permissions"); await settle(screen => screen.includes("No permission rules active")); text("a")
      }
      phase = "tool selection"; await settle(screen => screen.includes("Tool authorization") && screen.includes("select tools"))
      if (scenario !== "custom") { text("w"); await settle(screen => /[2-9] selected/.test(screen)) }
      key("Enter")
      if (!folderScenario || fromMenu) {
        phase = "resource scope"; await settle(screen => screen.includes("Entire selected tools")); text(fromMenu ? "3" : "2")
      }
      await settle(screen => screen.includes("resource filter"))
      if (fromMenu) text(alias)
      else if (scenario !== "custom" && !folderScenario) text("src/**")
      await settle(screen => screen.includes(retarget ? alias : folderScenario ? outputDirectory : "src/**")); await sleep(150); key("Enter")
      phase = "lifetime"; await settle(screen => screen.includes("This session — cleared")); text(scenario === "project" || folderScenario ? "2" : "1")
      phase = "review"; const review = await settle(screen => screen.includes("review authorization"))
      expect(review).toContain(`write_file(${ruleScope})`)
      if (scenario !== "custom") expect(review).toContain(`edit_file(${ruleScope})`)
      expect(review).toContain("Sandbox escape is separate")
      if (retarget) { unlinkSync(alias); symlinkSync(other, alias, "junction") }
      key("Enter")
      if (retarget) {
        const rejected = await settle(screen => screen.includes("scope changed after review"))
        expect(rejected).toContain(`write_file(${ruleScope})`)
        expect(existsSync(join(other, "result.txt"))).toBe(false)
        expect(existsSync(join(outputDirectory, "result.txt"))).toBe(false)
        // Use the fixture's data dir, not the test runner's global settings.
        const settings = join(root, "permissions", "projects")
        expect(existsSync(settings)).toBe(false)
        return
      }
      phase = "grant applied"
      if (scenario !== "custom" && scenario !== "folder") {
        await settle(screen => screen.includes("write_file(src/**)") && screen.includes("d delete")); await closePermissions(); await send("WRITE_TEST")
      }
      await settle(screen => screen.includes("BATCH_DONE") && !screen.includes("Esc twice to stop") && existsSync(join(outputDirectory, "result.txt")))
      await sleep(250)
      expect(capture()).not.toContain("Approve?")
      if (scenario === "project" || scenario === "folder") {
        phase = "restart"; tmux("kill-session", "-t", "tools"); await start(); await send("WRITE_AGAIN")
        await settle(screen => screen.includes("BATCH_DONE") && !screen.includes("Esc twice to stop") && existsSync(join(outputDirectory, "again.txt")))
        await sleep(250)
        phase = "revoke"; await send("/permissions"); await settle(screen => screen.includes("d delete")); text("c")
        await settle(screen => screen.includes("Press c again")); text("c")
        await settle(screen => screen.includes("No permission rules active")); await closePermissions(); await send("WRITE_REVOKED")
      } else {
        phase = "new session"; await send("/new"); await settle(screen => !screen.includes("BATCH_DONE")); await send("WRITE_AGAIN")
      }
      phase = "approval after expiry/revoke"; expect(await settle(screen => screen.includes("Approve?"))).toContain("g customize scope")
      text("4"); await settle(screen => screen.includes("BATCH_DONE") && !screen.includes("Approve?"))
      expect(existsSync(join(outputDirectory, scenario === "project" || scenario === "folder" ? "revoked.txt" : "again.txt"))).toBe(false)
      if (scenario === "folder" && process.env.ZAP_TOOL_GRANT_RECORDING) {
        const header = { version: 2, width: 170, height: 40, title: "Folder authorization: multiple tools, restart reuse and revocation (fixture provider)" }
        writeFileSync(process.env.ZAP_TOOL_GRANT_RECORDING, [JSON.stringify(header), ...frames.map((frame, index) =>
          JSON.stringify([index * 1.5, "o", "\x1b[2J\x1b[H" + frame.replaceAll("\n", "\r\n")]))].join("\n") + "\n")
      }
    } finally {
      try { tmux("kill-server") } catch {}
      server.stop(); rmSync(root, { recursive: true, force: true })
    }
  }, 60000)
}
