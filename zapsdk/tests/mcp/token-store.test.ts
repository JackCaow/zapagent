import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { MCPTokenStore } from "../../mcp/oauth/token-store.js"

describe("MCPTokenStore", () => {
  let path: string

  beforeEach(() => {
    path = join(tmpdir(), `zap-mcp-token-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  })

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path)
  })

  it("returns undefined for unknown servers when file is missing", async () => {
    const store = new MCPTokenStore(path)
    expect(await store.get("nope")).toBeUndefined()
  })

  it("persists tokens and reads back on a fresh instance", async () => {
    const s1 = new MCPTokenStore(path)
    await s1.upsert({
      serverName: "linear",
      serverUrl: "https://mcp.linear.app/mcp",
      tokens: { access_token: "abc", token_type: "Bearer" },
    })
    const s2 = new MCPTokenStore(path)
    const got = await s2.get("linear")
    expect(got?.tokens?.access_token).toBe("abc")
  })

  it("patch merges fields without dropping previously-set ones", async () => {
    const store = new MCPTokenStore(path)
    await store.upsert({ serverName: "linear", serverUrl: "u", loopbackPort: 33418 })
    await store.patch("linear", { tokens: { access_token: "t", token_type: "Bearer" } })
    const got = await store.get("linear")
    expect(got?.loopbackPort).toBe(33418)
    expect(got?.tokens?.access_token).toBe("t")
  })

  it("flushes with mode 0600", async () => {
    const store = new MCPTokenStore(path)
    await store.upsert({ serverName: "linear", serverUrl: "u" })
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it("tightens permissions when replacing an existing broad token file", async () => {
    writeFileSync(path, JSON.stringify({ version: 1, servers: {} }) + "\n", { mode: 0o666 })
    chmodSync(path, 0o666)

    const store = new MCPTokenStore(path)
    await store.upsert({ serverName: "linear", serverUrl: "u" })

    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("stores tokens in a private zapcode directory", async () => {
    if (process.platform === "win32") return
    const root = join(tmpdir(), `zap-mcp-token-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const dir = join(root, "zapcode")
    const tokenPath = join(dir, "mcp-tokens.json")
    try {
      mkdirSync(dir, { recursive: true })
      chmodSync(dir, 0o777)
      const store = new MCPTokenStore(tokenPath)

      await store.upsert({ serverName: "linear", serverUrl: "u" })

      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("sanitizes malformed server maps on load", async () => {
    writeFileSync(path, JSON.stringify({
      version: 1,
      servers: {
        valid: { serverUrl: "https://example.com/mcp" },
        badNumber: 42,
        badNull: null,
      },
    }) + "\n")

    const store = new MCPTokenStore(path)
    expect(await store.get("badNumber")).toBeUndefined()
    expect(await store.get("badNull")).toBeUndefined()
    expect(await store.get("valid")).toEqual({
      serverName: "valid",
      serverUrl: "https://example.com/mcp",
    })
  })

  it("rewrites sanitized data after patching a malformed token file", async () => {
    writeFileSync(path, JSON.stringify({
      version: 1,
      servers: {
        valid: { serverUrl: "u" },
        invalid: "bad",
      },
    }) + "\n")

    const store = new MCPTokenStore(path)
    await store.patch("valid", { tokens: { access_token: "t", token_type: "Bearer" } })

    const raw = JSON.parse(readFileSync(path, "utf-8"))
    expect(raw.servers.invalid).toBeUndefined()
    expect(raw.servers.valid.serverName).toBe("valid")
    expect(raw.servers.valid.tokens.access_token).toBe("t")
  })

  it("delete removes the entry", async () => {
    const store = new MCPTokenStore(path)
    await store.upsert({ serverName: "linear", serverUrl: "u" })
    await store.delete("linear")
    expect(await store.get("linear")).toBeUndefined()
  })
})
