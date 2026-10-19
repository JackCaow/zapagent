import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { getAppDataDir } from "../utils/platform.js";
import type { ToolResourceLimits } from "../tools/effects.js";
import { DefaultExecutionBroker } from "./broker.js";
import { ExecutionBoundaryError, operationFailure } from "./failure.js";
import type {
  ExecutionBroker,
  ExecutionBrokerRequest,
  ExecutionProcessBroker,
  OsSandbox,
  SandboxCommandOptions,
  SandboxExecutionContext,
  SandboxStatus,
} from "./types.js";
import {
  ensureProtectedWorkspacePaths,
  normalizeZapVmShellCommand,
  resolveZapVmGuestCwd,
  resolveZapVmNetworkPolicy,
  type ZapVmNetworkPolicy,
} from "./zapvm.js";

const DEFAULT_CONFIG_NAME = "zapvm-cloud.json";
const DEFAULT_POLL_MS = 500;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const TERMINAL_STATES = new Set(["succeeded", "failed", "canceled"]);

interface ZapVmCloudConfigBase {
  schema_version: 1;
  control_url: string;
  server_ca: string;
  certificate: string;
  private_key: string;
  workspace_read_only: boolean;
  network: "off" | "restricted";
  allowed_domains: string[];
  allowed_ports: number[];
  poll_ms: number;
  computer_profile: "sandbox" | "work";
}

export interface ZapVmCloudFixedConfig extends ZapVmCloudConfigBase {
  binding_mode: "fixed";
  computer_id: string;
  workspace_root: string;
}

export interface ZapVmCloudLocalAutoConfig extends ZapVmCloudConfigBase {
  binding_mode: "local-auto";
  provisioner_binary: string;
  daemon_endpoint: string;
  workspace_roots: string[];
  computer_id_prefix: string;
  computer_revision: string;
}

export type ZapVmCloudConfig = ZapVmCloudFixedConfig | ZapVmCloudLocalAutoConfig;

export interface ZapVmCloudTask {
  id: string;
  state: "pending" | "leased" | "running" | "succeeded" | "failed" | "canceled";
  failure_code?: string;
}

export interface ZapVmCloudTaskEvent {
  cursor: number;
  task_id: string;
  type: string;
  command_id?: string;
  stream?: "stdout" | "stderr";
  data?: string;
  ok?: boolean;
  error?: string;
}

export interface ZapVmCloudSubmit {
  id: string;
  computerId: string;
  command: {
    id: string;
    sessionId: string;
    argv: string[];
    cwd: string;
    protectedWorkspacePaths: string[];
    timeoutMs: number;
  };
}

export interface ZapVmCloudControlClient {
  submit(input: ZapVmCloudSubmit): Promise<ZapVmCloudTask>;
  inspect(taskId: string): Promise<ZapVmCloudTask>;
  events(taskId: string, after: number): Promise<ZapVmCloudTaskEvent[]>;
  cancel(taskId: string): Promise<ZapVmCloudTask>;
}

export interface ZapVmCloudExecutionBrokerOptions {
  limits?: Partial<ToolResourceLimits>;
  client?: ZapVmCloudControlClient;
}

/** Discover an owner-only cloud binding. Its presence is an explicit runtime
 * installation decision, so malformed bindings fail closed instead of
 * silently moving Agent commands back onto the Host. */
export function discoverZapVmCloudConfig(options: {
  configPath?: string;
  dataDir?: string;
} = {}): ZapVmCloudConfig | undefined {
  if (process.env.ZAPCODE_DISABLE_ZAPVM === "1") return undefined;
  const explicit = options.configPath ?? process.env.ZAPCODE_ZAPVM_CLOUD_CONFIG;
  const path = resolve(explicit || join(options.dataDir ?? getAppDataDir(), "runtime", DEFAULT_CONFIG_NAME));
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (!explicit && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`zapVM cloud configuration is unavailable: ${path}`);
  }
  assertOwnerOnlyRegularFile(path, info, "configuration");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`zapVM cloud configuration is not valid JSON: ${errorMessage(error)}`);
  }
  return parseZapVmCloudConfig(raw);
}

