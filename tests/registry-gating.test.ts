import { describe, it, expect } from "bun:test";
import { createBuiltinRegistry } from "../zapsdk/builtin-tools/index.js";
import { cronTools } from "../zapsdk/builtin-tools/cron.js";
import { monitorTool } from "../zapsdk/builtin-tools/monitor.js";

describe("createBuiltinRegistry — cron/monitor gating", () => {
  it("omits cron tools when no cronHandle is supplied", () => {
    const r = createBuiltinRegistry({});
    expect(r.has("cron_create")).toBe(false);
    expect(r.has("cron_delete")).toBe(false);
    expect(r.has("cron_list")).toBe(false);
  });

  it("omits monitor when no monitorHandle is supplied", () => {
    const r = createBuiltinRegistry({});
    expect(r.has("monitor")).toBe(false);
  });

  it("registers cron tools when cronHandle is supplied", () => {
    const cron = cronTools({});
    const r = createBuiltinRegistry({ cronHandle: cron });
    expect(r.has("cron_create")).toBe(true);
    expect(r.has("cron_delete")).toBe(true);
    expect(r.has("cron_list")).toBe(true);
    cron.stop();
  });

  it("registers monitor when monitorHandle is supplied", () => {
    const mon = monitorTool({});
    const r = createBuiltinRegistry({ monitorHandle: mon });
    expect(r.has("monitor")).toBe(true);
    mon.stopAll();
  });

  it("honors exclude for cron subtools", () => {
    const cron = cronTools({});
    const r = createBuiltinRegistry({
      cronHandle: cron,
      exclude: ["cron_delete"],
    });
    expect(r.has("cron_create")).toBe(true);
    expect(r.has("cron_delete")).toBe(false);
    expect(r.has("cron_list")).toBe(true);
    cron.stop();
  });
});

describe("subagent registry stripping (Fix #1)", () => {
  // The subagent tool clones the main registry and then unregisters
  // cron_create / cron_delete / cron_list / monitor. We don't exercise
  // the full subagentTool factory here (that requires an LLM provider +
  // executor setup); instead, we verify the clone-then-unregister pattern
  // our fix relies on: cloning preserves the tools, explicit unregister
  // removes them, and the main registry remains intact.
  it("subagent clone can strip cron/monitor without affecting main", () => {
    const cron = cronTools({});
    const mon = monitorTool({});
    const main = createBuiltinRegistry({ cronHandle: cron, monitorHandle: mon });

    const sub = main.clone();
    sub.unregister("cron_create");
    sub.unregister("cron_delete");
    sub.unregister("cron_list");
    sub.unregister("monitor");

    // Sub no longer has them.
    expect(sub.has("cron_create")).toBe(false);
    expect(sub.has("cron_delete")).toBe(false);
    expect(sub.has("cron_list")).toBe(false);
    expect(sub.has("monitor")).toBe(false);

    // Main still does.
    expect(main.has("cron_create")).toBe(true);
    expect(main.has("cron_delete")).toBe(true);
    expect(main.has("cron_list")).toBe(true);
    expect(main.has("monitor")).toBe(true);

    cron.stop();
    mon.stopAll();
  });
});

describe("app tool surface", () => {
  it("leaves specialized tools out of the main agent registry", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const { buildAgentObjects } = await import("../src/agent-factory.js")
    const { getDefaultConfig } = await import("../src/config.js")
    const root = mkdtempSync(join(tmpdir(), "zap-tool-surface-"))
    const previous = process.env.ZAPCODE_DATA_DIR
    process.env.ZAPCODE_DATA_DIR = join(root, "data")
    try {
      const planCallbacks = { enter: () => {}, isActive: () => false, requestExit: async () => ({ approved: false }) }
      const { registry } = buildAgentObjects(getDefaultConfig(), undefined, undefined, planCallbacks, undefined, undefined, root, "disabled")
      for (const name of ["monitor", "cron_create", "cron_delete", "cron_list", "move_file", "http_request", "current_time", "enter_plan_mode"])
        expect(registry.has(name)).toBe(false)
      for (const name of ["bash", "read_file", "http_fetch", "exit_plan_mode", "task_status"]) expect(registry.has(name)).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR
      else process.env.ZAPCODE_DATA_DIR = previous
      rmSync(root, { recursive: true, force: true })
    }
  });
});
