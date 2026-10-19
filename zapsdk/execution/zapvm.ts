import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveZapVmGuestCwd } from "./workspace-path.js";
import { getAppDataDir } from "../utils/platform.js";
import type { ToolResourceLimits } from "../tools/effects.js";
import type {
  ExecutionBroker,
  ExecutionBrokerRequest,
  ExecutionProcessBroker,
  OsSandbox,
  SandboxCommandOptions,
  SandboxExecutionContext,
  SandboxStatus,
} from "./types.js";
import { DefaultExecutionBroker } from "./broker.js";
import { terminateProcessTreeWithGrace } from "./process.js";
import { operationFailure } from "./failure.js";
import { observeLegacyExecution } from "./observation.js";

const DEFAULT_START_TIMEOUT_MS = 10_000;

export interface ZapVmInstallation {
  runtimeRoot: string;
  binaryPath: string;
  imageRoot: string;
  publicKeyPath: string;
  stateRoot: string;
}

export interface ZapVmCapabilities {
  schema_version: 1;
  rootfs_mode: "read-only";
  workspace_mode: "read-write-executable";
  protected_workspace_paths: string[];
  temporary_storage_scope: "request";
  temporary_storage_executable: true;
  runtime_package_management: "image-build-only" | "persistent-rootless";
  commands: string[];
  network_modes: Array<"off" | "restricted" | "unrestricted">;
}

const capabilitiesCache = new Map<string, ZapVmCapabilities | undefined>();

export type ZapVmDaemonProbeState = "ready" | "unhealthy" | "unreachable";

export interface ZapVmRuntimeOptions {
  installation: ZapVmInstallation;
  maxWorkers?: number;
  maxPerWorkspace?: number;
  idleTimeout?: string;
  startTimeoutMs?: number;
}

export interface ZapVmRuntimeController {
  readonly installation: ZapVmInstallation;
  readonly endpoint: string;
  ensureReady(signal?: AbortSignal): Promise<void>;
}

export interface TransparentExecutionBrokerOptions {
  local: ExecutionBroker;
  runtime?: ZapVmRuntimeController;
  /** Injectable VM broker for SDK embeddings and deterministic tests. */
  vm?: ExecutionBroker;
  /** @deprecated Explicit compatibility override. New tools declare
   * definition.executionLocation instead of coupling routing to their name. */
  vmToolNames?: ReadonlySet<string>;
  limits?: Partial<ToolResourceLimits>;
}

export interface ZapVmNetworkPolicy {
  domains: string[];
  ports: number[];
}

/** Discover a complete, signed zapVM runtime installed by Zap's package
 * installer. The development override is intentionally undocumented in the
 * user-facing CLI; production users never select a backend or provide paths. */
export function discoverZapVmInstallation(options: {
  runtimeRoot?: string;
  executablePath?: string;
  dataDir?: string;
  platform?: NodeJS.Platform;
} = {}): ZapVmInstallation | undefined {
  if (process.env.ZAPCODE_DISABLE_ZAPVM === "1") return undefined;
  const platform = options.platform ?? process.platform;
  if (!new Set<NodeJS.Platform>(["darwin", "linux", "win32"]).has(platform)) return undefined;
  const dataDir = resolve(options.dataDir ?? getAppDataDir());
  const explicitRoot = options.runtimeRoot ?? process.env.ZAPCODE_ZAPVM_RUNTIME_DIR;
  const executablePath = options.executablePath ?? process.execPath;
  const roots = explicitRoot
    ? [resolve(explicitRoot)]
    : [
        resolve(dirname(executablePath), "zapvm-runtime"),
        resolve(dataDir, "runtime", "zapvm"),
      ];
  for (const runtimeRoot of roots) {
    const binaryName = platform === "win32" ? "zapvm.exe" : "zapvm";
    const nestedBinary = join(runtimeRoot, "bin", binaryName);
    const binaryPath = isRegularFile(nestedBinary)
      ? nestedBinary
      : join(runtimeRoot, binaryName);
    const imageRoot = join(runtimeRoot, "images");
    const publicKeyPath = join(runtimeRoot, "image-public.pem");
    if (!isRegularFile(binaryPath)) continue;
    if (!isRealDirectory(imageRoot) || !isRegularFile(join(imageRoot, "active.json"))) continue;
    if (!isRegularFile(publicKeyPath)) continue;
    return {
      runtimeRoot,
      binaryPath,
      imageRoot,
      publicKeyPath,
      stateRoot: join(dataDir, "runtime-state", "zapvm"),
    };
  }
  return undefined;
}