export function parseZapVmCloudConfig(raw: unknown): ZapVmCloudConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("zapVM cloud configuration must be an object");
  }
  const value = raw as Record<string, unknown>;
  const allowedKeys = new Set([
    "schema_version", "control_url", "server_ca", "certificate", "private_key",
    "binding_mode", "computer_id", "workspace_root", "workspace_read_only", "network",
    "allowed_domains", "allowed_ports", "poll_ms", "provisioner_binary",
    "daemon_endpoint", "workspace_roots", "computer_id_prefix", "computer_profile",
    "computer_revision",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`zapVM cloud configuration contains unknown field: ${key}`);
  }
  if (value.schema_version !== 1) throw new Error("zapVM cloud configuration schema_version must be 1");
  const controlUrl = requiredString(value.control_url, "control_url");
  let parsedUrl: URL;
  try { parsedUrl = new URL(controlUrl); }
  catch { throw new Error("zapVM cloud control_url is invalid"); }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.hash ||
      (parsedUrl.pathname !== "/" && parsedUrl.pathname !== "") || parsedUrl.search) {
    throw new Error("zapVM cloud control_url must be an HTTPS origin without credentials, path, query, or fragment");
  }
  const serverCA = securePath(value.server_ca, "server_ca");
  const certificate = securePath(value.certificate, "certificate");
  const privateKey = securePath(value.private_key, "private_key");
  const network = value.network ?? "off";
  if (network !== "off" && network !== "restricted") {
    throw new Error("zapVM cloud network must be off or restricted");
  }
  const allowedDomains = optionalStringList(value.allowed_domains, "allowed_domains", 128);
  const allowedPorts = optionalPortList(value.allowed_ports);
  if (network === "off" && (allowedDomains.length > 0 || allowedPorts.length > 0)) {
    throw new Error("zapVM cloud network=off cannot declare allowed domains or ports");
  }
  if (network === "restricted" && (allowedDomains.length === 0 || allowedPorts.length === 0)) {
    throw new Error("zapVM cloud restricted network requires allowed_domains and allowed_ports");
  }
  const pollMs = value.poll_ms ?? DEFAULT_POLL_MS;
  if (!Number.isSafeInteger(pollMs) || (pollMs as number) < 100 || (pollMs as number) > 10_000) {
    throw new Error("zapVM cloud poll_ms must be between 100 and 10000");
  }
  if (value.workspace_read_only !== undefined && typeof value.workspace_read_only !== "boolean") {
    throw new Error("zapVM cloud workspace_read_only must be boolean");
  }
  const computerProfile = value.computer_profile ?? "sandbox";
  if (computerProfile !== "sandbox" && computerProfile !== "work") {
    throw new Error("zapVM cloud computer_profile must be sandbox or work");
  }
  const base: ZapVmCloudConfigBase = {
    schema_version: 1,
    control_url: parsedUrl.origin,
    server_ca: serverCA,
    certificate,
    private_key: privateKey,
    workspace_read_only: value.workspace_read_only === true,
    network,
    allowed_domains: allowedDomains,
    allowed_ports: allowedPorts,
    poll_ms: pollMs as number,
    computer_profile: computerProfile,
  };
  const bindingMode = value.binding_mode ?? "fixed";
  if (bindingMode === "fixed") {
    rejectPresentFields(value, ["provisioner_binary", "daemon_endpoint", "workspace_roots", "computer_id_prefix", "computer_revision"], "fixed");
    const computerId = requiredString(value.computer_id, "computer_id");
    if (!validID(computerId)) throw new Error("zapVM cloud computer_id is invalid");
    return {
      ...base,
      binding_mode: "fixed",
      computer_id: computerId,
      workspace_root: canonicalRealDirectory(value.workspace_root, "workspace_root"),
    };
  }
  if (bindingMode === "local-auto") {
    rejectPresentFields(value, ["computer_id", "workspace_root"], "local-auto");
    const prefix = value.computer_id_prefix === undefined
      ? "zap-"
      : requiredString(value.computer_id_prefix, "computer_id_prefix");
    if (prefix.length > 80 || !validID(prefix)) throw new Error("zapVM cloud computer_id_prefix is invalid");
    const revision = value.computer_revision === undefined
      ? "sandbox-v1"
      : requiredString(value.computer_revision, "computer_revision");
    if (!validID(revision)) throw new Error("zapVM cloud computer_revision is invalid");
    return {
      ...base,
      binding_mode: "local-auto",
      provisioner_binary: trustedExecutablePath(value.provisioner_binary),
      daemon_endpoint: daemonEndpoint(value.daemon_endpoint),
      workspace_roots: canonicalDirectoryList(value.workspace_roots),
      computer_id_prefix: prefix,
      computer_revision: revision,
    };
  }
  throw new Error("zapVM cloud binding_mode must be fixed or local-auto");
}

/** A Computer mounts one exact Host workspace. A valid binding installed for
 * one project is not an instruction to hijack Bash in every other project. */
