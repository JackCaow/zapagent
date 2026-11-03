import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { getAppDataDir } from "../zapsdk/utils/platform.js"
import { writeFileAtomic } from "./utils/secure-write.js"

// Public native-client OAuth registration, also used by Codex CLI/OpenCode.
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
const ISSUER = "https://auth.openai.com"
export interface CodexCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId?: string
}
type Fetch = typeof globalThis.fetch
export const codexCredentialPath = () => join(getAppDataDir(), "codex-oauth.json")

export function readCodexCredentials(path = codexCredentialPath()): CodexCredentials | null {
  let data: unknown
  try { data = JSON.parse(readFileSync(path, "utf8")) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new Error("Cannot read Codex credentials. Sign in again with /connect.")
  }
  const value = data as CodexCredentials | null
  if (!value || typeof value.accessToken !== "string" || !value.accessToken ||
    typeof value.refreshToken !== "string" || !value.refreshToken ||
    typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) ||
    (value.accountId !== undefined && typeof value.accountId !== "string")) {
    throw new Error("Invalid Codex credentials. Sign in again with /connect.")
  }
  return value
}

function writeCodexCredentials(value: CodexCredentials, path: string): void {
  writeFileAtomic(path, JSON.stringify(value) + "\n", { mode: 0o600 })
}

export async function saveCodexCredentials(value: CodexCredentials, path = codexCredentialPath(), signal?: AbortSignal): Promise<void> {
  // An explicit login may replace a previous login; it still serializes with logout.
  await withCredentialLock(path, signal, () => writeCodexCredentials(value, path))
}

export async function deleteCodexCredentials(path = codexCredentialPath()): Promise<void> {
  // Wait for in-flight refresh to commit before deleting. Once logout returns,
  // that refresh can no longer recreate the file behind the user's back.
  await withCredentialLock(path, undefined, () => rmSync(path, { force: true }))
}

function accountId(token: unknown): string | undefined {
  if (typeof token !== "string") return
  try {
    // Claims are routing metadata, not a locally verified authentication proof.
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
    const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? claims.chatgpt_account_id
    return typeof id === "string" ? id : undefined
  } catch { return undefined }
}

