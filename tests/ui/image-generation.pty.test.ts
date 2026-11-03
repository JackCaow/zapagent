import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { setTimeout as sleep } from "node:timers/promises"
import { Resvg } from "@resvg/resvg-js"
import { saveCodexCredentials } from "../../src/codex-auth.js"
import { connectCodexProvider } from "../../src/codex-provider.js"
import { getDefaultConfig, saveAppConfig } from "../../src/config.js"
import { selectCatalogModel } from "../../src/provider-catalog.js"
import { imagePreload } from "../fixtures/codex-image.js"

const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
ptyTest("real TUI approves image generation, shows the PNG preview and restores it from a saved session", async () => {
  const root = mkdtempSync(join(tmpdir(), "zap-image-tui-")), previous = process.env.ZAPCODE_DATA_DIR
  process.env.ZAPCODE_DATA_DIR = root
  const socket = `zap-image-${process.pid}-${Date.now()}`, frames: string[] = []
  const tmux = (...args: string[]) => {
    const run = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
    if (run.status !== 0) throw new Error(run.stderr || String(run.error))
    return run.stdout
  }
  const capture = () => tmux("capture-pane", "-e", "-p", "-t", "image")
  const visible = async (text: string) => {
    let screen = ""
    for (let i = 0; i < 200; i++) { screen = capture(); if (screen.includes(text)) return screen; await sleep(50) }
    throw new Error(`Missing ${text}:\n${screen}`)
  }
  const key = async (...keys: string[]) => { tmux("send-keys", "-t", "image", ...keys); await sleep(200) }
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
  try {
    const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="white"/><circle cx="32" cy="32" r="24" fill="blue"/></svg>').render().asPng()
    await saveCodexCredentials({ accessToken: "fixture-image-access", refreshToken: "fixture-image-refresh", expiresAt: Date.now() + 3600000 })
    const connected = connectCodexProvider(getDefaultConfig())
    saveAppConfig(join(root, "config.json"), selectCatalogModel(connected.config, connected.provider.id, { id: "account-model", source: "manual" }))
    writeFileSync(join(root, "preload.ts"), imagePreload(png.toString("base64")))
    const launch = (resume = false) => tmux("new-session", "-d", "-s", "image", "-x", "145", "-y", "48", "-c", root,
      `exec env ZAPCODE_DATA_DIR=${quote(root)} ZAPCODE_VM=0 ZAPCODE_EXECUTION=local ${quote(process.execPath)} --preload ${quote(join(root, "preload.ts"))} ${quote(resolve("src/index.tsx"))}${resume ? " --continue" : ""}`)
    launch(); await visible("account-model"); await sleep(700)
    tmux("send-keys", "-t", "image", "-l", "Create an image of a blue circle and save it to generated/circle.png")
    await sleep(300); await key("Enter")
    frames.push(await visible("Approve?"))
    expect(frames.at(-1)).toContain("GenerateImage")
    expect(existsSync(join(root, "generated/circle.png"))).toBe(false)
    await key("Enter")
    frames.push(await visible("Image ready: generated/circle.png"))
    expect(frames.at(-1)).toContain("64×64")
    expect(frames.at(-1)).toContain("▀")
    expect(readFileSync(join(root, "generated/circle.png"))).toEqual(png)
    await sleep(500)
    tmux("kill-session", "-t", "image"); launch()
    await visible("account-model"); await sleep(700)
    tmux("send-keys", "-t", "image", "-l", "/sessions"); await sleep(300); await key("Enter")
    await visible("Saved sessions"); await visible("Create an image of a blue circle")
    await key("Enter")
    frames.push(await visible("Image ready: generated/circle.png"))
    expect(frames.at(-1)).toContain("64×64")
    expect(frames.at(-1)).toContain("▀")
    if (process.env.ZAPCODE_IMAGE_RECORDING) writeFileSync(process.env.ZAPCODE_IMAGE_RECORDING,
      [JSON.stringify({ version: 2, width: 145, height: 48, title: "Codex image generation — approval, PNG preview and session restore (offline fixture)" }),
        ...frames.map((frame, i) => JSON.stringify([i * 4, "o", "\x1b[2J\x1b[H" + frame.replaceAll(realpathSync(root), "/tmp/zap-image-demo").replaceAll(root, "/tmp/zap-image-demo").replaceAll("\n", "\r\n")]))].join("\n") + "\n")
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"])
    if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR; else process.env.ZAPCODE_DATA_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
}, 60000)
