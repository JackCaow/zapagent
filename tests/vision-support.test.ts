import { describe, it, expect } from "bun:test";
import {
  inferVisionSupport,
  resolveVisionSupport,
  setVisionSupport,
  getActiveContextWindow,
  getActiveMaxOutputTokens,
  type AppConfig,
  type Provider,
} from "../src/config.js";

function makeProvider(p: Partial<Provider> = {}): Provider {
  return {
    id: "sp_test",
    name: "Test",
    baseURL: "https://x/v1",
    apiKey: "x",
    contextWindow: 128000,
    models: ["m1"],
    ...p,
  };
}

function makeConfig(p: Provider): AppConfig {
  return {
    providers: [p],
    active: { providerId: p.id, model: p.models[0] ?? "" },
    serperKey: "",
    maxTokens: 4096,
    maxSteps: 10,
    customSystemPrompt: "",
    compaction: { auto: true, prune: true, reserved: 0 },
    mcpServers: [],
    permissionMode: "default",
  };
}

describe("inferVisionSupport heuristic", () => {
  it("recognizes mainstream vision-capable models", () => {
    expect(inferVisionSupport("gpt-4o")).toBe(true);
    expect(inferVisionSupport("gpt-4o-mini")).toBe(true);
    expect(inferVisionSupport("gpt-5")).toBe(true);
    expect(inferVisionSupport("claude-opus-4-7")).toBe(true);
    expect(inferVisionSupport("claude-sonnet-4-6")).toBe(true);
    expect(inferVisionSupport("claude-haiku-4-5")).toBe(true);
    expect(inferVisionSupport("gemini-2.5-pro")).toBe(true);
    expect(inferVisionSupport("gemini-3.1-pro-preview")).toBe(true);
    expect(inferVisionSupport("pixtral-12b")).toBe(true);
    expect(inferVisionSupport("qwen2.5-vl-7b-instruct")).toBe(true);
    expect(inferVisionSupport("deepseek-vl2")).toBe(true);
    expect(inferVisionSupport("llava-1.6")).toBe(true);
  });

  it("leaves unrecognized model names unknown", () => {
    expect(inferVisionSupport("deepseek-v4-pro")).toBeUndefined();
    expect(inferVisionSupport("deepseek-v4-flash")).toBeUndefined();
    expect(inferVisionSupport("deepseek-chat")).toBeUndefined();
    expect(inferVisionSupport("kimi-k2.6-thinking")).toBeUndefined();
    expect(inferVisionSupport("glm-4.6")).toBeUndefined();
    expect(inferVisionSupport("qwen3-coder-plus")).toBeUndefined();
    expect(inferVisionSupport("MiniMax-M2.7")).toBeUndefined();
  });

  it("leaves unknown / empty model ids unknown", () => {
    expect(inferVisionSupport("")).toBeUndefined();
    expect(inferVisionSupport("some-random-self-host")).toBeUndefined();
  });
});

describe("resolveVisionSupport precedence", () => {
  it("returns the heuristic result when no per-model override", () => {
    const p = makeProvider({ models: ["gpt-4o"] });
    expect(resolveVisionSupport(p, "gpt-4o")).toBe(true);
    expect(resolveVisionSupport(p, "deepseek-v4-pro")).toBeUndefined();
  });

  it("explicit visionByModel override wins over heuristic", () => {
    const p = makeProvider({
      models: ["gpt-4o", "deepseek-v4-pro"],
      visionByModel: { "gpt-4o": false, "deepseek-v4-pro": true },
    });
    expect(resolveVisionSupport(p, "gpt-4o")).toBe(false);
    expect(resolveVisionSupport(p, "deepseek-v4-pro")).toBe(true);
  });

  it("uses models.dev metadata before the model-id heuristic", () => {
    const p = makeProvider({
      models: ["unknown-multimodal", "gpt-4o"],
      modelMetadata: {
        "unknown-multimodal": { supportsVision: true, source: "models.dev" },
        "gpt-4o": { supportsVision: false, source: "models.dev" },
      },
    });
    expect(resolveVisionSupport(p, "unknown-multimodal")).toBe(true);
    expect(resolveVisionSupport(p, "gpt-4o")).toBe(false);
  });

  it("falls back to heuristic when provider is null", () => {
    expect(resolveVisionSupport(null, "gpt-4o")).toBe(true);
    expect(resolveVisionSupport(undefined, "deepseek-v4-pro")).toBeUndefined();
  });
});

describe("models.dev token limits", () => {
  it("uses the active model context and caps configured output tokens", () => {
    const p = makeProvider({
      models: ["m1"],
      contextWindow: 128000,
      contextWindowMode: "auto",
      modelMetadata: {
        m1: { contextWindow: 400000, outputLimit: 8192, source: "models.dev" },
      },
    });
    const cfg = { ...makeConfig(p), maxTokens: 65536 };
    expect(getActiveContextWindow(cfg)).toBe(400000);
    expect(getActiveMaxOutputTokens(cfg)).toBe(8192);
  });

  it("falls back to provider and user limits when metadata is absent", () => {
    const p = makeProvider({ contextWindow: 200000 });
    const cfg = { ...makeConfig(p), maxTokens: 32768 };
    expect(getActiveContextWindow(cfg)).toBe(200000);
    expect(getActiveMaxOutputTokens(cfg)).toBe(32768);
  });
});

describe("setVisionSupport persistence", () => {
  it("writes a per-model entry under the named provider", () => {
    const p = makeProvider({ models: ["deepseek-v4-pro"] });
    const cfg = makeConfig(p);
    const next = setVisionSupport(cfg, p.id, "deepseek-v4-pro", false);
    const writtenProvider = next.providers.find((x) => x.id === p.id)!;
    expect(writtenProvider.visionByModel?.["deepseek-v4-pro"]).toBe(false);
    // Original config object is untouched (purity).
    expect(p.visionByModel).toBeUndefined();
  });

  it("preserves other providers and keeps active binding stable", () => {
    const p1 = makeProvider({ id: "sp_a", models: ["a1"] });
    const p2 = makeProvider({ id: "sp_b", models: ["b1"] });
    const cfg: AppConfig = {
      ...makeConfig(p1),
      providers: [p1, p2],
    };
    const next = setVisionSupport(cfg, "sp_b", "b1", false);
    expect(next.providers.find((x) => x.id === "sp_a")?.visionByModel).toBeUndefined();
    expect(next.providers.find((x) => x.id === "sp_b")?.visionByModel?.["b1"]).toBe(false);
    expect(next.active.providerId).toBe("sp_a");
  });
});
