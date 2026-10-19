import { describe, expect, it } from "bun:test";
import { deepseekImageTokens, estimateImageTokens, resolveImageTokenRule } from "../../context/image-tokens.js";
import { TokenCounter } from "../../context/token-counter.js";
import { imageDimensions, parseImageDimensions } from "../../utils/image-dimensions.js";
import type { ImageContent, Message } from "../../core/types.js";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";
import { AnthropicProvider } from "../../core/providers/anthropic.js";
import { RetryProvider } from "../../core/retry.js";
import { withModelOverride } from "../../core/llm.js";
import { ConversationManager } from "../../memory/conversation.js";
import { measureRecoveryInput } from "../../context/request-recovery.js";
import { buildConversationCacheDiagnostics } from "../../agent/conversation-cache-diagnostics.js";
import { ReactiveCompact } from "../../context/reactive-compact.js";
import { LoopAgent } from "../../agent/loop.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";

function png(width: number, height: number, padding = 0): ImageContent {
  const b = Buffer.alloc(24 + padding);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
  b.write("IHDR", 12); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return { type: "image", mediaType: "image/png", source: "fixture", filePath: "/nonexistent/image.png", base64: b.toString("base64") };
}
const tokens = (model: string, w: number, h: number, detail?: ImageContent["detail"]) => estimateImageTokens({ ...png(w, h), detail }, { model }).tokens;
const message = (image: ImageContent): Message => ({ role: "user", content: "", contentBlocks: [image] });

