import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointManager } from "../../checkpoint/index.js";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture(config = {}) {
  const root = await mkdtemp(join(tmpdir(), "zap-required-checkpoint-"));
  directories.push(root);
  const manager = new CheckpointManager({ sessionId: "required", cwd: root, config: { blobDir: join(root, "blobs"), ...config } });
  return { root, manager };
}

describe("required checkpoint coverage", () => {
  it("explains the unsupported path boundary and permits a workspace scratch path", async () => {
    const { root, manager } = await fixture();
    await expect(manager.trackEdits([join(root, "..", "external-diagnostic.c")], { required: true }))
      .rejects.toThrow(`outside workspace ${root}`);
    await mkdir(join(root, ".scratch"));
    await expect(manager.trackEdits([join(root, ".scratch", "diagnostic.c")], { required: true }))
      .resolves.toBeUndefined();
  });
  it("backs up existing and absent file paths", async () => {
    const { root, manager } = await fixture();
    await writeFile(join(root, "file"), "original");
    await expect(manager.trackEdits([join(root, "file"), join(root, "new")], { required: true })).resolves.toBeUndefined();
  });
  it("fails closed for skipped large files even without an error callback", async () => {
    const { root, manager } = await fixture({ maxFileBytes: 1 });
    await writeFile(join(root, "large"), "large");
    await expect(manager.trackEdits([join(root, "large")], { required: true })).rejects.toThrow("coverage is missing");
  });
  it("does not report a directory skip as successful coverage", async () => {
    const { root, manager } = await fixture();
    await mkdir(join(root, "directory"));
    await expect(manager.trackEdits([join(root, "directory")], { required: true })).rejects.toThrow("coverage is missing");
  });
  it("rejects required coverage when checkpointing is disabled", async () => {
    const { root, manager } = await fixture({ enabled: false });
    await expect(manager.trackEdits([join(root, "new")], { required: true })).rejects.toThrow("disabled");
    await expect(manager.trackEdits([join(root, "new")])).resolves.toBeUndefined();
  });
});


describe("checkpoint coverage reports", () => {
  it("reports backups for existing and absent files without changing the legacy API", async () => {
    const { root, manager } = await fixture();
    const paths = [join(root, "existing"), join(root, "absent")];
    await writeFile(paths[0]!, "original");
    expect(await manager.trackEditsWithCoverage(paths)).toEqual({ covered: true, uncoveredPaths: [] });
    await expect(manager.trackEdits(paths)).resolves.toBeUndefined();
  });

  it("reports partial coverage for skipped directories, external paths and large files", async () => {
    const { root, manager } = await fixture({ maxFileBytes: 4 });
    const covered = join(root, "small");
    const uncoveredPaths = [root, join(root, "..", "external"), join(root, "large")];
    await writeFile(covered, "ok");
    await writeFile(uncoveredPaths[2]!, "too large");
    expect(await manager.trackEditsWithCoverage([covered, ...uncoveredPaths])).toEqual({ covered: false, uncoveredPaths });
    await expect(manager.trackEditsWithCoverage(uncoveredPaths, { required: true })).rejects.toThrow("coverage is missing");
  });

  it("does not reuse pending coverage while disabled or after a session change", async () => {
    const { root, manager } = await fixture();
    const paths = [join(root, "new")];
    expect((await manager.trackEditsWithCoverage(paths)).covered).toBe(true);
    manager.updateConfig({ enabled: false });
    expect(await manager.trackEditsWithCoverage(paths)).toEqual({ covered: false, uncoveredPaths: paths });
    manager.updateConfig({ enabled: true, maxFileBytes: 1 });
    await writeFile(paths[0]!, "created after backup");
    // An earlier absent backup covers this turn, but not another session.
    expect((await manager.trackEditsWithCoverage(paths)).covered).toBe(true);
    manager.setSessionId("other");
    expect(await manager.trackEditsWithCoverage(paths)).toEqual({ covered: false, uncoveredPaths: paths });
  });
});
