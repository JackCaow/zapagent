import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { writeFileAtomic } from "../../src/utils/secure-write.js"

const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
ptyTest("real App manages independent follow-ups and Steers at a safe boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "zap-queue-pty-"))
  const socket = `zap-queue-${process.pid}-${Date.now()}`
  const frames: Record<string, string> = {}
  const requests: { role: string; content: unknown }[][] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let releaseIdle!: () => void
  const idleGate = new Promise<void>(resolve => { releaseIdle = resolve })
  const preparationGate = join(root, "preparation-ready")
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { messages: { role: string; content: unknown }[]; stream: boolean }
    requests.push(body.messages)
    const number = requests.length
    if (number === 1) await gate
    if (number === 4) await idleGate
    const text = `ANSWER_${number}`
    const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
    if (!body.stream) return Response.json({ id: `reply-${number}`, object: "chat.completion", model: "fixture",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage })
    const event = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: `reply-${number}`, object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`
    return new Response(event({ role: "assistant", content: text }) + event({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  writeFileAtomic(join(root, "config.json"), JSON.stringify({
    providers: [{ id: "local", name: "Fixture", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-only",
      models: ["fixture"], contextWindow: 128000, contextWindowMode: "manual", protocol: "openai" }],
    active: { providerId: "local", model: "fixture" }, followUpMode: "queue", maxTokens: 1024, maxSteps: 20,
    customSystemPrompt: "Answer briefly without tools.", permissionMode: "default", serperKey: "", mcpServers: [], compaction: { auto: false, prune: false, reserved: 20000 },
  }))
  const tmux = (...args: string[]) => {
    const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr || String(result.error))
    return result.stdout
  }
  const capture = () => tmux("capture-pane", "-p", "-t", "queue")
  const settle = async (condition: (screen: string) => boolean) => {
    let screen = ""
    for (let attempt = 0; attempt < 100; attempt++) {
      screen = capture()
      if (condition(screen)) return screen
      await sleep(50)
    }
    throw new Error(`Queue UI did not settle:\n${screen}`)
  }
  const literal = (value: string) => tmux("send-keys", "-t", "queue", "-l", value)
  const key = (...keys: string[]) => tmux("send-keys", "-t", "queue", ...keys)
  const send = async (value: string) => {
    literal(value)
    await settle(screen => screen.includes(`❯ ${value}`))
    await sleep(200)
    key("Enter")
    await sleep(200)
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  try {
    // Run the actual CLI/App/hook/SDK graph, not a mock QueuePanel fixture.
    tmux("new-session", "-d", "-s", "queue", "-x", "140", "-y", "42", "-c", root,
      `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAPCODE_VM=0 ZAP_TEST_PREPARATION_GATE=${quote(preparationGate)} ${quote(process.execPath)} --preload ${quote(resolve("tests/fixtures/delayed-turn-preparation.ts"))} ${quote(resolve("src/index.tsx"))}`)
    await settle(screen => screen.includes("zapAgent") && screen.includes("Fixture/fixture"))
    // A retained palette draft must not process Enter/Tab behind the manager.
    literal("/help")
    await settle(screen => screen.includes("❯ /help"))
    await sleep(200)
    key("C-q")
    frames.modalDraftBefore = await settle(screen => screen.includes("Follow-up messages") && screen.includes("❯ /help"))
    key("Enter")
    await sleep(200)
    expect(capture()).toContain("❯ /help")
    key("Tab")
    await sleep(100)
    frames.modalDraftAfter = capture()
    expect(frames.modalDraftAfter).toContain("❯ /help")
    expect(frames.modalDraftAfter).toContain("Follow-up messages")
    expect(requests).toHaveLength(0)
    key("Escape")
    await settle(screen => !screen.includes("Follow-up messages"))
    key("C-u"); await sleep(100)
    await send("ROOT_TASK")
    frames.preparing = await settle(screen => screen.includes("Preparing request") && screen.includes("› ROOT_TASK"))
    expect(frames.preparing.indexOf("› ROOT_TASK")).toBeLessThan(frames.preparing.indexOf("Preparing request"))
    expect(frames.preparing).not.toContain("❯ ROOT_TASK")
    expect(frames.preparing).not.toContain("Follow-ups ·")
    expect(requests).toHaveLength(0)
    writeFileAtomic(preparationGate, "ready")
    await settle(() => requests.length === 1)
    // A first send must stay visibly busy while the model has not replied,
    // without presenting the initial delivery receipt as a follow-up.
    const firstWaiting = await settle(screen => screen.includes("waiting for HTTP response"))
    expect(firstWaiting.match(/› ROOT_TASK/g)).toHaveLength(1)
    expect(firstWaiting).not.toContain("Follow-ups ·")
    await sleep(200)
    expect(capture()).toContain("waiting for HTTP response")
    for (const value of ["QUEUE_A", "QUEUE_B", "QUEUE_C"]) await send(value)
    frames.pending = await settle(screen => screen.includes("queued · QUEUE_A") && screen.includes("queued · QUEUE_C"))
    // Esc cancels a slash-message edit on its first press, not the palette.
    await send("/help")
    literal("ORIGINAL_DRAFT")
    await settle(screen => screen.includes("❯ ORIGINAL_DRAFT"))
    key("C-q")
    await settle(screen => screen.includes("4. /help"))
    key("Down", "Down", "Down")
    await sleep(100)
    literal("e")
    await settle(screen => screen.includes("Editing queued message") && screen.includes("❯ /help"))
    key("Escape")
    frames.cancelledSlashEdit = await settle(screen => screen.includes("❯ ORIGINAL_DRAFT") && !screen.includes("Editing queued message"))
    key("C-q")
    await settle(screen => screen.includes("4. /help"))
    key("Down", "Down", "Down"); await sleep(100); literal("x")
    await settle(screen => !screen.includes("/help") && screen.includes("3. QUEUE_C"))
    key("Escape"); await sleep(100); key("C-u"); await sleep(100)
    literal("DRAFT_KEPT")
    await settle(screen => screen.includes("❯ DRAFT_KEPT"))
    key("C-q")
    await settle(screen => screen.includes("Follow-up messages") && screen.includes("1. QUEUE_A"))
    tmux("resize-window", "-t", "queue", "-y", "24")
    frames.shortWindow = await settle(screen => screen.includes("1–2 of 3") && screen.includes("1. QUEUE_A"))
    tmux("resize-window", "-t", "queue", "-y", "42")
    await settle(screen => screen.includes("3. QUEUE_C"))
    literal("x")
    await settle(screen => !screen.includes("QUEUE_A") && screen.includes("1. QUEUE_B"))
    literal("e")
    await settle(screen => screen.includes("Editing queued message") && screen.includes("QUEUE_B"))
    key("Escape")
    frames.cancelledEdit = await settle(screen => screen.includes("queued · QUEUE_B") && screen.includes("DRAFT_KEPT") && !screen.includes("Editing queued message"))
    key("C-q")
    await settle(screen => screen.includes("1. QUEUE_B"))
    literal("e")
    await settle(screen => screen.includes("Editing queued message") && screen.includes("❯ QUEUE_B"))
    key("C-u")
    await sleep(100)
    literal("QUEUE_B_EDITED")
    await settle(screen => screen.includes("❯ QUEUE_B_EDITED"))
    await sleep(200)
    key("Enter")
    frames.edited = await settle(screen => screen.includes("queued · QUEUE_B_EDITED") && screen.includes("DRAFT_KEPT") && !screen.includes("Editing queued message"))
    key("C-q")
    await settle(screen => screen.includes("1. QUEUE_B_EDITED"))
    key("Down"); literal("[")
    frames.reordered = await settle(screen => screen.includes("1. QUEUE_C") && screen.includes("2. QUEUE_B_EDITED"))
    literal("s")
    frames.steering = await settle(screen => screen.includes("Steer · waiting for a safe boundary"))
    literal("q")
    await settle(screen => screen.includes("Queuing off"))
    key("Escape")
    await settle(screen => !screen.includes("Follow-up messages") && screen.includes("❯ DRAFT_KEPT"))
    key("C-u")
    await sleep(100)
    await send("DEFAULT_STEER")
    // Restore a draft without submitting it, then inspect the default mode.
    literal("DRAFT_KEPT")
    await settle(screen => screen.includes("❯ DRAFT_KEPT"))
    key("C-q")
    frames.defaultSteer = await settle(screen => screen.includes("DEFAULT_STEER") && screen.includes("Queuing off"))
    literal("q")
    await settle(screen => screen.includes("Queuing on"))
    key("Escape")
    await settle(screen => !screen.includes("Follow-up messages") && screen.includes("DRAFT_KEPT"))
    // Release current generation. C should join the existing run; B should
    // cause its own subsequent run. A must never appear in a model request.
    release()
    frames.final = await settle(screen => screen.includes("ANSWER_3") && !screen.includes("Follow-ups ·"))
    expect(requests).toHaveLength(3)
    const users = requests.map(messages => messages.filter(message => message.role === "user").map(message => message.content))
    expect(users[0]).toContain("ROOT_TASK")
    expect(users[0]).not.toContain("QUEUE_C")
    expect(users[1]).toContain("QUEUE_C")
    expect(users[1]).toContain("DEFAULT_STEER")
    expect(users[1]).not.toContain("QUEUE_B_EDITED")
    expect(users[2]).toContain("QUEUE_B_EDITED")
    expect(users.flat()).not.toContain("QUEUE_A")
    expect(frames.final).toContain("DRAFT_KEPT")
    key("C-u"); await sleep(100)
    await send("IDLE_AGAIN")
    await settle(() => requests.length === 4)
    const idleWaiting = await settle(screen => screen.includes("waiting for HTTP response"))
    expect(idleWaiting).not.toContain("Follow-ups ·")
    await sleep(200)
    expect(capture()).toContain("waiting for HTTP response")
    releaseIdle()
    await settle(screen => screen.includes("ANSWER_4") && !screen.includes("Esc twice to stop"))
    literal("DRAFT_KEPT")
    await settle(screen => screen.includes("❯ DRAFT_KEPT"))
    for (const [width, height] of [[78, 32], [160, 45], [110, 36]]) {
      tmux("resize-window", "-t", "queue", "-x", String(width), "-y", String(height))
      await sleep(200)
      await settle(screen => screen.includes("DRAFT_KEPT"))
    }
    key("C-q")
    frames.empty = await settle(screen => screen.includes("No pending messages"))
    key("Escape")
  } finally {
    release()
    releaseIdle()
    if (process.env.ZAPCODE_QUEUE_EVIDENCE_DIR) writeFileAtomic(join(process.env.ZAPCODE_QUEUE_EVIDENCE_DIR, "queue-pty.json"), JSON.stringify({ frames, requests }, null, 2))
    spawnSync("tmux", ["-L", socket, "kill-server"])
    server.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60000)

ptyTest("real App opens provider repair behind a failed queue head without retrying it", async () => {
  const root = mkdtempSync(join(tmpdir(), "zap-queue-recovery-pty-"))
  const socket = `zap-recovery-${process.pid}-${Date.now()}`
  const frames: Record<string, string> = {}
  const requests: { role: string; content: unknown }[][] = []
  let calls = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++
    const body = await request.json() as { messages: { role: string; content: unknown }[] }
    requests.push(body.messages)
    await gate
    return Response.json({ error: { message: "fixture provider failure", type: "invalid_request_error" } }, { status: 400 })
  } })
  writeFileAtomic(join(root, "config.json"), JSON.stringify({
    providers: [{ id: "local", name: "Fixture", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-only",
      models: ["fixture"], contextWindow: 128000, contextWindowMode: "manual", protocol: "openai" }],
    active: { providerId: "local", model: "fixture" }, followUpMode: "queue", maxTokens: 1024, maxSteps: 20,
    customSystemPrompt: "", permissionMode: "default", serperKey: "", mcpServers: [],
    compaction: { auto: false, prune: false, reserved: 20000 },
  }))
  const tmux = (...args: string[]) => {
    const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr || String(result.error))
    return result.stdout
  }
  const capture = () => tmux("capture-pane", "-p", "-t", "recovery")
  const settle = async (predicate: (screen: string) => boolean) => {
    let screen = ""
    for (let attempt = 0; attempt < 100; attempt++) {
      screen = capture()
      if (predicate(screen)) return screen
      await sleep(50)
    }
    throw new Error(`Provider repair UI did not settle:\n${screen}`)
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const send = async (value: string) => {
    tmux("send-keys", "-t", "recovery", "-l", value)
    await settle(screen => screen.includes(`❯ ${value}`))
    await sleep(200)
    tmux("send-keys", "-t", "recovery", "Enter")
  }
  try {
    tmux("new-session", "-d", "-s", "recovery", "-x", "130", "-y", "42", "-c", root,
      `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAPCODE_VM=0 ${quote(process.execPath)} ${quote(resolve("src/index.tsx"))}`)
    await settle(screen => screen.includes("zapAgent") && screen.includes("Fixture/fixture"))
    await send("ROOT_TASK")
    await settle(() => calls === 1)
    await send("FAILED_TASK")
    await settle(screen => screen.includes("queued · FAILED_TASK"))
    tmux("send-keys", "-t", "recovery", "C-q")
    await settle(screen => screen.includes("Follow-up messages") && screen.includes("1. FAILED_TASK"))
    tmux("send-keys", "-t", "recovery", "-l", "e")
    frames.editing = await settle(screen => screen.includes("Editing queued message") && screen.includes("❯ FAILED_TASK"))
    release()
    await settle(screen => screen.includes("Queue: 400 fixture provider failure"))
    tmux("send-keys", "-t", "recovery", "Escape")
    frames.failed = await settle(screen => screen.includes("failed · FAILED_TASK"))
    expect(frames.failed).not.toContain("Editing queued message")
    const failedCalls = calls
    await send("/connect")
    frames.repair = await settle(screen => screen.includes("Connections · /connect"))
    tmux("send-keys", "-t", "recovery", "Escape")
    await settle(screen => !screen.includes("Connections · /connect"))
    tmux("send-keys", "-t", "recovery", "C-q")
    frames.held = await settle(screen => screen.includes("Follow-up messages") && screen.includes("1. FAILED_TASK"))
    expect(frames.held).toContain("Queue · separate next turn · failed")
    expect(frames.held).not.toContain("2. /connect")
    // The provider may retry the failed ROOT_TASK; repairing configuration
    // must not start another request or submit the held follow-up.
    expect(calls).toBe(failedCalls)
    expect(requests.flat().filter(message => message.role === "user").map(message => message.content)).not.toContain("FAILED_TASK")
  } finally {
    release()
    if (process.env.ZAPCODE_QUEUE_EVIDENCE_DIR) writeFileAtomic(join(process.env.ZAPCODE_QUEUE_EVIDENCE_DIR, "queue-recovery-pty.json"), JSON.stringify({ frames, requests }, null, 2))
    spawnSync("tmux", ["-L", socket, "kill-server"])
    server.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 20000)
