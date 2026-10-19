import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { executeCommandTool } from "../../builtin-tools/command.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { matchDangerousToolCall } from "../../utils/safety.js";
import { createCapabilityGrant } from "../../policy/engine.js";
import type { ToolEffects } from "../../tools/effects.js";
import {
  createZapVmCloudExecutionBroker,
  deriveZapVmCloudComputerId,
  discoverZapVmCloudConfig,
  selectZapVmCloudConfigForWorkspace,
  type ExecutionBrokerRequest,
  type ZapVmCloudConfig,
  type ZapVmCloudControlClient,
  type ZapVmCloudLocalAutoConfig,
  type ZapVmCloudSubmit,
  type ZapVmCloudTask,
  type ZapVmCloudTaskEvent,
  TransparentExecutionBroker,
} from "../../execution/index.js";

describe("zapVM cloud execution", () => {
  const cleanup: string[] = [];
  const sockets: Server[] = [];

  afterEach(async () => {
    for (const server of sockets.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("loads only an owner-only fixed-workspace mTLS binding", () => {
    if (process.platform === "win32") return;
    const root = fixtureRoot(cleanup);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const ca = secureFile(root, "ca.pem");
    const certificate = secureFile(root, "operator.pem");
    const privateKey = secureFile(root, "operator.key");
    const configPath = join(root, "cloud.json");
    writeFileSync(configPath, JSON.stringify({
      schema_version: 1,
      control_url: "https://control.example.test:9444",
      server_ca: ca,
      certificate,
      private_key: privateKey,
      computer_id: "computer-a",
      workspace_root: workspace,
      network: "off",
    }), { mode: 0o600 });

    const config = discoverZapVmCloudConfig({ configPath });
    expect(config).toMatchObject({
      control_url: "https://control.example.test:9444",
      computer_id: "computer-a",
      workspace_root: realpathSync(workspace),
      workspace_read_only: false,
      network: "off",
      poll_ms: 500,
    });
    expect(selectZapVmCloudConfigForWorkspace(config, workspace)).toBe(config);
    expect(selectZapVmCloudConfigForWorkspace(config, root)).toBeUndefined();

    chmodSync(configPath, 0o644);
    expect(() => discoverZapVmCloudConfig({ configPath })).toThrow("group or others");
  });

  it("loads a trusted local auto-provisioner only for configured workspace roots", () => {
    if (process.platform === "win32") return;
    const root = fixtureRoot(cleanup);
    const allowed = join(root, "allowed");
    const project = join(allowed, "project");
    mkdirSync(project, { recursive: true });
    const provisioner = fakeProvisioner(root);
    const configPath = join(root, "cloud-auto.json");
    writeFileSync(configPath, JSON.stringify({
      schema_version: 1,
      binding_mode: "local-auto",
      control_url: "https://control.example.test",
      server_ca: secureFile(root, "auto-ca.pem"),
      certificate: secureFile(root, "auto-operator.pem"),
      private_key: secureFile(root, "auto-operator.key"),
      provisioner_binary: provisioner,
      daemon_endpoint: join(root, "daemon.sock"),
      workspace_roots: [allowed],
      computer_id_prefix: "zap-",
      computer_profile: "work",
      computer_revision: "work-v1",
      network: "off",
    }), { mode: 0o600 });

    const config = discoverZapVmCloudConfig({ configPath });
    expect(config?.binding_mode).toBe("local-auto");
    expect(config).toMatchObject({ computer_profile: "work", computer_revision: "work-v1" });
    expect(selectZapVmCloudConfigForWorkspace(config, project)).toBe(config);
    expect(selectZapVmCloudConfigForWorkspace(config, root)).toBeUndefined();
    chmodSync(provisioner, 0o775);
    expect(() => discoverZapVmCloudConfig({ configPath })).toThrow("not group/world writable");
  });

  it("streams cloud Task output through the existing Bash tool contract", async () => {
    const root = fixtureRoot(cleanup);
    mkdirSync(join(root, ".git"));
    const client = new RecordingClient({
      events: [{
        cursor: 1,
        task_id: "placeholder",
        type: "exec.output",
        stream: "stdout",
        data: Buffer.from("cloud-ready\n").toString("base64"),
      }, {
        cursor: 2,
        task_id: "placeholder",
        type: "exec.result",
        ok: true,
      }],
      terminalState: "succeeded",
    });
    const result = await cloudBroker(root, client).execute(commandRequest(root, "printf cloud-ready"));

    expect(result).toMatchObject({ success: true, output: "cloud-ready\n" });
    expect(result.runtime?.broker).toMatchObject({ sandbox: "zapvm", sandboxEnforced: true });
    expect(client.submissions).toHaveLength(1);
    expect(client.submissions[0]).toMatchObject({
      computerId: "computer-a",
      command: {
        argv: ["/bin/sh", "-c", "printf cloud-ready"],
        cwd: ".",
        protectedWorkspacePaths: [".git", ".zapcode"],
      },
    });
  });

  it("keeps approval guest paths aligned with the submitted shell cwd", async () => {
    const root = fixtureRoot(cleanup);
    mkdirSync(join(root, "nested"));
    // RecordingClient only records the submission; no command is executed.
    const client = new RecordingClient({ events: [{ cursor: 1, task_id: "placeholder", type: "exec.result", ok: true }], terminalState: "succeeded" });
    const registry = new ToolRegistry();
    registry.register(executeCommandTool({ defaultCwd: root, disableBackgroundTasks: true }));
    let approved = false;
    const executor = new ToolExecutor(registry, {
      cwd: root, executionBroker: cloudBroker(root, client),
      onApproval: async (_name, args, _signal, context) => {
        expect(context?.shell).toEqual({ syntax: "posix", filesystem: "workspace-mapped", workspaceRoot: "/workspace" });
        expect(matchDangerousToolCall(args, context!.workspaceRoot, context!.cwd, context!.shell)).toBeNull();
        approved = true;
        return true;
      },
    });
    const result = await executor.execute("bash", { command: "rm -rf /workspace/nested/cache", cwd: "nested" });
    expect(result.success).toBe(true);
    expect(approved).toBe(true);
    expect(client.submissions[0].command).toMatchObject({
      argv: ["/bin/sh", "-c", "rm -rf /workspace/nested/cache"], cwd: "./nested",
    });
  });

  it("waits for the terminal exec.result journal before reporting success", async () => {
    const root = fixtureRoot(cleanup);
    const client = new RecordingClient({
      eventsAfterCalls: 2,
      events: [{
        cursor: 1,
        task_id: "placeholder",
        type: "exec.output",
        stream: "stdout",
        data: Buffer.from("eventually-visible\n").toString("base64"),
      }, {
        cursor: 2,
        task_id: "placeholder",
        type: "exec.result",
        ok: true,
      }],
      terminalState: "succeeded",
    });
    const result = await cloudBroker(root, client).execute(commandRequest(root, "printf eventually-visible"));

    expect(result).toMatchObject({ success: true, output: "eventually-visible\n" });
    expect(client.eventCalls).toBe(3);
  });

  it("auto-provisions and reuses one stable Computer per allowed workspace", async () => {
    if (process.platform === "win32") return;
    const root = fixtureRoot(cleanup);
    const workspace = join(root, "project");
    mkdirSync(workspace);
    const provisioner = fakeProvisioner(root);
    const config = autoCloudConfig(root, provisioner);
    sockets.push(await daemonSocket(config.daemon_endpoint));
    const client = new RecordingClient({
      events: [{ cursor: 1, task_id: "placeholder", type: "exec.result", ok: true }],
      terminalState: "succeeded",
    });
    const broker = createZapVmCloudExecutionBroker(config, {
      client,
      limits: { timeoutMs: 5_000 },
    });

    expect(selectZapVmCloudConfigForWorkspace(config, workspace)).toBe(config);
    expect(await broker.execute(commandRequest(workspace, "true"))).toMatchObject({ success: true });
    expect(await broker.execute(commandRequest(workspace, "true"))).toMatchObject({ success: true });
    const expectedId = deriveZapVmCloudComputerId("zap-", realpathSync(workspace), config.computer_revision, config);
    expect(client.submissions.map((item) => item.computerId)).toEqual([expectedId, expectedId]);
    expect(readFileSync(join(root, "provision.log"), "utf8").trim().split("\n")).toHaveLength(4);
  });

  it("reports a missing configured daemon and never falls back to the host", async () => {
    if (process.platform === "win32") return;
    const root = fixtureRoot(cleanup);
    const client = new RecordingClient({ terminalState: "succeeded" });
    const vm = createZapVmCloudExecutionBroker(autoCloudConfig(root, fakeProvisioner(root)), { client });
    let hostRuns = 0;
    let toolRuns = 0;
    const broker = new TransparentExecutionBroker({ vm, local: {
      sandboxStatus: () => ({ provider: "none", available: false }),
      execute: async () => { hostRuns++; return { success: true, output: "host" }; },
    } });
    const request = commandRequest(root, "true");
    request.tool = { ...request.tool, handler: async () => { toolRuns++; return { success: true, output: "ran" }; } };
    expect(broker.sandboxStatus()).toMatchObject({ provider: "zapvm", available: false });
    const result = await broker.execute(request);
    expect(result).toMatchObject({ success: false, failure: { code: "BACKEND_UNAVAILABLE", source: "backend" },
      runtime: { execution: { receipt: { outcome: "rejected", spawnedProcesses: 0 } } } });
    expect(result.error).toContain("daemon socket is unavailable");
    expect(result.error).toContain("no host fallback");
    expect(hostRuns).toBe(0);
    expect(toolRuns).toBe(0);
    expect(client.submissions).toHaveLength(0);
  });

  it("rechecks daemon readiness between commands instead of trusting a session cache", async () => {
    if (process.platform === "win32") return;
    const root = fixtureRoot(cleanup);
    const provisioner = fakeProvisioner(root);
    const config = autoCloudConfig(root, provisioner);
    sockets.push(await daemonSocket(config.daemon_endpoint));
    const client = new RecordingClient({ terminalState: "succeeded",
      events: [{ cursor: 1, task_id: "placeholder", type: "exec.result", ok: true }] });
    const broker = createZapVmCloudExecutionBroker(config, { client });
    expect((await broker.execute(commandRequest(root, "true"))).success).toBe(true);
    writeFileSync(provisioner, "#!/bin/sh\necho 'daemon unavailable' >&2\nexit 1\n", { mode: 0o755 });
    const result = await broker.execute(commandRequest(root, "true"));
    expect(result).toMatchObject({ success: false, failure: { code: "BACKEND_UNAVAILABLE", source: "backend" },
      runtime: { execution: { receipt: { spawnedProcesses: 0 } } } });
    expect(result.error).toContain("daemon unavailable");
    expect(client.submissions).toHaveLength(1);
  });

  it("covers preflight with the broker deadline and does not invoke the tool after cancellation", async () => {
    if (process.platform === "win32") return;
    const root = fixtureRoot(cleanup);
    const provisioner = fakeProvisioner(root);
    writeFileSync(provisioner, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const config = autoCloudConfig(root, provisioner);
    sockets.push(await daemonSocket(config.daemon_endpoint));
    const client = new RecordingClient({ terminalState: "succeeded" });
    let toolRuns = 0;
    const request = commandRequest(root, "true");
    request.tool = { ...request.tool, handler: async () => { toolRuns++; return { success: true, output: "ran" }; } };
    const broker = createZapVmCloudExecutionBroker(config, { client, limits: { timeoutMs: 20 } });
    expect(await broker.execute(request)).toMatchObject({ success: false,
      failure: { code: "DEADLINE_EXCEEDED", source: "broker" } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(toolRuns).toBe(0);
    expect(client.submissions).toHaveLength(0);
  });

  it("rotates Work Computer identity with capability revision and policy", () => {
    const policy = {
      computer_profile: "work" as const,
      workspace_read_only: false,
      network: "restricted" as const,
      allowed_domains: ["cache.nixos.org", "channels.nixos.org"],
      allowed_ports: [443],
    };
    const first = deriveZapVmCloudComputerId("zap-", "/workspace/project", "work-v1", policy);
    const reordered = deriveZapVmCloudComputerId("zap-", "/workspace/project", "work-v1", {
      ...policy,
      allowed_domains: [...policy.allowed_domains].reverse(),
    });
    const upgraded = deriveZapVmCloudComputerId("zap-", "/workspace/project", "work-v2", policy);
    expect(reordered).toBe(first);
    expect(upgraded).not.toBe(first);
  });

  it("cancels the remote Task when the Agent call is aborted", async () => {
    const root = fixtureRoot(cleanup);
    const controller = new AbortController();
    const client = new RecordingClient({ terminalState: "running", onInspect: () => controller.abort() });
    const result = await cloudBroker(root, client).execute(
      commandRequest(root, "sleep 30"),
      controller.signal,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("aborted");
    expect(client.cancellations).toHaveLength(1);
  });

  it("rejects network grants that exceed the fixed Computer policy", async () => {
    const root = fixtureRoot(cleanup);
    const client = new RecordingClient({ terminalState: "succeeded" });
    const request = commandRequest(root, "curl https://example.com", ["https://example.com"]);
    const result = await cloudBroker(root, client).execute(request);

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("networking is disabled");
    expect(client.submissions).toHaveLength(0);
  });

  const live = process.env.ZAPCODE_ZAPVM_CLOUD_LIVE === "1" ? it : it.skip;
  live("executes through the configured mTLS control plane and real VM", async () => {
    const config = discoverZapVmCloudConfig();
    if (!config) throw new Error("live cloud binding is not installed");
    const workspace = config.binding_mode === "fixed"
      ? config.workspace_root
      : process.env.ZAPCODE_ZAPVM_CLOUD_LIVE_WORKSPACE;
    if (!workspace) throw new Error("local-auto live acceptance requires ZAPCODE_ZAPVM_CLOUD_LIVE_WORKSPACE");
    const marker = ".zap-cloud-live-acceptance";
    const command = [
      "set -eu",
      `trap 'rm -f ${marker}' EXIT`,
      "printf 'cloud-adapter-ready\\n'",
      "uname -s",
      "grep '^ID=' /etc/os-release",
      "test ! -w .git",
      "test ! -w .zapcode",
      `printf 'workspace-write-ok\\n' > ${marker}`,
      `cat ${marker}`,
    ].join("; ");
    const broker = createZapVmCloudExecutionBroker(config, {
      limits: { timeoutMs: 180_000 },
    });
    const result = await broker.execute(commandRequest(workspace, command));

    expect(result.success).toBe(true);
    expect(result.output).toContain("cloud-adapter-ready\nLinux\nID=alpine\nworkspace-write-ok\n");
    const installed = await broker.execute(commandRequest(workspace, "zap-pkg install hello", [
      "https://channels.nixos.org",
      "https://cache.nixos.org",
      "https://releases.nixos.org",
    ]));
    expect(installed).toMatchObject({ success: true });
    const persisted = await broker.execute(commandRequest(workspace, "sh -lc 'hello; zap-pkg list'"));
    expect(persisted.success).toBe(true);
    expect(persisted.output).toContain("Hello, world!\n");
    expect(persisted.output).toContain("hello");
  }, 240_000);
});

class RecordingClient implements ZapVmCloudControlClient {
  readonly submissions: ZapVmCloudSubmit[] = [];
  readonly cancellations: string[] = [];
  private taskId = "";
  private delivered = false;
  eventCalls = 0;

  constructor(private readonly options: {
    events?: ZapVmCloudTaskEvent[];
    eventsAfterCalls?: number;
    terminalState: ZapVmCloudTask["state"];
    onInspect?: () => void;
  }) {}

  async submit(input: ZapVmCloudSubmit): Promise<ZapVmCloudTask> {
    this.submissions.push(input);
    this.taskId = input.id;
    this.delivered = false;
    this.eventCalls = 0;
    return { id: input.id, state: "pending" };
  }

  async inspect(taskId: string): Promise<ZapVmCloudTask> {
    this.options.onInspect?.();
    return { id: taskId, state: this.options.terminalState };
  }

  async events(): Promise<ZapVmCloudTaskEvent[]> {
    this.eventCalls += 1;
    if (this.eventCalls <= (this.options.eventsAfterCalls ?? 0)) return [];
    if (this.delivered) return [];
    this.delivered = true;
    return (this.options.events ?? []).map((event) => ({ ...event, task_id: this.taskId }));
  }

  async cancel(taskId: string): Promise<ZapVmCloudTask> {
    this.cancellations.push(taskId);
    return { id: taskId, state: "canceled" };
  }
}

function cloudBroker(root: string, client: ZapVmCloudControlClient) {
  return createZapVmCloudExecutionBroker(cloudConfig(root), {
    client,
    limits: { timeoutMs: 5_000 },
  });
}

function cloudConfig(root: string): ZapVmCloudConfig {
  return {
    schema_version: 1,
    binding_mode: "fixed",
    control_url: "https://control.example.test",
    server_ca: "/secure/ca.pem",
    certificate: "/secure/operator.pem",
    private_key: "/secure/operator.key",
    computer_id: "computer-a",
    workspace_root: realpathSync(root),
    workspace_read_only: false,
    network: "off",
    allowed_domains: [],
    allowed_ports: [],
    poll_ms: 100,
    computer_profile: "sandbox",
  };
}

function autoCloudConfig(root: string, provisioner: string): ZapVmCloudLocalAutoConfig {
  return {
    schema_version: 1,
    binding_mode: "local-auto",
    control_url: "https://control.example.test",
    server_ca: "/secure/ca.pem",
    certificate: "/secure/operator.pem",
    private_key: "/secure/operator.key",
    provisioner_binary: provisioner,
    daemon_endpoint: join(root, "daemon.sock"),
    workspace_roots: [realpathSync(root)],
    computer_id_prefix: "zap-",
    computer_profile: "work",
    computer_revision: "work-v1",
    workspace_read_only: false,
    network: "off",
    allowed_domains: [],
    allowed_ports: [],
    poll_ms: 100,
  };
}

function commandRequest(root: string, command: string, destinations: string[] = []): ExecutionBrokerRequest {
  const tool = executeCommandTool({ defaultCwd: root, disableBackgroundTasks: true, restrictedNetwork: true });
  const effects: ToolEffects = {
    filesystem: [
      { kind: "filesystem", operation: "read", paths: [root] },
      { kind: "filesystem", operation: "modify", paths: [root] },
    ],
    network: destinations.length > 0
      ? [{ kind: "network", operation: "connect", destinations, methods: [] }]
      : [],
    process: [{ kind: "process", operation: "spawn", commandClass: "shell", background: false }],
    external: [],
    workspace: { mode: "root-integration" },
    confidence: "declared",
  };
  return {
    executionId: "exec:cloud",
    tool,
    name: "bash",
    args: { command, ...(destinations.length > 0 ? { network_destinations: destinations } : {}) },
    effects,
    grant: createCapabilityGrant("call:cloud", effects, Date.now() + 60_000),
    workspace: { root },
  };
}

function fixtureRoot(cleanup: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "zap-cloud-test-"));
  cleanup.push(root);
  return root;
}

async function daemonSocket(endpoint: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve());
  });
  return server;
}

function secureFile(root: string, name: string): string {
  const path = join(root, name);
  writeFileSync(path, `${name}\n`, { mode: 0o600 });
  return path;
}

function fakeProvisioner(root: string): string {
  const path = join(root, "fake-zapvm");
  const state = join(root, "computer.json");
  const log = join(root, "provision.log");
  writeFileSync(path, [
    "#!/bin/sh",
    `state='${state}'`,
    `log='${log}'`,
    "printf '%s %s\\n' \"$1\" \"$2\" >> \"$log\"",
    "action=$2",
    "shift 2",
    "if [ \"$action\" = inspect ]; then",
    "  if [ ! -f \"$state\" ]; then echo 'Computer does not exist' >&2; exit 1; fi",
    "  cat \"$state\"; exit 0",
    "fi",
    "id='' workspace='' network='off' readonly='false'",
    "while [ $# -gt 0 ]; do",
    "  case \"$1\" in",
    "    --id) id=$2; shift 2;;",
    "    --workspace) workspace=$2; shift 2;;",
    "    --network) network=$2; shift 2;;",
    "    --workspace-read-only) readonly='true'; shift;;",
    "    *) shift 2;;",
    "  esac",
    "done",
    "printf '{\"id\":\"%s\",\"workspace\":\"%s\",\"workspace_read_only\":%s,\"network\":\"%s\"}\\n' \"$id\" \"$workspace\" \"$readonly\" \"$network\" > \"$state\"",
    "cat \"$state\"",
  ].join("\n"), { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}
