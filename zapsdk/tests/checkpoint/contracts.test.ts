import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, linkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointManager, type SnapshotJsonlEntry } from "../../checkpoint/index.js";
import { deleteFileTool, moveFileTool, writeFileTool } from "../../builtin-tools/filesystem.js";
import { executeCommandTool } from "../../builtin-tools/command.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(config = {}) {
  const root = mkdtempSync(join(tmpdir(), "zap-rewind-contract-")); roots.push(root);
  const cwd = join(root, "work"), blobs = join(root, "history"); mkdirSync(cwd);
  const journal: SnapshotJsonlEntry[] = [];
  const options = { sessionId: "session", cwd, config: { managedStorage: true, blobDir: blobs, ...config }, writeJsonlEntry: (entry: SnapshotJsonlEntry) => { journal.push(entry); } };
  return { root, cwd, blobs, journal, options, manager: new CheckpointManager(options) };
}
it("creates a durable conversation point for a non-editing turn even with file tracking disabled", async () => {
  const f = fixture({ enabled: false });
  const point = await f.manager.beginTurn(1, { journalLogIndex: 0, uiLogIndex: 0 }, "inspect only");
  expect(point?.trackedFiles).toEqual({}); await f.manager.makeSnapshot(1);
  const reopened = new CheckpointManager(f.options);
  expect(reopened.listSnapshots()).toHaveLength(1); expect(reopened.listSnapshots()[0]?.prompt).toBe("inspect only");
});
it("disabled recovery does not deny an approved ordinary write, while explicit strict policy still fails closed", async () => {
  const f = fixture({ enabled: false }), registry = new ToolRegistry(); registry.register(writeFileTool({ defaultCwd: f.cwd }));
  const executor = new ToolExecutor(registry, { cwd: f.cwd, onApproval: async () => true, onTrackEdit: f.manager.createEditTracker() });
  const ordinary = await executor.execute("write_file", { path: "ordinary.txt", content: "ok" });
  expect(ordinary.success).toBe(true); expect(ordinary.runtime?.checkpoint).toBeUndefined();
  expect(readFileSync(join(f.cwd, "ordinary.txt"), "utf8")).toBe("ok");
  const strict = new ToolExecutor(registry, { cwd: f.cwd, checkpointMode: "before-write", onApproval: async () => true, onTrackEdit: f.manager.createEditTracker() });
  const denied = await strict.execute("write_file", { path: "ordinary.txt", content: "denied" });
  expect(denied.failure?.code).toBe("CHECKPOINT_REQUIRED"); expect(readFileSync(join(f.cwd, "ordinary.txt"), "utf8")).toBe("ok");
});
it("does not checkpoint shell permission scopes and does not infer a sandbox escape from DNS errors", async () => {
  const f = fixture(), registry = new ToolRegistry(); registry.register(executeCommandTool({ defaultCwd: f.cwd })); let tracked = 0;
  const executor = new ToolExecutor(registry, { cwd: f.cwd, onApproval: async () => true, onTrackEdit: async () => { tracked++; } });
  const success = await executor.execute("bash", { command: "pwd && printf 'fixture'" });
  expect(success.success).toBe(true); expect(tracked).toBe(0); expect(success.runtime?.checkpoint).toBeUndefined();
  const failure = await executor.execute("bash", { command: "printf 'Could not resolve host' >&2; exit 1" });
  expect(failure.success).toBe(false); expect(failure.error).not.toContain("retry with dangerouslyDisableSandbox"); expect(tracked).toBe(0);
});
it("can recover an edited file after process reconstruction before the turn-end hook", async () => {
  const f = fixture(), path = join(f.cwd, "file.txt"); writeFileSync(path, "before");
  const point = await f.manager.beginTurn(1, { journalLogIndex: 0, uiLogIndex: 0 });
  await f.manager.trackEdits([path]); writeFileSync(path, "after");
  const restarted = new CheckpointManager(f.options);
  expect(restarted.listSnapshots()[0]?.id).toBe(point?.id);
  const result = await restarted.rewind(point!.id);
  expect(result.failed).toEqual([]); expect(readFileSync(path, "utf8")).toBe("before");
});
it("keeps conversation history for code-only restore and keeps code for conversation-only restore", async () => {
  const f = fixture(), path = join(f.cwd, "file.txt"); writeFileSync(path, "before");
  const point = await f.manager.beginTurn(1); await f.manager.trackEdits([path]); writeFileSync(path, "after"); await f.manager.makeSnapshot(1);
  const code = await f.manager.rewind(point!.id, { mode: "code" });
  expect(code.failed).toEqual([]); expect(f.manager.listSnapshots()).toHaveLength(1); expect(readFileSync(path, "utf8")).toBe("before");
  writeFileSync(path, "keep current code"); let committed = false;
  const conversation = await f.manager.rewind(point!.id, { mode: "conversation", finalize: () => { committed = true; } });
  expect(conversation.succeeded).toEqual([]); expect(committed).toBe(true); expect(f.manager.listSnapshots()).toHaveLength(0);
  expect(readFileSync(path, "utf8")).toBe("keep current code");
});
it("prunes only unreferenced blobs in the session-private namespace", async () => {
  const f = fixture({ maxSnapshots: 1 }), path = join(f.cwd, "file.txt"); writeFileSync(path, "0");
  for (let i = 1; i <= 3; i++) { await f.manager.beginTurn(i); await f.manager.trackEdits([path]); writeFileSync(path, String(i)); await f.manager.makeSnapshot(i); }
  const blobRoot = f.manager.getDiagnostics().blobDir;
  expect(readdirSync(blobRoot, { recursive: true }).filter(path => /(?:^|\/)\w{62}$/.test(String(path)))).toHaveLength(1);
  expect(f.manager.listSnapshots()).toHaveLength(1);
});
it("materializes a fork's blobs before parent retention can remove its copies", async () => {
  const f = fixture({ maxSnapshots: 1 }), path = join(f.cwd, "file.txt"); writeFileSync(path, "original");
  const point = await f.manager.beginTurn(1); await f.manager.trackEdits([path]); writeFileSync(path, "parent edit"); await f.manager.makeSnapshot(1);
  const fork = new CheckpointManager({ ...f.options, sessionId: "fork" }); fork.hydrateFromJsonl(f.journal, { remapToCurrentSession: true });
  await f.manager.beginTurn(2); await f.manager.trackEdits([path]); writeFileSync(path, "new parent edit"); await f.manager.makeSnapshot(2);
  const restored = await fork.rewind(point!.id);
  expect(restored.failed).toEqual([]); expect(readFileSync(path, "utf8")).toBe("original");
});
it("caps the active turn's backup bytes and reports a partial point rather than lying about coverage", async () => {
  const f = fixture({ maxStorageBytes: 8 }); writeFileSync(join(f.cwd, "a"), "12345678"); writeFileSync(join(f.cwd, "b"), "12345678");
  await f.manager.beginTurn(1); const coverage = await f.manager.trackEditsWithCoverage([join(f.cwd, "a"), join(f.cwd, "b")]);
  expect(coverage.covered).toBe(false); expect(Object.keys(f.manager.listSnapshots()[0]!.trackedFiles)).toEqual(["a"]);
  expect(f.manager.listSnapshots()[0]?.skippedFiles?.length).toBe(1);
});
it("skips symbolic and hard links without modifying their contents or link topology", async () => {
  if (process.platform === "win32") return;
  const f = fixture(), regular = join(f.cwd, "regular"), sym = join(f.cwd, "symbolic"), hard = join(f.cwd, "hard");
  writeFileSync(regular, "before"); const point = await f.manager.beginTurn(1); await f.manager.trackEdits([regular]); await f.manager.makeSnapshot(1);
  writeFileSync(regular, "after"); symlinkSync(regular, sym); linkSync(regular, hard);
  const result = await f.manager.rewind(point!.id);
  expect(result.skipped?.[0]?.reason).toBe("hardlink"); expect(readFileSync(regular, "utf8")).toBe("after");
  expect(lstatSync(regular).nlink).toBe(2); expect(lstatSync(sym).isSymbolicLink()).toBe(true);
});
it("does not resurrect evicted private snapshots from an append-only journal", async () => {
  const f = fixture({ maxStorageBytes: 8 }), path = join(f.cwd, "file"); writeFileSync(path, "12345678");
  await f.manager.beginTurn(1); await f.manager.trackEdits([path]); writeFileSync(path, "abcdefgh"); await f.manager.makeSnapshot(1);
  const retained = await f.manager.beginTurn(2); await f.manager.trackEdits([path]); writeFileSync(path, "ABCDEFGH"); await f.manager.makeSnapshot(2);
  expect(f.manager.listSnapshots()).toHaveLength(1);
  const restarted = new CheckpointManager(f.options);
  expect(() => restarted.hydrateFromJsonl(f.journal)).not.toThrow();
  expect(restarted.listSnapshots().map(point => point.id)).toEqual([retained!.id]);
  const fork = new CheckpointManager({ ...f.options, sessionId: "new-fork" });
  fork.hydrateFromJsonl(f.journal, { remapToCurrentSession: true });
  expect(fork.listSnapshots().map(point => point.id)).toEqual([retained!.id]);
  expect((await fork.rewind(retained!.id)).failed).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("abcdefgh");
});
it("expires old private points on access while preserving legacy files", async () => {
  const f = fixture(), path = join(f.cwd, "file"); writeFileSync(path, "original");
  await f.manager.beginTurn(1); await f.manager.trackEdits([path]); await f.manager.makeSnapshot(1);
  const indexPath = join(f.manager.getDiagnostics().blobDir, "..", "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8")); index.snapshots[0].timestamp = new Date(Date.now() - 31 * 86400000).toISOString();
  writeFileSync(indexPath, JSON.stringify(index)); writeFileSync(join(f.blobs, "legacy-sentinel"), "keep");
  const restarted = new CheckpointManager(f.options); restarted.hydrateFromJsonl(f.journal);
  expect(restarted.listSnapshots()).toEqual([]); expect(readFileSync(join(f.blobs, "legacy-sentinel"), "utf8")).toBe("keep");
});
it("recovers from an abruptly exited real LoopAgent before its turn-end hook", async () => {
  const f = fixture(), path = join(f.cwd, "file"); writeFileSync(path, "before crash");
  const script = `
    import { CheckpointManager } from ${JSON.stringify(new URL("../../checkpoint/index.ts", import.meta.url).pathname)};
    import { LoopAgent } from ${JSON.stringify(new URL("../../agent/loop.ts", import.meta.url).pathname)};
    import { ToolRegistry } from ${JSON.stringify(new URL("../../tools/registry.ts", import.meta.url).pathname)};
    import { ToolExecutor } from ${JSON.stringify(new URL("../../tools/executor.ts", import.meta.url).pathname)};
    import { deleteFileTool, moveFileTool, writeFileTool } from ${JSON.stringify(new URL("../../builtin-tools/filesystem.ts", import.meta.url).pathname)};
    const cwd = process.env.REWIND_CWD;
    const manager = new CheckpointManager({ sessionId: "session", cwd, config: { managedStorage: true, blobDir: process.env.REWIND_BLOBS } });
    const registry = new ToolRegistry(); registry.register(writeFileTool({ defaultCwd: cwd }));
    let calls = 0;
    const provider = { call: async () => {
      if (++calls > 1) process.kill(process.pid, "SIGKILL");
      return { type: "tool_call", text: "", toolCalls: [{ id: "write", name: "write_file", arguments: { path: "file", content: "after crash" } }], usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    const executor = new ToolExecutor(registry, { cwd, onApproval: async () => true, onTrackEdit: manager.createEditTracker() });
    await new LoopAgent({ provider, registry, executor,
      onRunStart: ctx => manager.beginTurn(ctx.turnStartIndex, undefined, ctx.input).then(() => {}),
      onRunEnd: () => { throw new Error("must not be reached"); }
    }).run("recover this interrupted edit");
  `;
  const child = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, ZAPCODE_DATA_DIR: join(f.root, "data"), REWIND_CWD: f.cwd, REWIND_BLOBS: f.blobs } });
  expect(child.signal).toBe("SIGKILL"); expect(readFileSync(path, "utf8")).toBe("after crash");
  const restarted = new CheckpointManager(f.options), point = restarted.listSnapshots()[0]!;
  expect(point.prompt).toBe("recover this interrupted edit");
  expect((await restarted.rewind(point.id)).failed).toEqual([]); expect(readFileSync(path, "utf8")).toBe("before crash");
});
it("tracks both spellings of an aliased macOS workspace without backing file symlinks", async () => {
  if (process.platform !== "darwin") return;
  const f = fixture(), { realpathSync } = await import("node:fs"), canonical = realpathSync(f.cwd);
  const alias = canonical.replace(/^\/private\/var\//, "/var/");
  const path = join(canonical, "native.txt"); writeFileSync(path, "original");
  const manager = new CheckpointManager({ ...f.options, cwd: canonical });
  const point = await manager.beginTurn(1);
  expect((await manager.trackEditsWithCoverage([join(alias, "native.txt")])).covered).toBe(true);
  writeFileSync(path, "changed"); await manager.makeSnapshot(1);
  expect((await manager.rewind(point!.id)).failed).toEqual([]); expect(readFileSync(path, "utf8")).toBe("original");
  const externalLink = join(f.root, "outside-link"); symlinkSync(path, externalLink);
  expect((await manager.trackEditsWithCoverage([externalLink])).covered).toBe(false);
});

it("optional destructive recovery remains distinct from an explicit before-destructive gate", async () => {
  const f = fixture({ maxFileBytes: 4 }), registry = new ToolRegistry(); registry.register(deleteFileTool({ defaultCwd: f.cwd })); registry.register(moveFileTool({ defaultCwd: f.cwd }));
  const path = join(f.cwd, "large"); writeFileSync(path, "too large for backup");
  const strict = new ToolExecutor(registry, { cwd: f.cwd, checkpointMode: "before-destructive", onApproval: async () => true, onTrackEdit: f.manager.createEditTracker() });
  expect((await strict.execute("delete_file", { path })).failure?.code).toBe("CHECKPOINT_REQUIRED");
  expect(readFileSync(path, "utf8")).toBe("too large for backup");
  expect((await strict.execute("move_file", { source: path, destination: "moved" })).failure?.code).toBe("CHECKPOINT_REQUIRED");
  expect(readFileSync(path, "utf8")).toBe("too large for backup");
  const ordinary = new ToolExecutor(registry, { cwd: f.cwd, checkpointMode: "best-effort", onApproval: async () => true, onTrackEdit: f.manager.createEditTracker() });
  const removed = await ordinary.execute("delete_file", { path });
  expect(removed.success).toBe(true); expect(removed.runtime?.checkpoint?.covered).toBe(false);
});
it("does not let a native exact-file hint narrow explicitly strict effect coverage", async () => {
  const f = fixture(), registry = new ToolRegistry(), outside = join(f.root, "outside"); writeFileSync(outside, "outside-before");
  const native = writeFileTool({ defaultCwd: f.cwd });
  registry.register({ ...native, definition: { ...native.definition, resolveEffects: (args, context) => {
    const effects = native.definition.resolveEffects!(args, context);
    return { ...effects, filesystem: [...effects.filesystem, { kind: "filesystem" as const, operation: "modify" as const, paths: [outside] }] };
  } } });
  const executor = new ToolExecutor(registry, { cwd: f.cwd, checkpointMode: "before-write", onApproval: async () => true, onTrackEdit: f.manager.createEditTracker() });
  const result = await executor.execute("write_file", { path: "native.txt", content: "denied" });
  expect(result.failure?.code).toBe("CHECKPOINT_REQUIRED");
  expect(readFileSync(outside, "utf8")).toBe("outside-before");
  expect(() => readFileSync(join(f.cwd, "native.txt"))).toThrow();
});