export function selectZapVmCloudConfigForWorkspace(
  config: ZapVmCloudConfig | undefined,
  workspaceRoot: string,
): ZapVmCloudConfig | undefined {
  if (!config) return undefined;
  try {
    const canonical = realpathSync.native(resolve(workspaceRoot));
    if (config.binding_mode === "fixed") {
      return canonical === config.workspace_root ? config : undefined;
    }
    return config.workspace_roots.some((root) => pathWithin(root, canonical)) ? config : undefined;
  } catch {
    return undefined;
  }
}

export function createZapVmCloudExecutionBroker(
  config: ZapVmCloudConfig,
  options: ZapVmCloudExecutionBrokerOptions = {},
): ExecutionBroker {
  const client = options.client ?? new HttpsZapVmCloudControlClient(config);
  return new DefaultExecutionBroker({
    shellEnvironment: { syntax: "posix", filesystem: "workspace-mapped", workspaceRoot: "/workspace" },
    sandbox: new ZapVmCloudSandbox(config),
    sandboxMode: "required",
    limits: options.limits,
    processBrokerFactory: ({ request, signal, limits }) => (
      new ZapVmCloudExecutionProcessBroker(config, client, request, signal, limits)
    ),
  });
}

export class HttpsZapVmCloudControlClient implements ZapVmCloudControlClient {
  private readonly ca: Buffer;
  private readonly cert: Buffer;
  private readonly key: Buffer;

  constructor(private readonly config: ZapVmCloudConfig) {
    this.ca = readFileSync(config.server_ca);
    this.cert = readFileSync(config.certificate);
    this.key = readFileSync(config.private_key);
  }

  submit(input: ZapVmCloudSubmit): Promise<ZapVmCloudTask> {
    const payload = {
      id: input.id,
      computer_id: input.computerId,
      command: {
        id: input.command.id,
        session_id: input.command.sessionId,
        argv: input.command.argv,
        cwd: input.command.cwd,
        protected_workspace_paths: input.command.protectedWorkspacePaths,
        timeout_ms: input.command.timeoutMs,
      },
    };
    return this.call<unknown>("POST", "/v1/tasks", {
      id: input.id,
      computer_id: input.computerId,
      payload,
    }).then((task) => parseCloudTask(task, input.id));
  }

  inspect(taskId: string): Promise<ZapVmCloudTask> {
    return this.call<unknown>("GET", `/v1/tasks/${encodeURIComponent(taskId)}`)
      .then((task) => parseCloudTask(task, taskId));
  }

  async events(taskId: string, after: number): Promise<ZapVmCloudTaskEvent[]> {
    const page = await this.call<{ events: ZapVmCloudTaskEvent[] }>(
      "GET",
      `/v1/tasks/${encodeURIComponent(taskId)}/events?after=${after}&limit=256`,
    );
    if (!page || !Array.isArray(page.events)) throw new Error("cloud control returned an invalid event page");
    return page.events;
  }

  cancel(taskId: string): Promise<ZapVmCloudTask> {
    return this.call<unknown>("DELETE", `/v1/tasks/${encodeURIComponent(taskId)}`)
      .then((task) => parseCloudTask(task, taskId));
  }

  private call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const url = new URL(path, `${this.config.control_url}/`);
    const options: RequestOptions = {
      method,
      ca: this.ca,
      cert: this.cert,
      key: this.key,
      rejectUnauthorized: true,
      servername: url.hostname,
      headers: {
        accept: "application/json",
        ...(data ? {
          "content-type": "application/json",
          "content-length": String(data.length),
        } : {}),
      },
    };
    return new Promise<T>((resolveRequest, reject) => {
      const request = httpsRequest(url, options, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("cloud control response exceeded limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`cloud control ${method} ${url.pathname} failed (${response.statusCode ?? "no status"}): ${boundedText(text)}`));
            return;
          }
          try { resolveRequest(JSON.parse(text) as T); }
          catch { reject(new Error("cloud control returned invalid JSON")); }
        });
      });
      request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("cloud control request timed out")));
      request.once("error", reject);
      if (data) request.end(data);
      else request.end();
    });
  }
}

class ZapVmCloudExecutionProcessBroker implements ExecutionProcessBroker {
  private _spawnCount = 0;
  private _sandboxedSpawnCount = 0;
  private binding?: ResolvedCloudComputerBinding;

  constructor(
    private readonly config: ZapVmCloudConfig,
    private readonly client: ZapVmCloudControlClient,
    private readonly request: Readonly<ExecutionBrokerRequest>,
    private readonly signal: AbortSignal,
    private readonly limits: Readonly<ToolResourceLimits>,
  ) {}

