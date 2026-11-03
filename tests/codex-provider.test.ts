import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { CODEX_BASE_URL, saveCodexCredentials } from "../src/codex-auth.js"
import { normalizeModelReasoning, modelReasoningFor } from "../zapsdk/core/reasoning-effort.js"
import { refreshModelsDevMetadata, applyMetadataRefresh } from "../src/provider-metadata.js"
import { associateModelMetadata } from "../src/provider-catalog.js"
import { connectCodexProvider } from "../src/codex-provider.js"
import { getEffort, setEffort, setActive, cycleEffort, getEffortValuesForProvider, resolveEffortInput, getDefaultConfig, hasApiKey, loadAppConfig, saveAppConfig } from "../src/config.js"
import { discoverProviderModels, selectCatalogModel } from "../src/provider-catalog.js"

const originalFetch = globalThis.fetch
let root: string
let previous: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-codex-provider-"))
  previous = process.env.ZAPCODE_DATA_DIR
  process.env.ZAPCODE_DATA_DIR = root
})
afterEach(() => {
  globalThis.fetch = originalFetch
  if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR
  else process.env.ZAPCODE_DATA_DIR = previous
  rmSync(root, { recursive: true, force: true })
})

it("persists an OAuth connection without secrets and keeps it stable after reauthentication", () => {
  const connected = connectCodexProvider(getDefaultConfig())
  const selected = selectCatalogModel(connected.config, connected.provider.id, { id: "account-model", source: "manual" })
  const file = join(root, "config.json")
  saveAppConfig(file, selected)
  const loaded = loadAppConfig(file)
  expect(loaded.providers[0].authMode).toBe("codex-oauth")
  expect(loaded.providers[0].apiKey).toBe("")
  expect(hasApiKey(loaded)).toBe(true)
  const again = connectCodexProvider(loaded)
  expect(again.config.providers).toHaveLength(1)
  expect(again.config.active).toEqual(loaded.active)
  expect(again.provider.models).toEqual(["account-model"])
})

it("discovers from the pinned Codex endpoint with OAuth, includes backend-only models, and preserves selection", async () => {
  await saveCodexCredentials({ accessToken: "secret-access", refreshToken: "secret-refresh", expiresAt: Date.now() + 3600_000, accountId: "account" })
  const { config, provider } = connectCodexProvider(getDefaultConfig())
  provider.baseURL = "https://untrusted.invalid/v1"
  let requests = 0
  globalThis.fetch = (async (url, init) => {
    requests++
    expect(String(url).startsWith(`${CODEX_BASE_URL}/models?client_version=`)).toBe(true)
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret-access")
    expect(new Headers(init?.headers).get("ChatGPT-Account-ID")).toBe("account")
    return Response.json({ models: [{ slug: "backend-only", supported_in_api: false, visibility: "list", context_window: 400000, input_modalities: ["text", "image"] },
      { slug: "hidden-model", visibility: "hide" }] })
  }) as typeof fetch
  const result = await discoverProviderModels(provider, new AbortController().signal)
  expect(requests).toBe(1)
  expect(result.rows.map(row => row.id)).toEqual(["backend-only"])
  expect(result.rows[0].metadata).toMatchObject({ contextWindow: 400000, supportsVision: true })
  expect(config.active.model).toBe("")
  expect(provider.models).toEqual([])
  expect(JSON.stringify(config)).not.toContain("secret-access")
})

it("retains saved models and gives an actionable error when signed out", async () => {
  const { provider } = connectCodexProvider(getDefaultConfig())
  provider.models = ["saved-model"]
  const result = await discoverProviderModels(provider, new AbortController().signal)
  expect(result.rows.map(row => row.id)).toEqual(["saved-model"])
  expect(result.error).toContain("signed out")
})

