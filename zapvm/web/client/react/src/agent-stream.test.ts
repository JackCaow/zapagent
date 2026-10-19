import { describe, expect, it } from "vitest";
import { agentStreamSocketURL } from "./agent-stream";

describe("agent stream transport", () => {
  it("builds a same-origin secure WebSocket URL with a resume cursor", () => {
    expect(agentStreamSocketURL("turn-123", 42, { protocol: "https:", host: "agent.example.com" } as Location))
      .toBe("wss://agent.example.com/api/agent/sessions/turn-123/stream/socket?after=42&limit=1000");
  });

  it("escapes task IDs and uses ws for local development", () => {
    expect(agentStreamSocketURL("turn test", 0, { protocol: "http:", host: "127.0.0.1:5173" } as Location))
      .toBe("ws://127.0.0.1:5173/api/agent/sessions/turn%20test/stream/socket?after=0&limit=1000");
  });
});