  get spawnCount(): number { return this._spawnCount; }
  get sandboxedSpawnCount(): number { return this._sandboxedSpawnCount; }

  async ensureReady(): Promise<void> {
    if (this.config.workspace_read_only && this.request.effects.filesystem.some((effect) => effect.operation !== "read")) {
      throw new ExecutionBoundaryError("Cloud Computer workspace is read-only for a command that declares writes",
        operationFailure("POLICY_DENIED", "backend"));
    }
    try {
      assertCloudWorkspaceAllowed(this.config, this.request.workspace.root);
      assertCloudNetworkPolicy(resolveZapVmNetworkPolicy(this.request.grant.network), this.config);
    } catch (error) {
      throw new ExecutionBoundaryError(errorMessage(error), operationFailure("POLICY_DENIED", "backend"));
    }
    try {
      this.binding = resolveCloudComputerBinding(this.config, this.request.workspace.root, this.signal);
      await this.binding.ready;
    } catch (error) {
      if (error instanceof ExecutionBoundaryError) throw error;
      throw new ExecutionBoundaryError(
        `Configured cloud VM is unavailable: ${errorMessage(error)}. Restore this backend before retrying; no host fallback was used.`,
        operationFailure("BACKEND_UNAVAILABLE", "backend"));
    }
  }

  spawnCommand(executable: string, args: string[], options: SandboxCommandOptions): ChildProcess {
    let guestExecutable = executable;
    if (isAbsolute(executable)) {
      const rel = relative(resolve(this.request.workspace.root), resolve(executable));
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error("Host executable is not available inside the cloud VM");
      }
      guestExecutable = `/workspace/${rel.split(sep).join("/")}`;
    }
    return this.launch([guestExecutable, ...args], options);
  }

  spawnShell(command: string, options: SandboxCommandOptions): ChildProcess {
    return this.launch(["/bin/sh", "-c", normalizeZapVmShellCommand(command)], options);
  }

  private launch(argv: string[], options: SandboxCommandOptions): ChildProcess {
    if (this.signal.aborted) throw new Error("aborted");
    const binding = this.binding;
    if (!binding) throw new ExecutionBoundaryError("Cloud VM readiness was not checked",
      operationFailure("BACKEND_UNAVAILABLE", "backend"));
    if (this.config.workspace_read_only && this.request.effects.filesystem.some((effect) => effect.operation !== "read")) {
      throw new Error("Cloud Computer workspace is read-only for a command that declares writes");
    }
    assertCloudNetworkPolicy(resolveZapVmNetworkPolicy(this.request.grant.network), this.config);
    this._spawnCount += 1;
    this._sandboxedSpawnCount += 1;
    const taskId = `zap-${randomUUID()}`;
    const process = new ZapVmCloudChildProcess(this.client, this.config.poll_ms, {
      id: taskId,
      computerId: binding.computerId,
      command: {
        id: `${taskId}-command`,
        sessionId: boundedIdentifier(
          this.request.context?.agentRun?.runId ?? this.request.context?.sessionId ?? "zap-session",
          "zap-session",
        ),
        argv,
        cwd: resolveZapVmGuestCwd(this.request.workspace.root, options.cwd),
        protectedWorkspacePaths: ensureProtectedWorkspacePaths(this.request.workspace.root),
        timeoutMs: Math.max(1, Math.floor(this.limits.timeoutMs)),
      },
    }, this.signal, binding.ready);
    return process.asChildProcess();
  }
}

class ZapVmCloudSandbox implements OsSandbox {
  constructor(private readonly config: ZapVmCloudConfig) {}

  status(): SandboxStatus {
    // Socket presence is only a preliminary check; ensureReady re-inspects
    // the daemon and durable binding before every command. Never fall back to
    // host execution when an explicitly configured cloud backend is down.
    if (this.config.binding_mode === "local-auto" && process.platform !== "win32") {
      try {
        if (!lstatSync(this.config.daemon_endpoint).isSocket()) throw new Error("not a socket");
      } catch {
        return { provider: "zapvm", available: false,
          reason: `Configured cloud VM daemon socket is unavailable: ${this.config.daemon_endpoint}. Restore the configured daemon before retrying; no host fallback was used.` };
      }
    }
    return { provider: "zapvm", available: true };
  }

