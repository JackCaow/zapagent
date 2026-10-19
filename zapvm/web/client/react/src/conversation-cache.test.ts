import { describe, expect, it } from "vitest";
import { isCompleteConversationSnapshot } from "./conversation-cache";

describe("conversation snapshot completeness", () => {
  it("accepts a cache only when fingerprint and ordered turns match", () => {
    expect(isCompleteConversationSnapshot("a", ["turn-1", "turn-2"], "a", ["turn-1", "turn-2"])).toBe(true);
  });

  it("rejects an empty StrictMode cleanup snapshot for a real conversation", () => {
    expect(isCompleteConversationSnapshot("a", [], "a", ["turn-1"])).toBe(false);
  });

  it("rejects stale or differently ordered turns", () => {
    expect(isCompleteConversationSnapshot("old", ["turn-1"], "new", ["turn-1"])).toBe(false);
    expect(isCompleteConversationSnapshot("a", ["turn-2", "turn-1"], "a", ["turn-1", "turn-2"])).toBe(false);
  });
});
