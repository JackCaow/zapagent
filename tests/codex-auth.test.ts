import { expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { createServer } from "node:net"
import { runCodexAuth } from "../src/codex-auth.js"
import { spawnSync } from "node:child_process"
import { installCodexFixture } from "./fixtures/native-codex.js"

it("delegates login, status and logout to the native CLI, ignoring legacy tokens", () => {
  const root = mkdtempSync(join(tmpdir(), "zap-native-login-"))
  try {
    installCodexFixture(root)
    const legacy = join(root, "codex-oauth.json")
    writeFileSync(legacy, "legacy-secret")
    const run = (...args: string[]) => spawnSync(process.execPath, [resolve("src/index.tsx"), "auth", ...args], {
      encoding: "utf8", env: { ...process.env, PATH: root + delimiter + process.env.PATH, ZAPCODE_DATA_DIR: root },
    })
    expect(run("status", "codex").status).toBe(1)
    expect(run("login", "codex", "--device-code").status).toBe(0)
    const status = run("status", "codex")
    expect(status.status).toBe(0)
    expect(status.stderr).toContain("Logged in using ChatGPT")
    expect(status.stdout + status.stderr).not.toContain("legacy-secret")
    expect(readFileSync(legacy, "utf8")).toBe("legacy-secret")
    expect(run("login", "codex", "--invalid").status).toBe(2)
    expect(run("logout", "codex").status).toBe(0)
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(root, "calls"), "utf8").trim().split("\n")).toEqual(["login status", "login --device-auth", "login status", "logout"])
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 30000)

it("cancelling login releases the callback listener in the CLI wrapper's child", async () => {
  const root = mkdtempSync(join(tmpdir(), "zap-cancel-login-"))
  const originalPath = process.env.PATH
  const controller = new AbortController()
  const server = createServer()
  try {
    installCodexFixture(root)
    process.env.PATH = root + delimiter + originalPath
    writeFileSync(join(root, "wait-login.cjs"), `
      const s = require("node:net").createServer()
      s.listen(0, "127.0.0.1", () => console.log("port=" + s.address().port))
    `)
    let output = "", port = 0
    const result = runCodexAuth("login", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      onOutput: text => {
        output += text
        const match = output.match(/port=(\d+)\r?\n/)
        if (match) { port = Number(match[1]); controller.abort() }
      } })
    await expect(result).rejects.toThrow()
    expect(port).toBeGreaterThan(0)
    await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", ok) })
  } finally {
    controller.abort()
    if (server.listening) server.close()
    process.env.PATH = originalPath
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)