describe("model-specific image token rules", () => {
  // Captured from DeepSeek's official calculator, not from the implementation under test.
  for (const [w, h, expected] of [
    [1, 1, 184], [200, 200, 184], [512, 512, 184], [544, 544, 184], [1024, 1024, 652],
    [1920, 1080, 968], [1080, 1920, 986], [2000, 2000, 994], [5000, 5000, 994],
    [8192, 128, 790], [128, 8192, 982], [1000, 1000, 602], [6515, 2602, 1022],
  ]) it(`DeepSeek official vector ${w} x ${h} = ${expected}`, () => {
    expect(tokens("deepseek-flash", w!, h!)).toBe(expected!);
    expect(deepseekImageTokens(w!, h!)).toBe(expected!);
  });

  for (const [w, h, standard, high] of [
    [200, 200, 64, 64], [1000, 1000, 1296, 1296], [1092, 1092, 1521, 1521],
    [1920, 1080, 1560, 2691], [2000, 1500, 1564, 3888], [3840, 2160, 1560, 4784],
  ]) it(`Claude official vector ${w} x ${h}`, () => {
    expect(tokens("claude-sonnet-4-6", w!, h!)).toBe(standard!);
    expect(tokens("claude-opus-4-7", w!, h!)).toBe(high!);
  });

  // Independent vectors from the official Python/TypeScript resize reference.
  // Exact .5 ties use round-to-even, and division must retain the aspect ratio.
  for (const [w, h, expected] of [[2016, 1046, 1512], [2185, 2186, 1560], [2540, 3288, 1530], [3136, 1065, 1064]]) {
    it(`matches Claude half-pixel resizing at ${w} x ${h}`, () => {
      expect(tokens("claude-sonnet-4-6", w!, h!)).toBe(expected!);
      expect(tokens("claude-sonnet-4-6", h!, w!)).toBe(expected!);
    });
  }

  it("applies OpenAI patch/tile coefficients and detail, without enlarging small tiles", () => {
    expect(tokens("gpt-4o", 1024, 1024)).toBe(765);
    expect(tokens("gpt-4o", 200, 200)).toBe(255);
    expect(tokens("gpt-4o", 4096, 8192, "low")).toBe(85);
    expect(tokens("gpt-4o-mini", 1024, 1024)).toBe(25501);
    expect(tokens("gpt-5.1", 1024, 1024)).toBe(630);
    expect(tokens("gpt-4.1-mini", 1024, 1024)).toBe(1659);
    expect(tokens("gpt-6-astra", 1024, 1024, "high")).toBe(1229);
    expect(tokens("gpt-6-astra", 2048, 2048, "high")).toBe(3000);
    expect(tokens("gpt-6-astra", 4096, 512, "high")).toBe(2458);
    expect(tokens("gpt-5.5", 4096, 4096)).toBe(12000);
    expect(tokens("gpt-5.5", 4096, 4096, "high")).toBe(3000);
    expect(tokens("gpt-5.5", 4096, 4096, "low")).toBe(308);
    expect(tokens("gpt-6-astra", 8192, 8192)).toBeGreaterThan(36000);
  });

  it("resolves namespaced and dated models, without attributing unknown models to a vendor rule", () => {
    expect(tokens("deepseek/deepseek-flash", 1920, 1080)).toBe(968);
    expect(tokens("openai/gpt-4o-2024-08-06", 1024, 1024)).toBe(765);
    expect(tokens("claude-sonnet-4-20250514", 1920, 1080)).toBe(1560);
    expect(tokens("claude-3-5-sonnet-20241022", 1920, 1080)).toBe(1560);
    expect(resolveImageTokenRule({ model: "gpt-4o-custom" })).toBeUndefined();
    expect(estimateImageTokens(png(1920, 1080), { model: "unknown" }).basis).toBe("heuristic");
    expect(estimateImageTokens(png(1920, 1080), { model: "private", imageTokenRule: { kind: "deepseek" } }).tokens).toBe(968);
  });

  it("uses a model upper bound for missing/corrupt dimensions; counts no unsent images", () => {
    const broken = { ...png(10, 10), base64: "bad-header" };
    expect(estimateImageTokens(broken, { model: "deepseek-flash" })).toEqual({ tokens: 1024, basis: "model-upper-bound", rule: "deepseek" });
    expect(estimateImageTokens(broken, { model: "claude-opus-4-7" }).tokens).toBe(4784);
    expect(estimateImageTokens(broken, { model: "unknown" }).basis).toBe("heuristic");
    expect(estimateImageTokens(broken, { supportsVision: false }).tokens).toBe(0);
    expect(estimateImageTokens({ ...broken, base64: undefined }).tokens).toBe(0);
  });

  it("does not treat inherited object keys as registered model rules", () => {
    for (const model of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(resolveImageTokenRule({ model })).toBeUndefined();
      for (const image of [png(1920, 1080), { ...png(1, 1), base64: "bad-header" }]) {
        const estimate = estimateImageTokens(image, { model });
        expect(estimate.basis).toBe("heuristic");
        expect(Number.isFinite(estimate.tokens)).toBe(true);
        expect(estimate.tokens).toBeGreaterThan(0);
      }
    }
  });

  it("keeps Base64 bytes and cache prefixes independent from visual tokens", () => {
    const counter = new TokenCounter({ model: "deepseek-flash" });
    const a = message(png(1920, 1080)), b = message(png(1920, 1080, 100000));
    const before = JSON.stringify(b);
    expect(counter.countMessage(a)).toBe(counter.countMessage(b));
    expect(measureRecoveryInput([b], counter).estimatedTokens).toBe(972);
    expect(measureRecoveryInput([b], counter).imageBytes).toBeGreaterThan(100000);
    expect(counter.countMessageChars(b)).toBe(0);
    expect(JSON.stringify(b)).toBe(before);
    expect(buildConversationCacheDiagnostics([b], counter).tail.estimatedTokens).toBe(972);
  });
});