  createContext(input: Parameters<OsSandbox["createContext"]>[0]): SandboxExecutionContext {
    assertCloudWorkspaceAllowed(this.config, input.workspace.root);
    const unsupported = (): never => { throw new Error("zapVM cloud commands must use the cloud process broker"); };
    return {
      provider: "zapvm",
      enforced: true,
      readablePaths: input.grant.filesystem?.read ?? [],
      writablePaths: input.grant.filesystem?.write ?? [],
      protectedPaths: ensureProtectedWorkspacePaths(input.workspace.root).map((path) => join(input.workspace.root, path)),
      networkAllowed: this.config.network === "restricted",
      prepareCommand: unsupported,
      prepareShell: unsupported,
    };
  }
}

class ZapVmCloudChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private cursor = 0;
  private settled = false;
  private submitted = false;
  private cancelRequested = false;
  private failure = "";
  private sawExecResult = false;

  constructor(
    private readonly client: ZapVmCloudControlClient,
    private readonly pollMs: number,
    private readonly submission: ZapVmCloudSubmit,
    private readonly signal: AbortSignal,
    private readonly bindingReady: Promise<void>,
  ) {
    super();
    this.stdin.end();
    this.signal.addEventListener("abort", this.onAbort, { once: true });
    queueMicrotask(() => { void this.run(); });
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.settled) return false;
    this.killed = true;
    this.cancelRequested = true;
    const normalized = typeof signal === "string" ? signal : "SIGTERM";
    if (this.submitted) void this.cancelAndClose(normalized);
    return true;
  }

  private readonly onAbort = () => { this.kill("SIGTERM"); };

  private async run(): Promise<void> {
    try {
      await this.bindingReady;
      if (this.cancelRequested) {
        this.finish(null, "SIGTERM");
        return;
      }
      await this.client.submit(this.submission);
      this.submitted = true;
      if (this.cancelRequested) {
        await this.cancelAndClose("SIGTERM");
        return;
      }
      while (!this.settled) {
        await this.consumeEvents();
        if (this.settled) return;
        const task = await this.client.inspect(this.submission.id);
        if (this.settled) return;
        if (TERMINAL_STATES.has(task.state)) {
          await this.drainTerminalEvents();
          if (task.state === "succeeded") this.finish(0, null);
          else if (task.state === "canceled") this.finish(null, "SIGTERM");
          else {
            if (!this.failure) this.writeFailure(task.failure_code || "cloud_task_failed");
            this.finish(1, null);
          }
          return;
        }
        await delay(this.pollMs);
      }
    } catch (error) {
      if (this.settled) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.emit("error", failure);
      this.finish(1, null);
    }
  }

  private async consumeEvents(): Promise<void> {
    const events = await this.client.events(this.submission.id, this.cursor);
    for (const event of events) {
      if (!Number.isSafeInteger(event.cursor) || event.cursor <= this.cursor || event.task_id !== this.submission.id) {
        throw new Error("cloud control returned an invalid or out-of-order task event");
      }
      this.cursor = event.cursor;
      if (event.type === "exec.output") {
        if ((event.stream !== "stdout" && event.stream !== "stderr") || typeof event.data !== "string") {
          throw new Error("cloud control returned invalid command output");
        }
        const data = decodeBase64(event.data);
        (event.stream === "stderr" ? this.stderr : this.stdout).write(data);
      } else if (event.type === "exec.result") {
        this.sawExecResult = true;
        if (event.ok === false) this.writeFailure(event.error || "guest_command_failed");
      } else if (event.type === "task.interrupted" || event.type === "task.canceled") {
        if (event.error) this.failure = event.error;
      }
    }
  }

  /** The Task record and event journal may become visible on different control-plane
   * replicas a few polls apart. A terminal Task without its exec.result is not a
   * complete result and must never be reported as a successful empty command. */
  private async drainTerminalEvents(): Promise<void> {
    const deadline = Date.now() + Math.max(5_000, Math.min(15_000, this.pollMs * 20));
    while (!this.sawExecResult && !this.settled) {
      await this.consumeEvents();
      if (this.sawExecResult) return;
      if (Date.now() >= deadline) {
        throw new Error("cloud control terminal Task is missing its exec.result event");
      }
      await delay(this.pollMs);
    }
  }

  private writeFailure(message: string): void {
    if (this.failure) return;
    this.failure = boundedText(message);
    this.stderr.write(`ZAPVM_ERROR[CLOUD_EXEC_FAILED]: ${this.failure}\n`);
  }

  private async cancelAndClose(signal: NodeJS.Signals): Promise<void> {
    if (this.settled) return;
    try { await this.client.cancel(this.submission.id); }
    catch (error) { this.stderr.write(`ZAPVM_ERROR[CLOUD_CANCEL_FAILED]: ${boundedText(errorMessage(error))}\n`); }
    this.finish(null, signal);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return;
    this.settled = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.signal.removeEventListener("abort", this.onAbort);
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => {
      this.emit("exit", code, signal);
      this.emit("close", code, signal);
    });
  }
}

