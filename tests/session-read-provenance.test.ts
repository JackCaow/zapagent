import { describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sessionLogsToTurns, type SessionLog } from "../src/session.js"
import { turnsToMessages } from "../zapsdk/core/turn.js"
import { ConversationManager } from "../zapsdk/memory/conversation.js"
import { restoreRecentFiles } from "../zapsdk/context/restore-files.js"

function readLogs(id: string, success: boolean | undefined, output: string): SessionLog[] {
  return [
    { type: "tool", text: "read_file", tool: { id, name: "read_file", arguments: { path: "/virtual/private.txt" } } },
    { type: "result", text: output, tool: { id, name: "read_file", output, success } },
    { type: "agent", text: "Read attempt complete." },
  ]
}

describe("session read result provenance", () => {
  for (const sample of [
    { name: "denied", success: false, output: "Permission denied" },
    { name: "failed", success: false, output: "Read failed: unavailable" },
    { name: "legacy unknown", success: undefined, output: "unproven historical output" },
    { name: "successful", success: true, output: "authorized historical contents" },
  ]) {
    it(`preserves ${sample.name} status through turns, messages, and conversation reconstruction`, async () => {
      const turns = sessionLogsToTurns(readLogs("read-1", sample.success, sample.output))
      const toolTurn = turns.find(turn => turn.kind === "tool_turn")
      if (toolTurn?.kind !== "tool_turn") throw new Error("missing restored tool turn")
      expect(toolTurn.calls[0]!.resultStatusUnknown).toBe(sample.success === undefined ? true : undefined)
      if (sample.success !== undefined) expect(toolTurn.calls[0]!.result.success).toBe(sample.success)

      const messages = turnsToMessages(turns)
      expect(messages.find(message => message.role === "tool_result")?.toolResultSuccess).toBe(sample.success)
      const conversation = new ConversationManager({ maxMessages: 100 })
      for (const message of messages) conversation.add(message)
      conversation.mutateInPlace(() => {})
      const restored = await restoreRecentFiles(conversation.getAllMessages())
      if (sample.success === true) expect(restored).toContain(sample.output)
      else expect(restored).toBeNull()
    })
  }

  it("does not revive an earlier successful read after a later denied or unknown attempt", async () => {
    for (const success of [false, undefined]) {
      const logs = [
        ...readLogs("old", true, "old authorized snapshot"),
        ...readLogs("new", success, "latest unproven output"),
      ]
      expect(await restoreRecentFiles(turnsToMessages(sessionLogsToTurns(logs)))).toBeNull()
    }
  })

  it("preserves status and duplicate suppression through persisted resume and session fork", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-provenance-"))
    try {
      const script = `
        import { setActiveSession, getCurrentSessionId, loadSavedSession, sessionLogsToTurns } from "./src/session.ts";
        import { turnsToMessages } from "./zapsdk/core/turn.ts";
        import { restoreRecentFiles } from "./zapsdk/context/restore-files.ts";
        const logs = [false, undefined, true].map((success, index) => ({
          type: "result", text: "snapshot-" + index,
          tool: { id: "read-" + index, name: "read_file", arguments: { path: "/virtual/" + index }, output: "snapshot-" + index, success },
        }));
        logs.push({ type: "agent", text: "Read attempts complete." });
        logs.push({
          type: "result", text: "Duplicate tool call suppressed",
          tool: { id: "duplicate-read", name: "read_file", arguments: { path: "/virtual/2" },
            output: "Duplicate tool call suppressed", success: true, suppression: "duplicate" },
        });
        setActiveSession(logs);
        const sourceId = getCurrentSessionId();
        const resumed = loadSavedSession(sourceId);
        setActiveSession(resumed, { sourceSessionId: sourceId });
        const forked = loadSavedSession(getCurrentSessionId());
        const result = [];
        for (const restoredLogs of [resumed, forked]) {
          const messages = turnsToMessages(sessionLogsToTurns(restoredLogs));
          result.push({
            statuses: messages.filter(m => m.role === "tool_result").map(m => m.toolResultSuccess ?? null),
            suppressions: messages.filter(m => m.role === "tool_result").map(m => m.toolResultSuppression ?? null),
            restored: await restoreRecentFiles(messages),
          });
        }
        console.log(JSON.stringify(result));
      `
      const results = JSON.parse(execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
        timeout: 10000,
      })) as Array<{ statuses: Array<boolean | null>; suppressions: Array<string | null>; restored: string }>
      expect(results.length).toBe(2)
      for (const result of results) {
        expect(result.statuses).toEqual([false, null, true, true])
        expect(result.suppressions).toEqual([null, null, null, "duplicate"])
        expect(result.restored).toContain("snapshot-2")
        expect(result.restored).not.toContain("snapshot-0")
        expect(result.restored).not.toContain("snapshot-1")
        expect(result.restored).not.toContain("Duplicate tool call suppressed")
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
