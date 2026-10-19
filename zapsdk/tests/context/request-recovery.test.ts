import { describe, expect, it } from "bun:test";
import { ReactiveCompact } from "../../context/reactive-compact.js";
import { measureRecoveryInput, recoveryReason, reduceHistoricalImages, rebaseMessageBoundary } from "../../context/request-recovery.js";
import type { Message } from "../../core/types.js";

const response = { type: "text" as const, text: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
const bodyError = new Error("413 Failed to buffer the request body: length limit exceeded");
export function imageHistory(count = 30): Message[] {
  const messages: Message[] = [{ role: "user", content: "Make the video. Preserve the agreed narration and verify the final artifact." }];
  for (let i = 0; i < count; i++) {
    messages.push({ role: "assistant", content: `Observation ${i}`, toolCalls: [{ id: `r${i}`, name: "read_file", arguments: { path: `/images/${i}.png` } }] });
    messages.push({ role: "tool_result", toolCallId: `r${i}`, content: `Loaded ${i}`, contentBlocks: [
      { type: "image", base64: "YQ==".repeat(1024), mediaType: "image/png", source: `/images/${i}.png`, filePath: `/images/${i}.png` },
    ] });
  }
  return messages;
}

describe("request recovery contract", () => {
  it("separates body limits, token limits, and invalid requests", () => {
    expect(recoveryReason(bodyError)).toBe("request_body");
    expect(recoveryReason({ status: 413 })).toBe("request_body");
    expect(recoveryReason(new Error("maximum context length exceeded"))).toBe("context_tokens");
    for (const text of ["400 invalid JSON", "Unexpected end of JSON input", "failed to parse the request body", "401 token limit", "429 request too large"]) {
      expect(recoveryReason(new Error(text))).toBeUndefined();
    }
  });

  it("reduces image bytes even when breadcrumb text grows, without dropping narrative or latest image group", () => {
    const history = imageHistory();
    const result = reduceHistoricalImages(history);
    expect(measureRecoveryInput(result).imageBytes).toBeLessThan(measureRecoveryInput(history).imageBytes);
    expect(result).toHaveLength(history.length);
    expect(result[0]).toEqual(history[0]);
    expect(result.at(-1)).toEqual(history.at(-1));
    for (let i = 0; i < history.length; i++) expect(result[i].content).toContain(history[i].content);
    expect(result[2].content).toContain("base64-sha256=");
    expect(history[2].contentBlocks?.[0].type).toBe("image");
  });

  it("protects all images in the latest parallel tool group and user attachments", () => {
    const history = imageHistory(3);
    const latest = history.pop()!;
    history.push({ ...latest, toolCallId: "parallel1" }, { ...latest, toolCallId: "parallel2" });
    history.unshift({ role: "user", content: "reference", contentBlocks: latest.contentBlocks });
    const result = reduceHistoricalImages(history);
    expect(result[0]).toEqual(history[0]);
    expect(result.slice(-2)).toEqual(history.slice(-2));
  });

  it("does not resend a known failed payload before shrinking it", async () => {
    const history = imageHistory();
    let calls = 0;
    const notices: unknown[] = [];
    const result = await new ReactiveCompact({ onRetry: n => notices.push(n) }).callWithCompaction({
      async call(messages) {
        calls++;
        expect(measureRecoveryInput(messages).messageBytes).toBeLessThan(measureRecoveryInput(history).messageBytes);
        return response;
      },
    }, history, undefined, undefined, { initialError: bodyError });
    expect(calls).toBe(1);
    expect(notices).toHaveLength(1);
    expect(result.compacted).toBe(true);
  });

  it("stops immediately without progress rather than claiming two compactions", async () => {
    let calls = 0;
    let notices = 0;
    const compact = new ReactiveCompact({ onRetry: () => notices++ });
    await expect(compact.callWithCompaction({ async call() { calls++; throw bodyError; } }, [
      { role: "user", content: "short" },
    ])).rejects.toThrow("no further safe media reduction");
    expect(calls).toBe(1);
    expect(notices).toBe(0);
  });

  it("does not compact ordinary bad requests", async () => {
    let calls = 0;
    await expect(new ReactiveCompact().callWithCompaction({ async call() {
      calls++;
      throw new Error("400 invalid JSON");
    } }, imageHistory())).rejects.toThrow("400 invalid JSON");
    expect(calls).toBe(1);
  });

  it("never folds transient state into a persisted summary", async () => {
    const history: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: "transient secret sentinel", cache: { transient: true } },
      { role: "user", content: "x".repeat(24000) },
      ...Array.from({ length: 8 }, (_, i): Message => ({ role: "assistant", content: `message ${i}` })),
    ];
    const result = await new ReactiveCompact().callWithCompaction({ async call() { return response; } },
      history, undefined, undefined, { initialError: new Error("context length exceeded") });
    expect(result.messages.some(m => m.cache?.transient && m.content.includes("sentinel"))).toBe(true);
    expect(result.messages.filter(m => !m.cache?.transient).some(m => m.content.includes("sentinel"))).toBe(false);
  });

  it("does not commit a candidate after cancellation", async () => {
    const controller = new AbortController();
    let committed = false;
    await expect(new ReactiveCompact().callWithCompaction({ async call() {
      controller.abort();
      return response;
    } }, imageHistory(), undefined, { signal: controller.signal }, {
      initialError: bodyError, onRecovered: () => { committed = true; },
    })).rejects.toThrow();
    expect(committed).toBe(false);
  });
});

it("does not retry or commit media reduction for a JSON character offset of 413", async () => {
  let calls = 0;
  let commits = 0;
  await expect(new ReactiveCompact().callWithCompaction({ async call() {
    calls++;
    throw new SyntaxError("Unexpected token '}', invalid JSON at position 413");
  } }, imageHistory(), undefined, undefined, { onRecovered: () => { commits++; } })).rejects.toThrow("position 413");
  expect(calls).toBe(1);
  expect(commits).toBe(0);
});


it("rebases stable context by ordered suffix when user messages repeat", () => {
  const history: Message[] = [
    { role: "user", content: "old task" },
    { role: "user", content: "continue" },
    { role: "assistant", content: "first response" },
    { role: "user", content: "continue" },
  ];
  const reduced = [{ role: "user" as const, content: "summary" }, ...history.slice(1)];
  expect(rebaseMessageBoundary(history, reduced, 1)).toBe(1);
});
