import { afterEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function run(blockMs: number): { dir: string; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "zap-watchdog-")); roots.push(dir)
  const script = `
    import { startFreezeWatchdog } from ${JSON.stringify(join(process.cwd(), "src/watchdog.ts"))}
    startFreezeWatchdog({ directory: ${JSON.stringify(dir)}, thresholdMs: 2000, intervalMs: 300 })
    await new Promise(r => setTimeout(r, 1500))           // heartbeats flow normally first
    const end = Date.now() + ${blockMs}; while (Date.now() < end) {}   // then the main thread stops
    await new Promise(r => setTimeout(r, 600))
  `
  const result = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 40_000 })
  expect(result.status).toBe(0)
  // The monitor sleeps up to a few seconds between checks and may still be sampling.
  const deadline = Date.now() + 14_000
  let files = readdirSync(dir)
  while (blockMs > 0 && !files.some(f => f.endsWith(".txt")) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); files = readdirSync(dir)
  }
  return { dir, files }
}

const posixDescribe = process.platform === "win32" ? describe.skip : describe
posixDescribe("freeze watchdog", () => {
  it("records a diagnostic when the main thread stops answering", () => {
    const { dir, files } = run(9000)
    const report = files.find(f => /^freeze-\d{8}T\d{6}\.txt$/.test(f))
    expect(report).toBeDefined()
    const text = readFileSync(join(dir, report!), "utf8")
    expect(text).toContain("main thread stalled for at least 2s")
    expect(text).toContain("--- lsof ---")
  }, 60_000)

  it("stays silent and removes its heartbeat when nothing stalls", () => {
    const { dir, files } = run(0)
    expect(files.some(f => f.startsWith("freeze-"))).toBe(false)
    expect(files.some(f => f.startsWith("heartbeat-"))).toBe(false)
    expect(existsSync(dir)).toBe(true)
  }, 60_000)
})