it("routes auth status/logout before headless prompt handling and never prints credentials", async () => {
  await saveCodexCredentials({ accessToken: "secret-access", refreshToken: "secret-refresh", expiresAt: Date.now() + 3600_000 })
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve("src/index.tsx"), "auth", ...args], {
    encoding: "utf8", env: { ...process.env, ZAPCODE_DATA_DIR: root },
  })
  const status = cli("status", "codex")
  expect(status.status).toBe(0)
  expect(status.stdout).toContain("signed in")
  expect(status.stdout + status.stderr).not.toContain("secret-")
  expect(cli("login", "codex", "--invalid").status).toBe(2)
  expect(cli("logout", "codex").status).toBe(0)
  expect(cli("status", "codex").status).toBe(1)
})

it("runs the real headless host through the Codex OAuth Responses adapter", async () => {
  await saveCodexCredentials({ accessToken: "fixture-oauth", refreshToken: "fixture-refresh", expiresAt: Date.now() + 3600_000 })
  const connected = connectCodexProvider(getDefaultConfig())
  const config = selectCatalogModel(connected.config, connected.provider.id, { id: "account-model", source: "manual" })
  saveAppConfig(join(root, "config.json"), config)
  const preload = join(root, "fixture-preload.ts")
  writeFileSync(preload, `
    globalThis.fetch = async (url, init) => {
      if (String(url) !== "https://chatgpt.com/backend-api/codex/responses") throw new Error("Unexpected network request");
      if (new Headers(init.headers).get("authorization") !== "Bearer fixture-oauth") throw new Error("Missing OAuth credential");
      const body = JSON.parse(String(init.body));
      if (body.model !== "account-model" || body.store !== false || !Array.isArray(body.tools)) throw new Error("Invalid Codex request");
      const events = [
        { type: "response.output_text.delta", delta: "Codex host integration verified." },
        { type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", phase: "final_answer",
          content: [{ type: "output_text", text: "Codex host integration verified." }] }], usage: { input_tokens: 20, output_tokens: 5 } } },
      ];
      return new Response(events.map(event => "data: " + JSON.stringify(event) + "\\n\\n").join(""), { headers: { "Content-Type": "text/event-stream" } });
    };
  `)
  const result = spawnSync(process.execPath, ["--preload", preload, resolve("src/index.tsx"),
    "--print", "Say hello", "--output-format", "stream-json", "--max-turns", "1", "--no-devtools"], {
    encoding: "utf8", cwd: root, timeout: 20_000,
    env: { ...process.env, ZAPCODE_DATA_DIR: root, ZAPCODE_EXECUTION: "local", ZAPCODE_DEVTOOLS_PORT: "" },
  })
  if (result.status !== 0) throw new Error(result.stdout + result.stderr)
  expect(result.stdout).toContain("Codex host integration verified.")
  expect(result.stdout + result.stderr).not.toContain("fixture-oauth")
}, 30_000)

const levels = ["low", "medium", "high", "xhigh", "max", "ultra"]
const fullProfile = { levels: levels.map(effort => ({ effort, description: `${effort} description` })), defaultEffort: "low" }

it("normalizes advertised levels, future values and explicit empty capabilities", () => {
  expect(normalizeModelReasoning(undefined)).toBeUndefined()
  expect(normalizeModelReasoning([{ effort: "low" }, {}])).toBeUndefined()
  expect(normalizeModelReasoning([])).toEqual({ levels: [] })
  expect(normalizeModelReasoning([{ effort: "future_v2", description: "hi\n\x1bbye" }, { effort: "FUTURE_V2" }], "FUTURE_V2"))
    .toEqual({ levels: [{ effort: "future_v2", description: "hi  bye" }], defaultEffort: "future_v2" })
  expect(modelReasoningFor({}, "__proto__")).toBeUndefined()
  expect(normalizeModelReasoning([{ effort: "low" }], "high")?.defaultEffort).toBeUndefined()
})

function effortConfig() {
  const connected = connectCodexProvider(getDefaultConfig())
  let config = selectCatalogModel(connected.config, connected.provider.id, { id: "full", source: "provider", reasoning: fullProfile })
  config = selectCatalogModel(config, connected.provider.id, { id: "small", source: "provider", reasoning: { levels: [{ effort: "low" }] } })
  config.providers[0].extraRequestParams = { reasoning_effort: "high", reasoning: { summary: "auto", effort: "max" } }
  return setActive(config, connected.provider.id, "full")
}

