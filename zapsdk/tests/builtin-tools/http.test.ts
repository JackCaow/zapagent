import { afterEach, describe, expect, it } from "bun:test";
import {
  assertSafePublicHttpUrl,
  httpFetchTool,
  httpRequestTool,
  resolvePublicDnsOverHttps,
  truncateHttpText,
} from "../../builtin-tools/http.js";

const originalFetch = globalThis.fetch;
const publicResolver = async () => ["93.184.216.34"];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("http_fetch truncation", () => {
  it("truncates successful responses by Unicode code point", () => {
    expect(truncateHttpText("a😀b😀c", 4))
      .toBe("a😀b😀\n\n… [truncated — 5 total chars]");
  });

  it("does not split non-BMP characters when truncating raw responses", async () => {
    globalThis.fetch = async () => new Response("ab😀cd", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });

    const tool = httpFetchTool({ maxResponseLength: 3, timeoutMs: 1000, resolveHostname: publicResolver });
    const result = await tool.handler({ url: "https://example.test/raw", raw: true });

    expect(result.success).toBe(true);
    expect(result.output).toBe("ab😀\n\n… [truncated — 5 total chars]");
    expect(hasUnpairedSurrogate(result.output)).toBe(false);
  });

  it("does not split non-BMP characters in error body previews", async () => {
    globalThis.fetch = async () => new Response(`${"x".repeat(999)}🧪tail`, {
      status: 500,
      statusText: "Server Error",
      headers: { "content-type": "text/plain" },
    });

    const tool = httpFetchTool({ timeoutMs: 1000, resolveHostname: publicResolver });
    const result = await tool.handler({ url: "https://example.test/fail", raw: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 500 Server Error");
    expect(result.error).toContain("🧪");
    expect(result.error).not.toContain("tail");
    expect(hasUnpairedSurrogate(result.error ?? "")).toBe(false);
  });

  it("blocks localhost and private address literals before fetch", async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response("unexpected");
    };

    const tool = httpFetchTool({ resolveHostname: publicResolver });
    const localhost = await tool.handler({ url: "http://127.0.0.1/admin", raw: true });
    const metadata = await tool.handler({ url: "http://169.254.169.254/latest", raw: true });

    expect(localhost.success).toBe(false);
    expect(metadata.success).toBe(false);
    expect(called).toBe(false);
  });

  it("revalidates redirect destinations", async () => {
    globalThis.fetch = async () => new Response("", {
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
    });
    const tool = httpFetchTool({ resolveHostname: publicResolver });

    const result = await tool.handler({ url: "https://example.test/start", raw: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not allowed");
  });

  it("caps bytes while streaming instead of buffering the complete response", async () => {
    globalThis.fetch = async () => new Response("abcdefghij", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    const tool = httpFetchTool({
      maxResponseBytes: 4,
      maxResponseLength: 100,
      resolveHostname: publicResolver,
    });

    const result = await tool.handler({ url: "https://example.test/large", raw: true });

    expect(result.success).toBe(true);
    expect(result.output).toContain("abcd");
    expect(result.output).toContain("response truncated at 4 bytes");
    expect(result.output).not.toContain("efghij");
  });

  it("separates mutating requests behind confirm permission", () => {
    const read = httpFetchTool();
    const write = httpRequestTool();

    expect(read.definition.permission).toBe("auto");
    expect(read.definition.parameters.safeParse({ url: "https://example.com", method: "POST" }).success).toBe(false);
    expect(write.definition.permission).toBe("confirm");
    expect(write.definition.parameters.safeParse({ url: "https://example.com", method: "POST" }).success).toBe(true);
  });

  it("rejects DNS names that resolve to private addresses", async () => {
    await expect(assertSafePublicHttpUrl("https://internal.example", async () => ["10.0.0.5"]))
      .rejects.toThrow("not allowed");
  });

  it("resolves public addresses over HTTPS when native DNS uses Fake-IP", async () => {
    const queries: string[] = [];
    const addresses = await resolvePublicDnsOverHttps("example.com", async (input) => {
      const url = new URL(String(input));
      queries.push(url.searchParams.get("type") ?? "");
      const type = Number(url.searchParams.get("type"));
      return Response.json(type === 1
        ? { Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] }
        : { Status: 0, Answer: [{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }] });
    });

    expect(queries).toEqual(["1", "28"]);
    expect(addresses).toEqual(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
    await expect(assertSafePublicHttpUrl("https://example.com", async () => addresses)).resolves.toBeInstanceOf(URL);
  });

  it("does not let private DNS-over-HTTPS answers bypass URL safety", async () => {
    const addresses = await resolvePublicDnsOverHttps("internal.example", async (input) => {
      const type = Number(new URL(String(input)).searchParams.get("type"));
      return Response.json(type === 1
        ? { Status: 0, Answer: [{ type: 1, data: "10.0.0.5" }] }
        : { Status: 0, Answer: [] });
    });

    await expect(assertSafePublicHttpUrl("https://internal.example", async () => addresses))
      .rejects.toThrow("not allowed");
  });
});

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
