import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommandTool } from "../../builtin-tools/command.js";
import { TaskStore } from "../../tasks/store.js";
import type { TaskExitedEvent } from "../../tasks/types.js";

// Only operates on disposable directories. The two candidate paths exist so
// silently choosing the wrong base cannot masquerade as a missing-dir error.
describe("bash cwd and shell cd composition", () => {
  it("reports a nonexistent directory as a failed command", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-shell-cd-missing-")));
    try {
      const result = await executeCommandTool({ defaultCwd: root }).handler({ command: "cd missing" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("missing");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not claim a successful cd changed the directory of later calls", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-shell-cd-local-")));
    try {
      mkdirSync(join(root, "nested"));
      const tool = executeCommandTool({ defaultCwd: root });
      const changed = await tool.handler({ command: "cd nested" });
      expect(changed.success).toBe(true);
      expect(changed.output).not.toContain("Working directory:");
      const next = await tool.handler({ command: "pwd" });
      expect(next.output.trim()).toBe(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps explicit cwd and shell expansion when spawning background work", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-shell-cd-background-")));
    const store = new TaskStore({ outputDir: join(root, "output") });
    let taskId: string | undefined;
    try {
      const expected = join(root, "selected", "nested");
      mkdirSync(expected, { recursive: true });
      mkdirSync(join(root, "nested"));
      const tool = executeCommandTool({ defaultCwd: root, store });
      const result = await tool.handler({
        command: 'cd "$PWD/nested" && printf correct > marker.txt && pwd',
        cwd: "selected",
        run_in_background: true,
      });
      expect(result.success).toBe(true);
      const task = JSON.parse(result.output);
      taskId = task.taskId;
      await new Promise<void>((resolve) => {
        const onExit = (event: TaskExitedEvent) => {
          if (event.taskId === task.taskId) {
            store.off("exited", onExit);
            resolve();
          }
        };
        store.on("exited", onExit);
        if (store.get(task.taskId)?.exitedAt !== undefined) {
          store.off("exited", onExit);
          resolve();
        }
      });
      expect(readFileSync(task.outputFile, "utf8").trim()).toBe(expected);
      expect(readFileSync(join(expected, "marker.txt"), "utf8")).toBe("correct");
      expect(existsSync(join(root, "nested", "marker.txt"))).toBe(false);
    } finally {
      if (taskId) await store.settle([taskId]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const command of [
    "cd nested && printf correct > marker.txt && pwd",
    'cd "$PWD/nested" && printf correct > marker.txt && pwd',
  ]) {
    it(`preserves shell semantics for ${command}`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-shell-cwd-")));
      try {
        const selected = join(root, "selected");
        const expected = join(selected, "nested");
        mkdirSync(expected, { recursive: true });
        mkdirSync(join(root, "nested"));
        const tool = executeCommandTool({ defaultCwd: root });
        const args = { command, cwd: "selected" };
        const effects = tool.definition.resolveEffects!(args, { cwd: root } as never);
        // cwd changes the shell's starting directory, not its workspace grant.
        expect(effects.filesystem.map(e => e.paths)).toEqual([[root], [root]]);
        const result = await tool.handler(args);
        expect(result.success).toBe(true);
        expect(result.output.trim()).toBe(expected);
        expect(readFileSync(join(expected, "marker.txt"), "utf8")).toBe("correct");
        expect(existsSync(join(root, "nested", "marker.txt"))).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  it("keeps shell tilde quoting literal instead of expanding a quoted directory name", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-shell-quoted-cwd-")));
    try {
      mkdirSync(join(root, "~"));
      const tool = executeCommandTool({ defaultCwd: root });
      const result = await tool.handler({ command: "cd '~' && pwd" });
      expect(result.success).toBe(true);
      expect(result.output.trim()).toBe(join(root, "~"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
