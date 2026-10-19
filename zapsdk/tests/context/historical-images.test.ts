import { describe, expect, it } from "bun:test";
import type { Message } from "../../core/types.js";
import { HistoricalImageRetention, imagePayloadBytes, retireHistoricalImages } from "../../context/historical-images.js";
import { ConversationManager } from "../../memory/conversation.js";

const policy = { highWaterBytes: 24_000, lowWaterBytes: 8_000, keepRecentGroups: 2 };
function frame(id: number): Message[] {
  return [
    { role: "assistant", content: `Observed frame ${id}`, toolCalls: [{ id: `f${id}`, name: "read", arguments: {} }] },
    { role: "tool_result", toolCallId: `f${id}`, content: `Loaded frame ${id}`, contentBlocks: [
      { type: "image", mediaType: "image/png", source: "/frame.png", filePath: "/frame.png", base64: "YQ==".repeat(1000) },
    ] },
  ];
}
const history = (n: number) => Array.from({ length: n }, (_, i) => frame(i)).flat();

describe("historical image cache epochs", () => {
  it("retires a batch at the high watermark, then leaves the whole prefix unchanged as images arrive", () => {
    const retention = new HistoricalImageRetention(policy);
    const original = history(6);
    const before = JSON.stringify(original);
    const first = retention.prepare(original)!;
    expect(first.retiredGroups).toBe(4);
    expect(first.afterImageBytes).toBe(8000);
    expect(first.messages.slice(-4)).toEqual(original.slice(-4));
    expect(JSON.stringify(original)).toBe(before);
    let next = first.messages;
    const prefix = JSON.stringify(next);
    for (let i = 6; i < 9; i++) {
      next = [...next, ...frame(i)];
      expect(retention.prepare(next)).toBeUndefined();
      expect(JSON.stringify(next.slice(0, original.length))).toBe(prefix);
    }
    const second = retention.prepare([...next, ...frame(9)])!;
    expect(second.retiredGroups).toBe(4);
    expect(second.afterImageBytes).toBe(8000);
    expect(second.messages.slice(0, 8)).toEqual(first.messages.slice(0, 8));
    expect(second.messages.at(-1)?.contentBlocks?.[0].type).toBe("image");
  });

  it("retires an entire parallel tool group even when the target is reached mid-group", () => {
    const original = history(3);
    original.splice(2, 0, { ...frame(99)[1], toolCallId: "parallel" });
    const result = retireHistoricalImages(original, 12_000, 1);
    expect(result.retiredGroups).toBe(1);
    expect(imagePayloadBytes(result.messages.slice(0, 3))).toBe(0);
    expect(imagePayloadBytes(result.messages)).toBe(8000);
  });

  it("keeps user attachments and waits a growth interval when protected images exceed the budget", () => {
    const retention = new HistoricalImageRetention(policy);
    const user: Message = { ...frame(99)[1], role: "user", toolCallId: undefined,
      contentBlocks: [{ type: "image", mediaType: "image/png", source: "/frame.png", filePath: "/frame.png", base64: "YQ==".repeat(8000) }] };
    const first = retention.prepare([user, ...history(3)])!;
    expect(first.messages[0]).toEqual(user);
    expect(first.afterImageBytes).toBe(40_000);
    expect(first.nextSweepAtBytes).toBe(56_000);
    expect(retention.prepare([...first.messages, ...frame(3)])).toBeUndefined();
    retention.reset();
    expect(retention.prepare([...first.messages, ...frame(3)])?.retiredGroups).toBe(1);
  });

  it("does not change transient input or emit another batch when no images are eligible", () => {
    const retention = new HistoricalImageRetention(policy);
    const original = history(2).map(m => ({ ...m, cache: { transient: true } }));
    original.push({ role: "user", content: "attachment", cache: { transient: true }, contentBlocks: [
      { type: "image", mediaType: "image/png", source: "/frame.png", filePath: "/frame.png", base64: "YQ==".repeat(8000) },
    ] });
    expect(retention.prepare(original)?.messages).toBe(original);
    expect(retention.prepare(original)).toBeUndefined();
  });

  it("keeps retired references and text stable, including re-reading the same path", () => {
    const original = history(6);
    const result = new HistoricalImageRetention(policy).prepare(original)!;
    original.forEach((m, i) => expect(result.messages[i].content).toContain(m.content));
    expect(result.messages[1].content).toContain('"/frame.png"');
    expect(result.messages[1].content).toContain("base64-sha256=");
    expect(result.messages.at(-1)?.contentBlocks).toEqual(original.at(-1)?.contentBlocks);
  });

  it("rejects invalid watermarks instead of silently evicting every step", () => {
    for (const invalid of [{ lowWaterBytes: 24_000 }, { highWaterBytes: Infinity }, { keepRecentGroups: 0 }]) {
      expect(() => new HistoricalImageRetention({ ...policy, ...invalid })).toThrow();
    }
  });

  it("persists reductions in the conversation without resurrecting hidden history", () => {
    const conversation = new ConversationManager({ maxMessages: Infinity, imageRetention: policy });
    history(9).forEach(m => conversation.add(m));
    conversation.setProviderViewStart(6);
    const hidden = conversation.getAllMessages().slice(0, 6);
    expect(conversation.maintainHistoricalImages()?.retiredGroups).toBe(4);
    expect(conversation.getAllMessages().slice(0, 6)).toEqual(hidden);
    expect(conversation.getMessages()[0].toolCalls?.[0].id).toBe("f3");
    const prefix = conversation.getMessages();
    frame(9).forEach(m => conversation.add(m));
    expect(conversation.maintainHistoricalImages()).toBeUndefined();
    expect(conversation.getMessages().slice(0, prefix.length)).toEqual(prefix);
    conversation.clear();
    history(6).forEach(m => conversation.add(m));
    expect(conversation.maintainHistoricalImages()?.retiredGroups).toBe(4);
  });

  it("supports disabling proactive retirement independently of error recovery", () => {
    const conversation = new ConversationManager({ maxMessages: Infinity, imageRetention: false });
    history(6).forEach(m => conversation.add(m));
    expect(conversation.maintainHistoricalImages()).toBeUndefined();
    expect(imagePayloadBytes(conversation.getAllMessages())).toBe(24_000);
  });

  for (const operation of ["replace", "rewind"] as const) it(`resets the media epoch after ${operation} without resetting on cache hint edits`, () => {
    const conversation = new ConversationManager({ maxMessages: Infinity, imageRetention: policy });
    const user: Message = { role: "user", content: "large attachment", contentBlocks: [
      { type: "image", mediaType: "image/png", source: "/user.png", filePath: "/user.png", base64: "YQ==".repeat(10000) },
    ] };
    conversation.add(user);
    history(3).forEach(m => conversation.add(m));
    expect(conversation.maintainHistoricalImages()?.nextSweepAtBytes).toBe(64_000);
    // Repeated provider calls may update cache hints. This must not start a new epoch.
    conversation.mutateInPlace(messages => { for (const m of messages) m.cache = { ...(m.cache ?? {}), transient: false }; });
    frame(3).forEach(m => conversation.add(m));
    expect(conversation.maintainHistoricalImages()).toBeUndefined();
    if (operation === "replace") conversation.mutateInPlace(messages => messages.splice(0, messages.length, ...history(6)));
    else { conversation.truncateAfter(0); history(6).forEach(m => conversation.add(m)); }
    expect(conversation.maintainHistoricalImages()?.retiredGroups).toBe(4);
    expect(imagePayloadBytes(conversation.getMessages())).toBe(8_000);
  });
});
