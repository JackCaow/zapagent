import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

for (const managedStorage of [false, true]) {
  it(`rewinds merged restored transcripts with managedStorage=${managedStorage}`, () => {
    const data = mkdtempSync(join(tmpdir(), "zap-restored-rewind-"));
    try {
      // Isolate the session singleton and exercise the same restore order as App.
      const result = spawnSync(process.execPath, ["-e", `
        import assert from "node:assert/strict";
        import { mkdirSync } from "node:fs";
        import { join } from "node:path";
        import * as session from "./src/session.ts";
        import { loadSessionForDialog, commitSessionForDialog, replaceConversationMessages } from "./src/ui/dialog-sessions.tsx";
        import { resolveRewindUiCutoff, rewindDraft } from "./src/ui/dialog-rewind.tsx";
        import { CheckpointManager } from "./zapsdk/checkpoint/index.ts";
        import { ConversationManager } from "./zapsdk/memory/conversation.ts";
        const cwd = join(process.env.ZAPCODE_DATA_DIR, "work");
        mkdirSync(cwd);
        const manager = new CheckpointManager({
          sessionId: session.getCurrentSessionId(), cwd,
          config: { managedStorage: ${managedStorage}, blobDir: join(process.env.ZAPCODE_DATA_DIR, "checkpoints") },
          writeJsonlEntry: entry => session.appendSnapshot(entry.snapshot, true),
        });
        session.appendLog("user", "first prompt");
        for (const chunk of ["one\\n", "two\\n", "three"]) session.appendLog("agent", chunk);
        // One user, three streaming rows, and the live turn divider.
        const point = await manager.beginTurn(2, { journalLogIndex: 4, uiLogIndex: 5 }, "selected prompt");
        session.appendLog("user", "selected prompt");
        session.appendLog("agent", "abandoned answer");
        await manager.makeSnapshot(2);
        // Ordinary hydration still preserves an exact live UI boundary.
        manager.hydrateFromJsonl(session.readCheckpointJournal(session.getCurrentSessionId()));
        assert.equal(manager.getSnapshotById(point.id).uiLogIndex, 5);
        const conversation = new ConversationManager({ maxMessages: 100 });
        let loaded;
        // A second restore also exercises the fork archive, not just source JSONL.
        for (let i = 0; i < 2; i++) {
          loaded = await loadSessionForDialog(session.getCurrentSessionId());
          const forkId = commitSessionForDialog(loaded, conversation);
          manager.setSessionId(forkId);
          manager.hydrateFromJsonl(loaded.metadata.checkpointJournal, { remapToCurrentSession: true });
          const restored = manager.getSnapshotById(point.id);
          assert.equal(restored.uiLogIndex, undefined);
          assert.equal(restored.journalLogIndex, 4);
          assert.equal(restored.turnStartIndex, point.turnStartIndex);
          assert.equal(resolveRewindUiCutoff(loaded.logs, restored), 3);
          assert.equal(rewindDraft(restored, loaded.logs).text, "selected prompt");
        }
        const restored = manager.getSnapshotById(point.id);
        const cutoff = resolveRewindUiCutoff(loaded.logs, restored);
        const rewind = await manager.rewind(restored.id, {
          mode: "conversation",
          finalize: () => session.appendRewindMarkerDurable(restored.turnStartIndex, restored.journalLogIndex, restored.id),
        });
        assert.deepEqual(rewind.failed, []);
        assert.deepEqual(loaded.logs.slice(0, cutoff).map(log => log.text), ["first prompt", "one\\ntwo\\nthree", ""]);
        replaceConversationMessages(conversation, session.sessionLogsToMessages(session.readCurrentSessionLogs()));
        assert.deepEqual(conversation.getAllMessages().map(message => message.content), ["first prompt", "one\\ntwo\\nthree"]);
        assert.equal(manager.listSnapshots().length, 0);
        const reopened = await loadSessionForDialog(session.getCurrentSessionId());
        assert.deepEqual(reopened.messages.map(message => message.content), ["first prompt", "one\\ntwo\\nthree"]);
      `], {
        cwd: resolve(import.meta.dir, ".."),
        env: { ...process.env, ZAPCODE_DATA_DIR: data }, encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
}
