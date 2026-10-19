import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { writeFileAtomic } from "../../src/utils/secure-write.js"

const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
ptyTest("real App rewinds code, conversation and both, refills prompts and routes double Esc", async () => {
  const root = mkdtempSync(join(tmpdir(), "zap-rewind-pty-")), socket = `zap-rewind-${process.pid}-${Date.now()}`
  const file = join(root, "note.txt")
  writeFileSync(file, "original")
  const large = join(root, "large.txt"); writeFileSync(large, "large fixture".repeat(100))
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any; requests++
    const last = body.messages.at(-1)
    const write = last?.role === "user" && JSON.stringify(last.content).includes("EDIT_REWIND")
    const remove = last?.role === "user" && JSON.stringify(last.content).includes("DELETE_REWIND")
    const name = remove ? "delete_file" : "write_file"
    const delta = write || remove ? { tool_calls: [{ index: 0, id: `edit-${requests}`, type: "function", function: { name, arguments: JSON.stringify(remove ? { path: large } : { path: file, content: "edited" }) } }] } : { content: "REWIND_ANSWER" }
    return new Response(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: write || remove ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  writeFileAtomic(join(root, "config.json"), JSON.stringify({
    providers: [{ id: "local", name: "RewindFixture", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-only", models: ["fixture"], contextWindow: 128000, contextWindowMode: "manual", protocol: "openai" }],
    active: { providerId: "local", model: "fixture" }, maxTokens: 1024, maxSteps: 20, maxSnapshotFileBytes: 32,
    permissionMode: "default", customSystemPrompt: "Follow the local fixture.", mcpServers: [], serperKey: "", compaction: { auto: false, prune: false, reserved: 20000 },
  }))
  const tmux = (...args: string[]) => {
    const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr || String(result.error))
    return result.stdout
  }
  const capture = () => tmux("capture-pane", "-p", "-t", "rewind")
  const settle = async (condition: (screen: string) => boolean) => {
    let screen = ""
    for (let attempt = 0; attempt < 150; attempt++) {
      screen = capture(); if (condition(screen)) return screen; await sleep(50)
    }
    throw new Error(`Rewind UI did not settle:\n${screen}`)
  }
  const key = (value: string) => tmux("send-keys", "-t", "rewind", value)
  const type = (value: string) => tmux("send-keys", "-t", "rewind", "-l", value)
  const submit = async (value: string) => { type(value); await settle(screen => screen.includes(value)); await sleep(250); key("Enter"); await sleep(200) }
  const journal = () => readdirSync(root, { recursive: true }).filter(path => String(path).endsWith(".jsonl")).map(path => readFileSync(join(root, String(path)), "utf8")).join("\n")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  try {
    const entry = process.env.ZAP_TEST_COMPILED_BINARY
      ? quote(resolve(process.env.ZAP_TEST_COMPILED_BINARY))
      : `${quote(process.execPath)} ${quote(resolve("src/index.tsx"))}`
    tmux("new-session", "-d", "-s", "rewind", "-x", "170", "-y", "45", "-c", root,
      `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAPCODE_VM=0 ${entry}`)
    await settle(screen => screen.includes("RewindFixture/fixture"))
    await submit("EDIT_REWIND first")
    await settle(screen => screen.includes("Approve?")); type("1")
    await settle(screen => screen.includes("REWIND_ANSWER") && readFileSync(file, "utf8") === "edited")
    await sleep(200)
    const requestsBeforeRestore = requests
    await submit("/rewind")
    await settle(screen => screen.includes("↑/↓ select")); key("Enter")
    await settle(screen => screen.includes("Will revert 1 file")); type("3")
    await settle(screen => screen.includes("code only (keep conversation)")); type("y")
    await settle(screen => !screen.includes("↑/↓ select") && readFileSync(file, "utf8") === "original")
    expect(journal()).not.toContain('"type":"rewind-marker"')
    writeFileSync(file, "keep current code")
    await submit("/rewind"); await settle(screen => screen.includes("↑/↓ select")); key("Enter")
    await settle(screen => screen.includes("Will revert 1 file")); type("2"); await sleep(100); type("y")
    const refilled = await settle(screen => screen.includes("\n❯ EDIT_REWIND first"))
    expect(refilled).not.toContain("REWIND_ANSWER")
    expect(readFileSync(file, "utf8")).toBe("keep current code")
    expect(journal()).toContain('"type":"rewind-marker"')
    expect(requests).toBe(requestsBeforeRestore)
    key("Escape"); await sleep(100); key("Escape"); await sleep(150)
    expect(capture()).not.toMatch(/\n❯ EDIT_REWIND first/)
    key("Up"); await settle(screen => screen.includes("\n❯ EDIT_REWIND first"))
    key("Escape"); await sleep(100); key("Escape"); await sleep(150)
    await submit("CHAT_REWIND")
    await settle(screen => screen.includes("REWIND_ANSWER")); await sleep(150)
    key("Escape"); await sleep(100); key("Escape")
    await settle(screen => screen.includes("↑/↓ select")); key("Enter")
    const chat = await settle(screen => screen.includes("No tracked code changes"))
    expect(chat).toContain("conversation only (keep current code)")
    type("y"); await settle(screen => screen.includes("\n❯ CHAT_REWIND"))
    key("Escape"); await sleep(100); key("Escape"); await sleep(150)
    await submit("EDIT_REWIND both")
    await settle(screen => screen.includes("Approve?")); type("1")
    await settle(screen => screen.includes("REWIND_ANSWER") && readFileSync(file, "utf8") === "edited"); await sleep(150)
    await submit("/rewind"); await settle(screen => screen.includes("↑/↓ select")); key("Enter")
    await settle(screen => screen.includes("code and conversation") && screen.includes("Will revert 1 file")); type("y")
    await settle(screen => screen.includes("\n❯ EDIT_REWIND both"))
    expect(readFileSync(file, "utf8")).toBe("keep current code")
    expect(requests).toBeGreaterThanOrEqual(5)
    key("Escape"); await sleep(100); key("Escape"); await sleep(150)
    await submit("DELETE_REWIND")
    await settle(screen => screen.includes("Approve?")); type("1")
    const removed = await settle(screen => !existsSync(large) && screen.includes("REWIND_ANSWER"))
    expect(removed).toContain("rewind coverage unavailable")
    expect(removed).not.toContain("CHECKPOINT_REQUIRED")
  } finally {
    try { tmux("kill-server") } catch {}
    server.stop(); rmSync(root, { recursive: true, force: true })
  }
}, 45000)
