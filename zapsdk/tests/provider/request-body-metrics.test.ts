import { expect, it } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createHash } from "node:crypto";
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js";
import { AnthropicProvider } from "../../core/providers/anthropic.js";
import type { ProviderRequestEvent } from "../../core/llm.js";

for (const kind of ["openai", "anthropic"] as const) {
  for (const streaming of [true, false]) {
    it(`matches real SDK wire bytes and enforces the boundary (${kind}, stream=${streaming})`, async () => {
      let calls = 0;
      let wireBody = "";
      const fetch: typeof globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        calls++;
        wireBody = String(init?.body);
        return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "fixture rejection" } }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }) as typeof globalThis.fetch;
      const createProvider = (maxRequestBytes?: number) => kind === "openai"
        ? new OpenAICompatibleProvider({ model: "test", maxRequestBytes, client: new OpenAI({ apiKey: "test", fetch, maxRetries: 0 }) })
        : new AnthropicProvider({ model: "test", maxRequestBytes, client: new Anthropic({ apiKey: "test", fetch, maxRetries: 0 }) });
      const run = async (maxRequestBytes?: number, events: ProviderRequestEvent[] = []) => {
        const provider = createProvider(maxRequestBytes);
        const messages = [{ role: "user" as const, content: "字节测量" }];
        const options = { onRequestEvent: (event: ProviderRequestEvent) => events.push(event) };
        if (streaming) for await (const _ of provider.stream(messages, [], options)) { /* consume */ }
        else await provider.call(messages, [], options);
      };
      const events: ProviderRequestEvent[] = [];
      await expect(run(undefined, events)).rejects.toThrow("fixture rejection");
      expect(calls).toBe(1);
      const wireBytes = Buffer.byteLength(wireBody);
      const measured = events.find(event => event.phase === "failed")!;
      expect(measured.requestBytes).toBe(wireBytes);
      expect(measured.requestFingerprint).toBe(createHash("sha256").update(wireBody).digest("hex"));
      expect(JSON.parse(wireBody).stream).toBe(streaming ? true : undefined);

      calls = 0;
      await expect(run(wireBytes - 1)).rejects.toMatchObject({ name: "RequestBodyLimitError", requestBytes: wireBytes });
      expect(calls).toBe(0);
      await expect(run(wireBytes)).rejects.toThrow("fixture rejection");
      expect(calls).toBe(1);
    });

    it(`checks configured body bytes before transport (${kind}, stream=${streaming})`, async () => {
      let calls = 0;
      const unexpected = () => { calls++; throw new Error("transport must not start"); };
      const provider = kind === "openai"
        ? new OpenAICompatibleProvider({ model: "test", maxRequestBytes: 100, client: { chat: { completions: { create: unexpected } } } as any })
        : new AnthropicProvider({ model: "test", maxRequestBytes: 100, client: { messages: { create: unexpected, stream: unexpected } } as any });
      const run = async () => {
        const messages = [{ role: "user" as const, content: "字".repeat(100) }];
        if (streaming) for await (const _ of provider.stream(messages)) { /* consume */ }
        else await provider.call(messages);
      };
      await expect(run()).rejects.toMatchObject({ name: "RequestBodyLimitError", status: 413, maxRequestBytes: 100 });
      expect(calls).toBe(0);
    });

    it(`measures final JSON bytes without exposing payload (${kind}, stream=${streaming})`, async () => {
      const provider = kind === "openai"
        ? new OpenAICompatibleProvider({ model: "test", apiKey: "test" })
        : new AnthropicProvider({ model: "test", client: {} as any });
      let expectedBytes = 0;
      const stop = async (params: unknown) => {
        expectedBytes = Buffer.byteLength(JSON.stringify(params));
        throw new Error("413 request too large");
      };
      (provider as any).client = kind === "openai" ? { chat: { completions: { create: stop } } } : { messages: { create: stop, stream: stop } };
      const events: ProviderRequestEvent[] = [];
      const options = { onRequestEvent: (e: ProviderRequestEvent) => events.push(e) };
      const messages = [{ role: "user" as const, content: "private 测试内容" }];
      const run = async () => {
        if (streaming) for await (const _ of provider.stream(messages, [], options)) { /* consume */ }
        else await provider.call(messages, [], options);
      };
      await expect(run()).rejects.toThrow("413");
      const measured = events.filter(e => e.requestBytes !== undefined);
      expect(measured.length).toBeGreaterThan(0);
      expect(measured.every(e => e.requestBytes === expectedBytes)).toBe(true);
      expect(measured[0].requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(events)).not.toContain("private");
    });
  }
}
