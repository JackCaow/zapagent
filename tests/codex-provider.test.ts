import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { installCodexFixture } from "./fixtures/native-codex.js"
import { normalizeModelReasoning, modelReasoningFor } from "../zapsdk/core/reasoning-effort.js"
import { refreshModelsDevMetadata, applyMetadataRefresh } from "../src/provider-metadata.js"
import { associateModelMetadata } from "../src/provider-catalog.js"
import { codexConversationSpec } from "../src/agent/official-agents.js"
import { connectCodexProvider } from "../src/codex-provider.js"
import { conversationAgentId, getEffort, setEffort, setActive, cycleEffort, getEffortValuesForProvider, resolveEffortInput, getDefaultConfig, hasApiKey, loadAppConfig, saveAppConfig } from "../src/config.js"
import { discoverProviderModels, selectCatalogModel } from "../src/provider-catalog.js"

const initialPath = process.env.PATH
let root: string
let previous: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zap-codex-provider-"))
  installCodexFixture(root)
  process.env.PATH = root + (process.platform === "win32" ? ";" : ":") + initialPath
  previous = process.env.ZAPCODE_DATA_DIR
  process.env.ZAPCODE_DATA_DIR = root
})
afterEach(() => {
  process.env.PATH = initialPath
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

it("loads the native CLI catalog independent of the saved endpoint", async () => {
  const { provider } = connectCodexProvider(getDefaultConfig())
  provider.baseURL = "https://unused.invalid"
  writeFileSync(join(root, "models"), JSON.stringify({ models: [
    { slug: "backend-only", supported_in_api: false, context_window: 400000, input_modalities: ["image"] },
    { slug: "hidden", visibility: "hide" }] }))
  const result = await discoverProviderModels(provider, new AbortController().signal)
  expect(result.rows.map(row => row.id)).toEqual(["backend-only"])
  expect(result.rows[0].metadata).toMatchObject({ contextWindow: 400000, supportsVision: true })
  provider.models = ["saved"]
  writeFileSync(join(root, "offline"), "")
  expect((await discoverProviderModels(provider, new AbortController().signal)).rows.map(row => row.id)).toEqual(["saved"])
})

it("routes old subscriptions to Codex, persists the Claude choice and guards headless runs", () => {
  const { config, provider } = connectCodexProvider(getDefaultConfig())
  const selected = selectCatalogModel(config, provider.id, { id: "old-model", source: "manual" })
  selected.providers[0].baseURL = "https://unused.invalid"
  const file = join(root, "config.json")
  saveAppConfig(file, selected)
  const loaded = loadAppConfig(file)
  expect(conversationAgentId(loaded)).toBe("codex")
  expect(loaded.providers[0].baseURL).toBe("codex://local")
  saveAppConfig(file, { ...loaded, subscriptionAgent: "claude-code" })
  expect(conversationAgentId(loadAppConfig(file))).toBe("claude-code")
  const reselected = setActive(loadAppConfig(file), provider.id, "old-model")
  expect(conversationAgentId(reselected)).toBe("codex")
  saveAppConfig(file, reselected)
  const run = spawnSync(process.execPath, [resolve("src/index.tsx"), "--print", "test", "--no-devtools"], {
    encoding: "utf8", env: { ...process.env, ZAPCODE_DATA_DIR: root }, timeout: 15000,
  })
  expect(run.status).not.toBe(0)
  expect(run.stderr).toContain("codex exec")
})

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

it("refreshes native capabilities, retires missing levels, keeps offline data and rejects concurrent edits", async () => {
  const initial = effortConfig(), id = initial.active.providerId
  writeFileSync(join(root, "models"), JSON.stringify({ models: [{ slug: "full", supported_reasoning_levels: [{ effort: "low" }], default_reasoning_level: "low" }, { slug: "small" }] }))
  const refreshed = await refreshModelsDevMetadata(initial)
  expect(getEffortValuesForProvider(refreshed, id)).toEqual(["low"])
  expect(getEffort(refreshed, id)).toBeUndefined()
  expect(refreshed.providers[0].reasoningByModel?.small).toBeUndefined()
  const changed = setEffort(initial, id, "max")
  expect(applyMetadataRefresh(changed, initial, refreshed)).toBe(changed)
  const selected = setActive(initial, id, "small")
  expect(applyMetadataRefresh(selected, initial, refreshed).active.model).toBe("small")
  writeFileSync(join(root, "offline"), "")
  expect(await refreshModelsDevMetadata(initial)).toBe(initial)
})


it("persists exact model IDs even when they coincide with object prototype keys", () => {
  const connected = connectCodexProvider(getDefaultConfig())
  let config = connected.config
  for (const model of ["__proto__", "constructor", "toString"]) {
    config = selectCatalogModel(config, connected.provider.id, { id: model, source: "provider", reasoning: fullProfile })
    expect(Object.hasOwn(config.providers[0].reasoningByModel!, model)).toBe(true)
    expect(getEffortValuesForProvider(config, connected.provider.id)).toEqual(levels)
    config = setEffort(config, connected.provider.id, "ultra")
    expect(getEffort(config, connected.provider.id)).toBe("ultra")
  }
  const file = join(root, "prototype-models.json")
  saveAppConfig(file, config)
  const loaded = loadAppConfig(file)
  expect(Object.hasOwn(loaded.providers[0].reasoningByModel!, "__proto__")).toBe(true)
  expect(Object.hasOwn(loaded.providers[0].effortByModel!, "__proto__")).toBe(true)
})


it("applies Zap's sandbox to /agent codex with an API provider and preserves configured adapter arguments", async () => {
  const config = getDefaultConfig()
  const spec = { id: "codex", command: "configured-wrapper", args: ["--local"], model: "native-choice" }
  config.acpAgents = [spec]
  config.activeAgent = "codex"
  config.active.model = "unrelated-api-model"
  for (const mode of ["plan", "default", "acceptEdits"] as const) {
    expect(await codexConversationSpec({ ...config, permissionMode: mode }, spec)).toMatchObject({
      command: spec.command, args: spec.args, model: spec.model, requireSettings: true,
      mode: mode === "acceptEdits" ? "workspace-write" : "read-only",
    })
  }
})
