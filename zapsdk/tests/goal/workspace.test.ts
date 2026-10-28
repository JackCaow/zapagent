import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GoalWorkspace, goalTreeHash } from "../../goal/workspace.js";
import { assertGoalFinalAcceptance, verifyGoalCandidate, verifyGoalFinalSnapshot } from "../../goal/acceptance.js";
import { createGoalVerifierCommandRunner } from "../../goal/workspace-broker.js";
import { InMemoryAcceptanceStore } from "../../runtime/acceptance-store.js";
import { WorkspaceManager } from "../../workspace/manager.js";
import { MergeCoordinator } from "../../merge/coordinator.js";
import type { AgentOutcomeV1 } from "../../runtime/outcome.js";
import type { InlineHostVerifier } from "../../runtime/inline-acceptance.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(git: boolean) {
  const base = await mkdtemp(join(tmpdir(), "zap-goal-workspace-test-")); dirs.push(base);
  const root = join(base, "project"); const host = join(base, "host");
  const { mkdir } = await import("node:fs/promises"); await mkdir(root);
  await writeFile(join(root, "report.txt"), "initial\n");
  if (git) {
    execFileSync("git", ["init", root]);
    execFileSync("git", ["-C", root, "add", "report.txt"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
    await writeFile(join(root, "report.txt"), "dirty user content\n");
  }
  const goal = await GoalWorkspace.create(root, "goal-a", host);
  return { root, host, goal };
}
function outcome(attemptId: string): AgentOutcomeV1 {
  return { schema: "zap.outcome", schemaVersion: 1, threadId: "thread", turnId: "turn", runId: attemptId, attemptId, startedAt: 1, endedAt: 2,
    execution: { attemptId, status: "finished", stopReason: "end_turn", finalResponse: "done", unresolvedActions: [] },
    acceptance: { attemptId, status: "unverified", code: "NO_ACCEPTANCE_SPEC", checks: [] },
    workflow: { attemptId, status: "not_requested", controlRevision: 0, code: "WORKFLOW_NOT_CONFIGURED" } };
}
const spec = { id: "report", revision: 1, subjects: [{ id: "report", path: "report.txt", expected: "exists" as const }],
  checks: [{ id: "contains", verifierId: "host-check", subjectIds: ["report"] }] };
const binding = { goalSpecRevision: 1, planRevision: 1, taskSpecRevision: 1, verifierVersion: "host-check-v1" };
const verifier: InlineHostVerifier = { id: "host-check", async verify({ outcome, spec, snapshot, signal }) {
  const content = new TextDecoder().decode(await snapshot.readFile("report", signal));
  return [{ checkId: "contains", attemptId: outcome.attemptId, specId: spec.id, specRevision: spec.revision,
    snapshotId: snapshot.id, dependencies: snapshot.subjects, status: content.includes("finished") ? "passed" : "failed",
    code: "REPORT_CHECK", evidenceRefs: ["host:report"] }];
} };

describe("Goal workspace and acceptance", () => {
  it("creates a child from the parent's current private Git history and merges only files", async () => {
    if (process.platform !== "darwin") return;
    const { root, host, goal } = await fixture(true);
    const sourceHead = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const worker = await goal.acquireWorker("parent");
    await writeFile(join(worker.lease.path, "report.txt"), "parent change\n");
    execFileSync("git", ["-C", worker.lease.path, "add", "report.txt"]);
    execFileSync("git", ["-C", worker.lease.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "parent"]);
    const parentHead = execFileSync("git", ["-C", worker.lease.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const ownerDirectory = goal.exportState().privateGit!.ownerDirectory;
    const manager = new WorkspaceManager({ root: worker.lease.path, tempRoot: join(host, "children"), forbidGit: true,
      capturePrivateGitFromRoot: { ownerDirectory, sourceBinding: worker.lease.privateGit! } });
    try {
      const child = await manager.acquire("child", true);
      expect(execFileSync("git", ["-C", child.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(parentHead);
      await writeFile(join(child.path, "report.txt"), "child change\n");
      execFileSync("git", ["-C", child.path, "add", "report.txt"]);
      execFileSync("git", ["-C", child.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "child"]);
      const childHead = execFileSync("git", ["-C", child.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const artifact = (await manager.finalize(child))!;
      expect(execFileSync("git", [`--git-dir=${artifact.privateGitHistory!.repository}`, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(childHead);
      expect((await new MergeCoordinator(manager).merge([artifact.artifactId])).success).toBe(true);
      expect(await readFile(join(worker.lease.path, "report.txt"), "utf8")).toBe("child change\n");
      expect(execFileSync("git", ["-C", worker.lease.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(parentHead);
      expect(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(sourceHead);
    } finally { await manager.cleanup(); await goal.cleanup(); }
  }, 30_000);
  it("keeps private commits across two tasks without changing source refs or index", async () => {
    if (process.platform !== "darwin") return;
    const { root, goal } = await fixture(true);
    const sourceHead = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const sourceIndex = execFileSync("git", ["-C", root, "diff", "--cached", "--binary"]).toString();
    const first = await goal.acquireWorker("one");
    await writeFile(join(first.lease.path, "report.txt"), "finished first\n");
    execFileSync("git", ["-C", first.lease.path, "add", "report.txt"]);
    execFileSync("git", ["-C", first.lease.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "private first"]);
    const privateHead = execFileSync("git", ["-C", first.lease.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const candidate = await goal.finalizeWorker(first, outcome("first"));
    const store = new InMemoryAcceptanceStore(), check = await goal.prepareVerifier(candidate);
    const result = await verifyGoalCandidate({ workspace: goal, candidate, verifierWorkspace: check, outcome: outcome("first"), spec, verifiers: [verifier], store, binding, timeoutMs: 3000 });
    expect((await goal.merge(candidate, result.receipt!, store)).success).toBe(true);
    const reopened = await GoalWorkspace.open(goal.exportState());
    const second = await reopened.acquireWorker("two");
    expect(execFileSync("git", ["-C", second.lease.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(privateHead);
    expect(await readFile(join(second.lease.path, "report.txt"), "utf8")).toBe("finished first\n");
    expect(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(sourceHead);
    expect(execFileSync("git", ["-C", root, "diff", "--cached", "--binary"]).toString()).toBe(sourceIndex);
    await reopened.cleanup();
  }, 30_000);
  for (const git of [false, true]) {
    it(git ? "isolates and verifies a Git workspace without modifying user history" : "isolates and verifies ordinary workspaces and retains user files", async () => {
      if (git && process.platform !== "darwin") {
        await expect(fixture(true)).rejects.toThrow("requires macOS Seatbelt");
        return;
      }
      const { root, goal } = await fixture(git);
      const original = await readFile(join(root, "report.txt"), "utf8");
      const worker = await goal.acquireWorker("attempt-1");
      expect(await readFile(join(worker.lease.path, "report.txt"), "utf8")).toBe(original);
      await writeFile(join(worker.lease.path, "report.txt"), "finished report\n");
      const candidate = await goal.finalizeWorker(worker, outcome("attempt-1"));
      await writeFile(join(worker.lease.path, "report.txt"), "subsequent mutation\n");
      expect(await readFile(join(candidate.snapshotPath, "report.txt"), "utf8")).toBe("finished report\n");
      const verify = await goal.prepareVerifier(candidate, ["test-output"]);
      const store = new InMemoryAcceptanceStore();
      const result = await verifyGoalCandidate({ workspace: goal, candidate, verifierWorkspace: verify, outcome: outcome("attempt-1"),
        spec, verifiers: [verifier], store, binding, timeoutMs: 3000 });
      expect(result.status).toBe("passed");
      expect((await goal.merge(candidate, result.receipt!, store)).success).toBe(true);
      expect(await readFile(join(goal.integrationPath, "report.txt"), "utf8")).toBe("finished report\n");
      expect(await readFile(join(root, "report.txt"), "utf8")).toBe(original);
      const snapshot = await goal.finalSnapshot();
      expect(snapshot.treeHash).toBe(await goalTreeHash(goal.integrationPath));
      const finalVerifier = await goal.prepareFinalVerifier(snapshot);
      const final = await verifyGoalFinalSnapshot({ workspace: goal, snapshot, verifierWorkspace: finalVerifier, outcome: outcome("final-1"),
        spec, verifiers: [verifier], store, binding, timeoutMs: 3000 });
      expect(final.status).toBe("passed");
      await assertGoalFinalAcceptance(goal, snapshot, final.receipt!, store);
      await writeFile(join(goal.integrationPath, "report.txt"), "changed after final verification\n");
      await expect(assertGoalFinalAcceptance(goal, snapshot, final.receipt!, store)).rejects.toThrow("stale or invalid");
      await goal.cleanup();
    });
  }

  it("isolates Git workspaces without executing repository hooks or filters", async () => {
    const base = await mkdtemp(join(tmpdir(), "zap-goal-git-hook-")); dirs.push(base);
    const root = join(base, "project"), marker = join(base, "hook-ran");
    execFileSync("git", ["init", root]);
    await writeFile(join(root, "base.txt"), "base\n");
    execFileSync("git", ["-C", root, "add", "base.txt"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
    const hook = join(root, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/bin/sh\nprintf triggered > "${marker}"\n`, { mode: 0o755 });
    execFileSync("git", ["-C", root, "config", "core.fsmonitor", hook]);
    execFileSync("git", ["-C", root, "config", "filter.evil.clean", hook]);
    await writeFile(join(root, ".gitattributes"), "*.txt filter=evil\n");
    await writeFile(join(root, "payload.txt"), "payload\n");
    if (process.platform !== "darwin") {
      await expect(GoalWorkspace.create(root, "goal", join(base, "host"))).rejects.toThrow("requires macOS Seatbelt");
    } else {
      const goal = await GoalWorkspace.create(root, "goal", join(base, "host"));
      await goal.cleanup();
    }
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not execute a workspace-controlled git through a relative PATH", async () => {
    if (process.platform === "win32") return;
    const base = await mkdtemp(join(tmpdir(), "zap-goal-path-git-")); dirs.push(base);
    const root = join(base, "project"), bin = join(root, "bin"), marker = join(base, "git-ran");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "git"), `#!/bin/sh\nprintf triggered > "${marker}"\nexit 1\n`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = "bin";
      const goal = await GoalWorkspace.create(root, "goal-path", join(base, "host"));
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await goal.cleanup();
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
  });

  it("rejects resuming a legacy Git workspace before hydration", async () => {
    const { goal } = await fixture(false);
    const state = goal.exportState();
    state.baseLease.mode = "isolated-git";
    await expect(GoalWorkspace.open(state)).rejects.toThrow("host Git execution is not sealed");
    await goal.cleanup();
  });

  it("retains an abandoned repair and restores the previous frozen candidate", async () => {
    const { goal } = await fixture(false);
    const worker = await goal.acquireWorker("original-worker");
    await writeFile(join(worker.lease.path, "report.txt"), "original candidate\n");
    const candidate = await goal.finalizeWorker(worker, outcome("original-attempt"));
    const repair = await goal.acquireRepair(candidate, "interrupted-repair");
    await writeFile(join(repair.lease.path, "report.txt"), "partial repair\n");
    await expect(goal.abandonWorker({ runId: repair.lease.runId, stopped: true, externalEffects: "unknown", reason: "test" } as never))
      .rejects.toThrow("confirmed safe reconciliation");
    await goal.abandonWorker({ runId: repair.lease.runId, stopped: true, externalEffects: "none", reason: "process tree stopped" });
    expect(await readFile(join(repair.lease.path, "report.txt"), "utf8")).toBe("partial repair\n");
    const state = goal.exportState();
    expect(state.abandoned).toHaveLength(1);
    const recovered = await GoalWorkspace.open(state);
    await recovered.assertCandidate(candidate);
    expect(await readFile(join(candidate.snapshotPath, "report.txt"), "utf8")).toBe("original candidate\n");
    await recovered.cleanup();
  });

  it("does not accept an unverified or stale candidate", async () => {
    const { goal } = await fixture(false);
    const worker = await goal.acquireWorker("attempt-2");
    await writeFile(join(worker.lease.path, "report.txt"), "finished report\n");
    const candidate = await goal.finalizeWorker(worker, outcome("attempt-2"));
    const verify = await goal.prepareVerifier(candidate);
    const store = new InMemoryAcceptanceStore();
    const result = await verifyGoalCandidate({ workspace: goal, candidate, verifierWorkspace: verify, outcome: outcome("attempt-2"),
      spec, verifiers: [verifier], store, binding, timeoutMs: 3000 });
    await writeFile(join(candidate.snapshotPath, "report.txt"), "changed after validation\n");
    await expect(goal.merge(candidate, result.receipt!, store)).rejects.toThrow("modified after freezing");
    await goal.cleanup();
  });

  it("allows declared test outputs but rejects source changes in verifier", async () => {
    const { goal } = await fixture(false);
    const worker = await goal.acquireWorker("attempt-3");
    await writeFile(join(worker.lease.path, "report.txt"), "finished report\n");
    const candidate = await goal.finalizeWorker(worker, outcome("attempt-3"));
    const verify = await goal.prepareVerifier(candidate, ["test-output"]);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(verify.path, "test-output"));
    await writeFile(join(verify.path, "test-output", "results"), "ok");
    await goal.assertVerifierUnchanged(candidate, verify);
    await writeFile(join(verify.path, "report.txt"), "tampered");
    await expect(goal.assertVerifierUnchanged(candidate, verify)).rejects.toThrow("Verifier modified candidate source");
    await goal.cleanup();
  });

  it("hydrates the frozen artifact and still checks integration drift", async () => {
    const { goal } = await fixture(false);
    const worker = await goal.acquireWorker("attempt-4");
    await writeFile(join(worker.lease.path, "report.txt"), "finished report\n");
    const candidate = await goal.finalizeWorker(worker, outcome("attempt-4"));
    const recovered = await GoalWorkspace.open(goal.exportState());
    await recovered.assertCandidate(candidate);
    const verify = await recovered.prepareVerifier(candidate);
    const store = new InMemoryAcceptanceStore();
    const result = await verifyGoalCandidate({ workspace: recovered, candidate, verifierWorkspace: verify, outcome: outcome("attempt-4"),
      spec, verifiers: [verifier], store, binding, timeoutMs: 3000 });
    await writeFile(join(recovered.integrationPath, "report.txt"), "concurrent write\n");
    await expect(recovered.merge(candidate, result.receipt!, store)).rejects.toThrow("integration changed");
    await recovered.cleanup();
  });

  for (const git of [false, true]) {
    it(git ? "repairs a failed Git candidate without losing its private history" : "repairs a failed ordinary candidate without losing the original base", async () => {
      if (git && process.platform !== "darwin") {
        await expect(fixture(true)).rejects.toThrow("requires macOS Seatbelt");
        return;
      }
      const { goal } = await fixture(git);
      const worker = await goal.acquireWorker("first-worker");
      await writeFile(join(worker.lease.path, "report.txt"), "incomplete\n");
      const first = await goal.finalizeWorker(worker, outcome("first-attempt"));
      const verifierCopy = await goal.prepareVerifier(first);
      const store = new InMemoryAcceptanceStore();
      const failed = await verifyGoalCandidate({ workspace: goal, candidate: first, verifierWorkspace: verifierCopy,
        outcome: outcome("first-attempt"), spec, verifiers: [verifier], store, binding, timeoutMs: 3000 });
      expect(failed.status).toBe("failed");
      const repair = await goal.acquireRepair(first, "repair-worker");
      expect(await readFile(join(repair.lease.path, "report.txt"), "utf8")).toBe("incomplete\n");
      const recovered = await GoalWorkspace.open(goal.exportState());
      await writeFile(join(repair.lease.path, "report.txt"), "finished report\n");
      const fixed = await recovered.finalizeWorker(repair, outcome("repair-attempt"));
      const check = await recovered.prepareVerifier(fixed);
      const passed = await verifyGoalCandidate({ workspace: recovered, candidate: fixed, verifierWorkspace: check,
        outcome: outcome("repair-attempt"), spec, verifiers: [verifier], store, binding, timeoutMs: 3000 });
      expect(passed.status).toBe("passed");
      expect((await recovered.merge(fixed, passed.receipt!, store)).success).toBe(true);
      expect(await readFile(join(recovered.integrationPath, "report.txt"), "utf8")).toBe("finished report\n");
      await recovered.cleanup();
    });
  }

  for (const git of [false, true]) {
    it(git ? "delivers Git workspace files without changing user index or refs" : "delivers a verified ordinary result without touching unrelated user changes", async () => {
      if (git && process.platform !== "darwin") {
        await expect(fixture(true)).rejects.toThrow("requires macOS Seatbelt");
        return;
      }
      const { goal, root } = await fixture(git);
      const worker = await goal.acquireWorker("delivery-worker");
      await writeFile(join(worker.lease.path, "report.txt"), "finished report\n");
      const candidate = await goal.finalizeWorker(worker, outcome("delivery-attempt"));
      const store = new InMemoryAcceptanceStore();
      const check = await goal.prepareVerifier(candidate);
      const accepted = await verifyGoalCandidate({ workspace: goal, candidate, verifierWorkspace: check, outcome: outcome("delivery-attempt"),
        spec, verifiers: [verifier], store, binding, timeoutMs: 3000 });
      expect((await goal.merge(candidate, accepted.receipt!, store)).success).toBe(true);
      const snapshot = await goal.finalSnapshot();
      const finalCheck = await goal.prepareFinalVerifier(snapshot);
      const final = await verifyGoalFinalSnapshot({ workspace: goal, snapshot, verifierWorkspace: finalCheck, outcome: outcome("delivery-final"),
        spec, verifiers: [verifier], store, binding, timeoutMs: 3000 });
      await writeFile(join(root, "unrelated.txt"), "user's unrelated new file\n");
      if (git) execFileSync("git", ["-C", root, "add", "unrelated.txt"]);
      const indexBefore = git ? execFileSync("git", ["-C", root, "diff", "--cached", "--binary"]).toString() : "";
      await goal.prepareDelivery(snapshot, final.receipt!, store);
      const reopened = await GoalWorkspace.open(goal.exportState());
      expect((await reopened.applyDelivery(snapshot, final.receipt!, store)).success).toBe(true);
      expect(await readFile(join(root, "report.txt"), "utf8")).toBe("finished report\n");
      expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe("user's unrelated new file\n");
      if (git) expect(execFileSync("git", ["-C", root, "diff", "--cached", "--binary"]).toString()).toBe(indexBefore);
      await reopened.cleanup();
    });

    it(git ? "rejects Git root drift during delivery" : "rejects ordinary root drift during delivery", async () => {
      if (git && process.platform !== "darwin") {
        await expect(fixture(true)).rejects.toThrow("requires macOS Seatbelt");
        return;
      }
      const { goal, root } = await fixture(git);
      const worker = await goal.acquireWorker("drift-worker");
      await writeFile(join(worker.lease.path, "report.txt"), "finished report\n");
      const candidate = await goal.finalizeWorker(worker, outcome("drift-attempt"));
      const store = new InMemoryAcceptanceStore();
      const check = await goal.prepareVerifier(candidate);
      const accepted = await verifyGoalCandidate({ workspace: goal, candidate, verifierWorkspace: check, outcome: outcome("drift-attempt"),
        spec, verifiers: [verifier], store, binding, timeoutMs: 3000 });
      expect((await goal.merge(candidate, accepted.receipt!, store)).success).toBe(true);
      const snapshot = await goal.finalSnapshot();
      const finalCheck = await goal.prepareFinalVerifier(snapshot);
      const final = await verifyGoalFinalSnapshot({ workspace: goal, snapshot, verifierWorkspace: finalCheck, outcome: outcome("drift-final"),
        spec, verifiers: [verifier], store, binding, timeoutMs: 3000 });
      await goal.prepareDelivery(snapshot, final.receipt!, store);
      await writeFile(join(root, "report.txt"), "user changed this concurrently\n");
      const result = await goal.applyDelivery(snapshot, final.receipt!, store);
      expect(result.success).toBe(false);
      expect(await readFile(join(root, "report.txt"), "utf8")).toBe("user changed this concurrently\n");
      await goal.cleanup();
    });
  }

  it("refuses host checks while descendant sealing cannot be guaranteed", async () => {
    const { goal } = await fixture(false);
    const worker = await goal.acquireWorker("sandbox-check");
    await writeFile(join(worker.lease.path, "report.txt"), "finished report\n");
    const candidate = await goal.finalizeWorker(worker, outcome("actual-runtime-attempt"));
    const copy = await goal.prepareVerifier(candidate, ["output.txt"]);
    const run = createGoalVerifierCommandRunner(copy);
    const source = "import os,time\np=os.fork()\nif p==0:\n os.setsid()\n time.sleep(1)\n open('orphan-proof.txt','w').write('escaped')\n os._exit(0)\n";
    const escaped = `python3 -c ${JSON.stringify(source)}`;
    await expect(run(escaped)).rejects.toThrow("GOAL_VERIFIER_PROCESS_SEAL_UNSUPPORTED");
    await expect(readFile(join(copy.path, "orphan-proof.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(join(candidate.snapshotPath, "report.txt"), "utf8")).toBe("finished report\n");
    await goal.assertVerifierUnchanged(candidate, copy);
    await goal.cleanup();
  });
});
