import { afterEach, describe, expect, it } from "bun:test";
import type { AgentEvent } from "../../agent/events.js";
import { startDevToolsServer, type DevToolsServerHandle } from "../../devtools/server.js";

class FakeAgent {
  handlers = new Set<(event: AgentEvent) => void>();

  on(_type: "*", handler: (event: AgentEvent) => void): void {
    this.handlers.add(handler);
  }

  off(_type: "*", handler: (event: AgentEvent) => void): void {
    this.handlers.delete(handler);
  }

  emit(event: AgentEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

const noopAgent = new FakeAgent();

describe("devtools server auth", () => {
  let handle: DevToolsServerHandle | null = null;

  afterEach(() => {
    handle?.stop();
    handle = null;
  });

  it("requires a token for snapshot data and redacts config", async () => {
    handle = startDevToolsServer({
      port: 0,
      token: "test-token",
      agent: noopAgent,
      getConversation: () => [],
      getSystemPrompt: () => "system",
      getConfig: () => ({
        providers: [{ id: "p1", apiKey: "sk-live" }],
        safe: true,
      }),
    });

    expect(handle.url).toContain("token=test-token");

    const bare = await fetch(`http://127.0.0.1:${handle.port}/snapshot`);
    expect(bare.status).toBe(401);

    const authed = await fetch(`http://127.0.0.1:${handle.port}/snapshot?token=test-token`);
    expect(authed.status).toBe(200);
    const json = await authed.json() as any;
    expect(json.config).toEqual({
      providers: [{ id: "p1", apiKey: "[REDACTED]" }],
      safe: true,
    });
  });

  it("redacts snapshots and buffered events before exposing them", async () => {
    const agent = new FakeAgent();
    const longText = `BEGIN-${"x".repeat(30_000)}-END`;
    handle = startDevToolsServer({
      port: 0,
      token: "test-token",
      agent,
      getConversation: () => [
        {
          role: "assistant",
          content: "about to write",
          toolCalls: [{
            id: "tc_1",
            name: "write_file",
            arguments: { path: "secret.txt", apiKey: "sk-live", content: longText },
          }],
        },
      ],
      getSystemPrompt: () => `Authorization: Bearer sk-live\n${longText}`,
      getConfig: () => ({ token: "cfg-token" }),
    });

    agent.emit({
      type: "content_final",
      kind: "tool_call",
      id: "tc_1",
      step: 1,
      toolName: "write_file",
      arguments: { apiKey: "sk-event", content: longText },
    });

    const response = await fetch(`http://127.0.0.1:${handle.port}/snapshot?token=test-token`);
    expect(response.status).toBe(200);
    const json = await response.json() as any;
    const serialized = JSON.stringify(json);

    expect(serialized).not.toContain("sk-live");
    expect(serialized).not.toContain("sk-event");
    expect(json.config.token).toBe("[REDACTED]");
    expect(json.systemPrompt).toContain("Bearer [REDACTED]");
    expect(json.systemPrompt).toContain("truncated by devtools");
    expect(json.conversation[0].toolCalls[0].arguments.apiKey).toBe("[REDACTED]");
    expect(json.conversation[0].toolCalls[0].arguments.content).toContain("truncated by devtools");
    expect(json.recentEvents[0].event.arguments.apiKey).toBe("[REDACTED]");
    expect(json.recentEvents[0].event.arguments.content).toContain("truncated by devtools");
  });
});
