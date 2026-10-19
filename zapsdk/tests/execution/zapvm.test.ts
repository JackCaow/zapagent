import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  TransparentExecutionBroker,
  ZapVmRuntime,
  buildZapVmExecArgs,
  discoverZapVmInstallation,
  normalizeZapVmShellCommand,
  parseZapVmCapabilities,
  parseZapVmDaemonStatus,
  resolveZapVmGuestCwd,
  resolveZapVmNetworkPolicy,
  type ExecutionBroker,
  type ExecutionBrokerRequest,
  type ZapVmRuntimeController,
} from "../../execution/index.js";

describe("transparent zapVM execution", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("discovers only a complete non-symlinked runtime installation", () => {
    const root = fixtureRoot(cleanup);
    const dataDir = join(root, "data");
    const runtimeRoot = join(root, "runtime");
    mkdirSync(join(runtimeRoot, "bin"), { recursive: true });
    mkdirSync(join(runtimeRoot, "images"), { recursive: true });
    writeFileSync(join(runtimeRoot, "bin", "zapvm"), "binary");
    writeFileSync(join(runtimeRoot, "images", "active.json"), "{}\n");
    writeFileSync(join(runtimeRoot, "image-public.pem"), "public-key\n");

    expect(discoverZapVmInstallation({ runtimeRoot, dataDir, platform: "darwin" })).toEqual({
      runtimeRoot: resolve(runtimeRoot),
      binaryPath: join(resolve(runtimeRoot), "bin", "zapvm"),
      imageRoot: join(resolve(runtimeRoot), "images"),
      publicKeyPath: join(resolve(runtimeRoot), "image-public.pem"),
      stateRoot: join(resolve(dataDir), "runtime-state", "zapvm"),
    });

    rmSync(join(runtimeRoot, "image-public.pem"));
    expect(discoverZapVmInstallation({ runtimeRoot, dataDir, platform: "darwin" })).toBeUndefined();
    const realKey = join(root, "real-key.pem");
    writeFileSync(realKey, "public-key\n");
    symlinkSync(realKey, join(runtimeRoot, "image-public.pem"));
    expect(discoverZapVmInstallation({ runtimeRoot, dataDir, platform: "darwin" })).toBeUndefined();
  });

  it("maps host working directories into the authorized guest workspace", () => {
    expect(resolveZapVmGuestCwd("/repo", "/repo")).toBe(".");
    expect(resolveZapVmGuestCwd("/repo", "/repo/packages/app")).toBe("./packages/app");
    expect(() => resolveZapVmGuestCwd("/repo", "/outside")).toThrow("outside the authorized workspace");
  });

  it("accepts only the signed VM capability contract shape", () => {
    const valid = JSON.stringify({
      schema_version: 1,
      rootfs_mode: "read-only",
      workspace_mode: "read-write-executable",
      protected_workspace_paths: [".git", ".zapcode"],
      temporary_storage_scope: "request",
      temporary_storage_executable: true,
      runtime_package_management: "image-build-only",
      commands: ["bash", "python3"],
      network_modes: ["off", "restricted", "unrestricted"],
    });
    expect(parseZapVmCapabilities(valid)?.commands).toEqual(["bash", "python3"]);
    expect(parseZapVmCapabilities(valid.replace("image-build-only", "persistent-rootless"))?.runtime_package_management).toBe("persistent-rootless");
    expect(parseZapVmCapabilities(valid.replace("read-only", "writable"))).toBeUndefined();
    expect(parseZapVmCapabilities("not-json")).toBeUndefined();
  });

  it("marks a degraded daemon status as unhealthy", () => {
    expect(parseZapVmDaemonStatus('{"workers":0,"degraded":false}')).toBe("ready");
    expect(parseZapVmDaemonStatus('{"workers":0,"degraded":true}')).toBe("unhealthy");
    expect(parseZapVmDaemonStatus('{"workers":0}')).toBeUndefined();
    expect(parseZapVmDaemonStatus("not-json")).toBeUndefined();
  });

  for (const initiallyUnreachable of [false, true]) it(`recycles a degraded daemon (initially unreachable: ${initiallyUnreachable})`, async () => {
    if (process.platform === "win32") return;
    const root = fixtureRoot(cleanup);
    const binaryPath = join(root, "fake-zapvm");
    const unhealthy = join(root, "unhealthy");
    const stopped = join(root, "stopped");
    const ready = join(root, "ready");
    writeFileSync(unhealthy, "\n");
    writeFileSync(binaryPath, [
      "#!/bin/sh",
      `unhealthy='${unhealthy.replaceAll("'", "'\\''")}'`,
      `stopped='${stopped.replaceAll("'", "'\\''")}'`,
      `ready='${ready.replaceAll("'", "'\\''")}'`,
      'if [ "$1 $2" = "daemon status" ]; then',
      ...(initiallyUnreachable ? [`  if [ ! -f '${root}/probed' ]; then : > '${root}/probed'; exit 1; fi`] : []),
      '  if [ -f "$unhealthy" ]; then printf \'{"degraded":true}\\n\'; exit 0; fi',
      '  if [ -f "$ready" ]; then printf \'{"degraded":false}\\n\'; exit 0; fi',
      "  exit 1",
      "fi",
      'if [ "$1 $2" = "daemon stop" ]; then rm -f "$ready"; mv "$unhealthy" "$stopped"; exit 1; fi',
      'if [ "$1 $2" = "daemon serve" ]; then : > "$ready"; exit 0; fi',
      "exit 2",
    ].join("\n"));
    chmodSync(binaryPath, 0o755);

    const runtime = new ZapVmRuntime({
      installation: {
        runtimeRoot: root,
        binaryPath,
        imageRoot: join(root, "images"),
        publicKeyPath: join(root, "image-public.pem"),
        stateRoot: join(root, "state"),
      },
      startTimeoutMs: 3_000,
    });
    await runtime.ensureReady();
    expect(existsSync(stopped)).toBe(true);
    expect(existsSync(ready)).toBe(true);
  });

  it("builds an argv-only daemon request without host-shell interpolation", () => {
    expect(buildZapVmExecArgs({
      endpoint: "/data/runtime-state/zapvm/daemon.sock",
      workspaceRoot: "/repo",
      hostCwd: "/repo/packages/app",
      sessionId: "session-a",
      timeoutMs: 60_000,
      argv: ["/bin/sh", "-c", "printf '$HOME; still one argv'"],
    })).toEqual([
      "daemon", "exec",
      "--endpoint", "/data/runtime-state/zapvm/daemon.sock",
      "--workspace", "/repo",
      "--session-id", "session-a",
      "--cwd", "./packages/app",
      "--exec-timeout", "60000ms",
      "--network", "off",
      "--", "/bin/sh", "-c", "printf '$HOME; still one argv'",
    ]);
  });

  it("maps explicit network grants and protected paths to daemon flags", () => {
    const networkPolicy = resolveZapVmNetworkPolicy({
      destinations: ["https://API.Example.com/v1", "http://mirror.example.com:8080", "*.cdn.example.com"],
      methods: [],
    });
    expect(networkPolicy).toEqual({
      domains: ["*.cdn.example.com", "api.example.com", "mirror.example.com"],
      ports: [443, 8080],
    });
    const args = buildZapVmExecArgs({
      endpoint: "/daemon.sock",
      workspaceRoot: "/repo",
      hostCwd: "/repo",
      sessionId: "session-a",
      timeoutMs: 1000,
      argv: ["curl", "https://api.example.com"],
      protectedWorkspacePaths: [".git", ".zapcode"],
      networkPolicy,
    });
    expect(args).toContain("restricted");
    expect(args.filter((value) => value === "--protect-workspace-path")).toHaveLength(2);
    expect(args.filter((value) => value === "--allow-domain")).toHaveLength(3);
    expect(args.filter((value) => value === "--allow-port")).toHaveLength(2);
    expect(resolveZapVmNetworkPolicy({ destinations: ["*.assets.example.com"], methods: [] }))
      .toEqual({ domains: ["*.assets.example.com"], ports: [443] });
  });

  it("rejects wildcard and method-scoped shell network grants", () => {
    expect(() => resolveZapVmNetworkPolicy({ destinations: ["*"], methods: [] }))
      .toThrow("explicit destination domains");
    expect(() => resolveZapVmNetworkPolicy({ destinations: ["example.com"], methods: ["GET"] }))
      .toThrow("method-scoped grants");
  });

  it("keeps a truncated multibyte Session ID valid and within the daemon limit", () => {
    const args = buildZapVmExecArgs({
      endpoint: "/data/runtime-state/zapvm/daemon.sock",
      workspaceRoot: "/repo",
      hostCwd: "/repo",
      sessionId: "会".repeat(100),
      timeoutMs: 1000,
      argv: ["true"],
    });
    const sessionId = args[args.indexOf("--session-id") + 1];
    expect(Buffer.byteLength(sessionId, "utf8")).toBeLessThanOrEqual(256);
    expect(sessionId).not.toContain("�");
  });

  it("restores Windows Host null redirects for the Linux Guest shell", () => {
    expect(normalizeZapVmShellCommand("build > NUL 2>>nul; echo 'NUL'", "win32"))
      .toBe("build > /dev/null 2>> /dev/null; echo 'NUL'");
    expect(normalizeZapVmShellCommand("build > NUL", "darwin")).toBe("build > NUL");
  });

  it("routes bash to the VM and keeps non-process tools on the host", async () => {
    const calls: string[] = [];
    const local = recordingBroker("local", calls);
    const vm = recordingBroker("vm", calls);
    const runtime = runtimeController(async () => { calls.push("ready"); });
    const broker = new TransparentExecutionBroker({ local, vm, runtime });

    expect((await broker.execute(request("read_file"))).output).toBe("local");
    expect((await broker.execute(request("bash"))).output).toBe("vm");
    expect(calls).toEqual(["local:read_file", "ready", "vm:bash"]);
  });

  it("fails closed when an installed runtime cannot start", async () => {
    const calls: string[] = [];
    const broker = new TransparentExecutionBroker({
      local: recordingBroker("local", calls),
      vm: recordingBroker("vm", calls),
      runtime: runtimeController(async () => { throw new Error("VM unavailable"); }),
    });

    const result = await broker.execute(request("bash"));
    expect(result).toMatchObject({ success: false, error: "VM unavailable" });
    expect(result.failure).toMatchObject({ code: "BACKEND_UNAVAILABLE", source: "backend" });
    expect(result.runtime?.execution?.receipt.outcome).toBe("rejected");
    expect(calls).toEqual([]);
  });

  it("routes by trusted workspace capability, independent of tool name", async () => {
    const calls: string[] = [];
    const broker = new TransparentExecutionBroker({
      local: recordingBroker("local", calls), vm: recordingBroker("vm", calls),
    });
    const renamed = request("terminal_exec");
    renamed.tool.definition.executionLocation = "workspace";
    const host = request("bash");
    host.tool.definition.executionLocation = "host";
    // Model-supplied arguments cannot change the host-owned declaration.
    host.args.executionLocation = "workspace";
    await broker.execute(renamed);
    await broker.execute(host);
    expect(calls).toEqual(["vm:terminal_exec", "local:bash"]);
  });

  it("does not retry or fall back after an execution failure", async () => {
    const calls: string[] = [];
    const failure = { success: false, output: "partial", error: "network denied" };
    const broker = new TransparentExecutionBroker({
      local: recordingBroker("local", calls),
      vm: { sandboxStatus: () => ({ provider: "zapvm", available: true }),
        execute: async () => { calls.push("vm"); return failure; } },
    });
    expect(await broker.execute(request("bash"))).toBe(failure);
    expect(calls).toEqual(["vm"]);
  });

  it("preserves an explicitly configured legacy routing override", async () => {
    const calls: string[] = [];
    const broker = new TransparentExecutionBroker({
      local: recordingBroker("local", calls), vm: recordingBroker("vm", calls),
      vmToolNames: new Set(["legacy_exec"]),
    });
    await broker.execute(request("legacy_exec"));
    expect(calls).toEqual(["vm:legacy_exec"]);
  });

  it("fails closed for process tools that omit their execution boundary", async () => {
    const calls: string[] = [];
    const broker = new TransparentExecutionBroker({
      local: recordingBroker("local", calls), vm: recordingBroker("vm", calls),
    });
    const undeclared = request("new_process_tool");
    undeclared.effects.process = [{ kind: "process", operation: "spawn", commandClass: "shell", background: false }];
    const result = await broker.execute(undeclared);
    expect(result.success).toBe(false);
    expect(result.error).toContain("EXECUTION_LOCATION_REQUIRED");
    expect(result.failure?.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(calls).toEqual([]);
  });
});

