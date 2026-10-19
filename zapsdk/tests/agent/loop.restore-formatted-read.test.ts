import { expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import { restoreRecentFiles } from "../../context/restore-files.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMResponse, Message } from "../../core/types.js";
import { ConversationManager } from "../../memory/conversation.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

for (const transport of ["call", "stream", "xml"] as const) {
  for (const scenario of ["unchanged", "changed", "denied", "recovered"] as const) {
    it(`restores real snapshots after formatted rereads (${transport}, ${scenario})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "zap-formatted-read-"));
      const path = join(root, "source.txt");
      const original = "ORIGINAL_AUTHORIZED_SNAPSHOT";
      const changed = "CHANGED_AUTHORIZED_SNAPSHOT";
      let reads = 0, mutations = 0, calls = 0;
      const registry = new ToolRegistry();
      registry.register({
        definition: { name: "read_file", description: "Read fixture", readOnly: true,
          parameters: z.object({ path: z.string() }) },
        handler: async () => {
          reads++;
          return (scenario === "denied" && mutations > 0) || (scenario === "recovered" && mutations === 1)
            ? { success: false, output: "", error: "Fixture access denied" }
            : { success: true, output: await readFile(path, "utf8") };
        },
      });
      registry.register({
        definition: { name: "mutate_fixture", description: "Write fixture", readOnly: false,
          parameters: z.object({}) },
        handler: async () => {
          mutations++;
          // Invalidates execution-time deduplication even if source.txt is unchanged.
          await writeFile(scenario === "changed" ? path : join(root, "other.txt"), changed);
          return { success: true, output: "Updated fixture" };
        },
      });
      const response = (): LLMResponse => {
        const index = calls++;
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (index >= (scenario === "denied" || scenario === "recovered" ? 5 : 3)) return { type: "text", text: "done", usage };
        const name = index % 2 ? "mutate_fixture" : "read_file";
        const args = name === "read_file" ? { path } : {};
        return transport === "xml"
          ? { type: "text", text: `<tool_call>${name}${name === "read_file" ? `<arg_key>path</arg_key><arg_value>${path}</arg_value>` : ""}</tool_call>`, usage }
          : { type: "tool_call", text: "", toolCalls: [{ id: `call-${index}`, name, arguments: args }], usage };
      };
      const provider: LLMProvider = { async call() { return response(); } };
      if (transport === "stream") provider.stream = async function* () {
        const result = response();
        for (const call of result.toolCalls ?? []) {
          yield { type: "tool_call_start", toolCallId: call.id, toolName: call.name };
          yield { type: "tool_call_delta", toolCallId: call.id, partialJson: JSON.stringify(call.arguments) };
          yield { type: "tool_call_end", toolCallId: call.id };
        }
        if (result.text) yield { type: "text_delta", text: result.text };
        yield { type: "done", usage: result.usage };
      };
      const conversation = new ConversationManager({ maxMessages: 100 });
      const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), conversation,
        taskDecomposition: "off", maxSteps: 10, reserveSteps: 0, storageProjectCwd: root });
      const eventResults: unknown[] = [];
      agent.on("content_final", event => {
        if (event.type === "content_final" && event.kind === "tool_result") {
          eventResults.push(structuredClone(event.result));
        }
      });
      try {
        await writeFile(path, original);
        const result = await agent.run("Read source, update the fixture, and reread source.");
        expect(result.text).toBe("done");
        expect(reads).toBe(scenario === "denied" || scenario === "recovered" ? 3 : 2);
        // Formatting must not relabel actual executions as suppressed tool calls.
        expect(result.toolResults).toEqual(eventResults);
        expect(result.toolResults.every(result => !result.runtime?.suppression)).toBe(true);
        const messages = conversation.getAllMessages();
        const reread = messages.filter(message => message.role === "tool_result").at(-1)!;
        expect(reread.toolResultSuppression).toBe(scenario === "unchanged" ? "duplicate" : undefined);
        expect(reread.toolResultSuccess).toBe(scenario !== "denied");
        if (scenario === "unchanged") expect(reread.content).toContain("File already read");

        // Exercise both the live view and persisted message reconstruction.
        const restoredConversation = new ConversationManager({ maxMessages: 100 });
        const persisted: Message[] = JSON.parse(JSON.stringify(messages));
        persisted.forEach(message => restoredConversation.add(message));
        restoredConversation.mutateInPlace(() => {});
        for (const view of [messages, restoredConversation.getAllMessages()]) {
          const restored = await restoreRecentFiles(view);
          if (scenario === "denied") expect(restored).toBeNull();
          else {
            expect(restored).toContain(scenario === "changed" ? changed : original);
            expect(restored).not.toContain("File already read");
            if (scenario === "changed") expect(restored).not.toContain(original);
          }
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
}
