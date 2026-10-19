import { describe, expect, it } from "vitest";
import { createAuthSyncEvent, parseAuthSyncEvent } from "./auth-sync";

describe("auth session synchronization", () => {
  it("creates a credential-free versioned event", () => {
    const event = createAuthSyncEvent("authenticated");
    expect(event).toMatchObject({ version: 1, type: "authenticated" });
    expect(event.id).not.toBe("");
    expect(JSON.stringify(event)).not.toMatch(/token|cookie|csrf|project/i);
  });

  it("accepts only supported authentication transitions", () => {
    expect(parseAuthSyncEvent({ version: 1, id: "event-1", type: "signed-out", timestamp: 1 }))
      .toEqual({ version: 1, id: "event-1", type: "signed-out", timestamp: 1 });
    expect(parseAuthSyncEvent({ version: 2, id: "event-1", type: "signed-out", timestamp: 1 })).toBeUndefined();
    expect(parseAuthSyncEvent({ version: 1, id: "event-1", type: "refresh-token", timestamp: 1 })).toBeUndefined();
    expect(parseAuthSyncEvent("authenticated")).toBeUndefined();
  });
});