/** Read the image-signed execution contract once per active image revision.
 * The zapVM helper verifies the manifest signature and capabilities hash; Zap
 * never trusts prompt material read directly from an image directory. */
export function readZapVmCapabilities(
  installation: ZapVmInstallation,
): ZapVmCapabilities | undefined {
  let revision: string;
  try {
    const active = lstatSync(join(installation.imageRoot, "active.json"));
    if (!active.isFile() || active.isSymbolicLink()) return undefined;
    revision = `${installation.runtimeRoot}:${active.size}:${active.mtimeMs}`;
  } catch {
    return undefined;
  }
  if (capabilitiesCache.has(revision)) return capabilitiesCache.get(revision);
  const result = spawnSync(installation.binaryPath, [
    "capabilities",
    "--image-root", installation.imageRoot,
    "--image-public-key", installation.publicKeyPath,
    "--json",
  ], {
    encoding: "utf8",
    env: daemonEnvironment(),
    maxBuffer: 128 * 1024,
    timeout: 5_000,
    windowsHide: true,
  });
  const capabilities = result.status === 0 && !result.error
    ? parseZapVmCapabilities(result.stdout)
    : undefined;
  capabilitiesCache.set(revision, capabilities);
  return capabilities;
}

export function parseZapVmCapabilities(raw: string): ZapVmCapabilities | undefined {
  try {
    const value = JSON.parse(raw) as Partial<ZapVmCapabilities>;
    if (value.schema_version !== 1 || value.rootfs_mode !== "read-only" ||
        value.workspace_mode !== "read-write-executable" ||
        value.temporary_storage_scope !== "request" ||
        value.temporary_storage_executable !== true ||
        !["image-build-only", "persistent-rootless"].includes(value.runtime_package_management ?? "") ||
        !validCapabilityList(value.protected_workspace_paths) ||
        !validCapabilityList(value.commands) ||
        !Array.isArray(value.network_modes) || value.network_modes.length === 0 ||
        value.network_modes.some((mode) => !["off", "restricted", "unrestricted"].includes(mode))) {
      return undefined;
    }
    return value as ZapVmCapabilities;
  } catch {
    return undefined;
  }
}

function validCapabilityList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 128 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 64);
}

/** Lazily owns the private daemon lifecycle. No VM process is started until a
 * process-capable Agent tool executes for the first time. */
export class ZapVmRuntime implements ZapVmRuntimeController {
  private ready = false;
  private starting?: Promise<void>;
  private readonly options: Required<Omit<ZapVmRuntimeOptions, "installation">> & Pick<ZapVmRuntimeOptions, "installation">;

  constructor(options: ZapVmRuntimeOptions) {
    this.options = {
      installation: options.installation,
      maxWorkers: options.maxWorkers ?? 4,
      maxPerWorkspace: options.maxPerWorkspace ?? 2,
      idleTimeout: options.idleTimeout ?? "15m",
      startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    };
  }

  get installation(): ZapVmInstallation { return this.options.installation; }
  get endpoint(): string {
    return process.platform === "win32"
      ? String.raw`\\.\pipe\zapvm-zapcode`
      : join(this.installation.stateRoot, "daemon.sock");
  }

