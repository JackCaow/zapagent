import { expect, it } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import { REQUIRED_COMPACT_SUMMARY_HEADINGS } from "../../context/autocompact.js";
import type { LLMProvider } from "../../core/llm.js";
import type { ImageContent } from "../../core/types.js";
import { ConversationManager } from "../../memory/conversation.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

function frame(index: number): ImageContent {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.write("IHDR", 12);
  header.writeUInt32BE(1920, 16);
  header.writeUInt32BE(1080, 20);
  return { type: "image", mediaType: "image/png", filePath: `/frames/${index}.png`,
    source: "fixture", base64: header.toString("base64") };
}

for (const managed of [false, true]) {
  it(`compacts image-heavy history at its model token watermark (managed=${managed})`, async () => {
    const registry = new ToolRegistry();
    registry.register({ definition: { name: "read_frame", description: "Read a video frame",
      parameters: z.object({ frame: z.number() }), readOnly: true },
    handler: async (args) => ({ success: true, output: `frame ${args.frame}`,
      contentBlocks: [frame(args.frame as number)] }) });
    let calls = 0;
    let summaries = 0;
    const compactStarts: Array<Record<string, unknown>> = [];
    const provider: LLMProvider = {
      getImageTokenContext: () => ({ model: "deepseek-flash" }),
      async call() {
        const index = calls++;
        return index < 14
          ? { type: "tool_call", text: "", toolCalls: [{ id: `frame-${index}`, name: "read_frame", arguments: { frame: index } }],
              usage: { inputTokens: 1, outputTokens: 1 } }
          : { type: "text", text: "frames verified", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const summarizer: LLMProvider = { async call() {
      summaries++;
      return { type: "text", text: REQUIRED_COMPACT_SUMMARY_HEADINGS.map(heading => `# ${heading}\nKeep inspecting the remaining frames.`).join("\n\n"),
        usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    const agent = new LoopAgent({ provider, summarizer, registry, executor: new ToolExecutor(registry),
      ...(managed ? { conversation: new ConversationManager({ maxMessages: Infinity }) } : {}),
      systemPrompt: "Inspect all frames.", maxSteps: 20, reserveSteps: 0,
      autoCompactThreshold: 1_000_000, autoCompactTokenThreshold: 12_000,
      contextWindow: 100_000, reservedOutputTokens: 1000 });
    agent.on("observation", event => {
      if (event.type === "observation" && event.kind === "autocompact_start") compactStarts.push(event.detail!);
    });

    const result = await agent.run("Inspect fourteen distinct frames in order.");
    expect(result.text).toBe("frames verified");
    expect(calls).toBe(15);
    expect(summaries).toBe(1);
    expect(compactStarts).toHaveLength(1);
    expect(compactStarts[0]!.trigger).toBe("tokens");
    expect(compactStarts[0]!.tokenEstimate as number).toBeGreaterThan(12_000);
    expect(compactStarts[0]!.charCount as number).toBeLessThan(12_000);
  });
}