interface ResolvedCloudComputerBinding {
  computerId: string;
  ready: Promise<void>;
}

function resolveCloudComputerBinding(
  config: ZapVmCloudConfig,
  workspaceRoot: string,
  signal: AbortSignal,
): ResolvedCloudComputerBinding {
  const canonical = assertCloudWorkspaceAllowed(config, workspaceRoot);
  if (config.binding_mode === "fixed") {
    return { computerId: config.computer_id, ready: Promise.resolve() };
  }
  const computerId = deriveZapVmCloudComputerId(
    config.computer_id_prefix,
    canonical,
    config.computer_revision,
    config.computer_profile === "work" ? config : undefined,
  );
  // A durable Computer ID may be reused, but readiness cannot be cached for
  // the session: the daemon or its policy can change between commands.
  return { computerId, ready: ensureLocalAutoComputer(config, canonical, computerId, signal) };
}

export function deriveZapVmCloudComputerId(
  prefix: string,
  canonicalWorkspace: string,
  revision = "sandbox-v1",
  policy?: Pick<ZapVmCloudConfigBase, "computer_profile" | "workspace_read_only" | "network" | "allowed_domains" | "allowed_ports">,
): string {
  const hash = createHash("sha256");
  if (!policy && revision === "sandbox-v1") {
    hash.update("zapvm-cloud-workspace-v1\0").update(canonicalWorkspace);
  } else {
    hash.update("zapvm-cloud-workspace-v2\0").update(canonicalWorkspace).update("\0").update(revision).update("\0");
    hash.update(JSON.stringify(policy ? {
      profile: policy.computer_profile,
      workspace_read_only: policy.workspace_read_only,
      network: policy.network,
      allowed_domains: [...policy.allowed_domains].sort(),
      allowed_ports: [...policy.allowed_ports].sort((left, right) => left - right),
    } : {}));
  }
  const digest = hash.digest("hex");
  return `${prefix}${digest.slice(0, 40)}`;
}

function assertCloudWorkspaceAllowed(config: ZapVmCloudConfig, requestRoot: string): string {
  let canonical: string;
  try { canonical = realpathSync.native(resolve(requestRoot)); }
  catch { throw new Error("Active workspace is unavailable for the cloud Computer binding"); }
  if (config.binding_mode === "fixed") {
    if (canonical !== config.workspace_root) {
      throw new Error(`Cloud Computer is bound to ${config.workspace_root}; active workspace is ${canonical}`);
    }
    return canonical;
  }
  if (!config.workspace_roots.some((root) => pathWithin(root, canonical))) {
    throw new Error(`Active workspace is outside the cloud auto-provision roots: ${canonical}`);
  }
  return canonical;
}

async function ensureLocalAutoComputer(
  config: ZapVmCloudLocalAutoConfig,
  workspace: string,
  computerId: string,
  signal: AbortSignal,
): Promise<void> {
  const inspected = await inspectLocalComputer(config, workspace, computerId, true, signal);
  if (inspected) return;
  const args = [
    "computer", "create",
    "--endpoint", config.daemon_endpoint,
    "--id", computerId,
    "--workspace", workspace,
    "--network", config.network,
  ];
  if (config.workspace_read_only) args.push("--workspace-read-only");
  for (const domain of config.allowed_domains) args.push("--allow-domain", domain);
  for (const port of config.allowed_ports) args.push("--allow-port", String(port));
  const created = await runProvisioner(config.provisioner_binary, args, signal);
  if (created.code !== 0) {
    if (!created.stderr.includes("Computer already exists")) {
      throw new Error(`Cloud Computer auto-provision failed: ${boundedText(created.stderr || created.stdout)}`);
    }
  }
  const current = await inspectLocalComputer(config, workspace, computerId, false, signal);
  if (!current) throw new Error("Cloud Computer auto-provision did not create a durable binding");
}

