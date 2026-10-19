import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommandTool } from "../../builtin-tools/command.js";
import { delegateAgentTool } from "../../builtin-tools/delegate.js";
import { createLocalProcessBroker, terminateProcessTreeWithGrace } from "../../execution/process.js";
import { TaskStore } from "../../tasks/store.js";

const posixTest = process.platform === "win32" ? test.skip : test;

for (const detached of [false, true]) {
  posixTest(`reaps a TERM-resistant descendant after its leader exits (detached=${detached})`, async () => {
    const descendant = "process.on('SIGTERM', () => {}); console.log('DESCENDANT_READY:' + process.pid); setInterval(() => {}, 1000);";
    const parent = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit', detached: ${detached} }); setInterval(() => {}, 1000);`;
    const child = createLocalProcessBroker().spawnCommand(process.execPath, ["-e", parent], { cwd: process.cwd() });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let descendantPid: number | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("descendant did not start")), 3000);
        child.stdout!.on("data", (chunk) => {
          const match = String(chunk).match(/DESCENDANT_READY:(\d+)/);
          if (match) {
            descendantPid = Number(match[1]);
            clearTimeout(timer);
            resolve();
          }
        });
      });
      terminateProcessTreeWithGrace(child, 100);
      const didClose = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(false), 1500); }),
      ]);
      expect(child.signalCode).toBe("SIGTERM");
      expect(didClose).toBe(true);
    } finally {
      clearTimeout(deadline);
      // Clean up even when the regression prevents the production helper from killing descendants.
      if (descendantPid) { try { process.kill(descendantPid, "SIGKILL"); } catch {} }
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      await closed;
    }
  }, 6000);
}

posixTest("foreground timeout preserves partial output when a descendant ignores TERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zap-group-timeout-"));
  const pidFile = join(dir, "parent.pid");
  const descendant = "process.on('SIGTERM', () => {}); console.log('PARTIAL_OUTPUT'); setInterval(() => {}, 1000);";
  const parent = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  const cleanupGroup = () => {
    try { process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
  };
  let fallbackUsed = false;
  const fallback = setTimeout(() => { fallbackUsed = true; cleanupGroup(); }, 4000);
  try {
    const result = await executeCommandTool({ timeoutMs: 1000 }).handler({
      command: `exec ${quote(process.execPath)} -e ${quote(parent)}`,
    });
    expect(fallbackUsed).toBe(false);
    expect(result.success).toBe(false);
    expect(result.output).toContain("PARTIAL_OUTPUT");
    expect(result.error).toContain("Command timed out after 1000ms");
    expect(result.runtime?.command?.timedOut).toBe(true);
    expect(result.runtime?.command?.aborted).toBe(false);
  } finally {
    clearTimeout(fallback);
    cleanupGroup();
    rmSync(dir, { recursive: true, force: true });
  }
}, 7000);

posixTest("background settle closes output after an owned descendant changes process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zap-detached-task-"));
  const store = new TaskStore({ outputDir: dir });
  const descendant = "process.on('SIGTERM', () => {}); console.log('READY:' + process.pid); setInterval(() => {}, 1000);";
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit', detached: true }); setInterval(() => {}, 1000);`;
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  const task = store.spawnShell({ command: `exec ${quote(process.execPath)} -e ${quote(parent)}` });
  let descendantPid: number | undefined;
  try {
    const deadline = Date.now() + 3000;
    while (!descendantPid && Date.now() < deadline) {
      const match = store.tailOutput(task.taskId)?.match(/READY:(\d+)/);
      if (match) descendantPid = Number(match[1]);
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(descendantPid).toBeDefined();
    await store.settle([task.taskId], 250);
    expect(store.get(task.taskId)?.exitedAt).toBeDefined();
    expect(readFileSync(task.outputFile, "utf8")).toContain("READY:");
  } finally {
    if (descendantPid) { try { process.kill(descendantPid, "SIGKILL"); } catch {} }
    await store.settle([task.taskId], 250);
    rmSync(dir, { recursive: true, force: true });
  }
}, 6000);

posixTest("delegate timeout escalates after its CLI leader exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zap-detached-delegate-"));
  const pidFile = join(dir, "descendant.pid");
  const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit', detached: true }); setInterval(() => {}, 1000);`;
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  const bin = join(dir, "fake-cli.sh");
  writeFileSync(bin, `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(parent)}\n`);
  chmodSync(bin, 0o755);
  const cleanup = () => {
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
  };
  let fallbackUsed = false;
  const fallback = setTimeout(() => { fallbackUsed = true; cleanup(); }, 6000);
  try {
    const tool = delegateAgentTool({ providers: [{ name: "claude", bin }], defaultCwd: dir, timeoutMs: 1000 })!;
    const result = await tool.handler({ provider: "claude", task: "fixture" });
    expect(fallbackUsed).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  } finally {
    clearTimeout(fallback);
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}, 8000);
