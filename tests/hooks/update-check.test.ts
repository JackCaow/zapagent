import { afterEach, beforeEach, expect, it } from "bun:test"
import { createElement } from "react"
import { Text, render } from "ink"
import { PassThrough } from "node:stream"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { useUpdateCheck } from "../../src/hooks/useUpdateCheck.js"
import { VERSION } from "../../src/version.js"

let root: string, cachePath: string, calls: number
let originalFetch: typeof fetch
let previous: Record<string, string | undefined>
const close: (() => void)[] = []
const pause = () => new Promise(resolve => setTimeout(resolve, 30))
async function until(test: () => boolean) {
  const end = Date.now() + 2000
  while (!test()) { if (Date.now() > end) throw Error("Update check did not settle"); await pause() }
}
function mount(manual = false) {
  let state!: ReturnType<typeof useUpdateCheck>
  function Harness() { state = useUpdateCheck(manual); return createElement(Text, null, state.status) }
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 24 })
  stdout.on("data", () => {})
  const stdin = new PassThrough()
  const instance = render(createElement(Harness), { stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream, stderr: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false, exitOnCtrlC: false })
  const dispose = () => { instance.unmount(); instance.cleanup(); stdout.destroy(); stdin.destroy() }
  close.push(dispose)
  return { get state() { return state }, dispose }
}
beforeEach(() => {
  previous = Object.fromEntries(["CI", "ZAP_DISABLE_UPDATE_CHECK", "ZAPCODE_DATA_DIR"].map(key => [key, process.env[key]]))
  delete process.env.CI; delete process.env.ZAP_DISABLE_UPDATE_CHECK
  root = mkdtempSync(join(tmpdir(), "zap-update-hook-"))
  process.env.ZAPCODE_DATA_DIR = root
  mkdirSync(join(root, "cache"))
  cachePath = join(root, "cache", "update-check.json")
  calls = 0; originalFetch = globalThis.fetch
  globalThis.fetch = (async () => { calls++; return Response.json({ latest: "99.0.0" }) }) as typeof fetch
})
afterEach(() => {
  for (const dispose of close.splice(0)) dispose()
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

it("automatic startup uses a fresh success cache without a request or a current banner", async () => {
  const data = JSON.stringify({ checkedAt: Date.now(), latest: VERSION, failed: false })
  writeFileSync(cachePath, data)
  const ui = mount(); await pause()
  expect(calls).toBe(0)
  expect(ui.state.status).toBe("idle")
  expect(readFileSync(cachePath, "utf8")).toBe(data)
})

it("automatic startup writes fetched metadata and reuses it on the next launch", async () => {
  const first = mount(); await until(() => first.state?.status === "available")
  expect(JSON.parse(readFileSync(cachePath, "utf8"))).toMatchObject({ latest: "99.0.0", failed: false })
  first.dispose()
  const second = mount(); await until(() => second.state?.status === "available")
  expect(calls).toBe(1)
})

it("automatic offline checks stay quiet and retain the failure TTL across launches", async () => {
  globalThis.fetch = (async () => { calls++; throw Error("offline") }) as typeof fetch
  const first = mount(); await until(() => existsSync(cachePath)); await pause()
  expect(first.state.status).toBe("idle")
  expect(JSON.parse(readFileSync(cachePath, "utf8")).failed).toBe(true)
  first.dispose()
  const second = mount(); await pause()
  expect(second.state.status).toBe("idle")
  expect(calls).toBe(1)
  second.dispose()
  const cached = JSON.parse(readFileSync(cachePath, "utf8")); cached.checkedAt -= 16 * 60 * 1000
  writeFileSync(cachePath, JSON.stringify(cached))
  mount(); await until(() => calls === 2)
})

it("manual checks bypass the opt-out and fresh automatic cache", async () => {
  process.env.ZAP_DISABLE_UPDATE_CHECK = "1"
  writeFileSync(cachePath, JSON.stringify({ checkedAt: Date.now(), latest: VERSION, failed: false }))
  const automatic = mount(); await pause()
  expect(automatic.state.status).toBe("disabled")
  expect(calls).toBe(0)
  automatic.dispose()
  const manual = mount(true); await until(() => manual.state?.status === "available")
  expect(calls).toBe(1)
})