async function inspectLocalComputer(
  config: ZapVmCloudLocalAutoConfig,
  workspace: string,
  computerId: string,
  allowMissing: boolean,
  signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const result = await runProvisioner(config.provisioner_binary, [
    "computer", "inspect", "--endpoint", config.daemon_endpoint, computerId,
  ], signal);
  if (result.code !== 0) {
    if (allowMissing && result.stderr.includes("Computer does not exist")) return undefined;
    throw new Error(`Cloud Computer inspect failed: ${boundedText(result.stderr || result.stdout)}`);
  }
  let value: unknown;
  try { value = JSON.parse(result.stdout); }
  catch { throw new Error("Cloud Computer inspect returned invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cloud Computer inspect returned an invalid record");
  }
  const record = value as Record<string, unknown>;
  const domains = Array.isArray(record.allowed_domains) ? record.allowed_domains : [];
  const ports = Array.isArray(record.allowed_ports) ? record.allowed_ports : [];
  if (record.id !== computerId || record.workspace !== workspace ||
      (record.workspace_read_only === true) !== config.workspace_read_only ||
      record.network !== config.network || !sameStringList(domains, config.allowed_domains) ||
      !sameNumberList(ports, config.allowed_ports)) {
    throw new Error(`Existing Cloud Computer ${computerId} does not match the requested workspace or policy`);
  }
  return record;
}

interface ProvisionerResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runProvisioner(binary: string, args: string[], signal: AbortSignal): Promise<ProvisionerResult> {
  return new Promise((resolveRun, reject) => {
    if (signal.aborted) {
      reject(new ExecutionBoundaryError("aborted", operationFailure("CANCELLED", "backend")));
      return;
    }
    const child = spawn(binary, args, {
      env: cloudProvisionerEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const append = (target: "stdout" | "stderr", chunk: string) => {
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") + Buffer.byteLength(chunk, "utf8") > 256 * 1024) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (chunk: string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: string) => append("stderr", chunk));
    const onAbort = () => {
      child.kill("SIGKILL");
      reject(new ExecutionBoundaryError("aborted", operationFailure("CANCELLED", "backend")));
    };
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener("abort", onAbort); };
    child.once("error", (error) => { cleanup(); reject(error); });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    timeout.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.once("close", (code) => {
      cleanup();
      if (overflow) reject(new Error("Cloud Computer provisioner output exceeded limit"));
      else resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

function assertCloudNetworkPolicy(policy: ZapVmNetworkPolicy | undefined, config: ZapVmCloudConfig): void {
  if (!policy) return;
  if (config.network === "off") throw new Error("Cloud Computer networking is disabled");
  const allowedPorts = new Set(config.allowed_ports);
  for (const port of policy.ports) {
    if (!allowedPorts.has(port)) throw new Error(`Cloud Computer does not allow network port ${port}`);
  }
  for (const domain of policy.domains) {
    if (!config.allowed_domains.some((allowed) => domainCovered(allowed, domain))) {
      throw new Error(`Cloud Computer does not allow network domain ${domain}`);
    }
  }
}

function domainCovered(allowed: string, requested: string): boolean {
  const normalizedAllowed = allowed.toLowerCase().replace(/\.$/, "");
  const normalizedRequested = requested.toLowerCase().replace(/\.$/, "");
  if (normalizedAllowed === normalizedRequested) return true;
  if (!normalizedAllowed.startsWith("*.")) return false;
  const suffix = normalizedAllowed.slice(1);
  return normalizedRequested.endsWith(suffix) && normalizedRequested.length > suffix.length;
}

function securePath(value: unknown, field: string): string {
  const path = requiredAbsolutePath(value, field);
  const info = lstatSync(path);
  assertOwnerOnlyRegularFile(path, info, field);
  return realpathSync.native(path);
}

function trustedExecutablePath(value: unknown): string {
  const path = requiredAbsolutePath(value, "provisioner_binary");
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`zapVM cloud provisioner_binary must be a regular non-symlink file: ${path}`);
  }
  if (process.platform !== "win32") {
    if ((info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) {
      throw new Error(`zapVM cloud provisioner_binary must be executable and not group/world writable: ${path}`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) {
      throw new Error(`zapVM cloud provisioner_binary must be owned by the current user: ${path}`);
    }
  }
  return realpathSync.native(path);
}

function daemonEndpoint(value: unknown): string {
  const endpoint = requiredString(value, "daemon_endpoint");
  if (process.platform === "win32" && /^\\\\\.\\pipe\\[^\\]+$/.test(endpoint)) return endpoint;
  if (!isAbsolute(endpoint)) throw new Error("zapVM cloud daemon_endpoint must be absolute");
  return resolve(endpoint);
}

function canonicalRealDirectory(value: unknown, field: string): string {
  const path = requiredAbsolutePath(value, field);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`zapVM cloud ${field} must be a real directory`);
  }
  return realpathSync.native(path);
}

function canonicalDirectoryList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error("zapVM cloud workspace_roots must contain between 1 and 32 directories");
  }
  const roots = value.map((entry) => canonicalRealDirectory(entry, "workspace_roots entry"));
  return [...new Set(roots)].sort();
}

function rejectPresentFields(value: Record<string, unknown>, fields: string[], mode: string): void {
  const present = fields.filter((field) => value[field] !== undefined);
  if (present.length > 0) {
    throw new Error(`zapVM cloud binding_mode=${mode} cannot declare ${present.join(", ")}`);
  }
}

function assertOwnerOnlyRegularFile(path: string, info: Stats, label: string): void {
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`zapVM cloud ${label} must be a regular non-symlink file: ${path}`);
  if (process.platform !== "win32") {
    if ((info.mode & 0o077) !== 0) throw new Error(`zapVM cloud ${label} must not be accessible by group or others: ${path}`);
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) throw new Error(`zapVM cloud ${label} must be owned by the current user: ${path}`);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")) {
    throw new Error(`zapVM cloud ${field} must be a non-empty bounded string`);
  }
  return value.trim();
}

function requiredAbsolutePath(value: unknown, field: string): string {
  const path = requiredString(value, field);
  if (!isAbsolute(path)) throw new Error(`zapVM cloud ${field} must be absolute`);
  return resolve(path);
}

function optionalStringList(value: unknown, field: string, maximum: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum ||
      value.some((entry) => typeof entry !== "string" || !entry || entry.length > 253 || entry.includes("\0"))) {
    throw new Error(`zapVM cloud ${field} is invalid`);
  }
  const normalized = value.map((entry) => entry.toLowerCase().replace(/\.$/, ""));
  if (normalized.some((entry) => !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(entry))) {
    throw new Error(`zapVM cloud ${field} contains an invalid domain`);
  }
  return [...new Set(normalized)].sort();
}

