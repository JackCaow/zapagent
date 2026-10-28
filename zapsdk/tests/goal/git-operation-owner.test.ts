import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertNoUnresolvedGitOperation, withPersistentGitOperation } from "../../goal/git-operation-owner.js";

it("records ownership before execution, rejects overlaps, and clears only on success", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-git-owner-"));
  try {
    let release!: () => void; let started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const didStart = new Promise<void>(resolve => { started = resolve; });
    const first = withPersistentGitOperation(root, async () => { started(); await wait; return 7; });
    await didStart;
    expect(() => assertNoUnresolvedGitOperation(root)).toThrow("GOAL_GIT_OPERATION_UNCONFIRMED");
    let secondStarted = false;
    const second = withPersistentGitOperation(root, async () => { secondStarted = true; return 8; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(secondStarted).toBe(false);
    release(); expect(await first).toBe(7); expect(await second).toBe(8); expect(() => assertNoUnresolvedGitOperation(root)).not.toThrow();
    await expect(withPersistentGitOperation(root, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(() => assertNoUnresolvedGitOperation(root)).toThrow("GOAL_GIT_OPERATION_UNCONFIRMED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("retains the durable marker after a real owner process is killed", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-git-owner-kill-"));
  try {
    const modulePath = resolve("zapsdk/goal/git-operation-owner.ts");
    const child = spawn(process.execPath, ["-e", `import {withPersistentGitOperation} from ${JSON.stringify(modulePath)}; await withPersistentGitOperation(${JSON.stringify(root)}, async()=>{process.stdout.write("started\\n"); await new Promise(()=>{});});`], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("owner did not start")), 5000); child.stdout.once("data", () => { clearTimeout(timer); resolve(); }); child.once("error", reject); });
    child.kill("SIGKILL"); await new Promise(resolve => child.once("close", resolve));
    expect(JSON.parse(await readFile(join(root, "git-operation.json"), "utf8")).version).toBe(1);
    expect(() => assertNoUnresolvedGitOperation(root)).toThrow("GOAL_GIT_OPERATION_UNCONFIRMED");
  } finally { await rm(root, { recursive: true, force: true }); }
});
