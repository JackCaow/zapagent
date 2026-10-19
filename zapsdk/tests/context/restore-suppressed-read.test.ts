import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { AgentEventEmitter } from "../../agent/events.js";
import { executeNonStreamingTurn } from "../../agent/nonstreaming-tool-executor.js";
import { createRunToolExecutionHooks } from "../../agent/tool-execution-guards.js";
import { restoreRecentFiles } from "../../context/restore-files.js";
import { buildToolTurn, turnToMessages } from "../../core/turn.js";
import type { Message } from "../../core/types.js";
import { ConversationManager } from "../../memory/conversation.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zap-restore-duplicate-"));
  const path = join(root, "source.txt");
  await writeFile(path, "ACTUAL_AUTHORIZED_SNAPSHOT");
  let readCount = 0;
  let failRead = false;
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "read_file", description: "read fixture", permission: "auto", readOnly: true, parameters: z.object({ path: z.string() }) },
    handler: async args => {
      readCount++;
      return failRead
        ? { success: false, output: "", error: "Fixture access denied" }
        : { success: true, output: await readFile(String(args.path), "utf8") };
    },
  });
  const executor = new ToolExecutor(registry);
  const hooks = createRunToolExecutionHooks(executor, () => {}, "off", false);
  const messages: Message[] = [];
  let index = 0;
  async function executeRead() {
    const call = { id: `read-${index++}`, name: "read_file", arguments: { path } };
    const turn = await executeNonStreamingTurn({ type: "tool_call", text: "", toolCalls: [call], usage: { inputTokens: 0, outputTokens: 0 } },
      { executor, emitter: new AgentEventEmitter(), sessionId: "restore-duplicate" }, index, undefined, hooks);
    const result = turn.results.get(call.id)!;
    messages.push(...turnToMessages(buildToolTurn({ text: "", completed: [{ ...call, result }] })));
    return result;
  }
  return { root, messages, executeRead, readCount: () => readCount,
    invalidateAndDeny() { failRead = true; hooks.afterExecute?.("write_file", { path }, { success: true, output: "changed" }); } };
}

describe("restoring suppressed reads", () => {
  it("retains the actual read snapshot after an executed duplicate guard", async () => {
    const f = await fixture();
    try {
      await f.executeRead();
      const suppressed = await f.executeRead();
      expect(f.readCount()).toBe(1);
      expect(suppressed.runtime?.suppression).toBe("duplicate");
      expect(f.messages[3]?.toolResultSuppression).toBe("duplicate");
      const restored = await restoreRecentFiles(f.messages);
      expect(restored).toContain("ACTUAL_AUTHORIZED_SNAPSHOT");
      expect(restored).not.toContain("Duplicate read_file suppressed");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("preserves suppression through JSON, legacy add, and message rederivation", async () => {
    const f = await fixture();
    try {
      await f.executeRead(); await f.executeRead();
      const persisted: Message[] = JSON.parse(JSON.stringify(f.messages));
      // Change display text so the regression cannot depend on English wording.
      persisted[3]!.content = "显示文案可变";
      const cm = new ConversationManager({ maxMessages: 100 });
      persisted.forEach(message => cm.add(message));
      cm.mutateInPlace(() => {});
      expect(cm.getAllMessages()[3]?.toolResultSuppression).toBe("duplicate");
      expect(await restoreRecentFiles(cm.getAllMessages())).toContain("ACTUAL_AUTHORIZED_SNAPSHOT");
      expect(await restoreRecentFiles(cm.getAllMessages())).not.toContain("显示文案可变");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("still blocks old snapshots after a real failed read following suppression", async () => {
    const f = await fixture();
    try {
      await f.executeRead(); await f.executeRead();
      f.invalidateAndDeny();
      const failed = await f.executeRead();
      expect(failed.success).toBe(false);
      expect(failed.runtime?.suppression).toBeUndefined();
      expect(f.readCount()).toBe(2);
      expect(await restoreRecentFiles(f.messages)).toBeNull();
      const cm = new ConversationManager({ maxMessages: 100 });
      f.messages.forEach(message => cm.add(message));
      cm.mutateInPlace(() => {});
      expect(await restoreRecentFiles(cm.getAllMessages())).toBeNull();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
