import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { listModels } from "../../core/list-models.js"

// Capture which URLs listModels probes, in order. We replace global fetch
// with a stub that records the URL and returns a configurable status.
function withFetch(handler: (url: string) => { status: number; body?: unknown }) {
  const calls: string[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.url
    calls.push(url)
    const { status, body } = handler(url)
    return new Response(typeof body === "string" ? body : JSON.stringify(body ?? {}), { status })
  }) as any
  return {
    calls,
    restore: () => { globalThis.fetch = orig },
  }
}

describe("listModels — probe order", () => {
  let restore: () => void = () => {}
  afterEach(() => restore())

  it("uses only Bearer authentication for Responses model discovery", async () => {
    const original = globalThis.fetch
    restore = () => { globalThis.fetch = original }
    let headers: Headers | undefined
    globalThis.fetch = (async (_input: unknown, options: RequestInit) => {
      headers = new Headers(options.headers)
      return Response.json({ data: [{ id: "fixture" }] })
    }) as typeof fetch
    expect(await listModels("https://fixture.invalid/v1", "fixture", 1000, undefined, "openai-responses")).toEqual(["fixture"])
    expect(headers!.get("Authorization")).toBe("Bearer fixture")
    expect(headers!.has("x-api-key")).toBe(false)
    expect(headers!.has("anthropic-version")).toBe(false)
  })

  it("sends no credentials to a keyless endpoint", async () => {
    const original = globalThis.fetch
    restore = () => { globalThis.fetch = original }
    let headers: Headers | undefined
    globalThis.fetch = (async (_input: unknown, options: RequestInit) => {
      headers = new Headers(options.headers)
      return Response.json({ data: [{ id: "local" }] })
    }) as typeof fetch
    expect(await listModels("http://localhost:11434/v1", "")).toEqual(["local"])
    expect(headers!.has("Authorization")).toBe(false)
    expect(headers!.has("x-api-key")).toBe(false)
  })

  it("does not start a probe after caller cancellation", async () => {
    const f = withFetch(() => ({ status: 404 }))
    restore = f.restore
    const controller = new AbortController()
    controller.abort()
    await expect(listModels("https://example.com/v1", "key", 1000, controller.signal)).rejects.toThrow()
    expect(f.calls).toEqual([])
  })

  it("for root baseURL tries /models AND /v1/models when first 404s", async () => {
    const f = withFetch((url) => {
      if (url.endsWith("/v1/models")) return { status: 200, body: { data: [{ id: "claude-x" }] } }
      return { status: 404 }
    })
    restore = f.restore
    const ids = await listModels("https://www.bac.com", "k", 1000)
    expect(ids).toEqual(["claude-x"])
    expect(f.calls).toContain("https://www.bac.com/models")
    expect(f.calls).toContain("https://www.bac.com/v1/models")
  })

  it("for /v1 baseURL tries /v1/models first, then walks up", async () => {
    const f = withFetch((url) => {
      if (url === "https://www.bac.com/v1/models") return { status: 200, body: { data: [{ id: "ok" }] } }
      return { status: 404 }
    })
    restore = f.restore
    const ids = await listModels("https://www.bac.com/v1", "k", 1000)
    expect(ids).toEqual(["ok"])
    expect(f.calls[0]).toBe("https://www.bac.com/v1/models")
  })

  it("does not fan out /v1/v1/models when prefix already ends in /v1", async () => {
    const f = withFetch(() => ({ status: 404 }))
    restore = f.restore
    await listModels("https://www.bac.com/v1", "k", 1000).catch(() => {})
    expect(f.calls).not.toContain("https://www.bac.com/v1/v1/models")
  })

  it("stops on 401 (auth real), does not keep walking", async () => {
    const f = withFetch(() => ({ status: 401, body: "bad key" }))
    restore = f.restore
    await expect(listModels("https://www.bac.com", "k", 1000)).rejects.toThrow(/HTTP 401/)
    expect(f.calls.length).toBe(1)
  })

  it("falls through 200-OK SPA HTML and finds the real /v1/models", async () => {
    // Sub2API-style gateway: /models returns the frontend SPA (200 + HTML),
    // /v1/models returns the actual JSON list. The old code threw "Failed to
    // parse JSON" on the first 200 and never reached /v1/models.
    const f = withFetch((url) => {
      if (url === "https://gw.example.com/models") return { status: 200, body: "<!doctype html><html>...</html>" }
      if (url === "https://gw.example.com/v1/models") return { status: 200, body: { data: [{ id: "claude-opus-4.7" }] } }
      return { status: 404 }
    })
    restore = f.restore
    const ids = await listModels("https://gw.example.com", "k", 1000)
    expect(ids).toEqual(["claude-opus-4.7"])
    expect(f.calls).toContain("https://gw.example.com/models")
    expect(f.calls).toContain("https://gw.example.com/v1/models")
  })

  it("falls through 200-OK with empty data and keeps walking", async () => {
    const f = withFetch((url) => {
      if (url === "https://gw.example.com/models") return { status: 200, body: { data: [] } }
      if (url === "https://gw.example.com/v1/models") return { status: 200, body: { data: [{ id: "m" }] } }
      return { status: 404 }
    })
    restore = f.restore
    const ids = await listModels("https://gw.example.com", "k", 1000)
    expect(ids).toEqual(["m"])
  })

  it("walks up nested paths and tries /v1/models at root too", async () => {
    const f = withFetch((url) => {
      if (url === "https://api.example.com/v1/models") return { status: 200, body: { data: [{ id: "m" }] } }
      return { status: 404 }
    })
    restore = f.restore
    const ids = await listModels("https://api.example.com/anthropic", "k", 1000)
    expect(ids).toEqual(["m"])
    expect(f.calls).toContain("https://api.example.com/anthropic/models")
    expect(f.calls).toContain("https://api.example.com/v1/models")
  })
})

