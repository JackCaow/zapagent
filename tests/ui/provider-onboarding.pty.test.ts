import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { writeFileAtomic } from "../../src/utils/secure-write.js"
import type { AppConfig } from "../../src/config.js"

const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
ptyTest("real App guides connection creation into model selection, skip and repair", async () => {
  const root = mkdtempSync(join(tmpdir(), "zap-provider-onboarding-"))
  const socket = `zap-onboarding-${process.pid}-${Date.now()}`
  const frames: Record<string, string> = {}
  const requests: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname
    requests.push(path)
    if (path.startsWith("/failure")) return Response.json({ error: "fixture unavailable" }, { status: 503 })
    return Response.json({ data: [{ id: "alpha-model" }, { id: "beta-model" }] })
  } })
  writeFileAtomic(join(root, "config.json"), JSON.stringify({ providers: [], active: { providerId: "", model: "" },
    maxTokens: 1024, maxSteps: 20, permissionMode: "default", mcpServers: [], serperKey: "",
    compaction: { auto: false, prune: false, reserved: 20000 } }))
  // Keep this test offline except for our own discovery endpoint.
  writeFileAtomic(join(root, "cache/models-dev-v1.json"), JSON.stringify({ version: 1, fetchedAt: Date.now(),
    catalog: { fixture: { id: "fixture", name: "Fixture directory", models: {} } } }))
  const config = () => JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as AppConfig
  const tmux = (...args: string[]) => {
    const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr || String(result.error))
    return result.stdout
  }
  const capture = () => tmux("capture-pane", "-p", "-t", "setup")
  const settle = async (predicate: (screen: string) => boolean) => {
    let screen = ""
    for (let attempt = 0; attempt < 120; attempt++) {
      screen = capture()
      if (predicate(screen)) return screen
      await sleep(50)
    }
    throw new Error(`Provider UI did not settle:\n${screen}`)
  }
  const visible = (text: string) => settle(screen => screen.includes(text))
  const key = async (...keys: string[]) => { tmux("send-keys", "-t", "setup", ...keys); await sleep(180) }
  const literal = async (value: string) => { tmux("send-keys", "-t", "setup", "-l", value); await sleep(180) }
  const command = async (value: string) => {
    await literal(value)
    if (value.startsWith("/")) await visible(value)
    await sleep(250)
    await key("Enter")
  }
  const openConnect = async () => { await command("/connect"); await visible("Connections · /connect") }
  const newConnection = async (name: string, path = "/v1", withKey = false) => {
    await openConnect()
    for (let i = 0; i < config().providers.length; i++) await key("Down")
    await key("Enter"); await visible("Provider directory · models.dev")
    await key("Enter"); await visible("Connection · name")
    await command(name); await visible("Connection · endpoint")
    await command(`http://127.0.0.1:${server.port}${path}`); await visible("Connection · wire protocol")
    await key("Enter"); await visible("Connection · authentication")
    if (withKey) {
      await key("Enter"); await visible("Connection · API key")
      await command("fixture-key")
    } else { await key("Down"); await key("Enter") }
    await visible("Review connection · next: choose a model")
    await key("Enter")
    frames[name] = await visible(`Choose a model · ${name}`)
    expect(frames[name]).toContain("Connection saved.")
    expect(frames[name]).toContain("esc choose later")
    expect(config().providers.some(provider => provider.name === name)).toBe(true)
  }
  const closed = () => settle(screen => !screen.includes("enter select") && !screen.includes("Review connection") && !screen.includes("Connection ·"))
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  try {
    tmux("new-session", "-d", "-s", "setup", "-x", "145", "-y", "38", "-c", root,
      `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAPCODE_VM=0 ${quote(process.execPath)} ${quote(resolve("src/index.tsx"))}`)
    await visible("start by typing /connect")
    await sleep(500)
    // Cancel before save: no partial connection persisted.
    await openConnect(); await key("Enter"); await visible("Provider directory · models.dev")
    await key("Escape"); await visible("Connections · /connect"); await key("Escape")
    expect(config().providers).toHaveLength(0)

    await newConnection("First", "/v1", true)
    await visible("alpha-model")
    await key("Escape"); await closed()
    expect(config().providers).toHaveLength(1)
    expect(config().active.model).toBe("")
    await command("/model"); await visible("Models · First"); await visible("alpha-model")
    await key("Enter"); await closed()
    const first = config().active
    expect(first.model).toBe("alpha-model")

    // New connection must target itself, not the existing active provider.
    await newConnection("Second")
    await visible("beta-model")
    expect(config().active).toEqual(first)
    await key("Down"); await key("Enter"); await closed()
    const second = config().active
    expect(second.model).toBe("beta-model")
    expect(second.providerId).not.toBe(first.providerId)

    await newConnection("Offline", "/failure")
    frames.failure = await visible("Endpoint discovery failed")
    expect(config().active).toEqual(second)
    await key("Escape"); await closed()
    expect(config().active).toEqual(second)

    // Re-open models directly on a saved but incomplete connection.
    await openConnect(); await key("Down"); await key("Down"); await literal("m")
    await visible("Models · Offline"); await visible("Endpoint discovery failed")
    await literal("t"); await visible("Manual model ID · Offline")
    await key("Escape"); await visible("Models · Offline")
    await literal("t"); await visible("Manual model ID · Offline")
    await command("manual-id"); await closed()
    expect(config().active.model).toBe("manual-id")
    const manual = config().active

    // Esc from m returns to connections; no parent dialog consumes the same key.
    await openConnect(); await literal("m"); await visible("Models · First")
    await key("Escape"); await visible("Connections · /connect")
    expect(config().active).toEqual(manual)
    await key("Escape")

    // Editing keeps existing model state and does not restart onboarding.
    await openConnect(); await key("Enter"); await visible("Connection · name")
    await key("Enter"); await visible("Connection · endpoint")
    await key("Enter"); await visible("Connection · wire protocol")
    await key("Enter"); await visible("Connection · authentication")
    await key("Enter"); await visible("Connection · API key")
    await key("Enter"); await visible("current model is kept")
    await key("Enter"); frames.edited = await closed()
    expect(frames.edited).not.toContain("Choose a model")
    expect(config().active).toEqual(manual)
    expect(config().providers[0]?.models).toEqual(["alpha-model"])
    expect(requests.some(path => path.startsWith("/failure"))).toBe(true)
    expect(requests.every(path => path.endsWith("/models"))).toBe(true)
  } finally {
    if (process.env.ZAPCODE_PROVIDER_EVIDENCE_DIR) writeFileAtomic(join(process.env.ZAPCODE_PROVIDER_EVIDENCE_DIR, "provider-onboarding.json"), JSON.stringify({ frames, requests }, null, 2))
    spawnSync("tmux", ["-L", socket, "kill-server"])
    server.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60000)
