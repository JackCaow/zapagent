import { describe, it, expect } from "bun:test";
import {
  getEffort,
  setEffort,
  cycleEffort,
  getEffortValuesForProvider,
  hasDeclaredEffortValues,
  resolveEffortInput,
  DEFAULT_EFFORT_VALUES,
  type AppConfig,
  type Provider,
} from "../src/config.js";

function makeConfig(p: Partial<Provider>): AppConfig {
  const provider: Provider = {
    id: "sp_test",
    name: "Test",
    baseURL: "https://x/v1",
    apiKey: "x",
    contextWindow: 128000,
    models: ["m1"],
    ...p,
  };
  return {
    providers: [provider],
    active: { providerId: "sp_test", model: "m1" },
    serperKey: "",
    maxTokens: 4096,
    maxSteps: 10,
    customSystemPrompt: "",
    compaction: { auto: true, prune: true, reserved: 0 },
    mcpServers: [],
    permissionMode: "default",
  };
}

describe("reasoning effort helpers", () => {
  it("getEffort reads from extraRequestParams.reasoning_effort", () => {
    const cfg = makeConfig({ extraRequestParams: { reasoning_effort: "high" } });
    expect(getEffort(cfg, "sp_test")).toBe("high");
  });

  it("getEffort returns undefined when unset", () => {
    expect(getEffort(makeConfig({}), "sp_test")).toBeUndefined();
    expect(getEffort(makeConfig({ extraRequestParams: {} }), "sp_test")).toBeUndefined();
  });

  it("setEffort writes the value into extraRequestParams, preserving other keys", () => {
    const cfg = makeConfig({ extraRequestParams: { thinking: { type: "enabled" } } });
    const next = setEffort(cfg, "sp_test", "max");
    expect(next.providers[0].extraRequestParams).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
  });

  it("setEffort(null) removes the key while keeping others", () => {
    const cfg = makeConfig({ extraRequestParams: { thinking: { type: "enabled" }, reasoning_effort: "high" } });
    const next = setEffort(cfg, "sp_test", null);
    expect(next.providers[0].extraRequestParams).toEqual({ thinking: { type: "enabled" } });
  });

  it("getEffortValuesForProvider returns preset values when sourcePresetId matches", () => {
    const cfg = makeConfig({ sourcePresetId: "deepseek" });
    expect(getEffortValuesForProvider(cfg, "sp_test")).toEqual(["high", "max"]);
  });

  it("getEffortValuesForProvider falls back to DEFAULT_EFFORT_VALUES for unknown / missing preset", () => {
    expect(getEffortValuesForProvider(makeConfig({}), "sp_test")).toEqual([...DEFAULT_EFFORT_VALUES]);
    expect(getEffortValuesForProvider(makeConfig({ sourcePresetId: "unknown_xxx" }), "sp_test")).toEqual([...DEFAULT_EFFORT_VALUES]);
  });

  it("getEffortValuesForProvider returns [] for providers with no reasoning (Anthropic, Ollama)", () => {
    expect(getEffortValuesForProvider(makeConfig({ sourcePresetId: "anthropic" }), "sp_test")).toEqual([]);
    expect(getEffortValuesForProvider(makeConfig({ sourcePresetId: "ollama" }), "sp_test")).toEqual([]);
  });

  it("cycleEffort advances off → first → ... → last → off for DeepSeek", () => {
    let cfg = makeConfig({ sourcePresetId: "deepseek" });
    // off → high
    let next = cycleEffort(cfg, "sp_test");
    expect(next).toBe("high");
    cfg = setEffort(cfg, "sp_test", next);

    // high → max
    next = cycleEffort(cfg, "sp_test");
    expect(next).toBe("max");
    cfg = setEffort(cfg, "sp_test", next);

    // max → off (null)
    next = cycleEffort(cfg, "sp_test");
    expect(next).toBeNull();
    cfg = setEffort(cfg, "sp_test", next);
    expect(getEffort(cfg, "sp_test")).toBeUndefined();
  });

  it("cycleEffort returns null for providers without reasoning mode", () => {
    expect(cycleEffort(makeConfig({ sourcePresetId: "anthropic" }), "sp_test")).toBeNull();
    expect(cycleEffort(makeConfig({ sourcePresetId: "ollama" }), "sp_test")).toBeNull();
  });

  it("cycleEffort handles unknown current value by resetting to off", () => {
    const cfg = makeConfig({ sourcePresetId: "deepseek", extraRequestParams: { reasoning_effort: "some_garbage" } });
    // Unknown value → cycle to off (null)
    expect(cycleEffort(cfg, "sp_test")).toBeNull();
  });

  it("hasDeclaredEffortValues distinguishes preset-declared vs fallback", () => {
    // Declared presets
    expect(hasDeclaredEffortValues(makeConfig({ sourcePresetId: "deepseek" }), "sp_test")).toBe(true);
    expect(hasDeclaredEffortValues(makeConfig({ sourcePresetId: "openai" }), "sp_test")).toBe(true);
    expect(hasDeclaredEffortValues(makeConfig({ sourcePresetId: "anthropic" }), "sp_test")).toBe(true); // []
    expect(hasDeclaredEffortValues(makeConfig({ sourcePresetId: "ollama" }), "sp_test")).toBe(true);   // []
    // Not declared — sourcePresetId missing (custom / sub2api / direct baseURL)
    expect(hasDeclaredEffortValues(makeConfig({}), "sp_test")).toBe(false);
    // Preset exists but declared no effortValues → treated as non-strict
    expect(hasDeclaredEffortValues(makeConfig({ sourcePresetId: "moonshot" }), "sp_test")).toBe(false);
  });
});