it("uses exact model levels, preserves preferences across switches, persists default independently of legacy overrides", () => {
  let config = effortConfig()
  const id = config.active.providerId
  expect(getEffortValuesForProvider(config, id)).toEqual(levels)
  expect(resolveEffortInput(config, id, "ULTRA")).toEqual({ ok: true, value: "ultra" })
  expect(resolveEffortInput(config, id, "minimal").ok).toBe(false)
  expect(getEffort(config, id)).toBe("high")
  config = setEffort(config, id, "ultra")
  expect(cycleEffort(config, id)).toBeNull()
  config = setActive(config, id, "small")
  expect(getEffortValuesForProvider(config, id)).toEqual(["low"])
  expect(getEffort(config, id)).toBeUndefined()
  expect(resolveEffortInput(config, id, "ultra").ok).toBe(false)
  config = setEffort(config, id, "low")
  config = setActive(config, id, "full")
  expect(getEffort(config, id)).toBe("ultra")
  config = setEffort(config, id, null)
  const file = join(root, "effort-config.json")
  saveAppConfig(file, config)
  config = loadAppConfig(file)
  expect(config.providers[0].reasoningByModel?.full).toEqual(fullProfile)
  expect(config.providers[0].effortByModel).toEqual({ full: null, small: "low" })
  expect(getEffort(config, id)).toBeUndefined()
  expect(config.providers[0].extraRequestParams?.reasoning_effort).toBe("high")
  config.providers[0].extraRequestParams!.model = "small"
  expect(getEffort(config, id)).toBe("low")
  expect(getEffortValuesForProvider(config, id)).toEqual(["low"])
})

it("separates authoritative capabilities from public metadata associations and handles missing snapshots", () => {
  const config = effortConfig(), id = config.active.providerId
  const linked = associateModelMetadata(config, id, "full", { source: "models.dev", catalogRef: { providerId: "x", modelId: "y" }, reasoning: false })
  expect(linked.providers[0].reasoningByModel?.full).toEqual(fullProfile)
  const saved = selectCatalogModel(config, id, { id: "full", source: "saved" })
  expect(saved.providers[0].reasoningByModel?.full).toEqual(fullProfile)
  const absent = selectCatalogModel(config, id, { id: "full", source: "provider" })
  expect(absent.providers[0].reasoningByModel?.full).toBeUndefined()
  expect(getEffortValuesForProvider(absent, id)).toEqual([])
  expect(resolveEffortInput(absent, id, "future").ok).toBe(true)
  const empty = selectCatalogModel(config, id, { id: "full", source: "provider", reasoning: { levels: [] } })
  expect(getEffort(empty, id)).toBeUndefined()
  expect(resolveEffortInput(empty, id, "high").ok).toBe(false)
})

it("refreshes authenticated capabilities, retires missing levels, keeps offline data and rejects concurrent edits", async () => {
  await saveCodexCredentials({ accessToken: "fixture", refreshToken: "fixture", expiresAt: Date.now() + 3600000 })
  const initial = effortConfig(), id = initial.active.providerId
  globalThis.fetch = (async () => Response.json({ models: [{ slug: "full", supported_reasoning_levels: [{ effort: "low" }], default_reasoning_level: "low" }, { slug: "small" }] })) as typeof fetch
  const refreshed = await refreshModelsDevMetadata(initial)
  expect(getEffortValuesForProvider(refreshed, id)).toEqual(["low"])
  expect(getEffort(refreshed, id)).toBeUndefined()
  expect(refreshed.providers[0].reasoningByModel?.small).toBeUndefined()
  const changed = setEffort(initial, id, "max")
  expect(applyMetadataRefresh(changed, initial, refreshed)).toBe(changed)
  const selected = setActive(initial, id, "small")
  expect(applyMetadataRefresh(selected, initial, refreshed).active.model).toBe("small")
  globalThis.fetch = (async () => { throw new Error("offline") }) as typeof fetch
  expect(await refreshModelsDevMetadata(initial)).toBe(initial)
})
