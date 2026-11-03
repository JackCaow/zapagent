import { afterEach, expect, it } from "bun:test"
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { CODEX_CLIENT_ID, getCodexCredentials, readCodexCredentials, saveCodexCredentials, startCodexBrowserLogin, startCodexDeviceLogin } from "../src/codex-auth.js"

const roots: string[] = []
const logins: Array<{ cancel: () => void }> = []
afterEach(() => {
  for (const login of logins.splice(0)) login.cancel()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const path = () => { const root = mkdtempSync(join(tmpdir(), "zap-codex-auth-")); roots.push(root); return join(root, "codex-oauth.json") }
const token = (value: object) => `header.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`

it("uses PKCE and state, ignores invalid callbacks, and exchanges only a matching callback", async () => {
  let body: URLSearchParams | undefined
  const login = await startCodexBrowserLogin({ port: 0, fetcher: (async (url, init) => {
    expect(String(url)).toBe("https://auth.openai.com/oauth/token")
    body = new URLSearchParams(String(init?.body))
    return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600,
      id_token: token({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } }) })
  }) as typeof fetch })
  logins.push(login)
  const authorize = new URL(login.url)
  expect(authorize.searchParams.get("client_id")).toBe(CODEX_CLIENT_ID)
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
  const callback = new URL(authorize.searchParams.get("redirect_uri")!)
  callback.searchParams.set("code", "one-time-code")
  callback.searchParams.set("state", "wrong")
  expect((await fetch(callback)).status).toBe(400)
  expect(body).toBeUndefined()
  callback.searchParams.set("state", authorize.searchParams.get("state")!)
  expect((await fetch(callback)).status).toBe(200)
  const credentials = await login.complete
  expect(credentials.accountId).toBe("acct-test")
  expect(credentials.accessToken).toBe("access")
  expect(body!.get("code")).toBe("one-time-code")
  expect(body!.get("redirect_uri")).toBe(authorize.searchParams.get("redirect_uri"))
  expect(createHash("sha256").update(body!.get("code_verifier")!).digest("base64url")).toBe(authorize.searchParams.get("code_challenge"))
})

it("cancels browser login and releases its callback listener", async () => {
  const login = await startCodexBrowserLogin({ port: 0 })
  logins.push(login)
  login.cancel()
  await expect(login.complete).rejects.toThrow("cancelled")
})

it("bounds browser login and handles denied authorization without echoing untrusted error text", async () => {
  const timeout = await startCodexBrowserLogin({ port: 0, timeoutMs: 30 })
  logins.push(timeout)
  await expect(timeout.complete).rejects.toThrow("timed out")
  const login = await startCodexBrowserLogin({ port: 0 })
  logins.push(login)
  const authorize = new URL(login.url)
  const callback = new URL(authorize.searchParams.get("redirect_uri")!)
  callback.searchParams.set("state", authorize.searchParams.get("state")!)
  callback.searchParams.set("error", "secret-should-not-leak")
  expect(await (await fetch(callback)).text()).not.toContain("secret-should-not-leak")
  await expect(login.complete).rejects.toThrow("declined")
})

it("stores tokens privately, reuses fresh tokens, and rotates one refresh across concurrent requests", async () => {
  const file = path()
  saveCodexCredentials({ accessToken: "old", refreshToken: "rotate-once", expiresAt: 0, accountId: "acct" }, file)
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600)
  let requests = 0
  const fetcher = (async (_url, init) => {
    requests++
    expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("rotate-once")
    await new Promise(resolve => setTimeout(resolve, 25))
    return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 })
  }) as typeof fetch
  const values = await Promise.all(Array.from({ length: 3 }, () => getCodexCredentials(undefined, { path: file, fetcher })))
  expect(requests).toBe(1)
  expect(values.every(value => value.accessToken === "new" && value.accountId === "acct")).toBe(true)
  expect(readCodexCredentials(file)?.refreshToken).toBe("rotated")
  expect(existsSync(`${file}.lock`)).toBe(false)
})

it("keeps credentials on refresh failure and never echoes the token endpoint body", async () => {
  const file = path()
  saveCodexCredentials({ accessToken: "old", refreshToken: "secret", expiresAt: 0 }, file)
  await expect(getCodexCredentials(undefined, { path: file,
    fetcher: (async () => new Response("secret", { status: 401 })) as typeof fetch })).rejects.toThrow("HTTP 401")
  expect(readCodexCredentials(file)?.refreshToken).toBe("secret")
  expect(existsSync(`${file}.lock`)).toBe(false)
})

it("does not restore credentials after logout during a refresh", async () => {
  const file = path()
  saveCodexCredentials({ accessToken: "old", refreshToken: "secret", expiresAt: 0 }, file)
  await expect(getCodexCredentials(undefined, { path: file, fetcher: (async () => {
    rmSync(file)
    return Response.json({ access_token: "new", refresh_token: "rotated" })
  }) as typeof fetch })).rejects.toThrow("login changed")
  expect(readCodexCredentials(file)).toBeNull()
})

it("reports corrupt credential files instead of treating them as API keys", async () => {
  const file = path()
  writeFileSync(file, "not json")
  expect(() => readCodexCredentials(file)).toThrow("Cannot read Codex credentials")
})

it("polls a pending device authorization and exchanges the authorized code", async () => {
  let polls = 0
  const login = await startCodexDeviceLogin(undefined, { fetcher: (async (url, init) => {
    if (String(url).endsWith("/usercode")) return Response.json({ device_auth_id: "device-id", user_code: "ABC-DEF", interval: "1" })
    if (String(url).endsWith("/deviceauth/token")) {
      expect(JSON.parse(String(init?.body))).toEqual({ device_auth_id: "device-id", user_code: "ABC-DEF" })
      polls++
      return polls === 1 ? new Response(null, { status: 403 }) : Response.json({ authorization_code: "approved", code_verifier: "device-verifier" })
    }
    const params = new URLSearchParams(String(init?.body))
    expect(params.get("code_verifier")).toBe("device-verifier")
    expect(params.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback")
    return Response.json({ access_token: "device-access", refresh_token: "device-refresh" })
  }) as typeof fetch })
  logins.push(login)
  expect(login.url).toBe("https://auth.openai.com/codex/device")
  expect(login.instructions).toContain("ABC-DEF")
  expect((await login.complete).accessToken).toBe("device-access")
  expect(polls).toBe(2)
}, 15_000)

it("cancels device polling without making a token request", async () => {
  let requests = 0
  const login = await startCodexDeviceLogin(undefined, { fetcher: (async () => {
    requests++
    return Response.json({ device_auth_id: "id", user_code: "ABC", interval: "1" })
  }) as typeof fetch })
  logins.push(login)
  login.cancel()
  await expect(login.complete).rejects.toThrow()
  expect(requests).toBe(1)
})
