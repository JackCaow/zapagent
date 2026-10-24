import type { ServiceCapabilities } from "../services/contracts.js";
import type { ChildProcess } from "node:child_process";
import type { ToolEffects, ToolResourceLimits } from "../tools/effects.js";
import type { CapabilityGrant, WorkspaceIdentity } from "../policy/types.js";
import type { Tool, ToolExecutionContext, ToolResult } from "../tools/types.js";

export type SandboxProviderKind = "macos-seatbelt" | "linux-bwrap" | "windows-appcontainer" | "zapvm" | "none";
export type SandboxMode = "disabled" | "best-effort" | "required";

/** Descriptive backend data. Deliberately cannot carry prompts, retry rules,
 * model selection, turn budgets or completion decisions. */
export interface ExecutionEnvironmentFacts {
  processPlatform: string;
  shell: string;
  workspace: "mapped" | "native";
  rootFilesystem: "read-only" | "read-write";
  temporaryStorage: "request" | "session" | "persistent" | "unknown";
  /** Applies only to commands launched through the local OS sandbox. */
  sandboxTemporaryDirectory?: { environmentVariables: string[]; scope: "command" | "workspace"; cleanup: "on-command-exit" | "workspace-storage" };
  workspaceMode?: string;
  network: "off" | "computer-allowlist" | "per-command-declaration" | "runtime-policy";
  commands?: string[];
  outputDirectory?: string;
  packageManager?: { command: string; persistence: "computer" };
}

export interface SandboxedCommand {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  release(): void;
  networkDenials?(): Array<{ host: string; reason: string }>;
}

export interface SandboxCommandOptions {
  cwd: string;
  background?: boolean;
  /** Trusted tool adapter may expose the host HOME while filesystem policy
   * still limits which files can be read. Used by authenticated delegate CLIs. */
  hostHome?: boolean;
  /** Secret-like environment names that this trusted adapter explicitly
   * requires. All other credential-shaped variables are removed. */
  preserveEnvironment?: string[];
  /** Adapter-owned environment values. This never adds filesystem grants. */
  environment?: Record<string, string>;
  /** Adapter-specific aliases for the broker's private per-command temp dir. */
  temporaryDirectoryEnvironment?: string[];
  /** Trusted adapter endpoints, scoped to this command; explicit host denials still win. */
  networkDomains?: string[];
}

export interface SandboxExecutionContext {
  provider: Exclude<SandboxProviderKind, "none">;
  enforced: true;
  readablePaths: string[];
  writablePaths: string[];
  /** Control-plane paths remain readable but never inherit a broad workspace
   * write grant. */
  protectedPaths: string[];
  networkAllowed: boolean;
  prepareCommand(
    executable: string,
    args: string[],
    options: SandboxCommandOptions,
  ): SandboxedCommand;
  prepareShell(command: string, options: SandboxCommandOptions): SandboxedCommand;
}

/** The only process-launching capability exposed to Tool handlers. */
export interface ExecutionProcessBroker {
  readonly spawnCount: number;
  readonly sandboxedSpawnCount: number;
  readonly networkDenials?: Array<{ host: string; reason: string }>;
  /** Adapter readiness is checked under the execution deadline, before the
   * handler may launch anything. Failure never selects a different backend. */
  ensureReady?(): Promise<void>;
  spawnCommand(
    executable: string,
    args: string[],
    options: SandboxCommandOptions,
  ): ChildProcess;
  spawnShell(command: string, options: SandboxCommandOptions): ChildProcess;
}

export interface SandboxStatus {
  provider: SandboxProviderKind;
  available: boolean;
  reason?: string;
}

export interface OsSandbox {
  status(): SandboxStatus;
  createContext(input: {
    executionId: string;
    /** Broker-authorized external CLI integration, never derived from shell arguments. */
    externalCliIntegration?: boolean;
    workspace: WorkspaceIdentity;
    effects: ToolEffects;
    grant: CapabilityGrant;
  }): SandboxExecutionContext;
}

export interface ExecutionBrokerRequest {
  /** Host-minted stable approval identity; never read from model arguments. */
  serviceOperationNonce?: string;
  /** Host-only progress facts, so outer cancellation retains unknown effects. */
  onServiceObservation?: (observation: Pick<NonNullable<ToolResult["runtime"]>, "service" | "serviceOperation">) => void;
  executionId: string;
  tool: Tool;
  name: string;
  args: Record<string, unknown>;
  effects: ToolEffects;
  grant: CapabilityGrant;
  workspace: WorkspaceIdentity;
  context?: Readonly<ToolExecutionContext>;
  limits?: Partial<ToolResourceLimits>;
}

export interface ExecutionResourceUsage {
  files: number;
  fileBytes: number;
  maxDepth: number;
  networkBytes: number;
  backgroundOutputBytes: number;
}

/** Per-execution meter shared by the broker and trusted tool adapters. */
export interface ExecutionResourceBudget {
  readonly limits: Readonly<ToolResourceLimits>;
  readonly usage: Readonly<ExecutionResourceUsage>;
  consumeFiles(count?: number): void;
  consumeFileBytes(bytes: number): void;
  observeDepth(depth: number): void;
  consumeNetworkBytes(bytes: number): void;
  consumeBackgroundOutputBytes(bytes: number): void;
}

export interface ExecutionBroker {
  /** Explicit selected-backend service capability; never inferred from shell support. */
  serviceCapabilities?(workspace: WorkspaceIdentity): ServiceCapabilities | undefined;
  sandboxStatus(): SandboxStatus;
  /** Factual interpreter/namespace routing only; never an authorization grant. */
  shellEnvironment?(tool: { name: string; executionLocation?: "workspace" | "host" }): ShellExecutionEnvironment;
  execute(request: ExecutionBrokerRequest, signal?: AbortSignal): Promise<ToolResult>;
}

export type ShellExecutionEnvironment =
  | { syntax: "posix" | "cmd" | "unknown"; filesystem: "host" }
  | { syntax: "posix"; filesystem: "workspace-mapped"; workspaceRoot: string }
  | { syntax: "unknown"; filesystem: "unknown" };
