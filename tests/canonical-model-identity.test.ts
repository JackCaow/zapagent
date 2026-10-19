import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearModelsDevCache, parseModelsDevProvider } from "../zapsdk/core/models-dev.js";
import { canonicalModelId } from "../zapsdk/core/model-identity.js";
import { estimateImageTokens } from "../zapsdk/context/image-tokens.js";
import { TokenCounter } from "../zapsdk/context/token-counter.js";
import { OpenAICompatibleProvider } from "../zapsdk/core/providers/openai-compatible.js";
import { AnthropicProvider } from "../zapsdk/core/providers/anthropic.js";
import { RetryProvider } from "../zapsdk/core/retry.js";
import { withModelOverride } from "../zapsdk/core/llm.js";
import { ConversationManager } from "../zapsdk/memory/conversation.js";
import { getDefaultConfig, saveAppConfig, loadAppConfig, type Provider } from "../src/config.js";
import { enrichProviderMetadata, applyMetadataRefresh, modelCanonicalIds, resolveModelImageTokenContext, refreshModelsDevMetadata } from "../src/provider-metadata.js";
import { buildAgentObjects } from "../src/agent-factory.js";
import type { ImageContent } from "../zapsdk/core/types.js";

const binary = Buffer.alloc(24);
Buffer.from([137,80,78,71,13,10,26,10]).copy(binary);
binary.write("IHDR",12); binary.writeUInt32BE(1920,16); binary.writeUInt32BE(1080,20);
const image: ImageContent = { type:"image", filePath:"/nonexistent.png", source:"fixture", mediaType:"image/png", base64:binary.toString("base64") };
const identity = "deepseek/deepseek-v4.1-flash-1017";
const provider: Provider = { id:"relay", name:"Relay", baseURL:"http://127.0.0.1:1/v1", apiKey:"", authMode:"none", protocol:"openai",
  models:["fast", "child"], contextWindow:1000000, contextWindowMode:"manual" };
const config = (p: Provider) => ({ ...getDefaultConfig(), providers:[p], active:{providerId:p.id,model:"fast"} });
function catalog(canonical: unknown = identity) {
  return parseModelsDevProvider({ relay: { models: { fast: { id:"fast", canonical_model_id:canonical,
    modalities:{input:["text","image"],output:["text"]}, limit:{context:1000000,output:1000} },
    child: { canonical_model_id:"openai/gpt-4o-mini" } } } }, "relay")!;
}

