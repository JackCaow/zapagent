import { describe, expect, it } from "bun:test";
import { LoopAgent } from "../../agent/loop.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMResponse, ToolCallRequest } from "../../core/types.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

const unusedProvider: LLMProvider = {
  async call(): Promise<LLMResponse> {
    throw new Error("not used in this test");
  },
};

function makeAgent(): LoopAgent {
  const registry = new ToolRegistry();
  return new LoopAgent({
    provider: unusedProvider,
    registry,
    executor: new ToolExecutor(registry),
  });
}

function formatRead(
  agent: LoopAgent,
  output: string,
  seenFiles: Map<string, string>,
): string {
  const toolCall: ToolCallRequest = {
    id: "read-1",
    name: "read_file",
    arguments: { path: "/tmp/example.ts" },
  };
  return (agent as any).formatResult(
    toolCall,
    { success: true, output },
    new Map(),
    seenFiles,
  ).formattedOutput as string;
}

describe("LoopAgent file-read deduplication", () => {
  it("folds an identical repeated read", () => {
    const agent = makeAgent();
    const seenFiles = new Map<string, string>();
    const output = `${"shared prefix ".repeat(8)}original tail`;

    expect(formatRead(agent, output, seenFiles)).toContain(output);
    expect(formatRead(agent, output, seenFiles)).toContain(
      "File already read",
    );
  });

  it("preserves a changed reread when only the tail differs", () => {
    const agent = makeAgent();
    const seenFiles = new Map<string, string>();
    const sharedPrefix = "x".repeat(80);
    const original = `${sharedPrefix}\nconst state = \"before\";`;
    const changed = `${sharedPrefix}\nconst state = \"after\";`;

    formatRead(agent, original, seenFiles);
    const formatted = formatRead(agent, changed, seenFiles);

    expect(formatted).toContain(changed);
    expect(formatted).not.toContain("File already read");
  });
});
