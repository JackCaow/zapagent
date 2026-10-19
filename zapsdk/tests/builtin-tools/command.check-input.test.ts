import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommandTool } from "../../builtin-tools/command.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { matchDangerousToolCall } from "../../utils/safety.js";
import { shellCommandDisplay } from "../../utils/shell.js";
import { generateToolUseSummary } from "../../context/tool-use-summary.js";
import { createLocalProcessBroker } from "../../execution/process.js";
import { classifyObservedAcceptance } from "../../runtime/outcome.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-check-input-")));
  roots.push(root);
  const tool = executeCommandTool({ defaultCwd: root, allowUnsandboxed: false });
  const registry = new ToolRegistry();
  registry.register(tool);
  return { root, tool, registry };
}

describe("steps-only checks", () => {
  test("normalizes before approval and retains the same execution identity", async () => {
    const { root, registry } = fixture();
    const approvals: Record<string, unknown>[] = [];
    const hashes: string[] = [];
    const executor = new ToolExecutor(registry, {
      cwd: root, checkpointMode: "never",
      onApproval: async (_name, args) => { approvals.push(args); return true; },
      onApprovalLifecycle: e => { hashes.push(e.argumentsHash); },
      onExecutionLifecycle: e => { hashes.push(e.argumentsHash); },
    });
    const args = { check_steps: ["printf first", "printf second"] };
    const before = JSON.stringify(args);
    const result = await executor.execute("bash", args);
    expect(result.success).toBe(true);
    expect(result.runtime?.verification?.steps.map(s => s.exitCode)).toEqual([0, 0]);
    expect(approvals[0]?.command).toBe("(printf first) && (printf second)");
    expect(hashes.length).toBeGreaterThan(1);
    expect(new Set(hashes).size).toBe(1);
    expect(JSON.stringify(args)).toBe(before);
  });

  test("denial prevents steps-only side effects", async () => {
    const { root, registry } = fixture();
    const executor = new ToolExecutor(registry, { cwd: root, onApproval: async () => false });
    expect((await executor.execute("bash", { check_steps: ["echo denied > marker"] })).success).toBe(false);
    expect(existsSync(join(root, "marker"))).toBe(false);
  });

  test("rejects missing, empty and conflicting input before asking approval", async () => {
    const { root, registry, tool } = fixture();
    let approvals = 0;
    const executor = new ToolExecutor(registry, { cwd: root, onApproval: async () => { approvals++; return true; } });
    for (const args of [{}, { check_steps: [] }, { check_steps: [""] }, { check_steps: [1] },
      { command: "echo approved", check_steps: ["echo different"] }]) {
      expect((await executor.execute("bash", args)).failure?.code).toBe("INVALID_ARGUMENTS");
      expect((await tool.handler(args)).success).toBe(false);
    }
    expect(approvals).toBe(0);
  });

  test("stops a failed step before running stale output through the direct SDK path", async () => {
    const { root, tool } = fixture();
    writeFileSync(join(root, "stale.sh"), "echo stale > used");
    const result = await tool.handler({ check_steps: ["exit 7", "sh stale.sh"] });
    expect(result.success).toBe(false);
    expect(result.runtime?.verification?.steps).toEqual([{ command: "exit 7", exitCode: 7 }]);
    expect(existsSync(join(root, "used"))).toBe(false);
  });

  test("preserves ordinary pipelines and fresh shells for checks", async () => {
    const { tool } = fixture();
    const ordinary = await tool.handler({ command: "sh -c 'exit 7' | cat" });
    expect(ordinary.runtime?.command?.exitCode).toBe(0);
    expect(ordinary.runtime?.verification).toBeUndefined();
    const result = await tool.handler({ check_steps: ["export CHECK_FIXTURE_VALUE=first", "test -z \"$CHECK_FIXTURE_VALUE\""] });
    expect(result.runtime?.verification?.passed).toBe(true);
  });

  test("retains settled check output when a later process cannot start", async () => {
    const { root, tool } = fixture();
    const broker = createLocalProcessBroker();
    const spawn = broker.spawnShell.bind(broker);
    let attempts = 0;
    broker.spawnShell = (command, options) => {
      if (++attempts === 2) throw new Error("fixture backend unavailable");
      return spawn(command, options);
    };
    const steps = ["printf built; printf diagnostic >&2", "printf checking", "echo ran > unwanted"];
    const result = await tool.handler({ check_steps: steps }, undefined, {
      executionId: "partial-check", process: broker,
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("built");
    expect(result.output).toContain("diagnostic");
    expect(result.error).toContain("fixture backend unavailable");
    expect(result.error).toContain("printf checking");
    expect(result.runtime?.verification).toEqual({ passed: false, steps: [
      { command: steps[0], exitCode: 0 }, { command: steps[1], exitCode: null },
    ] });
    expect(result.runtime?.command?.commandRef).toBe("partial-check");
    expect(result.runtime?.command?.exitCode).toBeUndefined();
    expect(attempts).toBe(2);
    expect(existsSync(join(root, "unwanted"))).toBe(false);
    const acceptance = classifyObservedAcceptance("attempt", {
      text: "", steps: 1, totalUsage: { inputTokens: 0, outputTokens: 0 }, toolResults: [result],
    }, 1);
    expect(acceptance.status).toBe("unverified");
    expect(acceptance.checks.map(check => check.observedOutcome)).toEqual(["passed", "error"]);
  });

  test("keeps completed checks and cancellation when the next launch aborts", async () => {
    const { tool } = fixture();
    const broker = createLocalProcessBroker();
    const spawn = broker.spawnShell.bind(broker);
    let attempts = 0;
    broker.spawnShell = (command, options) => {
      if (++attempts === 2) throw new DOMException("fixture launch cancelled", "AbortError");
      return spawn(command, options);
    };
    const result = await tool.handler({ check_steps: ["printf settled", "printf pending"] }, undefined, {
      executionId: "cancelled-check", process: broker,
    });
    expect(result.output).toContain("settled");
    expect(result.runtime?.verification?.passed).toBe(false);
    expect(result.runtime?.verification?.steps.map(step => step.exitCode)).toEqual([0, null]);
    expect(result.runtime?.command).toMatchObject({ commandRef: "cancelled-check", aborted: true });
    expect(result.runtime?.command?.exitCode).toBeUndefined();
    expect(attempts).toBe(2);
  });

  test("a first-launch exception records an unknown exit without claiming verification", async () => {
    const { tool } = fixture();
    const broker = createLocalProcessBroker();
    broker.spawnShell = () => { throw new Error("fixture preparation failed"); };
    const result = await tool.handler({ command: "printf never" }, undefined, {
      executionId: "unstarted-command", process: broker,
    });
    expect(result.success).toBe(false);
    expect(result.output).toBe("");
    expect(result.runtime?.command?.commandRef).toBe("unstarted-command");
    expect(result.runtime?.command?.exitCode).toBeUndefined();
    expect(result.runtime?.verification).toBeUndefined();
    expect(broker.spawnCount).toBe(0);
  });

  test("exposes an input schema and retains explicit matching command compatibility", () => {
    const { tool, registry } = fixture();
    const schema = tool.definition.rawSchema!;
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toEqual([{ required: ["command"] }, { required: ["check_steps"] }]);
    expect(schema.required).toBeUndefined();
    const background = executeCommandTool({ store: {} as never });
    expect(background.definition.parameters.safeParse({ check_steps: ["echo ok"], run_in_background: true }).success).toBe(false);
    expect((schema.properties as Record<string, unknown>).check_steps).toBeDefined();
    expect(JSON.stringify(registry.manifests())).toContain('"check_steps"');
    const args = { command: "(echo ok)", check_steps: ["echo ok"] };
    expect(tool.definition.parameters.parse(args)).toEqual(args);
  });

  test("checks raw steps for danger and sandbox exclusions", () => {
    // Classification only; no destructive command is executed.
    expect(matchDangerousToolCall({ check_steps: ["echo ok", "rm -rf /"], cmd: "echo benign" }, process.cwd())).not.toBeNull();
    const tool = executeCommandTool({ sandboxExcludedCommands: ["docker:*"] });
    expect(tool.definition.resolveEffects!({ check_steps: ["echo ok", "docker ps"] }, { cwd: process.cwd() } as never).process[0].unsandboxed).toBe(true);
  });

  test("keeps raw calls visible in compacted tool history", () => {
    const args = { check_steps: ["echo first", "echo second"] };
    expect(shellCommandDisplay(args)).toBe("(echo first) && (echo second)");
    expect(generateToolUseSummary([{ name: "bash", arguments: args, result: { success: true, output: "ok" } }]))
      .toContain("(echo first) && (echo second)");
  });
});