describe("canonical model identity lifecycle", () => {
  it("parses public identity without replacing a provider model ID", () => {
    expect(catalog().models.find(m => m.id === "fast")?.canonicalModelId).toBe(identity);
    for (const bad of [null,42,"","gpt-4o","https://example.com/x","openai/gpt-4o\n","/openai/gpt-4o","openai/../gpt-4o", "openai/"+"x".repeat(300)]) {
      expect(canonicalModelId(bad)).toBeUndefined();
      expect(catalog(bad).models.find(m => m.id === "fast")?.canonicalModelId).toBeUndefined();
    }
  });
  it("persists identity for offline startup and ignores malformed config identities", () => {
    const dir=mkdtempSync(join(tmpdir(),"zap-canonical-"));
    try {
      const path=join(dir,"config.json");
      const enriched=enrichProviderMetadata(provider,catalog());
      saveAppConfig(path,config(enriched));
      const restored=loadAppConfig(path);
      expect(restored.active.model).toBe("fast");
      expect(restored.providers[0]!.modelMetadata!.fast!.canonicalModelId).toBe(identity);
      expect(estimateImageTokens(image,resolveModelImageTokenContext(restored.providers[0],"fast")).tokens).toBe(968);
      saveAppConfig(path,config({...provider,modelMetadata:{fast:{canonicalModelId:"https://wrong"}}}));
      expect(loadAppConfig(path).providers[0]!.modelMetadata?.fast?.canonicalModelId).toBeUndefined();
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  it("refreshes and removes stale catalog identity without losing other facts or changing availability", () => {
    const first=enrichProviderMetadata(provider,catalog());
    const updated=enrichProviderMetadata(first,catalog("openai/gpt-4o-mini"));
    expect(estimateImageTokens(image,resolveModelImageTokenContext(updated,"fast")).tokens).toBe(36835);
    const removed=enrichProviderMetadata(updated,catalog(null));
    expect(removed.modelMetadata?.fast?.canonicalModelId).toBeUndefined();
    expect(removed.modelMetadata?.fast?.supportsVision).toBe(true);
    expect(removed.models).toEqual(provider.models);
    expect(removed.contextWindow).toBe(provider.contextWindow);
    expect(enrichProviderMetadata(first,catalog())).toBe(first);
  });
  it("retains manual/provider identity and concurrent connection edits", () => {
    for (const source of ["manual","provider"] as const) {
      const p={...provider,modelMetadata:{fast:{canonicalModelId:"openai/gpt-4o",source}}};
      expect(enrichProviderMetadata(p,catalog()).modelMetadata?.fast?.canonicalModelId).toBe("openai/gpt-4o");
    }
    const initial=config(provider), refreshed=config(enrichProviderMetadata(provider,catalog()));
    const current={...initial,providers:[{...provider,name:"edited"}]};
    expect(applyMetadataRefresh(current,initial,refreshed)).toBe(current);
    const applied=applyMetadataRefresh(initial,initial,refreshed);
    expect(applied.active.model).toBe("fast");
    expect(applied.providers[0]!.modelMetadata!.fast!.canonicalModelId).toBe(identity);
  });
  it("retires a catalog identity when its whole model entry disappears", () => {
    const first=enrichProviderMetadata(provider,catalog());
    const removed=enrichProviderMetadata(first,{...catalog(),models:[]});
    expect(removed.modelMetadata?.fast?.canonicalModelId).toBeUndefined();
    expect(removed.modelMetadata?.fast?.supportsVision).toBe(true);
    expect(removed.modelMetadata?.fast?.contextWindow).toBe(1000000);
    expect(removed.models).toEqual(provider.models);
    expect(first.modelMetadata?.fast?.canonicalModelId).toBe(identity);
    expect(estimateImageTokens(image,resolveModelImageTokenContext(removed,"fast")).basis).toBe("heuristic");
    for (const source of ["manual","provider"] as const) {
      const explicit={...first,modelMetadata:{fast:{canonicalModelId:identity,source}}};
      expect(enrichProviderMetadata(explicit,{...catalog(),models:[]}).modelMetadata?.fast?.canonicalModelId).toBe(identity);
    }
  });
  it("preserves cached identity when the provider catalog is unavailable or offline", async () => {
    const dir=mkdtempSync(join(tmpdir(),"zap-canonical-offline-"));
    const originalFetch=globalThis.fetch, originalDataDir=process.env.ZAPCODE_DATA_DIR;
    const initial=config(enrichProviderMetadata({...provider,catalogProviderId:"relay"},catalog()));
    try {
      for (const offline of [false,true]) {
        process.env.ZAPCODE_DATA_DIR=join(dir,String(offline));
        clearModelsDevCache();
        globalThis.fetch=(async () => {
          if (offline) throw new Error("offline");
          return new Response(JSON.stringify({other:{models:{}}}));
        }) as typeof fetch;
        expect(await refreshModelsDevMetadata(initial)).toBe(initial);
        expect(initial.providers[0]!.modelMetadata?.fast?.canonicalModelId).toBe(identity);
      }
    } finally {
      globalThis.fetch=originalFetch;
      if (originalDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR;
      else process.env.ZAPCODE_DATA_DIR=originalDataDir;
      clearModelsDevCache();
      rmSync(dir,{recursive:true,force:true});
    }
  });
  it("recounts the same selected alias when only catalog identity changes", () => {
    const cm=new ConversationManager({maxMessages:Infinity});
    cm.add({role:"user",content:"",contentBlocks:[image]});
    const first=enrichProviderMetadata(provider,catalog()), next=enrichProviderMetadata(first,catalog("openai/gpt-4o-mini"));
    const firstContext=resolveModelImageTokenContext(first,"fast"), nextContext=resolveModelImageTokenContext(next,"fast");
    cm.setTokenCounter(new TokenCounter(firstContext)); expect(cm.estimatedTokens).toBe(972);
    const before=JSON.stringify(cm.getAllMessages());
    cm.setTokenCounter(new TokenCounter(nextContext)); expect(cm.estimatedTokens).toBe(36839);
    expect(JSON.stringify(nextContext)).not.toBe(JSON.stringify(firstContext));
    expect(JSON.stringify(cm.getAllMessages())).toBe(before);
  });
});

describe("canonical identity rule selection and transport", () => {
  it("uses canonical identity before aliases, while explicit rules still win", () => {
    expect(estimateImageTokens(image,{model:"fast",canonicalModelId:identity}).tokens).toBe(968);
    expect(estimateImageTokens(image,{model:"gpt-4o-mini",canonicalModelId:identity}).tokens).toBe(968);
    for (const id of ["openai/not-yet-supported","other/gpt-4o","anthropic/gpt-4o"]) {
      expect(estimateImageTokens(image,{model:"gpt-4o",canonicalModelId:id}).basis).toBe("heuristic");
    }
    expect(estimateImageTokens(image,{model:"gpt-4o",canonicalModelId:identity,imageTokenRule:{kind:"tiles",base:1,tile:2}}).tokens).toBe(13);
    expect(estimateImageTokens(image,{model:"gpt-4o"}).tokens).toBe(1105);
  });
  for (const protocol of ["openai","anthropic"] as const) {
    it(`factory and wrappers select each overridden model's identity (${protocol})`, () => {
      const p={...enrichProviderMetadata(provider,catalog()),protocol};
      const main=buildAgentObjects(config(p)).provider;
      expect(main.getImageTokenContext!().canonicalModelId).toBe(identity);
      expect(estimateImageTokens(image,main.getImageTokenContext!()).tokens).toBe(968);
      const child=withModelOverride(main,"child");
      expect(child.getImageTokenContext!().canonicalModelId).toBe("openai/gpt-4o-mini");
      expect(estimateImageTokens(image,child.getImageTokenContext!()).tokens).toBe(36835);
      expect(withModelOverride(main,"new-unknown").getImageTokenContext!().canonicalModelId).toBeUndefined();
    });
    it(`retains the endpoint wire model and image bytes (${protocol})`, async () => {
      let body: any;
      const create=async (params: any) => { body=params; return protocol === "openai"
        ? {choices:[{message:{content:"ok"},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1}}
        : {content:[{type:"text",text:"ok"}],stop_reason:"end_turn",usage:{input_tokens:1,output_tokens:1}}; };
      const ids=modelCanonicalIds(enrichProviderMetadata(provider,catalog()));
      const inner=protocol === "openai"
        ? new OpenAICompatibleProvider({model:"fast",canonicalModelIds:ids,client:{chat:{completions:{create}}} as any})
        : new AnthropicProvider({model:"fast",canonicalModelIds:ids,client:{messages:{create}} as any});
      const wrapped=new RetryProvider(inner,{maxRetries:0});
      const messages=[{role:"user" as const,content:"",contentBlocks:[image]}];
      const before=JSON.stringify(messages);
      await withModelOverride(wrapped,"child").call(messages);
      expect(body.model).toBe("child");
      expect(JSON.stringify(body)).not.toContain("canonicalModel");
      expect(JSON.stringify(body)).not.toContain("openai/gpt-4o-mini");
      expect(JSON.stringify(body)).toContain(image.base64!);
      expect(JSON.stringify(messages)).toBe(before);
    });
  }
  it("resolves explicit request-model overrides by their own metadata", () => {
    const p={...enrichProviderMetadata(provider,catalog()),extraRequestParams:{model:"child"}};
    expect(resolveModelImageTokenContext(p,"fast").canonicalModelId).toBe("openai/gpt-4o-mini");
    const actual=buildAgentObjects(config(p)).provider.getImageTokenContext!();
    expect(actual.model).toBe("child"); expect(actual.canonicalModelId).toBe("openai/gpt-4o-mini");
  });
});
