import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorTool } from "../zapsdk/builtin-tools/monitor.js";
import { resolveProjectDataSegment } from "../zapsdk/utils/project-paths.js";

function waitFor(pred: () => boolean, timeoutMs = 3000, stepMs = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "zapcode-monitor-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("monitor tool", () => {
  it("spawns a command, streams output to the log file, and records exit", async () => {
    const h = monitorTool({ outputDir: tmp });
    const res = await h.tool.handler({
      command: "printf 'hi\\nbye\\n' && exit 0",
      description: "greet",
    });
    expect(res.success).toBe(true);
    const { taskId, outputFile, pid } = JSON.parse(res.output);
    expect(typeof pid).toBe("number");
    expect(outputFile).toBe(join(tmp, `${taskId}.log`));
    expect(existsSync(outputFile)).toBe(true);

    await waitFor(() => h.get(taskId)?.exitedAt !== undefined);

    const task = h.get(taskId)!;
    expect(task.exitCode).toBe(0);
    const contents = readFileSync(outputFile, "utf8");
    expect(contents).toContain("hi");
    expect(contents).toContain("bye");
  });

  it("records non-zero exit codes", async () => {
    const h = monitorTool({ outputDir: tmp });
    const res = await h.tool.handler({
      command: "exit 7",
      description: "fail",
    });
    const { taskId } = JSON.parse(res.output);
    await waitFor(() => h.get(taskId)?.exitedAt !== undefined);
    expect(h.get(taskId)!.exitCode).toBe(7);
  });

  it("captures stderr in the same log file", async () => {
    const h = monitorTool({ outputDir: tmp });
    const res = await h.tool.handler({
      command: "printf 'oops\\n' 1>&2 && exit 0",
      description: "stderr",
    });
    const { taskId, outputFile } = JSON.parse(res.output);
    await waitFor(() => h.get(taskId)?.exitedAt !== undefined);
    expect(readFileSync(outputFile, "utf8")).toContain("oops");
  });

  it("does not expose exitedAt until buffered output is readable", async () => {
    const outputBytes = 2 * 1024 * 1024;
    const h = monitorTool({ outputDir: tmp });
    const res = await h.tool.handler({
      command: `yes x | head -c ${outputBytes} >&2`,
      description: "buffered stderr",
    });
    const { taskId, outputFile } = JSON.parse(res.output);

    await waitFor(() => h.get(taskId)?.exitedAt !== undefined);

    expect(readFileSync(outputFile).byteLength).toBe(outputBytes);
  });

  it("stopAll kills running children and marks them exited", async () => {
    const h = monitorTool({ outputDir: tmp });
    const res = await h.tool.handler({
      command: "sleep 30",
      description: "long",
    });
    const { taskId } = JSON.parse(res.output);
    // Give spawn a moment to actually start.
    await new Promise((r) => setTimeout(r, 50));
    expect(h.get(taskId)?.exitedAt).toBeUndefined();

    h.stopAll("SIGTERM");
    await waitFor(() => h.get(taskId)?.exitedAt !== undefined);

    const task = h.get(taskId)!;
    expect(task.exitedAt).toBeDefined();
    // Killed by SIGTERM → either signal is set or exitCode is null.
    // Some shells translate signals to exit codes (e.g. 143); accept either.
    expect(task.signal === "SIGTERM" || task.exitCode === null || task.exitCode === 143)
      .toBe(true);
  });

  it("uses projectCwd when it creates its own default TaskStore", async () => {
    const previousDataDir = process.env.ZAPCODE_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), "zap-monitor-data-"));
    const projectCwd = mkdtempSync(join(tmpdir(), "zap-monitor-project-"));
    process.env.ZAPCODE_DATA_DIR = dataDir;
    const h = monitorTool({ projectCwd });
    try {
      const res = await h.tool.handler({
        command: "printf monitor-scoped",
        description: "scoped",
      });
      expect(res.success).toBe(true);
      const { taskId, outputFile } = JSON.parse(res.output);
      const expectedDir = join(
        dataDir,
        "projects",
        resolveProjectDataSegment(projectCwd),
        "tasks",
        "outputs",
      );

      expect(outputFile).toBe(join(expectedDir, `${taskId}.log`));
      await waitFor(() => h.get(taskId)?.exitedAt !== undefined);
      expect(readFileSync(outputFile, "utf8")).toBe("monitor-scoped");
    } finally {
      h.stopAll("SIGKILL");
      if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR;
      else process.env.ZAPCODE_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });
});