  async ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.ready && await this.probe(signal)) return;
    this.ready = false;
    if (!this.starting) {
      // Daemon startup is process-scoped rather than call-scoped. Cancelling
      // one tool stops waiting for readiness, but does not race another Agent
      // request by tearing down the shared bootstrap attempt.
      this.starting = this.startAndWait().finally(() => { this.starting = undefined; });
    }
    await waitWithAbort(this.starting, signal);
  }

  private async startAndWait(): Promise<void> {
    const current = await this.probeState();
    if (current === "ready") {
      this.ready = true;
      return;
    }
    let recycled = current === "unhealthy";
    if (recycled) await this.recycleDaemon();
    this.startDaemon();
    const deadline = Date.now() + this.options.startTimeoutMs;
    while (Date.now() < deadline) {
      await abortableDelay(100);
      const state = await this.probeState();
      if (state === "ready") {
        this.ready = true;
        return;
      }
      // An inconclusive first probe is not evidence of a healthy/missing pool.
      // If the daemon becomes reachable during startup, honor that observation
      // too. Repair at most once and keep the original readiness deadline.
      if (state === "unhealthy" && !recycled) {
        recycled = true;
        await this.recycleDaemon();
        this.startDaemon();
      }
    }
    throw new Error("Secure execution environment did not become ready");
  }

  private probe(signal?: AbortSignal): Promise<boolean> {
    return this.probeState(signal).then((state) => state === "ready");
  }

  private probeState(signal?: AbortSignal): Promise<ZapVmDaemonProbeState> {
    return runDaemonProbe(this.installation.binaryPath, this.endpoint, signal);
  }

  private async recycleDaemon(): Promise<void> {
    await runProbe(this.installation.binaryPath, [
      "daemon", "stop", "--endpoint", this.endpoint,
    ], undefined, 20_000);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await this.probeState() === "unreachable") return;
      await abortableDelay(100);
    }
    throw new Error("Secure execution environment could not recycle a degraded VM pool");
  }

  private startDaemon(): void {
    const { binaryPath, imageRoot, publicKeyPath, stateRoot } = this.installation;
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const logRoot = join(stateRoot, "logs");
    mkdirSync(logRoot, { recursive: true, mode: 0o700 });
    const logFd = openSync(join(logRoot, "daemon.log"), "a", 0o600);
    try {
      const child = spawn(binaryPath, [
        "daemon", "serve",
        "--endpoint", this.endpoint,
        "--image-root", imageRoot,
        "--image-public-key", publicKeyPath,
        "--state-root", join(stateRoot, "state"),
        "--max-workers", String(this.options.maxWorkers),
        "--max-per-workspace", String(this.options.maxPerWorkspace),
        "--idle-timeout", this.options.idleTimeout,
      ], {
        detached: true,
        env: daemonEnvironment(),
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      });
      child.on("error", () => {});
      child.unref();
    } finally {
      closeSync(logFd);
    }
  }
}

/** Routes only Agent-generated process execution into zapVM. Host-owned model,
 * MCP, file policy, and delegate orchestration keep their existing boundary. */
export class TransparentExecutionBroker implements ExecutionBroker {
  private readonly local: ExecutionBroker;
  private readonly vm?: ExecutionBroker;
  private readonly runtime?: ZapVmRuntimeController;
  private readonly vmToolNames?: ReadonlySet<string>;

  constructor(options: TransparentExecutionBrokerOptions) {
    this.local = options.local;
    this.runtime = options.runtime;
    this.vmToolNames = options.vmToolNames;
    this.vm = options.vm
      ?? (options.runtime ? createZapVmExecutionBroker(options.runtime, options.limits) : undefined);
  }

  sandboxStatus(): SandboxStatus {
    return this.vm?.sandboxStatus() ?? this.local.sandboxStatus();
  }

  serviceCapabilities(workspace: import("../policy/types.js").WorkspaceIdentity) {
    return (this.vm ?? this.local).serviceCapabilities?.(workspace);
  }

  shellEnvironment(tool: { name: string; executionLocation?: "workspace" | "host" }) {
    const backend = this.usesWorkspaceBackend(tool.name, tool.executionLocation) ? this.vm! : this.local;
    return backend.shellEnvironment?.(tool) ?? { syntax: "unknown" as const, filesystem: "unknown" as const };
  }

