import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { webSearchTool, createSerpApiSearch } from "../../builtin-tools/web-search.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

describe("web_search abort handling", () => {
  it("passes an abortable executor signal to injected search functions", async () => {
    let seenSignal: AbortSignal | undefined;
    const tool = webSearchTool({
      searchFn: async (_query, _maxResults, signal) => {
        seenSignal = signal;
        return await new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            resolve([{ title: "ignored", url: "https://example.com", snippet: "late" }]);
          }, { once: true });
        });
      },
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry);
    const controller = new AbortController();

    const pending = executor.execute("web_search", { query: "zap" }, controller.signal);
    while (!seenSignal) await Promise.resolve();
    controller.abort(new Error("user cancelled"));
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.error).toBe("aborted");
    expect(seenSignal?.aborted).toBe(true);
  });

  it("does not call the search function when already aborted", async () => {
    let called = false;
    const tool = webSearchTool({
      searchFn: async () => {
        called = true;
        return [];
      },
    });
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));

    const result = await tool.handler({ query: "zap" }, controller.signal);

    expect(result.success).toBe(false);
    expect(result.error).toBe("aborted");
    expect(called).toBe(false);
  });

  it("normalizes a rejected in-flight search to aborted", async () => {
    const tool = webSearchTool({
      searchFn: async (_query, _maxResults, signal) => await new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    const controller = new AbortController();

    const pending = tool.handler({ query: "zap" }, controller.signal);
    controller.abort(new Error("user cancelled"));

    await expect(pending).resolves.toEqual({
      success: false,
      output: "",
      error: "aborted",
    });
  });

  it("combines provider timeout signals with caller abort signals", async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response(JSON.stringify({ organic_results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const controller = new AbortController();
      const search = createSerpApiSearch("key");
      await search("zap", 3, controller.signal);

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal).not.toBe(controller.signal);
      expect(capturedSignal?.aborted).toBe(false);

      controller.abort(new Error("user cancelled"));
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("web_search schema", () => {
  it("accepts bounded non-empty queries", () => {
    const tool = webSearchTool();
    const schema = tool.definition.parameters as z.ZodObject<{ query: z.ZodString }>;

    expect(schema.safeParse({ query: "zap" }).success).toBe(true);
    expect(schema.safeParse({ query: "   " }).success).toBe(false);
    expect(schema.safeParse({ query: "x".repeat(501) }).success).toBe(false);
    expect(schema.safeParse({ query: 42 }).success).toBe(false);
  });
});
