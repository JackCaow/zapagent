import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const REGISTRY_URL = "https://registry.npmjs.org/-/package/zapagent/dist-tags"
const SUCCESS_TTL = 24 * 60 * 60 * 1000
const FAILURE_TTL = 15 * 60 * 1000
const MAX_BYTES = 16 * 1024

interface Cache { checkedAt: number; latest: string | null; failed: boolean }
export function shouldCheckForUpdates(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.CI && env.ZAP_DISABLE_UPDATE_CHECK !== "1"
}
export interface UpdateCheckOptions {
  currentVersion: string
  cachePath: string
  signal?: AbortSignal
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

function stableVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
}

export function isNewerRelease(latest: string, current: string): boolean {
  if (!stableVersion(latest)) return false
  const parsed = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(current)
  if (!parsed) return false
  const next = latest.split(".").map(BigInt)
  for (let i = 0; i < 3; i++) {
    const installed = BigInt(parsed[i + 1]!)
    if (next[i]! !== installed) return next[i]! > installed
  }
  return Boolean(parsed[4])
}

async function readCache(path: string, now: number): Promise<Cache | undefined> {
  try {
    const text = await readFile(path, "utf8")
    if (text.length > MAX_BYTES) return
    const value = JSON.parse(text) as Cache
    if (!value || !Number.isFinite(value.checkedAt) || value.checkedAt < 0 || value.checkedAt > now
      || typeof value.failed !== "boolean" || (value.latest !== null && !stableVersion(value.latest))) return
    return value
  } catch { return }
}

async function writeCache(path: string, value: Cache): Promise<void> {
  const temporary = join(dirname(path), `.update-${randomUUID()}.tmp`)
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" })
    await rename(temporary, path)
  } catch { /* Read-only/unavailable storage must not affect the CLI. */ }
  finally { await unlink(temporary).catch(() => {}) }
}

export async function fetchLatestRelease(options: UpdateCheckOptions): Promise<string> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      (async () => {
        const response = await (options.fetch ?? fetch)(REGISTRY_URL, {
          signal: controller.signal, redirect: "error", headers: { Accept: "application/json" },
        })
        if (!response.ok || !response.body) throw new Error("Update metadata unavailable")
        const reader = response.body.getReader()
        let size = 0, text = ""
        const decoder = new TextDecoder()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_BYTES) throw new Error("Update metadata too large")
            text += decoder.decode(value, { stream: true })
          }
          text += decoder.decode()
        } finally { await reader.cancel().catch(() => {}) }
        const latest: unknown = JSON.parse(text)?.latest
        if (!stableVersion(latest)) throw new Error("Invalid stable release")
        return latest
      })(),
      new Promise<never>((_, reject) => {
        onAbort = () => { controller.abort(); reject(new Error("Update check cancelled")) }
        options.signal?.addEventListener("abort", onAbort, { once: true })
        if (options.signal?.aborted) return onAbort()
        timer = setTimeout(() => { controller.abort(); reject(new Error("Update check timed out")) }, options.timeoutMs ?? 3000)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) options.signal?.removeEventListener("abort", onAbort)
    controller.abort()
  }
}

/** Background-only, best effort. Never logs or throws into startup/protocol output. */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<string | null> {
  try {
    if (options.signal?.aborted) return null
    const now = options.now ?? Date.now
    const cached = await readCache(options.cachePath, now())
    if (options.signal?.aborted) return null
    let latest = cached?.latest ?? null
    if (!cached || now() - cached.checkedAt >= (cached.failed ? FAILURE_TTL : SUCCESS_TTL)) {
      let failed = false
      try { latest = await fetchLatestRelease(options) } catch { failed = true }
      if (options.signal?.aborted) return null
      await writeCache(options.cachePath, { checkedAt: now(), latest, failed })
    }
    return latest && isNewerRelease(latest, options.currentVersion) ? latest : null
  } catch { return null }
}

/** Returns immediately; unmount cancels requests and suppresses late notices. */
export function startUpdateCheck(options: Omit<UpdateCheckOptions, "signal">, notify: (version: string) => void): () => void {
  const controller = new AbortController()
  void checkForUpdate({ ...options, signal: controller.signal }).then(version => {
    if (version && !controller.signal.aborted) notify(version)
  }).catch(() => {})
  return () => controller.abort()
}
