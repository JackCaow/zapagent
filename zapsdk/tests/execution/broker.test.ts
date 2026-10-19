import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { executeCommandTool } from "../../builtin-tools/command.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { DefaultExecutionProcessBroker } from "../../execution/process.js";
import { createPlatformSandbox } from "../../execution/sandbox.js";
import type {
  OsSandbox,
  SandboxExecutionContext,
  SandboxedCommand,
} from "../../execution/types.js";
import { createCapabilityGrant } from "../../policy/engine.js";
import { emptyToolEffects, type ToolEffects } from "../../tools/effects.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { Tool } from "../../tools/types.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function processEffects(root: string): ToolEffects {
  return {
    filesystem: [{ kind: "filesystem", operation: "modify", paths: [root] }],
    network: [],
    process: [{ kind: "process", operation: "spawn", commandClass: "test" }],
    external: [],
    workspace: { mode: "root-integration" },
    confidence: "declared",
  };
}

function unavailableSandbox(): OsSandbox {
  return {
    status: () => ({ provider: "none", available: false, reason: "test unavailable" }),
    createContext: () => {
      throw new Error("unreachable");
    },
  };
}

describe("DefaultExecutionBroker", () => {
  for (const exitCode of [0, 7]) {
    test(`retains process exit ${exitCode} when its output exceeds the broker limit`, async () => {
      const root = mkdtempSync(join(tmpdir(), "zap-broker-output-status-"));
      cleanup.push(root);
      const registry = new ToolRegistry();
      registry.register(executeCommandTool({ defaultCwd: root }));
      const executor = new ToolExecutor(registry, {
        cwd: root,
        onApproval: async () => true,
        executionBroker: new DefaultExecutionBroker({
          sandboxMode: "disabled",
          limits: { maxOutputBytes: 64 },
        }),
      });

      const result = await executor.execute("bash", {
        command: `echo ${"x".repeat(128)}; exit ${exitCode}`,
      });

      expect(result.success).toBe(false);
      expect(result.failure).toMatchObject({ code: "RESOURCE_LIMIT", source: "broker" });
      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(64);
      expect(result.runtime?.command).toMatchObject({ exitCode });
      expect(result.runtime?.command?.commandRef).toBeTruthy();
      expect(result.runtime?.execution?.receipt.outcome).toBe("failed");
    });
  }

  test("routes a heredoc command through the broker-owned process launcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-broker-heredoc-"));
    cleanup.push(root);
    const registry = new ToolRegistry();
    registry.register(executeCommandTool({ defaultCwd: root }));
    const executor = new ToolExecutor(registry, {
      cwd: root,
      onApproval: async () => true,
      executionBroker: new DefaultExecutionBroker({ sandboxMode: "disabled" }),
    });

    const result = await executor.execute("bash", {
      command: "cat > probe.txt <<'EOF'\nhello broker\nEOF\ncat probe.txt",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("hello broker");
    expect(readFileSync(join(root, "probe.txt"), "utf8")).toBe("hello broker\n");
  });

  test("fails closed before invoking a process tool when a required sandbox is unavailable", async () => {
    let invoked = false;
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "process_test",
        description: "test",
        parameters: z.object({}),
        sandboxAware: true,
        resolveEffects: (_args, context) => processEffects(context.cwd),
      },
      handler: async () => {
        invoked = true;
        return { success: true, output: "ran" };
      },
    });
    const executor = new ToolExecutor(registry, {
      executionBroker: new DefaultExecutionBroker({
        sandbox: unavailableSandbox(),
        sandboxMode: "required",
      }),
    });

    const result = await executor.execute("process_test", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("OS sandbox required but unavailable");
    expect(invoked).toBe(false);
  });

  test("runs an approved unsandboxed bash call when the required sandbox is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-broker-unsandboxed-"));
    cleanup.push(root);
    const registry = new ToolRegistry();
    registry.register(executeCommandTool({ defaultCwd: root }));
    const executor = new ToolExecutor(registry, {
      cwd: root,
      onApproval: async () => true,
      executionBroker: new DefaultExecutionBroker({ sandbox: unavailableSandbox(), sandboxMode: "required" }),
    });

    const blocked = await executor.execute("bash", { command: "echo sandboxed" });
    expect(blocked.error).toContain("OS sandbox required but unavailable");

    const escaped = await executor.execute("bash", { command: "echo escaped", dangerouslyDisableSandbox: true });
    expect(escaped.success).toBe(true);
    expect(escaped.output).toContain("escaped");
    expect(escaped.runtime?.execution?.receipt.sandboxedProcesses).toBe(0);
  });

  test("refuses unsandboxed bash when host policy disables the escape hatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-broker-no-escape-"));
    cleanup.push(root);
    const registry = new ToolRegistry();
    // The model is not offered the parameter, but a forged call is still refused.
    const hidden = executeCommandTool({ defaultCwd: root, allowUnsandboxed: false })
      .definition.parameters as z.ZodObject;
    expect(Object.keys(hidden.shape)).not.toContain("dangerouslyDisableSandbox");
    registry.register(executeCommandTool({ defaultCwd: root }));
    const executor = new ToolExecutor(registry, {
      cwd: root,
      onApproval: async () => true,
      executionBroker: new DefaultExecutionBroker({ sandboxMode: "best-effort", allowUnsandboxed: false }),
    });

    const result = await executor.execute("bash", { command: "echo no", dangerouslyDisableSandbox: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("unsandboxed execution is disabled");
  });

  test("explains sandbox-blocked failures and offers the escape", async () => {
    const sandbox = createPlatformSandbox();
    if (!sandbox.status().available) return;
    const root = mkdtempSync(join(tmpdir(), "zap-broker-hint-"));
    const outside = mkdtempSync(join(tmpdir(), "zap-broker-outside-"));
    cleanup.push(root, outside);
    const run = async (allowUnsandboxed: boolean) => {
      const registry = new ToolRegistry();
      registry.register(executeCommandTool({ defaultCwd: root, allowUnsandboxed }));
      const executor = new ToolExecutor(registry, {
        cwd: root, onApproval: async () => true,
        executionBroker: new DefaultExecutionBroker({ sandbox, sandboxMode: "required" }),
      });
      return executor.execute("bash", { command: `echo x > '${join(outside, "f")}'` });
    };
    const withEscape = await run(true);
    expect(withEscape.success).toBe(false);
    expect(withEscape.error).toContain("dangerouslyDisableSandbox: true");
    const without = await run(false);
    expect(without.error).not.toContain("dangerouslyDisableSandbox");
  });

  test("rejects process handlers that do not consume the sandbox contract", async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "unsafe_process",
        description: "test",
        parameters: z.object({}),
        resolveEffects: (_args, context) => processEffects(context.cwd),
      },
      handler: async () => ({ success: true, output: "ran" }),
    });
    const executor = new ToolExecutor(registry, {
      executionBroker: new DefaultExecutionBroker({ sandboxMode: "best-effort" }),
    });

    const result = await executor.execute("unsafe_process", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("not sandbox-aware");
  });

  test("passes a sandbox context and records enforcement metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-broker-fake-"));
    cleanup.push(root);
    let prepared = false;
    const sandbox: OsSandbox = {
      status: () => ({ provider: "macos-seatbelt", available: true }),
      createContext: () => ({
        provider: "macos-seatbelt",
        enforced: true,
        readablePaths: [root],
        writablePaths: [root],
        protectedPaths: [],
        networkAllowed: false,
        prepareCommand: (): SandboxedCommand => {
          prepared = true;
          return { executable: "/usr/bin/true", args: [], env: {}, release: () => {} };
        },
        prepareShell: (): SandboxedCommand => {
          prepared = true;
          return { executable: "/usr/bin/true", args: [], env: {}, release: () => {} };
        },
      } satisfies SandboxExecutionContext),
    };
    const tool: Tool = {
      definition: {
        name: "sandbox_consumer",
        description: "test",
        parameters: z.object({}),
        sandboxAware: true,
        resolveEffects: () => processEffects(root),
      },
      handler: async (_args, _signal, context) => {
        const child = context?.process?.spawnShell("true", { cwd: root });
        if (!child) return { success: false, output: "", error: "missing process broker" };
        await new Promise<void>((resolve) => child.once("close", () => resolve()));
        return { success: true, output: "ok" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, {
      cwd: root,
      executionBroker: new DefaultExecutionBroker({ sandbox, sandboxMode: "required" }),
    });

    const result = await executor.execute("sandbox_consumer", {});

    expect(result.success).toBe(true);
    expect(prepared).toBe(true);
    expect(result.runtime?.broker?.executionId).toMatch(/^execution:/);
    expect(result.runtime?.broker?.sandbox).toBe("macos-seatbelt");
    expect(result.runtime?.broker?.sandboxEnforced).toBe(true);
    expect(result.runtime?.execution?.receipt).toMatchObject({ spawnedProcesses: 1, sandboxedProcesses: 1 });
    expect(result.runtime?.execution?.receipt.constraints.find((item) => item.dimension === "process-sandbox"))
      .toEqual({ dimension: "process-sandbox", status: "observed", level: "adapter" });
    expect(result.runtime?.execution?.receipt.constraints.some((item) => item.level === "kernel")).toBe(false);
  });

  test("passes explicitly preserved runtime variables from Bash into the sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-broker-env-"));
    cleanup.push(root);
    let preservedEnvironment: string[] | undefined;
    const sandbox: OsSandbox = {
      status: () => ({ provider: "zapvm", available: true }),
      createContext: () => ({
        provider: "zapvm",
        enforced: true,
        readablePaths: [root],
        writablePaths: [root],
        protectedPaths: [],
        networkAllowed: false,
        prepareCommand: () => ({ executable: "/usr/bin/true", args: [], env: {}, release: () => {} }),
        prepareShell: (_command, options) => {
          preservedEnvironment = options.preserveEnvironment;
          return { executable: "/usr/bin/true", args: [], env: {}, release: () => {} };
        },
      }),
    };
    const registry = new ToolRegistry();
    registry.register(executeCommandTool({
      defaultCwd: root,
      preserveEnvironment: ["ZAPVM_ARTIFACT_DIR"],
    }));
    const executor = new ToolExecutor(registry, {
      cwd: root,
      onApproval: async () => true,
      executionBroker: new DefaultExecutionBroker({ sandbox, sandboxMode: "required" }),
    });

    const result = await executor.execute("bash", { command: "true" });

    expect(result.success).toBe(true);
    expect(preservedEnvironment).toEqual(["ZAPVM_ARTIFACT_DIR"]);
  });

  test("supports an injected broker-owned process transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-broker-transport-"));
    cleanup.push(root);
    const seen: string[] = [];
    const sandbox: OsSandbox = {
      status: () => ({ provider: "zapvm", available: true }),
      createContext: () => ({
        provider: "zapvm",
        enforced: true,
        readablePaths: [root],
        writablePaths: [root],
        protectedPaths: [],
        networkAllowed: false,
        prepareCommand: () => ({ executable: "/usr/bin/true", args: [], env: {}, release: () => {} }),
        prepareShell: () => ({ executable: "/usr/bin/true", args: [], env: {}, release: () => {} }),
      }),
    };
    const tool: Tool = {
      definition: {
        name: "transport_test",
        description: "test",
        parameters: z.object({}),
        sandboxAware: true,
      },
      handler: async (_args, _signal, context) => {
        const child = context!.process!.spawnShell("true", { cwd: root });
        await new Promise<void>((resolve) => child.once("close", () => resolve()));
        return { success: true, output: "ok" };
      },
    };
    const effects = processEffects(root);
    const broker = new DefaultExecutionBroker({
      sandbox,
      sandboxMode: "required",
      limits: { timeoutMs: 3210 },
      processBrokerFactory: ({ request, sandbox: context, signal, limits }) => {
        seen.push(`${request.name}:${limits.timeoutMs}:${context?.provider}`);
        return new DefaultExecutionProcessBroker(context, signal);
      },
    });

    const result = await broker.execute({
      executionId: "execution:transport",
      tool,
      name: tool.definition.name,
      args: {},
      effects,
      grant: createCapabilityGrant("call", effects, Date.now() + 60_000),
      workspace: { root },
    });

    expect(result.success).toBe(true);
    expect(seen).toEqual(["transport_test:3210:zapvm"]);
    expect(result.runtime?.broker?.sandbox).toBe("zapvm");
    expect(result.runtime?.broker?.sandboxEnforced).toBe(true);
  });

  test("rejects a sandbox-aware handler that bypasses the broker-owned launcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-broker-bypass-"));
    cleanup.push(root);
    const sandbox: OsSandbox = {
      status: () => ({ provider: "macos-seatbelt", available: true }),
      createContext: () => ({
        provider: "macos-seatbelt",
        enforced: true,
        readablePaths: [root],
        writablePaths: [root],
        protectedPaths: [],
        networkAllowed: false,
        prepareCommand: () => ({ executable: "/usr/bin/true", args: [], env: {}, release: () => {} }),
        prepareShell: () => ({ executable: "/usr/bin/true", args: [], env: {}, release: () => {} }),
      }),
    };
    const tool: Tool = {
      definition: {
        name: "lying_sandbox_tool",
        description: "test",
        parameters: z.object({}),
        sandboxAware: true,
        resolveEffects: () => processEffects(root),
      },
      handler: async () => ({ success: true, output: "pretended" }),
    };
    const result = await new DefaultExecutionBroker({ sandbox, sandboxMode: "required" }).execute({
      executionId: "execution:bypass",
      tool,
      name: tool.definition.name,
      args: {},
      effects: processEffects(root),
      grant: createCapabilityGrant("call", processEffects(root), Date.now() + 60_000),
      workspace: { root, mode: "root" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("without using the broker-owned process launcher");
  });

  test("rejects a capability grant that does not cover resolved effects", async () => {
    const effects = processEffects("/tmp/broker-covered");
    const tool: Tool = {
      definition: {
        name: "grant_test",
        description: "test",
        parameters: z.object({}),
        sandboxAware: true,
      },
      handler: async () => ({ success: true, output: "ran" }),
    };
    const grant = createCapabilityGrant("call", emptyToolEffects(), Date.now() + 60_000);
    const result = await new DefaultExecutionBroker({ sandboxMode: "disabled" }).execute({
      executionId: "execution:test",
      tool,
      name: "grant_test",
      args: {},
      effects,
      grant,
      workspace: { root: "/tmp/broker-covered", mode: "root" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not cover modify path");
  });

  test("enforces the broker timeout even when a tool requests a larger timeout", async () => {
    const effects = emptyToolEffects();
    const tool: Tool = {
      definition: {
        name: "slow_test",
        description: "test",
        parameters: z.object({}),
        limits: { timeoutMs: 10_000 },
      },
      handler: async (_args, signal) => new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve({ success: false, output: "", error: "aborted" }), { once: true });
      }),
    };
    const result = await new DefaultExecutionBroker({
      sandboxMode: "disabled",
      limits: { timeoutMs: 20 },
    }).execute({
      executionId: "execution:timeout",
      tool,
      name: "slow_test",
      args: {},
      effects,
      grant: createCapabilityGrant("call", effects, Date.now() + 60_000),
      workspace: { root: process.cwd(), mode: "root" },
      limits: tool.definition.limits,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("broker timeout");
  });

  test("allows the host hard timeout to exceed SDK defaults while tools may only tighten it", async () => {
    const effects = emptyToolEffects();
    const tool: Tool = {
      definition: { name: "host_timeout", description: "test", parameters: z.object({}) },
      handler: async (_args, _signal, context) => ({
        success: true,
        output: String(context?.limits?.timeoutMs),
      }),
    };
    const broker = new DefaultExecutionBroker({ limits: { timeoutMs: 120_000 } });
    const baseRequest = {
      executionId: "execution:host-timeout",
      tool,
      name: "host_timeout",
      args: {},
      effects,
      grant: createCapabilityGrant("call", effects, Date.now() + 60_000),
      workspace: { root: process.cwd(), mode: "root" as const },
    };

    expect((await broker.execute(baseRequest)).output).toBe("120000");
    expect((await broker.execute({ ...baseRequest, limits: { timeoutMs: 5_000 } })).output).toBe("5000");
  });

  test("honors declared timeouts above the SDK fallback without relaxing other resource ceilings", async () => {
    const effects = emptyToolEffects();
    const tool: Tool = {
      definition: { name: "declared_timeout", description: "test", parameters: z.object({}) },
      handler: async (_args, _signal, context) => ({ success: true, output: JSON.stringify(context?.limits) }),
    };
    const broker = new DefaultExecutionBroker();
    const request = { executionId: "execution:declared-timeout", tool, name: "declared_timeout", args: {},
      effects, grant: createCapabilityGrant("call", effects, Date.now() + 60_000), workspace: { root: process.cwd() } };
    const fallback = JSON.parse((await broker.execute(request)).output);
    const declared = JSON.parse((await broker.execute({ ...request,
      limits: { timeoutMs: 1_230_000, maxOutputBytes: Number.MAX_SAFE_INTEGER } })).output);
    expect(fallback.timeoutMs).toBe(30_000);
    expect(declared.timeoutMs).toBe(1_230_000);
    expect(declared.maxOutputBytes).toBe(fallback.maxOutputBytes);
    for (const timeoutMs of [NaN, Infinity, -1]) {
      expect(await broker.execute({ ...request, limits: { timeoutMs } })).toMatchObject({
        success: false, failure: { code: "RESOURCE_LIMIT", source: "broker" },
      });
    }
  });

  test("executor fallback is not a hard ceiling for trusted per-tool timeouts", async () => {
    const registry = new ToolRegistry();
    for (const declared of [true, false]) {
      registry.register({
        definition: { name: declared ? "long_probe" : "fallback_probe", description: "test",
          parameters: z.object({}), resolveEffects: () => emptyToolEffects(),
          ...(declared ? { timeoutMs: 500 } : {}) },
        handler: async (_args, _signal, context) => {
          await new Promise(resolve => setTimeout(resolve, 60));
          return { success: true, output: String(context?.limits?.timeoutMs) };
        },
      });
    }
    const executor = new ToolExecutor(registry, { timeoutMs: 20 });
    expect(await executor.execute("long_probe", {})).toMatchObject({ success: true, output: "500" });
    expect(await executor.execute("fallback_probe", {})).toMatchObject({
      success: false, failure: { code: "DEADLINE_EXCEEDED" },
    });
  });

  test("passes one effective resource meter and rejects adapter overages", async () => {
    const effects = emptyToolEffects();
    const tool: Tool = {
      definition: { name: "meter_test", description: "test", parameters: z.object({}) },
      handler: async (_args, _signal, context) => {
        context!.resources!.consumeNetworkBytes(5);
        context!.resources!.consumeNetworkBytes(6);
        return { success: true, output: "unreachable" };
      },
    };
    const result = await new DefaultExecutionBroker({
      sandboxMode: "disabled",
      limits: { maxNetworkBytes: 10 },
    }).execute({
      executionId: "execution:meter",
      tool,
      name: "meter_test",
      args: {},
      effects,
      grant: createCapabilityGrant("call", effects, Date.now() + 60_000),
      workspace: { root: process.cwd(), mode: "root" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("maxNetworkBytes exceeded");
  });
});

const describeMacSandbox = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")
  ? describe
  : describe.skip;

describeMacSandbox("macOS Seatbelt integration", () => {
  test("allows writes inside the grant and denies writes outside it", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "zap-seatbelt-"));
    cleanup.push(fixture);
    const root = join(fixture, "workspace");
    const outside = join(fixture, "outside.txt");
    const outsideSecret = join(fixture, "secret.txt");
    const protectedContents = "seatbelt-protected-file-contents";
    mkdirSync(root);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".zapcode"));
    writeFileSync(outsideSecret, protectedContents);
    writeFileSync(join(root, ".git", "config"), "git-original");
    writeFileSync(join(root, ".zapcode", "settings.json"), "zap-original");
    const registry = new ToolRegistry();
    registry.register(executeCommandTool({ defaultCwd: root, sandboxNetwork: false }));
    const executor = new ToolExecutor(registry, {
      cwd: root,
      onApproval: async () => true,
      executionBroker: new DefaultExecutionBroker({
        sandbox: createPlatformSandbox(),
        sandboxMode: "required",
      }),
    });

    const allowed = await executor.execute("bash", {
      command: "printf allowed > inside.txt",
    });
    const denied = await executor.execute("bash", {
      command: `printf denied > ${JSON.stringify(outside)}`,
    });
    const deniedRead = await executor.execute("bash", {
      command: `cat ${JSON.stringify(outsideSecret)}`,
    });
    const deniedGitWrite = await executor.execute("bash", {
      command: "printf hacked > .git/config",
    });
    const deniedZapWrite = await executor.execute("bash", {
      command: "printf hacked > .zapcode/settings.json",
    });
    const server = createServer((_request, response) => response.end("reachable-with-network"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const deniedNetwork = await executor.execute("bash", {
      command: `curl -fsS http://127.0.0.1:${port}`,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(allowed.success).toBe(true);
    expect(readFileSync(join(root, "inside.txt"), "utf8")).toBe("allowed");
    expect(denied.success).toBe(false);
    expect(deniedRead.success).toBe(false);
    // Permission diagnostics may name secret.txt; check for actual file data.
    expect(deniedRead.output).not.toContain(protectedContents);
    expect(deniedRead.error ?? "").not.toContain(protectedContents);
    expect(deniedGitWrite.success).toBe(false);
    expect(deniedZapWrite.success).toBe(false);
    expect(deniedNetwork.success).toBe(false);
    expect(deniedNetwork.output).not.toContain("reachable-with-network");
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe("git-original");
    expect(readFileSync(join(root, ".zapcode", "settings.json"), "utf8")).toBe("zap-original");
    expect(existsSync(outside)).toBe(false);
    expect(allowed.runtime?.broker?.sandbox).toBe("macos-seatbelt");
    expect(allowed.runtime?.broker?.sandboxEnforced).toBe(true);
  });
});
