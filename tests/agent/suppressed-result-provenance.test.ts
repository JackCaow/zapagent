import { describe, expect, it } from "bun:test";
import { createRunHandlers } from "../../src/agent/wireRunHandlers.js";
import type { ToolCallInfo } from "../../src/ui/types.js";
import { AgentEventEmitter } from "../../zapsdk/agent/events.js";

describe("suppressed tool result log provenance", () => {
  for (const path of [undefined, ["child"]]) it(`preserves duplicate provenance for ${path ? "child" : "root"} results`, () => {
    const agent = new AgentEventEmitter();
    const logs: ToolCallInfo[] = [];
    createRunHandlers({
      currentConfig: { providers: [], active: { providerId: "", model: "" }, serperKey: "",
        maxTokens: 100, maxSteps: 10, customSystemPrompt: "",
        compaction: { auto: true, prune: true, reserved: 0 }, mcpServers: [], permissionMode: "default" },
      controller: new AbortController(), preview: { interruptPreviews: () => {} } as any,
      setStatus: () => {}, setStep: () => {}, setActiveTool: () => {}, setActiveToolBytes: () => {},
      setContextTokens: () => {}, setContextPending: () => {}, compactLogs: () => {},
      addLog: (_type, _text, tool) => { if (tool) logs.push(tool); },
      replaceLog: (_id, _type, _text, tool) => { if (tool) logs.push(tool); },
      peekNextLogId: () => 1,
    }).wire(agent);
    agent.emit({ type: "content_final", kind: "tool_call", id: "repeat", toolName: "read_file",
      step: 1, arguments: { path: "source.ts" }, ...(path ? { path } : {}) });
    agent.emit({ type: "content_final", kind: "tool_result", id: "repeat", toolName: "read_file",
      step: 1, result: { success: true, output: "duplicate notice", runtime: { suppression: "duplicate" } },
      ...(path ? { path } : {}) });
    expect(logs.at(-1)?.suppression).toBe("duplicate");
    expect(logs.at(-1)?.success).toBe(true);
  });
});
