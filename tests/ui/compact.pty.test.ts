import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { REQUIRED_COMPACT_SUMMARY_HEADINGS } from "../../zapsdk/context/autocompact.js"

const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
ptyTest("real App renders manual compact and preserves history after cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "zap-compact-pty-"))
  const workspace = join(root, "workspace"); mkdirSync(workspace)
  const socket = `zap-compact-${process.pid}-${Date.now()}`
  let calls = 0, summaries = 0, hold = false, release: (() => void) | undefined
  const requests: any[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any
    requests.push(body)
    const compact = body.messages.some((message: any) => String(message.content).includes("You are compacting an agent conversation"))
    if (compact) {
      const id = ++summaries
      if (hold) await new Promise<void>(resolve => { release = resolve })
      return Response.json({ id: "summary", choices: [{ index: 0, message: { role: "assistant", content:
        REQUIRED_COMPACT_SUMMARY_HEADINGS.map(heading => `# ${heading}\n- SUMMARY_${id}; KEEP_CONSTRAINT.`).join("\n") }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 100 } })
    }
    const text = `ANSWER_${++calls}`
    const event = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    return new Response(event({ role: "assistant", content: text }, null) + event({}, "stop") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } })
  } })
  writeFileSync(join(root, "config.json"), JSON.stringify({
    providers: [{ id: "local", name: "CompactFixture", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-only", models: ["fixture"], contextWindow: 1048576, protocol: "openai" }],
    active: { providerId: "local", model: "fixture" }, maxTokens: 8192, maxSteps: 4, serperKey: "", mcpServers: [],
    compaction: { auto: false, prune: false, reserved: 20000 },
  }), { mode: 0o600 })
  const tmux = (...args: string[]) => {
    const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout
  }
  const capture = () => tmux("capture-pane", "-p", "-S", "-200", "-t", "compact")
  const settle = async (condition: (screen: string) => boolean) => {
    let screen = ""
    for (let i = 0; i < 200; i++) { screen = capture(); if (condition(screen)) return screen; await sleep(50) }
    throw new Error(`Compact UI did not settle:\n${screen}`)
  }
  const send = async (text: string) => {
    tmux("send-keys", "-t", "compact", "-l", text.length > 1000 ? `\x1b[200~${text}\x1b[201~` : text); await sleep(600); tmux("send-keys", "-t", "compact", "Enter")
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const entry = process.env.ZAP_TEST_COMPILED_BINARY ? quote(resolve(process.env.ZAP_TEST_COMPILED_BINARY))
    : `${quote(process.execPath)} ${quote(resolve("src/index.tsx"))}`
  try {
    tmux("new-session", "-d", "-s", "compact", "-x", "180", "-y", "40", "-c", workspace,
      `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAPCODE_VM=0 ZAP_DISABLE_UPDATE_CHECK=1 ${entry}`)
    await settle(screen => screen.includes("CompactFixture/fixture"))
    for (let i = 0; i < 3; i++) {
      await send(`KEEP_CONSTRAINT history ${i} ` + "fixture ".repeat(500))
      await settle(screen => screen.includes(`ANSWER_${i + 1}`) && !screen.includes("Esc twice to stop"))
    }
    expect(summaries).toBe(0)
    await send("/compact")
    await settle(screen => screen.includes("Conversation compacted"))
    expect(summaries).toBe(1)
    await send("CHECK_BEFORE_CANCEL")
    await settle(screen => screen.includes("ANSWER_4") && !screen.includes("Esc twice to stop"))
    hold = true; await send("/compact")
    await settle(screen => summaries === 2 && screen.includes("Compacting"))
    tmux("send-keys", "-t", "compact", "Escape"); await sleep(100); tmux("send-keys", "-t", "compact", "Escape")
    await settle(screen => screen.includes("Compact cancelled"))
    hold = false; release?.(); await sleep(200)
    await send("AFTER_CANCEL")
    await settle(screen => screen.includes("ANSWER_5") && !screen.includes("Esc twice to stop"))
    const payload = JSON.stringify(requests.at(-1).messages)
    expect(payload).toContain("SUMMARY_1")
    expect(payload).not.toContain("SUMMARY_2")
    expect(payload).toContain("CHECK_BEFORE_CANCEL")
    expect(payload).toContain("KEEP_CONSTRAINT")
  } finally {
    hold = false; release?.()
    try { tmux("kill-server") } catch {}
    server.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 45000)
