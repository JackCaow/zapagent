import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { adaptLegacyTool, inferToolSource } from "../../tools/manifest.js";
import { DefaultToolPolicyEngine, createCapabilityGrant } from "../../policy/engine.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

describe("legacy ToolManifest adapter", () => {
  it("normalizes builtin, MCP, plugin, and agent identities", () => {
    expect(inferToolSource("read_file")).toEqual({ kind: "builtin", trust: "first-party" });
    expect(inferToolSource("mcp__github__issues")).toEqual({ kind: "mcp", owner: "github", trust: "configured" });
    expect(inferToolSource("plugin__acme__deploy")).toEqual({ kind: "plugin", owner: "acme", trust: "configured" });
    expect(inferToolSource("agent")).toEqual({ kind: "agent", trust: "first-party" });
  });

  it("preserves schema/handler and resolves legacy effects", async () => {
    const tool = {
      definition: {
        name: "read_file",
        description: "read",
        parameters: z.object({ path: z.string() }),
        readOnly: true,
      },
      handler: async () => ({ success: true, output: "ok" }),
    };
    const manifest = adaptLegacyTool(tool);
    expect(manifest.id).toEqual({ namespace: "builtin", name: "read_file" });
    expect(manifest.resolveEffects({ path: "a" }, { cwd: "/repo", toolName: "read_file" }).confidence).toBe("inferred");
    expect((await manifest.execute({ path: "a" })).output).toBe("ok");
  });
});

describe("DefaultToolPolicyEngine", () => {
  it("creates a least-scope grant from resolved effects", () => {
    const grant = createCapabilityGrant("call-1", {
      filesystem: [{ kind: "filesystem", operation: "read", paths: ["/repo/a"] }],
      network: [{ kind: "network", operation: "mutate", destinations: ["https://api.example"], methods: ["POST"] }],
      process: [],
      external: [],
      workspace: { mode: "shared-readonly" },
      confidence: "declared",
    }, 123);
    expect(grant).toMatchObject({
      callId: "call-1",
      expiresAt: 123,
      filesystem: { read: ["/repo/a"], write: [] },
      network: { destinations: ["https://api.example"], methods: ["POST"] },
    });
  });

  it("denies unsandboxed process effects in isolated workspaces", () => {
    const decision = new DefaultToolPolicyEngine().evaluate({
      call: { id: "c1", name: "bash", args: {} },
      definition: { name: "bash", description: "", parameters: z.object({}), permission: "confirm" },
      effects: {
        filesystem: [], network: [], external: [], workspace: { mode: "isolated-write" },
        process: [{ kind: "process", operation: "spawn", commandClass: "shell", unsandboxed: true }],
        confidence: "declared",
      },
      workspace: { mode: "isolated-write", root: "/repo", sandbox: "enforced" },
    } as never);
    expect(decision).toMatchObject({ decision: "deny" });
  });

  it("fails closed on unknown effects in strict mode", async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: "legacy", description: "legacy", parameters: z.object({}) },
      handler: async () => ({ success: true, output: "should not run" }),
    });
    const executor = new ToolExecutor(registry, {
      policyEngine: new DefaultToolPolicyEngine({ askOnUnknownEffects: true }),
    });
    const result = await executor.execute("legacy", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("requires approval");
  });

  it("passes the per-call grant to the handler after approval", async () => {
    let callId: string | undefined;
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "write",
        description: "write",
        parameters: z.object({ path: z.string() }),
        permission: "confirm",
        writesPath: (args) => [String(args.path)],
      },
      handler: async (_args, _signal, context) => {
        callId = context?.grant?.callId;
        return { success: true, output: "ok" };
      },
    });
    const executor = new ToolExecutor(registry, { onApproval: async () => true });
    const result = await executor.execute("write", { path: "a" }, undefined, { toolCallId: "approved-call" });
    expect(result.success).toBe(true);
    expect(callId).toBe("approved-call");
  });

  it("denies filesystem effects outside an isolated workspace", async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "write",
        description: "write",
        parameters: z.object({ path: z.string() }),
        permission: "confirm",
        writesPath: (args) => [String(args.path)],
      },
      handler: async () => ({ success: true, output: "should not run" }),
    });
    const executor = new ToolExecutor(registry, {
      cwd: "/repo/agent",
      workspace: { root: "/repo/agent", mode: "isolated-write" },
      onApproval: async () => true,
    });

    const result = await executor.execute("write", { path: join("/repo", "root.txt") });

    expect(result.success).toBe(false);
    expect(result.error).toContain("escape the isolated workspace");
  });

  it("denies unknown-effect tools inside an isolated workspace", async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "shell_like",
        description: "unknown process wrapper",
        parameters: z.object({}),
        permission: "confirm",
      },
      handler: async () => ({ success: true, output: "should not run" }),
    });
    const executor = new ToolExecutor(registry, {
      cwd: "/repo/agent",
      workspace: { root: "/repo/agent", mode: "isolated-write" },
      onApproval: async () => true,
    });

    const result = await executor.execute("shell_like", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("unknown effects");
  });
});