async function tokenRequest(params: Record<string, string>, signal?: AbortSignal,
  fetcher: Fetch = fetch, previous?: CodexCredentials): Promise<CodexCredentials> {
  const response = await fetcher(`${ISSUER}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CODEX_CLIENT_ID, ...params }),
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
    redirect: "error",
  })
  // Do not include response bodies: auth errors can echo credentials/codes.
  if (!response.ok) throw new Error(`Codex authentication failed (HTTP ${response.status}). Sign in again with /connect.`)
  const data = await response.json() as Record<string, unknown>
  if (typeof data.access_token !== "string" || !data.access_token ||
    (!previous && (typeof data.refresh_token !== "string" || !data.refresh_token))) {
    throw new Error("Codex returned an invalid token response.")
  }
  const seconds = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : 3600
  return { accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : previous!.refreshToken,
    expiresAt: Date.now() + seconds * 1000,
    accountId: accountId(data.id_token) ?? accountId(data.access_token) ?? previous?.accountId }
}

/** Every credential mutation uses this lock, including explicit login/logout. */
async function withCredentialLock<T>(path: string, signal: AbortSignal | undefined, action: () => T | Promise<T>): Promise<T> {
  const lock = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  const started = Date.now()
  for (;;) {
    signal?.throwIfAborted()
    try { mkdirSync(lock, { mode: 0o700 }); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      // Network refreshes are bounded to 15s; recover a lock left by a crash.
      try { if (Date.now() - statSync(lock).mtimeMs > 60_000) rmSync(lock, { recursive: true, force: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      if (Date.now() - started > 30_000) throw new Error("Codex credential store is busy. Try again shortly.")
      await delay(100, undefined, { signal })
    }
  }
  try {
    signal?.throwIfAborted()
    return await action()
  } finally { rmSync(lock, { recursive: true, force: true }) }
}

/** Serialize refreshes across Zap processes because refresh tokens rotate. */
export async function getCodexCredentials(signal?: AbortSignal, options: { path?: string; fetcher?: Fetch } = {}): Promise<CodexCredentials> {
  const path = options.path ?? codexCredentialPath()
  const current = readCodexCredentials(path)
  if (!current) throw new Error("Codex is signed out. Sign in with /connect or zap auth login codex.")
  if (current.expiresAt > Date.now() + 60_000) return current
  return withCredentialLock(path, signal, async () => {
    const latest = readCodexCredentials(path)
    if (!latest) throw new Error("Codex is signed out. Sign in again with /connect.")
    if (latest.expiresAt > Date.now() + 60_000) return latest
    const next = await tokenRequest({ grant_type: "refresh_token", refresh_token: latest.refreshToken }, signal, options.fetcher, latest)
    signal?.throwIfAborted()
    // Detect non-cooperating/manual edits too; public login/logout use our lock.
    if (readCodexCredentials(path)?.refreshToken !== latest.refreshToken) throw new Error("Codex login changed during refresh. Try again.")
    writeCodexCredentials(next, path)
    return next
  })
}

export function openAuthBrowser(url: string): void {
  const executable = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open"
  const child = spawn(executable, process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url],
    { detached: true, stdio: "ignore" })
  child.on("error", () => {}) // The UI/CLI always displays the URL as fallback.
  child.unref()
}

export interface CodexLogin {
  url: string
  instructions: string
  complete: Promise<CodexCredentials>
  cancel: () => void
}

/** PKCE + state, a loopback-only callback, and a bounded, cancellable lifetime. */
export async function startCodexBrowserLogin(options: {
  signal?: AbortSignal; port?: number; fetcher?: Fetch; timeoutMs?: number
} = {}): Promise<CodexLogin> {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 5 * 60_000),
    ...(options.signal ? [options.signal] : [])])
  signal.throwIfAborted()
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const state = randomBytes(32).toString("base64url")
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
  void code.catch(() => {})
  let accepted = false
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    response.setHeader("Cache-Control", "no-store")
    if (request.method !== "GET" || url.pathname !== "/auth/callback") { response.writeHead(404).end(); return }
    if (url.searchParams.get("state") !== state) { response.writeHead(400).end("Invalid OAuth state."); return }
    if (accepted) { response.writeHead(409).end("Callback already received."); return }
    if (url.searchParams.has("error")) {
      accepted = true
      rejectCode(new Error("Codex authorization was declined. Please try again."))
      response.writeHead(400).end("Authorization declined. Return to Zap.")
      return
    }
    const value = url.searchParams.get("code")
    if (!value) { response.writeHead(400).end("Missing authorization code."); return }
    accepted = true
    resolveCode(value)
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Authorization received. Return to Zap to finish signing in.")
  })
  const abort = () => { rejectCode(new DOMException("Codex login cancelled or timed out", "AbortError")); server.close() }
  signal.addEventListener("abort", abort, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once("error", onError)
      server.listen(options.port ?? 1455, "localhost", () => { server.off("error", onError); resolve() })
    })
    signal.throwIfAborted()
  } catch (error) {
    signal.removeEventListener("abort", abort); server.close()
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error("Codex login needs localhost:1455. Close the other login or use device code login.")
    throw error
  }
  const port = (server.address() as { port: number }).port
  const redirect = `http://localhost:${port}/auth/callback`
  const url = `${ISSUER}/oauth/authorize?${new URLSearchParams({
    response_type: "code", client_id: CODEX_CLIENT_ID, redirect_uri: redirect,
    scope: "openid profile email offline_access", code_challenge: challenge,
    code_challenge_method: "S256", state, id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true", originator: "zap",
  })}`
  const complete = code.then(value => tokenRequest({ grant_type: "authorization_code", code: value,
    redirect_uri: redirect, code_verifier: verifier }, signal, options.fetcher))
    .finally(() => { signal.removeEventListener("abort", abort); server.close() })
  void complete.catch(() => {})
  return { url, instructions: "Finish signing in with ChatGPT in your browser.", complete, cancel: () => controller.abort() }
}

export async function startCodexDeviceLogin(signal?: AbortSignal, options: { fetcher?: Fetch; timeoutMs?: number } = {}): Promise<CodexLogin> {
  const controller = new AbortController()
  const bounded = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 15 * 60_000), ...(signal ? [signal] : [])])
  const post = (path: string, body: unknown) => (options.fetcher ?? fetch)(`${ISSUER}${path}`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.any([bounded, AbortSignal.timeout(15_000)]), redirect: "error" })
  const response = await post("/api/accounts/deviceauth/usercode", { client_id: CODEX_CLIENT_ID })
  if (!response.ok) throw new Error(`Codex device login failed (HTTP ${response.status}).`)
  const data = await response.json() as { device_auth_id: string; user_code: string; interval: string }
  if (typeof data.device_auth_id !== "string" || !data.device_auth_id || typeof data.user_code !== "string" || !data.user_code) throw new Error("Invalid Codex device authorization response.")
  const interval = Math.max(1, Math.min(60, Number(data.interval) || 5)) * 1000 + 3000
  const complete = (async () => {
    for (;;) {
      await delay(interval, undefined, { signal: bounded })
      const result = await post("/api/accounts/deviceauth/token", { device_auth_id: data.device_auth_id, user_code: data.user_code })
      if (result.ok) {
        const tokens = await result.json() as { authorization_code: string; code_verifier: string }
        if (typeof tokens.authorization_code !== "string" || !tokens.authorization_code || typeof tokens.code_verifier !== "string" || !tokens.code_verifier) throw new Error("Invalid Codex device token response.")
        return tokenRequest({ grant_type: "authorization_code", code: tokens.authorization_code,
          code_verifier: tokens.code_verifier, redirect_uri: `${ISSUER}/deviceauth/callback` }, bounded, options.fetcher)
      }
      if (result.status !== 403 && result.status !== 404) throw new Error(`Codex device authorization failed (HTTP ${result.status}).`)
    }
  })()
  void complete.catch(() => {})
  return { url: `${ISSUER}/codex/device`, instructions: `Enter code: ${data.user_code}`, complete, cancel: () => controller.abort() }
}