describe("/effort command parsing", () => {
  const { parseCommand } = require("../src/commands.js");

  it("bare /effort returns set_effort with empty value (inspection mode)", () => {
    expect(parseCommand("/effort")).toEqual({ type: "set_effort", value: "" });
  });

  it("/effort <value> captures the arg", () => {
    expect(parseCommand("/effort high")).toEqual({ type: "set_effort", value: "high" });
    expect(parseCommand("/effort max")).toEqual({ type: "set_effort", value: "max" });
    expect(parseCommand("/effort cycle")).toEqual({ type: "set_effort", value: "cycle" });
    expect(parseCommand("/effort off")).toEqual({ type: "set_effort", value: "off" });
  });
});

describe("resolveEffortInput", () => {
  it("accepts declared values case-insensitively and returns the canonical form", () => {
    const cfg = makeConfig({ name: "DeepSeek", sourcePresetId: "deepseek" });
    expect(resolveEffortInput(cfg, "sp_test", "max")).toEqual({ ok: true, value: "max" });
    expect(resolveEffortInput(cfg, "sp_test", "  HIGH ")).toEqual({ ok: true, value: "high" });
  });

  it("rejects a typo for a preset that declares its values and lists the valid ones", () => {
    const cfg = makeConfig({ name: "DeepSeek", sourcePresetId: "deepseek" });
    const result = resolveEffortInput(cfg, "sp_test", "hihg");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Unknown effort "hihg"');
      expect(result.message).toContain("off, high, max");
    }
  });

  it("rejects any value for a preset with no reasoning mode", () => {
    const cfg = makeConfig({ name: "Ollama", sourcePresetId: "ollama" });
    const result = resolveEffortInput(cfg, "sp_test", "high");
    expect(result).toEqual({ ok: false, message: "Ollama has no reasoning effort setting" });
  });

  it("passes any value through for providers with no declared values", () => {
    expect(resolveEffortInput(makeConfig({}), "sp_test", "ultra")).toEqual({ ok: true, value: "ultra" });
    expect(resolveEffortInput(makeConfig({ sourcePresetId: "moonshot" }), "sp_test", "whatever")).toEqual({ ok: true, value: "whatever" });
  });
});
