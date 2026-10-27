import { describe, expect, it } from "bun:test";
import { requestCacheShape, RequestCacheTracker, scopeRequestCacheShape } from "../../context/request-cache.js";
import { ConversationManager } from "../../memory/conversation.js";

const shape = (messages: unknown[], rest = {}, protocol = "chat:https://fixture") => requestCacheShape({ model: "model", messages, ...rest }, protocol)!;
describe("serialized request prefix diagnostics", () => {
  it("distinguishes append from an actual rewrite and attributes explicit maintenance", () => {
    const tracker = new RequestCacheTracker(), history = [{ role: "user", content: "task" }];
    expect(tracker.observe(shape(history)).change).toBe("initial");
    history.push({ role: "assistant", content: "answer" });
    const appended = tracker.observe(shape(history));
    expect(appended.change).toBe("append"); expect(appended.commonPrefixMessages).toBe(1);
    tracker.markMaintenance("prune");
    history[0]!.content = "historical preview";
    const changed = tracker.observe(shape(history));
    expect(changed.change).toBe("rewrite"); expect(changed.reason).toBe("prune");
    expect(changed.commonPrefixMessages).toBe(0);
    expect(tracker.observe(shape([...history, { role: "user", content: "continue" }])).change).toBe("append");
  });
  it("isolates connection, model, protocol, endpoint, system and tool schemas", () => {
    const tracker = new RequestCacheTracker(), messages = [{ role: "user", content: "task" }];
    tracker.observe(shape(messages));
    expect(tracker.observe(shape(messages, { model: "other" })).change).toBe("scope_change");
    expect(tracker.observe(shape(messages, { model: "other" }, "responses:https://fixture")).change).toBe("scope_change");
    expect(tracker.observe(shape(messages, { model: "other" }, "responses:https://other")).change).toBe("scope_change");
    const scope = shape(messages);
    tracker.observe(scopeRequestCacheShape(scope, "connection-a"));
    expect(tracker.observe(scopeRequestCacheShape(scope, "connection-b")).change).toBe("scope_change");
    tracker.observe(shape(messages));
    expect(tracker.observe(shape(messages, { tools: [{ name: "new-schema" }] })).change).toBe("shape_change");
    expect(tracker.observe(shape(messages, { system: "new stable system" })).change).toBe("shape_change");
  });
  it("does not confuse cache placement or output budgets with changed token-bearing prefixes", () => {
    const tracker = new RequestCacheTracker();
    tracker.observe(shape([{ role: "user", content: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }] }], { max_tokens: 8192 }));
    expect(tracker.observe(shape([{ role: "user", content: [{ type: "text", text: "stable" }] }], { max_tokens: 1024 })).change).toBe("unchanged");
  });
  it("never labels unsampled tails as verified append, and does not retain source text", () => {
    const messages = Array.from({ length: 300 }, (_, i) => ({ role: "user", content: `PRIVATE_SECRET_TEXT_${i}` }));
    const tracker = new RequestCacheTracker(), first = shape(messages);
    expect(first.messageHashes.length).toBe(256);
    tracker.observe(first); messages[290]!.content = "changed outside sample";
    const observation = tracker.observe(shape(messages));
    expect(observation.change).toBe("unsampled_change"); expect(observation.sampled).toBe(true);
    expect(JSON.stringify([first, observation])).not.toContain("PRIVATE_SECRET_TEXT");
  });
  it("uses actual Responses input items and preserves a baseline across Loop rebuilds until clear", () => {
    const conversation = new ConversationManager({ maxMessages: Infinity });
    const first = requestCacheShape({ model: "fixture", input: [{ type: "function_call", call_id: "c", arguments: "{}", name: "read_file" }] }, "responses")!;
    conversation.requestCacheTracker.observe(first);
    expect(conversation.requestCacheTracker.observe(first).change).toBe("unchanged");
    conversation.clear(); expect(conversation.requestCacheTracker.observe(first).change).toBe("initial");
  });
});