describe("bounded image header inspection", () => {
  it("reads PNG, GIF, baseline/progressive JPEG, and all WebP containers", () => {
    expect(imageDimensions(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    const gif = Buffer.alloc(10); gif.write("GIF89a"); gif.writeUInt16LE(640, 6); gif.writeUInt16LE(480, 8);
    expect(parseImageDimensions(gif)).toEqual({ width: 640, height: 480 });
    for (const sof of [0xc0, 0xc2]) {
      const jpg = Buffer.from([255,216,255,224,0,4,0,0,255,sof,0,8,8,1,224,2,128,3]);
      expect(parseImageDimensions(jpg)).toEqual({ width: 640, height: 480 });
    }
    for (const type of ["VP8X", "VP8L", "VP8 "]) {
      const b = Buffer.alloc(30); b.write("RIFF"); b.write("WEBP",8); b.write(type,12); b.writeUInt32LE(10,16);
      if (type === "VP8X") { b.writeUIntLE(639,24,3); b.writeUIntLE(479,27,3); }
      if (type === "VP8L") { b[20]=0x2f; b.writeUInt32LE(639 | (479 << 14),21); }
      if (type === "VP8 ") { b[23]=0x9d; b[24]=1; b[25]=0x2a; b.writeUInt16LE(640,26); b.writeUInt16LE(480,28); }
      expect(parseImageDimensions(b)).toEqual({ width: 640, height: 480 });
    }
  });
  it("handles truncation, invalid dimensions, stale headers, and unavailable files without I/O", () => {
    for (let n=0;n<24;n++) expect(parseImageDimensions(Buffer.from(png(1,1).base64!,"base64").subarray(0,n))).toBeUndefined();
    expect(imageDimensions(png(0,0))).toBeUndefined();
    const img = png(640,480);
    expect(imageDimensions(img)?.width).toBe(640);
    img.base64 = png(1920,1080).base64;
    expect(imageDimensions(img)?.width).toBe(1920);
    expect(imageDimensions({ ...img, base64: undefined })).toBeUndefined();
  });
});

describe("runtime model accounting", () => {
  const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } } } as any;
  it("propagates retry wrappers, subagent model overrides, and runtime vision rejection", () => {
    const inner = new OpenAICompatibleProvider({ model: "deepseek-flash", client });
    const provider = new RetryProvider(inner, { maxRetries: 0 });
    const counter = new TokenCounter(() => provider.getImageTokenContext());
    const img = message(png(1920,1080));
    expect(counter.countMessage(img)).toBe(972);
    const child = withModelOverride(provider, "gpt-4o-mini");
    expect(new TokenCounter(() => child.getImageTokenContext!()).countMessage(img)).toBe(36839);
    provider.setVisionSupported(false);
    expect(counter.countMessage(img)).toBe(4);
    expect(new AnthropicProvider({ model: "claude-sonnet-4-6", client: {} as any }).getImageTokenContext().model).toBe("claude-sonnet-4-6");
  });
  it("does not apply an unsent detail setting on the Anthropic-compatible transport", () => {
    const provider = new AnthropicProvider({ model: "deepseek-flash", client: {} as any });
    const image = { ...png(1920,1080), detail: "low" as const };
    expect(estimateImageTokens(image, provider.getImageTokenContext()).tokens).toBe(968);
    expect(estimateImageTokens(image, { model: "deepseek-flash" }).tokens).toBeLessThan(968);
  });
  it("recounts restored history and the LoopAgent output budget when changing model", () => {
    const conversation = new ConversationManager({ maxMessages: Infinity });
    const img = message(png(1920,1080)); conversation.add(img);
    const registry = new ToolRegistry(); const executor = new ToolExecutor(registry, {});
    const make = (model: string) => new LoopAgent({ provider: new OpenAICompatibleProvider({ model, client }), registry, executor, conversation,
      contextWindow: 100000, outputTokenCeiling: 100000, reservedOutputTokens: 1000 });
    const deepseek = make("deepseek-flash") as any;
    expect(conversation.estimatedTokens).toBe(972);
    const before = deepseek.computeCallBudget([img], []);
    const mini = make("gpt-4o-mini") as any;
    expect(conversation.estimatedTokens).toBe(36839);
    expect(before - mini.computeCallBudget([img], [])).toBe(36839-972);
    expect(conversation.getAllMessages()).toHaveLength(1);
  });
  it("uses the fallback provider's model when recalculating the output budget", async () => {
    let outputBudget: number | undefined;
    const registry = new ToolRegistry(), executor = new ToolExecutor(registry, {});
    const agent = new LoopAgent({ provider: new OpenAICompatibleProvider({ model: "deepseek-flash", client }),
      registry, executor, contextWindow: 100000, outputTokenCeiling: 100000, reservedOutputTokens: 1000 }) as any;
    const fallback = {
      getImageTokenContext: () => ({ model: "gpt-4o-mini" }),
      call: async (_m: any, _t: any, opts: any) => { outputBudget = opts.maxOutputTokens;
        return { type: "text", text: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }; },
    };
    const messages = [message(png(1920,1080))];
    const primaryBudget = agent.computeCallBudget(messages, []);
    await agent.runWithProvider(fallback, messages, [], 1, primaryBudget);
    expect(primaryBudget - outputBudget!).toBe(36839 - 972);
  });
  it("does not carry an alias-specific rule into a different overridden model", () => {
    const provider = new OpenAICompatibleProvider({ model: "private-alias", client, imageTokenRule: { kind: "deepseek" } });
    expect(estimateImageTokens(png(1920,1080), provider.getImageTokenContext()).tokens).toBe(968);
    expect(provider.getImageTokenContext({ model: "gpt-4o-mini" }).imageTokenRule).toBeUndefined();
    expect(estimateImageTokens(png(1920,1080), provider.getImageTokenContext({ model: "gpt-4o-mini" })).tokens).toBe(36835);
  });
  it("matches the model actually serialized when extra request params override it", async () => {
    let body: any;
    const provider = new OpenAICompatibleProvider({ model: "private-alias", imageTokenRule: { kind: "deepseek" },
      extraRequestParams: { model: "gpt-4o-mini" },
      client: { chat: { completions: { create: async (params: any) => { body=params; return client.chat.completions.create(); } } } } as any });
    const context = provider.getImageTokenContext({ model: "deepseek-flash" });
    await provider.call([message(png(1920,1080))], [], { model: "deepseek-flash" });
    expect(context.model).toBe(body.model);
    expect(context.imageTokenRule).toBeUndefined();
    expect(estimateImageTokens(png(1920,1080), context).tokens).toBe(36835);
  });
  it("serializes detail identically for user images and tool-result images", async () => {
    let body: any;
    const p = new OpenAICompatibleProvider({ model: "gpt-4o", client: { chat: { completions: { create: async (params: any) => { body=params; return client.chat.completions.create(); } } } } as any });
    const img = { ...png(1920,1080), detail: "low" as const };
    await p.call([message(img), { role:"assistant", content:"", toolCalls:[{id:"read",name:"read_file",arguments:{}}] },
      { role:"tool_result", content:"image", toolCallId:"read", contentBlocks:[img] }]);
    const parts = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((b: any) => b.type === "image_url");
    expect(parts).toHaveLength(2);
    expect(parts.every((p: any) => p.image_url.detail === "low")).toBe(true);
    expect(parts[0].image_url.url).toBe(`data:image/png;base64,${img.base64}`);
  });
  it("measures recovery with the actual provider model instead of a default counter", async () => {
    const notices: any[] = [];
    const compact = new ReactiveCompact({ onCompact: () => [message(png(200,200))], onRetry: n => notices.push(n) });
    const provider = new OpenAICompatibleProvider({ model: "deepseek-flash", client });
    await compact.callWithCompaction(provider, [message(png(1920,1080))], [], undefined, { initialError: new Error("context length exceeded") });
    expect(notices[0].before.estimatedTokens).toBe(972);
    expect(notices[0].after.estimatedTokens).toBe(188);
  });
});