describe("listModels — auth fallback for Anthropic-compatible gateways", () => {
  let restore: () => void = () => {}
  afterEach(() => restore())

  function gateway(opts: { bearerRequiredAt: string }) {
    const seen: Array<{ url: string; bearer: boolean; apiKey: boolean }> = []
    const original = globalThis.fetch
    restore = () => { globalThis.fetch = original }
    globalThis.fetch = (async (input: unknown, options: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url
      const headers = new Headers(options.headers)
      seen.push({ url, bearer: headers.has("Authorization"), apiKey: headers.has("x-api-key") })
      if (url === `${opts.bearerRequiredAt}/models`) {
        return headers.has("Authorization")
          ? Response.json({ data: [{ id: "deepseek-chat" }] })
          : new Response("unauthorized", { status: 401 })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch
    return seen
  }

  it("retries the parent /models with Bearer after a 401 (DeepSeek /anthropic)", async () => {
    const seen = gateway({ bearerRequiredAt: "https://api.deepseek.com" })
    expect(await listModels("https://api.deepseek.com/anthropic", "key", 1000, undefined, "anthropic")).toEqual(["deepseek-chat"])
    const first = seen[0]!
    expect(first.url).toBe("https://api.deepseek.com/anthropic/models")
    expect(first.bearer).toBe(false)           // Anthropic-native auth first
    expect(first.apiKey).toBe(true)
    const rootAttempts = seen.filter(call => call.url === "https://api.deepseek.com/models")
    expect(rootAttempts.map(call => call.bearer)).toEqual([false, true])
  })

  it("does not send Bearer when the endpoint accepts x-api-key", async () => {
    const seen: boolean[] = []
    const original = globalThis.fetch
    restore = () => { globalThis.fetch = original }
    globalThis.fetch = (async (_input: unknown, options: RequestInit) => {
      seen.push(new Headers(options.headers).has("Authorization"))
      return Response.json({ data: [{ id: "claude-x" }] })
    }) as typeof fetch
    await listModels("https://api.anthropic.com/v1", "key", 1000, undefined, "anthropic")
    expect(seen).toEqual([false])
  })

  it("does not repeat a 401 for the OpenAI protocol or for a keyless endpoint", async () => {
    let calls = 0
    const original = globalThis.fetch
    restore = () => { globalThis.fetch = original }
    globalThis.fetch = (async () => { calls++; return new Response("no", { status: 401 }) }) as typeof fetch
    await expect(listModels("https://x.example/v1", "key", 1000, undefined, "openai")).rejects.toThrow("401")
    expect(calls).toBe(1)
    calls = 0
    await expect(listModels("https://x.example/anthropic", "", 1000, undefined, "anthropic")).rejects.toThrow("401")
    expect(calls).toBe(1)
  })

  it("stops after a second 401 on the same URL instead of walking to the parent", async () => {
    const urls: string[] = []
    const original = globalThis.fetch
    restore = () => { globalThis.fetch = original }
    globalThis.fetch = (async (input: unknown) => {
      urls.push(typeof input === "string" ? input : (input as Request).url)
      return new Response("bad key", { status: 401 })
    }) as typeof fetch
    await expect(listModels("https://gw.example/anthropic", "key", 1000, undefined, "anthropic")).rejects.toThrow("401")
    expect(urls).toEqual(["https://gw.example/anthropic/models", "https://gw.example/anthropic/models"])
  })

  it("does not retry once the caller has aborted after a 401", async () => {
    const controller = new AbortController()
    let calls = 0
    const original = globalThis.fetch
    restore = () => { globalThis.fetch = original }
    globalThis.fetch = (async () => {
      calls++
      controller.abort()
      return new Response("no", { status: 401 })
    }) as typeof fetch
    await expect(listModels("https://gw.example/anthropic", "key", 1000, controller.signal, "anthropic")).rejects.toThrow()
    expect(calls).toBe(1)
  })
})