function fixtureRoot(cleanup: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "zap-zapvm-test-"));
  cleanup.push(root);
  return root;
}

function recordingBroker(label: string, calls: string[]): ExecutionBroker {
  return {
    sandboxStatus: () => ({ provider: label === "vm" ? "zapvm" : "none", available: label === "vm" }),
    execute: async (input) => {
      calls.push(`${label}:${input.name}`);
      return { success: true, output: label };
    },
  };
}

function runtimeController(ensureReady: ZapVmRuntimeController["ensureReady"]): ZapVmRuntimeController {
  return {
    endpoint: "/data/runtime-state/zapvm/daemon.sock",
    installation: {
      runtimeRoot: "/runtime",
      binaryPath: "/runtime/bin/zapvm",
      imageRoot: "/runtime/images",
      publicKeyPath: "/runtime/image-public.pem",
      stateRoot: "/data/runtime-state/zapvm",
    },
    ensureReady,
  };
}

function request(name: string): ExecutionBrokerRequest {
  return {
    executionId: `exec:${name}`,
    name,
    args: {},
    tool: {
      definition: {
        name,
        description: name,
        parameters: z.object({}),
        executionLocation: name === "bash" ? "workspace" : undefined,
      },
      handler: async () => ({ success: true, output: "unused" }),
    },
    effects: {
      filesystem: [],
      network: [],
      process: [],
      external: [],
      workspace: { mode: "root-integration" },
      confidence: "declared",
    },
    grant: {
      callId: `call:${name}`,
      expiresAt: Date.now() + 60_000,
      workspace: { mode: "root-integration" },
    },
    workspace: { root: "/repo" },
  };
}
