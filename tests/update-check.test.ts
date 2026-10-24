import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkForUpdate, isNewerRelease, shouldCheckForUpdates, startUpdateCheck, type UpdateCheckOptions } from "../src/update-check.js"

let root: string, options: UpdateCheckOptions
const response = (latest = "1.15.0") => new Response(JSON.stringify({ latest }))
const mockFetch = (fn: (...args: any[]) => Promise<Response>) => fn as typeof fetch
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-update-check-"))
  options = { currentVersion: "1.14.8", cachePath: join(root, "cache.json"), now: () => 1_000_000,
    fetch: mockFetch(async () => response()), timeoutMs: 100 }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const cache = (latest: string | null, checkedAt = 1_000_000, failed = false) =>
  writeFileSync(options.cachePath, JSON.stringify({ latest, checkedAt, failed }))

describe("stable release comparison", () => {
  it("compares numeric components and ignores equal/older releases", () => {
    expect(isNewerRelease("1.14.10", "1.14.9")).toBe(true)
    expect(isNewerRelease("2.0.0", "1.99.99")).toBe(true)
    expect(isNewerRelease("1.14.8", "1.14.8")).toBe(false)
    expect(isNewerRelease("1.14.7", "1.14.8")).toBe(false)
    expect(isNewerRelease("1.14.8", "1.14.8-rc.1")).toBe(true)
    expect(isNewerRelease("1.14.8", "1.14.8+build.1")).toBe(false)
    expect(isNewerRelease("1.14.8", "2.0.0-rc.1")).toBe(false)
  })
  it("rejects prerelease/latest metadata and terminal/command injection", () => {
    for (const value of ["1.15.0-rc.1", "01.15.0", "1.15.0\n", "1.15.0; rm -rf /", "\x1b[31m1.15.0", "latest"]) {
      expect(isNewerRelease(value, "1.14.8")).toBe(false)
    }
    expect(isNewerRelease("1.15.0", "invalid")).toBe(false)
  })
})

describe("background update check", () => {
  it("requests only public dist tags and caches the stable result", async () => {
    let calls = 0
    options.fetch = mockFetch(async (url, init) => {
      calls++
      expect(url).toBe("https://registry.npmjs.org/-/package/zapagent/dist-tags")
      expect(init.redirect).toBe("error")
      expect(init.headers).toEqual({ Accept: "application/json" })
      return response()
    })
    expect(await checkForUpdate(options)).toBe("1.15.0")
    expect(await checkForUpdate(options)).toBe("1.15.0")
    expect(calls).toBe(1)
    expect(JSON.parse(readFileSync(options.cachePath, "utf8")).failed).toBe(false)
  })
  it("recompares cached versions against the installed version after upgrade", async () => {
    cache("1.15.0")
    options.fetch = mockFetch(async () => { throw new Error("must not fetch") })
    expect(await checkForUpdate({ ...options, currentVersion: "1.15.0" })).toBeNull()
    expect(await checkForUpdate({ ...options, currentVersion: "1.16.0" })).toBeNull()
  })
  it("refreshes expired, future and corrupt caches", async () => {
    let calls = 0
    options.fetch = mockFetch(async () => { calls++; return response() })
    cache("1.14.8", 0)
    options.now = () => 24 * 60 * 60 * 1000
    expect(await checkForUpdate(options)).toBe("1.15.0")
    cache("1.14.8", 2 * 24 * 60 * 60 * 1000)
    expect(await checkForUpdate(options)).toBe("1.15.0")
    writeFileSync(options.cachePath, "not-json")
    expect(await checkForUpdate(options)).toBe("1.15.0")
    expect(calls).toBe(3)
  })
  it("silently handles offline checks and throttles retry attempts", async () => {
    let calls = 0
    options.fetch = mockFetch(async () => { calls++; throw new Error("offline") })
    expect(await checkForUpdate(options)).toBeNull()
    expect(await checkForUpdate(options)).toBeNull()
    expect(calls).toBe(1)
    options.now = () => 1_000_000 + 15 * 60 * 1000
    expect(await checkForUpdate(options)).toBeNull()
    expect(calls).toBe(2)
  })
  it("preserves a known newer release when refreshing offline", async () => {
    cache("1.15.0", 0)
    options.now = () => 24 * 60 * 60 * 1000
    options.fetch = mockFetch(async () => { throw new Error("offline") })
    expect(await checkForUpdate(options)).toBe("1.15.0")
  })
  it("rejects HTTP errors, invalid metadata and oversized response bodies", async () => {
    for (const make of [() => new Response("denied", { status: 503 }),
      () => new Response("bad json"), () => response("1.15.0-rc.1"),
      () => response("1.15.0\n"), () => new Response("x".repeat(17 * 1024))]) {
      rmSync(options.cachePath, { force: true })
      options.fetch = mockFetch(async () => make())
      expect(await checkForUpdate(options)).toBeNull()
    }
  })
  it("still notifies if the cache is unwritable", async () => {
    const file = join(root, "not-a-directory")
    writeFileSync(file, "file")
    expect(await checkForUpdate({ ...options, cachePath: join(file, "cache.json") })).toBe("1.15.0")
  })
  it("bounds a fetch that never resolves and aborts it", async () => {
    let signal: AbortSignal | undefined
    options.fetch = mockFetch(async (_, init) => { signal = init.signal; return await new Promise<Response>(() => {}) })
    const start = Date.now()
    expect(await checkForUpdate({ ...options, timeoutMs: 20 })).toBeNull()
    expect(Date.now() - start).toBeLessThan(1000)
    expect(signal?.aborted).toBe(true)
  })
  it("also times out a stalled response body", async () => {
    options.fetch = mockFetch(async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}) } })))
    expect(await checkForUpdate({ ...options, timeoutMs: 20 })).toBeNull()
  })
  it("returns immediately and suppresses late results after unmount", async () => {
    let started!: () => void, finish!: (r: Response) => void
    const pending = new Promise<void>(resolve => { started = resolve })
    let signal: AbortSignal | undefined, notices = 0
    options.fetch = mockFetch((_, init) => {
      signal = init.signal; started()
      return new Promise(resolve => { finish = resolve })
    })
    const stop = startUpdateCheck(options, () => { notices++ })
    expect(typeof stop).toBe("function")
    expect(notices).toBe(0)
    await pending
    stop()
    expect(signal?.aborted).toBe(true)
    finish(response())
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(notices).toBe(0)
    expect(existsSync(options.cachePath)).toBe(false)
  })
  it("does not fetch or write when already cancelled", async () => {
    const controller = new AbortController(); controller.abort()
    options.fetch = mockFetch(async () => { throw new Error("must not fetch") })
    expect(await checkForUpdate({ ...options, signal: controller.signal })).toBeNull()
    expect(existsSync(options.cachePath)).toBe(false)
  })
  it("supports CI and explicit opt-out without disabling normal TUI checks", () => {
    expect(shouldCheckForUpdates({})).toBe(true)
    expect(shouldCheckForUpdates({ CI: "true" })).toBe(false)
    expect(shouldCheckForUpdates({ ZAP_DISABLE_UPDATE_CHECK: "1" })).toBe(false)
  })
})
