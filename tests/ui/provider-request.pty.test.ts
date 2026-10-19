import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { writeFileAtomic } from "../../src/utils/secure-write.js"

const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
ptyTest("real App distinguishes headers, first output, and visible retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "zap-provider-pty-"))
  const socket = `zap-provider-${process.pid}-${Date.now()}`
  const recordingStartedAt = Date.now()
  const frames: Array<[number, "o", string]> = []
  const record = (screen: string) => {
    frames.push([(Date.now() - recordingStartedAt) / 1000, "o", `\x1b[2J\x1b[H${screen.replaceAll("\n", "\r\n")}`])
  }
  let calls = 0
  let releaseBusy!: () => void, releaseHeaders!: () => void, releaseOutput!: () => void, releaseTail!: () => void
  const busyGate = new Promise<void>(resolve => { releaseBusy = resolve })
  const headerGate = new Promise<void>(resolve => { releaseHeaders = resolve })
  const outputGate = new Promise<void>(resolve => { releaseOutput = resolve })
  const tailGate = new Promise<void>(resolve => { releaseTail = resolve })
  const encode = new TextEncoder()
  const event = (delta: unknown, finish_reason: string | null = null) => encode.encode(`data: ${JSON.stringify({
    id: "fixture", choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    await request.json()
    calls++
    if (calls === 1) {
      await busyGate
      return Response.json({ error: { message: "busy" } }, { status: 503 })
    }
    await headerGate
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(event({ role: "assistant" }))
      await outputGate
      controller.enqueue(event({ content: "LIFECYCLE_ANSWER" }))
      await sleep(350)
      controller.enqueue(event({ content: " streaming" }))
      await tailGate
      controller.enqueue(event({}, "stop"))
      controller.enqueue(encode.encode(`data: ${JSON.stringify({ id: "fixture", choices: [], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })}\n\n`))
      controller.enqueue(encode.encode("data: [DONE]\n\n"))
      controller.close()
    } }), { headers: { "content-type": "text/event-stream" } })
  } })
  writeFileAtomic(join(root, "config.json"), JSON.stringify({
    providers: [{ id: "local", name: "Fixture", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-only",
      models: ["fixture", "fixture-2"], contextWindow: 128000, contextWindowMode: "manual", protocol: "openai" }],
    active: { providerId: "local", model: "fixture" }, maxTokens: 1024, maxSteps: 20,
    customSystemPrompt: "Answer briefly without tools.", permissionMode: "default", serperKey: "", mcpServers: [],
    compaction: { auto: false, prune: false, reserved: 20000 },
  }))
  const tmux = (...args: string[]) => {
    const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr || String(result.error))
    return result.stdout
  }
  const capture = () => tmux("capture-pane", "-p", "-t", "request")
  const settle = async (condition: (screen: string) => boolean) => {
    let screen = ""
    for (let attempt = 0; attempt < 100; attempt++) {
      screen = capture()
      if (condition(screen)) return screen
      await sleep(50)
    }
    throw new Error(`Provider UI did not settle:\n${screen}`)
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  try {
    const entry = process.env.ZAP_TEST_COMPILED_BINARY ? quote(resolve(process.env.ZAP_TEST_COMPILED_BINARY))
      : `${quote(process.execPath)} ${quote(resolve("src/index.tsx"))}`
    tmux("new-session", "-d", "-s", "request", "-x", "170", "-y", "35", "-c", root,
      `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAPCODE_VM=0 ${entry}`)
    record(await settle(screen => screen.includes("Fixture/fixture")))
    tmux("send-keys", "-t", "request", "-l", "HELLO_LIFECYCLE")
    await settle(screen => screen.includes("❯ HELLO_LIFECYCLE"))
    await sleep(200)
    tmux("send-keys", "-t", "request", "Enter")
    const waiting = await settle(screen => screen.includes("waiting for HTTP response"))
    record(waiting)
    expect(waiting).not.toContain("waiting for first model output")
    expect(waiting).not.toContain("token/s")
    releaseBusy()
    const retry = await settle(screen => screen.includes("Retrying provider"))
    record(retry)
    expect(retry).toContain("HTTP_503")
    expect(retry).toContain("attempt 2/3")
    expect(retry).not.toContain("token/s")
    record(await settle(screen => calls === 2 && screen.includes("waiting for HTTP response")))
    releaseHeaders()
    const output = await settle(screen => screen.includes("response received · waiting for first model output"))
    record(output)
    expect(output).toContain("attempt 2/3")
    expect(output).not.toContain("token/s")
    releaseOutput()
    record(await settle(screen => /~\d+\.\d token\/s/.test(screen)))
    releaseTail()
    const finished = await settle(screen => screen.includes("LIFECYCLE_ANSWER") && /\s\d+\.\d token\/s/.test(screen))
    record(finished)
    expect(finished).not.toMatch(/~\d+\.\d token\/s/)
    expect(calls).toBe(2)
    tmux("send-keys", "-t", "request", "-l", "/model fixture-2")
    await settle(screen => screen.includes("❯ /model fixture-2"))
    await sleep(200)
    tmux("send-keys", "-t", "request", "Enter")
    const switched = await settle(screen => screen.includes("Fixture/fixture-2") && !screen.includes("token/s"))
    record(switched)
    expect(switched).not.toContain("token/s")
    // Optional asciinema snapshot replay of this isolated fixture, not a
    // recording of the developer's terminal or real provider credentials.
    if (process.env.ZAPCODE_TUI_EVIDENCE_FILE) {
      const header = { version: 2, width: 170, height: 35, timestamp: Math.floor(recordingStartedAt / 1000),
        title: "Provider request lifecycle (tmux snapshots, controlled local HTTP fixture)", env: { TERM: "xterm-256color" } }
      writeFileAtomic(resolve(process.env.ZAPCODE_TUI_EVIDENCE_FILE), [header, ...frames].map(frame => JSON.stringify(frame)).join("\n") + "\n")
    }
  } finally {
    releaseBusy(); releaseHeaders(); releaseOutput(); releaseTail()
    try { tmux("kill-server") } catch {}
    server.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 30000)
