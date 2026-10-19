import { describe, expect, it } from "bun:test";
import { createKeylessWebSearch } from "../../builtin-tools/web-search-keyless.js";

const JINA_RESULT = [
  "1.[Zap &amp; Docs](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs)",
  "Current&nbsp;reference &#183; details",
  "example.com/docs",
].join("\n");

const CURL_DDG_RESULT = [
  '<div class="result__body">',
  '<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.net%2Fguide">Guide &amp; API</a>',
  '<a class="result__snippet">Fallback&nbsp;snippet &#xB7; current</a>',
  "</div>",
  "__HTTP_STATUS__:200",
].join("\n");

const BING_RESULT = [
  '<ol><li class="b_algo">',
  '<h2><a href="https://example.org/reference">Bing &amp; Reference</a></h2>',
  '<div class="b_caption"><p>Independent&nbsp;fallback</p></div>',
  "</li></ol>",
].join("");

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

describe("keyless web search", () => {
  it("uses Jina/DDG, unwraps direct URLs, and decodes HTML entities", async () => {
    const search = createKeylessWebSearch({
      fetchFn: async (input) => {
        expect(
          String(input).startsWith("https://r.jina.ai/https://lite.duckduckgo.com/"),
        ).toBe(true);
        return textResponse(JINA_RESULT);
      },
      curlRunner: async () => "\n__HTTP_STATUS__:200",
      requestIntervalMs: 0,
    });

    await expect(search("zapcode", 5)).resolves.toEqual([{
      title: "Zap & Docs",
      url: "https://example.com/docs",
      snippet: "Current reference · details",
    }]);
  });

  it("falls back to curl/DDG when Jina surfaces an anomaly challenge", async () => {
    const search = createKeylessWebSearch({
      fetchFn: async () => textResponse("anomaly duckduckgo", 202),
      curlRunner: async () => CURL_DDG_RESULT,
      requestIntervalMs: 0,
    });

    await expect(search("zapcode", 3)).resolves.toEqual([{
      title: "Guide & API",
      url: "https://example.net/guide",
      snippet: "Fallback snippet · current",
    }]);
  });

  it("uses an independent Bing fallback when both DDG routes are blocked", async () => {
    const search = createKeylessWebSearch({
      fetchFn: async (input) => String(input).startsWith("https://www.bing.com/")
        ? textResponse(BING_RESULT)
        : textResponse("anomaly duckduckgo", 202),
      curlRunner: async () => "anomaly duckduckgo\n__HTTP_STATUS__:202",
      requestIntervalMs: 0,
    });

    await expect(search("zapcode", 3)).resolves.toEqual([{
      title: "Bing & Reference",
      url: "https://example.org/reference",
      snippet: "Independent fallback",
    }]);
  });

  it("caches successful searches without persisting or repeating backend calls", async () => {
    let fetchCalls = 0;
    let curlCalls = 0;
    const search = createKeylessWebSearch({
      fetchFn: async () => {
        fetchCalls++;
        return textResponse(JINA_RESULT);
      },
      curlRunner: async () => {
        curlCalls++;
        return "\n__HTTP_STATUS__:200";
      },
      now: () => 1_000,
      requestIntervalMs: 0,
    });

    const first = await search("same query", 5);
    const second = await search("same query", 5);

    expect(second).toEqual(first);
    expect(fetchCalls).toBe(1);
    expect(curlCalls).toBe(1);
  });

  it("backs off DDG after a challenge while keeping Bing available", async () => {
    let jinaCalls = 0;
    let bingCalls = 0;
    let curlCalls = 0;
    const search = createKeylessWebSearch({
      fetchFn: async (input) => {
        if (String(input).startsWith("https://www.bing.com/")) {
          bingCalls++;
          return textResponse(BING_RESULT);
        }
        jinaCalls++;
        return textResponse("anomaly duckduckgo", 202);
      },
      curlRunner: async () => {
        curlCalls++;
        return "anomaly duckduckgo\n__HTTP_STATUS__:202";
      },
      now: () => 1_000,
      requestIntervalMs: 0,
      backoffMs: 60_000,
    });

    await search("first query", 3);
    await search("second query", 3);

    expect(jinaCalls).toBe(1);
    expect(curlCalls).toBe(1);
    expect(bingCalls).toBe(2);
  });

  it("does not back off healthy DDG after a partial backend failure", async () => {
    let jinaCalls = 0;
    let bingCalls = 0;
    let curlCalls = 0;
    const search = createKeylessWebSearch({
      fetchFn: async (input) => {
        if (String(input).startsWith("https://www.bing.com/")) {
          bingCalls++;
          return textResponse(BING_RESULT);
        }
        jinaCalls++;
        await new Promise(resolve => setTimeout(resolve, 1));
        return textResponse(JINA_RESULT);
      },
      curlRunner: async () => {
        curlCalls++;
        return "anomaly duckduckgo\n__HTTP_STATUS__:202";
      },
      now: () => 1_000,
      requestIntervalMs: 0,
      backoffMs: 60_000,
    });

    await search("first query", 3);
    await search("second query", 3);

    expect(jinaCalls).toBe(2);
    expect(curlCalls).toBe(2);
    expect(bingCalls).toBe(0);
  });

  it("refreshes cache recency before evicting the least recently used query", async () => {
    let jinaCalls = 0;
    const search = createKeylessWebSearch({
      fetchFn: async () => {
        jinaCalls++;
        return textResponse(JINA_RESULT);
      },
      curlRunner: async () => "\n__HTTP_STATUS__:200",
      now: () => 1_000,
      requestIntervalMs: 0,
      maxCacheEntries: 2,
    });

    await search("alpha", 3);
    await search("beta", 3);
    await search("alpha", 3);
    await search("gamma", 3);
    await search("beta", 3);

    expect(jinaCalls).toBe(4);
  });

  it("distinguishes total backend failure from a genuine empty result", async () => {
    const blocked = createKeylessWebSearch({
      fetchFn: async () => textResponse("just a moment", 429),
      curlRunner: async () => "anomaly duckduckgo\n__HTTP_STATUS__:202",
      requestIntervalMs: 0,
    });
    await expect(blocked("blocked", 3)).rejects.toThrow("All keyless search backends failed");

    const empty = createKeylessWebSearch({
      fetchFn: async () => textResponse("<html>no matches</html>"),
      curlRunner: async () => "<html>no matches</html>\n__HTTP_STATUS__:200",
      requestIntervalMs: 0,
    });
    await expect(empty("no matches", 3)).resolves.toEqual([]);
  });

  it("surfaces fallback failures instead of masking them as no results", async () => {
    const search = createKeylessWebSearch({
      fetchFn: async (input) => {
        if (String(input).startsWith("https://www.bing.com/")) {
          throw new Error("Bing offline");
        }
        return textResponse("<html>no parsed results</html>");
      },
      curlRunner: async () => {
        throw new Error("curl unavailable");
      },
      requestIntervalMs: 0,
    });

    await expect(search("incomplete search", 3)).rejects.toThrow(
      "All keyless search backends failed",
    );
  });
});