  private usesWorkspaceBackend(name: string, executionLocation?: "workspace" | "host"): boolean {
    return !!this.vm && (this.vmToolNames ? this.vmToolNames.has(name) : executionLocation === "workspace");
  }

  async execute(request: ExecutionBrokerRequest, signal?: AbortSignal) {
    if (request.tool.definition.serviceOperation) return (this.vm ?? this.local).execute(request, signal);
    if (this.vm && !this.vmToolNames && request.effects.process.length > 0 &&
        request.tool.definition.executionLocation === undefined) {
      let status: SandboxStatus | undefined;
      try { status = this.vm.sandboxStatus(); } catch { /* No capability claim without a status observation. */ }
      return {
        success: false,
        output: "",
        error: "EXECUTION_LOCATION_REQUIRED: process tools must declare workspace or host execution",
        failure: operationFailure("CAPABILITY_UNSUPPORTED", "broker", request.executionId),
        runtime: { execution: observeLegacyExecution(request, status, "required")("rejected") },
      };
    }
    if (!this.usesWorkspaceBackend(request.name, request.tool.definition.executionLocation)) {
      return this.local.execute(request, signal);
    }
    if (this.runtime) {
      try {
        await this.runtime.ensureReady(signal);
      } catch (error) {
        return {
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
          failure: operationFailure(signal?.aborted ? "CANCELLED" : "BACKEND_UNAVAILABLE", "backend", request.executionId),
          runtime: { execution: observeLegacyExecution(request, undefined, "required")("rejected") },
        };
      }
    }
    return this.vm!.execute(request, signal);
  }
}

export { resolveZapVmGuestCwd } from "./workspace-path.js";

export function buildZapVmExecArgs(input: {
  endpoint: string;
  workspaceRoot: string;
  hostCwd: string;
  sessionId: string;
  timeoutMs: number;
  argv: string[];
  workspaceReadOnly?: boolean;
  protectedWorkspacePaths?: string[];
  networkPolicy?: ZapVmNetworkPolicy;
}): string[] {
  if (input.argv.length === 0 || !input.argv[0]) throw new Error("Guest command requires an executable");
  const networkPolicy = input.networkPolicy;
  const args = [
    "daemon", "exec",
    "--endpoint", input.endpoint,
    "--workspace", resolve(input.workspaceRoot),
    "--session-id", boundedIdentifier(input.sessionId, "zap-session"),
    "--cwd", resolveZapVmGuestCwd(input.workspaceRoot, input.hostCwd),
    "--exec-timeout", `${Math.max(1, Math.floor(input.timeoutMs))}ms`,
    "--network", networkPolicy ? "restricted" : "off",
  ];
  if (input.workspaceReadOnly) args.push("--workspace-read-only");
  for (const protectedPath of input.protectedWorkspacePaths ?? []) {
    args.push("--protect-workspace-path", protectedPath);
  }
  for (const domain of networkPolicy?.domains ?? []) args.push("--allow-domain", domain);
  for (const port of networkPolicy?.ports ?? []) args.push("--allow-port", String(port));
  args.push("--", ...input.argv);
  return args;
}

