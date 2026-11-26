import { expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { installCodexFixture } from "./fixtures/native-codex.js"

const nativeTest = process.platform === "win32" ? it.skip : it

nativeTest("delegates login, status and logout to the native CLI, ignoring legacy tokens", () => {
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