function optionalPortList(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 ||
      value.some((entry) => !Number.isInteger(entry) || (entry as number) < 1 || (entry as number) > 65535)) {
    throw new Error("zapVM cloud allowed_ports is invalid");
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

function validID(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
}

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sameStringList(actual: unknown[], expected: string[]): boolean {
  if (actual.some((entry) => typeof entry !== "string")) return false;
  const normalized = (actual as string[]).map((entry) => entry.toLowerCase().replace(/\.$/, "")).sort();
  return JSON.stringify(normalized) === JSON.stringify([...expected].sort());
}

function sameNumberList(actual: unknown[], expected: number[]): boolean {
  if (actual.some((entry) => !Number.isInteger(entry))) return false;
  return JSON.stringify((actual as number[]).slice().sort((a, b) => a - b)) ===
    JSON.stringify([...expected].sort((a, b) => a - b));
}

function cloudProvisionerEnvironment(): NodeJS.ProcessEnv {
  const names = [
    "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
    "PATH", "Path", "PATHEXT", "ComSpec", "COMSPEC",
    "SystemRoot", "WINDIR", "USERPROFILE", "LANG", "LC_ALL",
  ];
  return Object.fromEntries(names.flatMap((name) => (
    process.env[name] === undefined ? [] : [[name, process.env[name]]]
  )));
}

function boundedIdentifier(value: string, fallback: string): string {
  const normalized = value.replaceAll("\0", "").trim() || fallback;
  let bytes = 0;
  let result = "";
  for (const character of normalized) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > 256) break;
    result += character;
    bytes += size;
  }
  return result || fallback;
}

function decodeBase64(value: string): Buffer {
  if (value.length > 128 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("cloud control returned malformed command output");
  }
  return Buffer.from(value, "base64");
}

function boundedText(value: string): string {
  const normalized = value.replaceAll("\0", "").trim();
  return normalized.length > 2048 ? `${normalized.slice(0, 2048)}…` : normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCloudTask(raw: unknown, expectedId: string): ZapVmCloudTask {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("cloud control returned an invalid Task");
  const value = raw as Record<string, unknown>;
  if (value.id !== expectedId || typeof value.state !== "string" ||
      !new Set(["pending", "leased", "running", "succeeded", "failed", "canceled"]).has(value.state)) {
    throw new Error("cloud control returned an invalid Task identity or state");
  }
  if (value.failure_code !== undefined && typeof value.failure_code !== "string") {
    throw new Error("cloud control returned an invalid Task failure code");
  }
  return {
    id: expectedId,
    state: value.state as ZapVmCloudTask["state"],
    ...(value.failure_code ? { failure_code: value.failure_code as string } : {}),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, ms); });
}