export function resolveZapVmNetworkPolicy(
  grant: ExecutionBrokerRequest["grant"]["network"],
): ZapVmNetworkPolicy | undefined {
  if (!grant || grant.destinations.length === 0) return undefined;
  if (grant.methods.length > 0) {
    throw new Error("Secure shell networking cannot enforce HTTP method-scoped grants");
  }
  const domains = new Set<string>();
  const ports = new Set<number>();
  for (const rawDestination of grant.destinations) {
    const destination = rawDestination.trim();
    if (!destination || destination === "*") {
      throw new Error("Secure shell networking requires explicit destination domains");
    }
    if (/^\*\.[A-Za-z0-9.-]+\.?$/.test(destination)) {
      domains.add(destination.toLowerCase().replace(/\.$/, ""));
      ports.add(443);
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(destination.includes("://") ? destination : `https://${destination}`);
    } catch {
      throw new Error(`Invalid secure shell network destination: ${destination}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported secure shell network protocol: ${parsed.protocol}`);
    }
    if (!parsed.hostname || parsed.username || parsed.password) {
      throw new Error(`Invalid secure shell network destination: ${destination}`);
    }
    domains.add(parsed.hostname.toLowerCase().replace(/\.$/, ""));
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "http:" ? 80 : 443;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid secure shell network port: ${parsed.port}`);
    }
    ports.add(port);
  }
  return { domains: [...domains].sort(), ports: [...ports].sort((a, b) => a - b) };
}

class ZapVmExecutionProcessBroker implements ExecutionProcessBroker {
  private _spawnCount = 0;
  private _sandboxedSpawnCount = 0;

  constructor(
    private readonly installation: ZapVmInstallation,
    private readonly endpoint: string,
    private readonly request: Readonly<ExecutionBrokerRequest>,
    private readonly signal: AbortSignal,
    private readonly limits: Readonly<ToolResourceLimits>,
  ) {}

  get spawnCount(): number { return this._spawnCount; }
  get sandboxedSpawnCount(): number { return this._sandboxedSpawnCount; }

  spawnCommand(executable: string, args: string[], options: SandboxCommandOptions): ChildProcess {
    let guestExecutable = executable;
    if (isAbsolute(executable)) {
      const rel = relative(resolve(this.request.workspace.root), resolve(executable));
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error("Host executable is not available inside the secure execution environment");
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
    this._spawnCount += 1;
    this._sandboxedSpawnCount += 1;
    const child = spawn(this.installation.binaryPath, buildZapVmExecArgs({
      endpoint: this.endpoint,
      workspaceRoot: this.request.workspace.root,
      hostCwd: options.cwd,
      sessionId: this.request.context?.agentRun?.runId
        ?? this.request.context?.sessionId
        ?? "zap-session",
      timeoutMs: this.limits.timeoutMs,
      argv,
      workspaceReadOnly: this.request.effects.workspace.mode === "shared-readonly",
      protectedWorkspacePaths: ensureProtectedWorkspacePaths(this.request.workspace.root),
      networkPolicy: resolveZapVmNetworkPolicy(this.request.grant.network),
    }), {
      cwd: this.request.workspace.root,
      detached: process.platform !== "win32",
      env: daemonEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin?.end();
    const onAbort = () => terminateProcessTreeWithGrace(child);
    this.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => this.signal.removeEventListener("abort", onAbort);
    child.once("close", cleanup);
    child.once("error", cleanup);
    return child;
  }
}

function createZapVmExecutionBroker(runtime: ZapVmRuntimeController, limits?: Partial<ToolResourceLimits>): ExecutionBroker {
  return new DefaultExecutionBroker({
    shellEnvironment: { syntax: "posix", filesystem: "workspace-mapped", workspaceRoot: "/workspace" },
    sandbox: new ZapVmSandbox(),
    sandboxMode: "required",
    limits,
    processBrokerFactory: ({ request, signal, limits: effectiveLimits }) => (
      new ZapVmExecutionProcessBroker(runtime.installation, runtime.endpoint, request, signal, effectiveLimits)
    ),
  });
}

class ZapVmSandbox implements OsSandbox {
  status(): SandboxStatus {
    return { provider: "zapvm", available: true };
  }

  createContext(input: Parameters<OsSandbox["createContext"]>[0]): SandboxExecutionContext {
    const unsupported = (): never => {
      throw new Error("zapVM commands must use the VM process broker");
    };
    return {
      provider: "zapvm",
      enforced: true,
      readablePaths: input.grant.filesystem?.read ?? [],
      writablePaths: input.grant.filesystem?.write ?? [],
      protectedPaths: ensureProtectedWorkspacePaths(input.workspace.root)
        .map((path) => join(input.workspace.root, path)),
      networkAllowed: (input.grant.network?.destinations.length ?? 0) > 0,
      prepareCommand: unsupported,
      prepareShell: unsupported,
    };
  }
}

export function ensureProtectedWorkspacePaths(workspaceRoot: string): string[] {
  const zapcodePath = join(workspaceRoot, ".zapcode");
  mkdirSync(zapcodePath, { recursive: true, mode: 0o700 });
  const zapcodeInfo = lstatSync(zapcodePath);
  if (!zapcodeInfo.isDirectory() || zapcodeInfo.isSymbolicLink()) {
    throw new Error("Workspace .zapcode control path must be a real directory");
  }
  const protectedPaths = [".zapcode"];
  const gitPath = join(workspaceRoot, ".git");
  try {
    const gitInfo = lstatSync(gitPath);
    if (gitInfo.isSymbolicLink() || (!gitInfo.isDirectory() && !gitInfo.isFile())) {
      throw new Error("Workspace .git control path must be a regular file or directory");
    }
    protectedPaths.unshift(".git");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return protectedPaths;
}

function isRegularFile(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function isRealDirectory(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
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

/** The existing command adapter normalizes `/dev/null` to `NUL` on a Windows
 * Host. zapVM always executes bash inside Linux, so restore only redirect
 * operands before sending the single command argv across the boundary. */
export function normalizeZapVmShellCommand(
  command: string,
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  if (hostPlatform !== "win32") return command;
  return command.replace(
    /(\d?>>?|&>|<)\s*NUL\b/gi,
    (_, operator) => `${operator} /dev/null`,
  );
}

function daemonEnvironment(): NodeJS.ProcessEnv {
  // zapVM itself receives no provider credentials, but its platform backends
  // must still locate codesign, cloud-hypervisor/virtiofsd/systemd, and the
  // Windows management tools. Linux systemd --user also needs its owner-only
  // runtime bus location.
  const names = [
    "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
    "PATH", "Path", "PATHEXT", "ComSpec", "COMSPEC",
    "SystemRoot", "WINDIR", "USERPROFILE",
    "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
    "LANG", "LC_ALL",
  ];
  return Object.fromEntries(names.flatMap((name) => (
    process.env[name] === undefined ? [] : [[name, process.env[name]]]
  )));
}

export function parseZapVmDaemonStatus(raw: string): Exclude<ZapVmDaemonProbeState, "unreachable"> | undefined {
  try {
    const value = JSON.parse(raw) as { degraded?: unknown };
    if (typeof value.degraded !== "boolean") return undefined;
    return value.degraded ? "unhealthy" : "ready";
  } catch {
    return undefined;
  }
}

function runDaemonProbe(
  binaryPath: string,
  endpoint: string,
  signal?: AbortSignal,
): Promise<ZapVmDaemonProbeState> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolveProbe, reject) => {
    let settled = false;
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let output = "";
    let overflow = false;
    const finish = (value: ZapVmDaemonProbeState) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveProbe(value);
    };
    const onAbort = () => {
      if (child) terminateProcessTreeWithGrace(child);
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      child = spawn(binaryPath, ["daemon", "status", "--endpoint", endpoint], {
        env: daemonEnvironment(),
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      finish("unreachable");
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (output.length + chunk.length > 64 * 1024) overflow = true;
      else output += chunk;
    });
    timer = setTimeout(() => {
      if (child) terminateProcessTreeWithGrace(child);
      finish("unreachable");
    }, 1_500);
    timer.unref();
    child.once("error", () => finish("unreachable"));
    child.once("close", (code) => {
      if (code !== 0) finish("unreachable");
      else finish(overflow ? "unhealthy" : (parseZapVmDaemonStatus(output) ?? "unhealthy"));
    });
  });
}

function runProbe(
  binaryPath: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 1_500,
): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolveProbe, reject) => {
    let settled = false;
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveProbe(value);
    };
    const onAbort = () => {
      if (child) terminateProcessTreeWithGrace(child);
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      child = spawn(binaryPath, args, {
        env: daemonEnvironment(),
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      if (child) terminateProcessTreeWithGrace(child);
      finish(false);
    }, timeoutMs);
    timer.unref();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const onAbort = () => reject(new Error("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      void promise.then(cleanup, cleanup);
    }),
  ]);
}
