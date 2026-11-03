import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { setTimeout as sleep } from "node:timers/promises"
import { saveCodexCredentials } from "../../src/codex-auth.js"
import { connectCodexProvider } from "../../src/codex-provider.js"
import { getDefaultConfig, saveAppConfig } from "../../src/config.js"
import { selectCatalogModel } from "../../src/provider-catalog.js"

const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
ptyTest("real App adapts effort options, restores per-model choices and persists server default", async () => {
  const root = mkdtempSync(join(tmpdir(), "zap-model-effort-"))
  const previous = process.env.ZAPCODE_DATA_DIR
  process.env.ZAPCODE_DATA_DIR = root
  const socket = `zap-effort-${process.pid}-${Date.now()}`
  const frames: string[] = []
  const tmux = (...args: string[]) => {
    const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr || String(result.error))
    return result.stdout
  }
  const capture = () => tmux("capture-pane", "-p", "-t", "effort")
  const visible = async (text: string) => {
    let screen = ""
    for (let attempt = 0; attempt < 160; attempt++) {
      screen = capture()
      if (screen.includes(text)) return screen
      await sleep(50)
    }
    throw new Error(`Missing ${text}:\n${screen}`)
  }
  const key = async (...keys: string[]) => { tmux("send-keys", "-t", "effort", ...keys); await sleep(180) }
  const command = async (value: string) => {
    tmux("send-keys", "-t", "effort", "-l", value)
    await visible(value); await sleep(250); await key("Enter")
  }
  const config = () => JSON.parse(readFileSync(join(root, "config.json"), "utf8"))
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  try {
    await saveCodexCredentials({ accessToken: "fixture", refreshToken: "fixture", expiresAt: Date.now() + 3600000 })
    const connected = connectCodexProvider(getDefaultConfig())
    saveAppConfig(join(root, "config.json"), selectCatalogModel(connected.config, connected.provider.id, { id: "full", source: "manual" }))
    writeFileSync(join(root, "preload.ts"), `globalThis.fetch = async (url) => {
      if (!String(url).startsWith("https://chatgpt.com/backend-api/codex/models?")) throw new Error("Offline fixture");
      if (await Bun.file(${JSON.stringify(join(root, "offline"))}).exists()) throw new Error("Offline");
      return Response.json({models:[
        {slug:"full", supported_reasoning_levels:["low","medium","high","xhigh","max","ultra"].map(effort=>({effort,description:effort+" depth"})), default_reasoning_level:"low"},
        {slug:"small", supported_reasoning_levels:[{effort:"low",description:"Quick"}], default_reasoning_level:"low"}
      ]});
    };`)
    const launch = () => tmux("new-session", "-d", "-s", "effort", "-x", "145", "-y", "38", "-c", root,
      `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAPCODE_VM=0 ${quote(process.execPath)} --preload ${quote(join(root, "preload.ts"))} ${quote(resolve("src/index.tsx"))}`)
    launch()
    await visible("full")
    await sleep(800)
    await command("/effort")
    frames.push(await visible("ultra depth"))
    expect(frames.at(-1)).not.toContain("minimal")
    expect(frames.at(-1)).toContain("server default (low)")
    await key("Down", "Down", "Down", "Down", "Down"); await key("Enter")
    expect(config().providers[0].effortByModel.full).toBe("max")
    await command("/effort"); frames.push(await visible("max depth · (current)"))
    await key("Down"); await key("Enter")
    expect(config().providers[0].effortByModel.full).toBe("ultra")
    await command("/model"); await visible("small")
    await key("Down"); await key("Enter")
    expect(config().active.model).toBe("small")
    await command("/effort"); frames.push(await visible("Quick"))
    expect(frames.at(-1)).not.toContain("ultra depth")
    await key("Down"); await key("Enter")
    expect(config().providers[0].effortByModel.small).toBe("low")
    await command("/model"); await visible("full")
    await key("Up"); await key("Enter")
    await command("/effort"); frames.push(await visible("ultra depth · (current)"))
    for (let i = 0; i < 6; i++) await key("Up")
    await key("Enter")
    expect(config().providers[0].effortByModel.full).toBeNull()
    writeFileSync(join(root, "offline"), "1")
    tmux("kill-session", "-t", "effort")
    launch(); await visible("full"); await sleep(800)
    await command("/effort"); frames.push(await visible("server default (low) (current)"))
    expect(frames.at(-1)).toContain("ultra depth")
    if (process.env.ZAPCODE_EFFORT_RECORDING) {
      writeFileSync(process.env.ZAPCODE_EFFORT_RECORDING, [JSON.stringify({ version: 2, width: 145, height: 38, title: "Model-aware Codex reasoning effort (offline fixture)" }),
        ...frames.map((frame, index) => JSON.stringify([index * 3, "o", "\x1b[2J\x1b[H" + frame.replaceAll("\n", "\r\n")]))].join("\n") + "\n")
    }
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"])
    if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR
    else process.env.ZAPCODE_DATA_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
}, 90000)
