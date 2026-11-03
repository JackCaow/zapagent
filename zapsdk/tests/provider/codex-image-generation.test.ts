import { expect, test } from "bun:test";
import { Resvg } from "@resvg/resvg-js";
import { generateCodexImage, type CodexImageOptions } from "../../core/providers/codex-image-generation.js";
const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="blue"/></svg>').render().asPng();
const item = (result = png.toString("base64")) => ({ id: "image-1", type: "image_generation_call", status: "completed", result });
const done = (output: any[] = []) => ({ type: "response.completed", response: { status: "completed", output } });
function fixture(events: unknown[], changes: Partial<CodexImageOptions> = {}) {
  const requests: any[] = [];
  const options: CodexImageOptions = { model: "account-model", getCredentials: async () => ({ accessToken: "fixture-secret", accountId: "acct" }),
    fetch: (async (url, init) => {
      requests.push({ url, ...init, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      const encoded = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""));
      return new Response(new ReadableStream({ start(c) {
        for (let offset = 0; offset < encoded.length; offset += 17) c.enqueue(encoded.slice(offset, offset + 17));
        c.close();
      } }));
    }) as typeof fetch, ...changes };
  return { requests, options };
}

test("uses pinned OAuth endpoint, bounded provider request and incremental result with sparse terminal output", async () => {
  const { options, requests } = fixture([{ type: "response.image_generation_call.generating" }, { type: "response.output_item.done", item: item() }, done()]);
  const image = await generateCodexImage(options, { prompt: "蓝色圆形", quality: "low", background: "transparent" });
  expect(image.bytes).toEqual(png);
  expect(image).toMatchObject({ width: 2, height: 2 });
  expect(image.responseBytes).toBeGreaterThan(png.length);
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(requests[0].headers.get("authorization")).toBe("Bearer fixture-secret");
  expect(requests[0].headers.get("chatgpt-account-id")).toBe("acct");
  expect(requests[0].redirect).toBe("error");
  expect(requests[0].body).toMatchObject({ model: "account-model", stream: true, store: false,
    tools: [{ type: "image_generation", model: "gpt-image-2", output_format: "png", quality: "low", background: "transparent" }], tool_choice: { type: "image_generation" } });
  for (const key of ["reasoning", "reasoning_effort", "max_output_tokens", "previous_response_id"]) expect(requests[0].body[key]).toBeUndefined();
});

test("accepts terminal-only images and deduplicates equal streamed/terminal copies", async () => {
  for (const events of [[done([item()])], [{ type: "response.output_item.done", item: item() }, done([item()])]]) {
    expect((await generateCodexImage(fixture(events).options, { prompt: "draw" })).bytes).toEqual(png);
  }
});

test("rejects partial, failed, conflicting or invalid payloads without retrying", async () => {
  const other = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>').render().asPng();
  const cases = [[], [{ type: "response.output_item.done", item: item() }], [done()],
    [{ type: "response.output_item.done", item: item() }, { type: "response.failed", response: { status: "failed" } }],
    [{ type: "response.incomplete", response: { status: "incomplete", output: [item()] } }],
    [done([{ ...item(), status: "in_progress" }])], [done([item("not image")])], [done([item(Buffer.from("not a png").toString("base64"))])],
    [{ type: "response.output_item.done", item: item() }, done([item(other.toString("base64"))])],
    [done([item(), { ...item(), id: "second-image" }])], [{ type: "error", message: "fixture-secret" }]];
  for (const events of cases) {
    const { options, requests } = fixture(events);
    await expect(generateCodexImage(options, { prompt: "draw" })).rejects.toBeInstanceOf(Error);
    expect(requests).toHaveLength(1);
  }
});

test("limits prompt and response bytes and hides error response credentials", async () => {
  const small = fixture([done([item()])], { maxResponseBytes: 50 });
  await expect(generateCodexImage(small.options, { prompt: "draw" })).rejects.toThrow("byte limit");
  const bad = fixture([], { fetch: (async () => Response.json({ error: "fixture-secret" }, { status: 403 })) as typeof fetch });
  await expect(generateCodexImage(bad.options, { prompt: "draw" })).rejects.toThrow("HTTP 403");
  try { await generateCodexImage(bad.options, { prompt: "draw" }); } catch (e) { expect(String(e)).not.toContain("fixture-secret"); }
  const { options, requests } = fixture([]);
  await expect(generateCodexImage(options, { prompt: "字".repeat(6000) })).rejects.toThrow("16000");
  expect(requests).toHaveLength(0);
});

test("bounds credential, headers and idle waits even for uncooperative injected transports", async () => {
  for (const change of [
    { getCredentials: () => new Promise<never>(() => {}) },
    { fetch: (() => new Promise<never>(() => {})) as typeof fetch },
    { fetch: (async () => new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }))) as typeof fetch },
  ]) {
    const { options } = fixture([], { timeoutMs: 30, idleMs: 20, ...change });
    const started = Date.now();
    await expect(generateCodexImage(options, { prompt: "draw" })).rejects.toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(1000);
  }
  const controller = new AbortController(); controller.abort();
  const { options, requests } = fixture([]);
  await expect(generateCodexImage(options, { prompt: "draw" }, controller.signal)).rejects.toBeInstanceOf(Error);
  expect(requests).toHaveLength(0);
});


test("rejects PNG header spoofs and corrupted pixel data", async () => {
  for (const corrupted of [png.subarray(0, 33), (() => { const copy = Buffer.from(png); copy[copy.length - 14] ^= 1; return copy; })()]) {
    const { options } = fixture([done([item(corrupted.toString("base64"))])]);
    await expect(generateCodexImage(options, { prompt: "draw" })).rejects.toThrow("PNG");
  }
});
