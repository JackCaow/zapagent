import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { setTimeout as sleep } from "node:timers/promises"
import { createCustomProvider, getDefaultConfig, saveAppConfig } from "../../src/config.js"

const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
ptyTest("aggregate model picker retains ownership and selection across discovery, filtering, editing and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "zap-model-aggregate-")), previous = process.env.ZAPCODE_DATA_DIR
  process.env.ZAPCODE_DATA_DIR = root
  let alphaRequests = 0, betaRequests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/alpha/v1/models") {
      alphaRequests++
      await sleep(2000)
      return Response.json({ data: [{ id: "shared" }, { id: "alpha-live" }] })
    }
    if (path === "/beta/v1/models") { betaRequests++; return new Response("offline fixture", { status: 503 }) }
    throw new Error(`Unexpected fixture call: ${path}`)
  } })
  const providers = ["Alpha", "Beta"].map((name, index) => ({ ...createCustomProvider({ name,
    baseURL: `http://127.0.0.1:${server.port}/${name.toLowerCase()}/v1`, apiKey: `fixture-${name}`,
    models: index === 0 ? ["shared"] : ["shared", "beta-only"], contextWindow: index === 0 ? 128000 : 64000 }), id: name.toLowerCase(), contextWindowMode: "manual" as const }))
  saveAppConfig(join(root, "config.json"), { ...getDefaultConfig(), providers, active: { providerId: "alpha", model: "shared" }, executionBackend: "local" })
  const config = () => JSON.parse(readFileSync(join(root, "config.json"), "utf8"))
  const socket = `zap-models-${process.pid}-${Date.now()}`, frames: string[] = []
  const tmux = (...args: string[]) => {
    const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr || String(result.error))
    return result.stdout
  }
  const screen = () => tmux("capture-pane", "-p", "-t", "models")
  const visible = async (text: string) => {
    let captured = ""
    for (let i = 0; i < 240; i++) { captured = screen(); if (captured.includes(text)) return captured; await sleep(50) }
    throw new Error(`Missing ${text}:\n${captured}`)
  }
  const key = async (...keys: string[]) => { for (const value of keys) { tmux("send-keys", "-t", "models", value); await sleep(180) } }
  const text = (value: string) => tmux("send-keys", "-t", "models", "-l", value)
  const command = async (value: string) => { text(value); await visible(`❯ ${value}`); await sleep(200); await key("Enter") }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const entry = process.env.ZAP_TEST_COMPILED_BINARY ? quote(resolve(process.env.ZAP_TEST_COMPILED_BINARY)) : `${quote(process.execPath)} ${quote(resolve("src/index.tsx"))}`
  const launch = () => tmux("new-session", "-d", "-s", "models", "-x", "160", "-y", "44", "-c", root,
    `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAPCODE_VM=0 ZAP_DISABLE_UPDATE_CHECK=1 ${entry}`)
  try {
    launch(); await visible("Alpha/shared"); await command("/model")
    let captured = await visible("Models · All connections")
    expect(captured).toContain("Alpha ·")
    expect(captured).toContain("Beta ·")
    expect(captured.match(/shared/g)!.length).toBeGreaterThanOrEqual(3)
    await key("Down")
    // Alpha inserts a row before Beta after the cursor has moved to Beta/shared.
    await visible("alpha-live")
    captured = await visible("› shared")
    expect(captured).toContain("Beta: manual context 64,000")
    expect(config().active).toEqual({ providerId: "alpha", model: "shared" })
    frames.push(tmux("capture-pane", "-e", "-p", "-t", "models"))
    await key("Enter"); await visible("Beta/shared")
    expect(config().active).toEqual({ providerId: "beta", model: "shared" })
    expect(config().providers.find((p: { id: string }) => p.id === "beta").apiKey).toBe("fixture-Beta")
    tmux("kill-session", "-t", "models"); launch(); await visible("Beta/shared")
    await command("/model"); await visible("All connections")
    await key("p"); await visible("All configured connections"); await key("Down", "Down", "Enter")
    captured = await visible("Models · Beta")
    expect(captured).not.toContain("Alpha ·")
    await key("p"); await visible("All configured connections"); await key("Up", "Up", "Enter")
    await visible("All connections")
    await key("/"); await visible("Filter models and connections"); text("Alpha"); await key("Enter")
    await visible("filter: Alpha")
    await key("c"); await visible("Context window"); await key("Enter")
    await visible("Manual context window"); await key("BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace"); text("96000"); await key("Enter")
    await visible("Alpha: manual context 96,000")
    expect(config().active.providerId).toBe("beta")
    expect(config().providers.find((p: { id: string }) => p.id === "alpha").contextWindow).toBe(96000)
    expect(config().providers.find((p: { id: string }) => p.id === "beta").contextWindow).toBe(64000)
    await key("t"); await visible("Manual model · choose connection"); await key("Enter")
    await visible("Manual model ID · Alpha"); text("manual-alias"); await key("Enter")
    await visible("Alpha/manual-alias")
    expect(config().active).toEqual({ providerId: "alpha", model: "manual-alias" })
    expect(config().providers.find((p: { id: string }) => p.id === "beta").models).not.toContain("manual-alias")
    expect(alphaRequests).toBeGreaterThan(0); expect(betaRequests).toBeGreaterThan(0)
    if (process.env.ZAPCODE_MODEL_AGGREGATE_RECORDING) {
      writeFileSync(process.env.ZAPCODE_MODEL_AGGREGATE_RECORDING, [JSON.stringify({ version: 2, width: 160, height: 44, title: "All-provider model picker (local fixture endpoints)" }),
        ...frames.map((frame, i) => JSON.stringify([i * 4, "o", "\x1b[2J\x1b[H" + frame.replaceAll("\n", "\r\n")]))].join("\n") + "\n")
    }
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"]); server.stop()
    if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR; else process.env.ZAPCODE_DATA_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
}, 90000)
