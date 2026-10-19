import { expect, it } from "bun:test";
import { ConversationManager } from "../../memory/conversation.js";

function fixture(maxMessages = Infinity) {
  const conversation = new ConversationManager({ maxMessages });
  conversation.add({ role: "system", content: "system" });
  for (let i = 0; i < 6; i++) conversation.add({ role: "user", content: `message ${i}` });
  conversation.setProviderViewStart(4);
  return conversation;
}

it("keeps recovery floor through appends, cache edits and token budget changes", () => {
  const c = fixture();
  expect(c.getAllMessages()).toHaveLength(7);
  expect(c.getMessages().map(m => m.content)).toEqual(["system", "message 3", "message 4", "message 5"]);
  c.mutateInPlace(messages => { for (const m of messages) m.cache = undefined; });
  c.setMaxTokens(1000000);
  c.add({ role: "assistant", content: "new answer" });
  expect(c.getMessages().map(m => m.content)).toEqual(["system", "message 3", "message 4", "message 5", "new answer"]);
});

it("resets recovery floor when a different session replaces the same message shape", () => {
  const c = fixture();
  c.mutateInPlace(messages => messages.splice(0, messages.length,
    ...messages.map(m => ({ ...m, content: `another ${m.content}` }))));
  expect(c.getMessages()).toHaveLength(7);
  expect(c.getMessages()[1].content).toBe("another message 0");
});

it("repositions the recovery floor after count pruning and clears it on rewind past the anchor", () => {
  const c = fixture(7);
  c.add({ role: "assistant", content: "new answer" });
  expect(c.getAllMessages()).toHaveLength(7);
  expect(c.getMessages().map(m => m.content)).toEqual(["system", "message 3", "message 4", "message 5", "new answer"]);
  c.truncateAfter(2);
  expect(c.getMessages().map(m => m.content)).toEqual(["system", "message 1"]);
  c.clear();
  c.add({ role: "user", content: "fresh" });
  expect(c.getMessages().map(m => m.content)).toEqual(["fresh"]);
});

it("rounds a recovery floor inside a tool group back to its assistant", () => {
  const c = new ConversationManager({ maxMessages: Infinity });
  c.add({ role: "user", content: "old" });
  c.add({ role: "assistant", content: "read", toolCalls: [{ id: "r", name: "read", arguments: {} }] });
  c.add({ role: "tool_result", toolCallId: "r", content: "result" });
  c.setProviderViewStart(2);
  expect(c.getMessages().map(m => m.role)).toEqual(["assistant", "tool_result"]);
});


it("does not promote a historical system message when the recovery floor skips its prefix", () => {
  const c = new ConversationManager({ maxMessages: Infinity });
  c.add({ role: "system", content: "trusted" });
  c.add({ role: "user", content: "hidden" });
  c.add({ role: "system", content: "historical" });
  c.add({ role: "user", content: "active" });
  c.setProviderViewStart(2);
  expect(c.getMessages().map(m => m.content)).toEqual(["trusted", "active"]);
  expect(c.getAllMessages().map(m => m.content)).toEqual(["trusted", "hidden", "historical", "active"]);
});
