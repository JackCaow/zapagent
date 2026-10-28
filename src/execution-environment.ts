import { localServiceOwnerNetworkPolicyDigest } from "../zapsdk/services/local-owner.js"
import { localExecutionShell } from "../zapsdk/execution/shell.js"
import { getAppDataDir } from "../zapsdk/utils/platform.js"
import { join } from "node:path"
// Application composition adapter. Only this layer knows how a runtime is
// discovered; Agent construction consumes a broker and factual capabilities.
import {
  DefaultExecutionBroker, TransparentExecutionBroker, ZapVmRuntime,
  createZapVmCloudExecutionBroker, createPlatformSandbox, hostPackageWriteRoots, NetworkProxy, DEFAULT_ALLOWED_DOMAINS,
  discoverZapVmCloudConfig, discoverZapVmInstallation, readZapVmCapabilities,
  selectZapVmCloudConfigForWorkspace,
  type ExecutionBroker, type SandboxMode, type ExecutionEnvironmentFacts, type AuthorizedServiceBackend,
} from "../zapsdk/index.js"
import type { ExecuteCommandOptions } from "../zapsdk/builtin-tools/command.js"
import { observeLocalExecutionCapacity, type ExecutionCapacityFacts } from "../zapsdk/execution/capacity.js"

export interface ExecutionEnvironment {
  broker: ExecutionBroker
  /** Explicit owner namespace; absent without a selected service owner. */
  workspaceId?: string
  facts?: ExecutionEnvironmentFacts
  capacity?: ExecutionCapacityFacts
  // No prompt, model, retry, budget or completion policy is accepted here.
  commandOptions: Pick<ExecuteCommandOptions,
    "disableBackgroundTasks" | "restrictedNetwork" | "preserveEnvironment" | "allowUnsandboxed" | "sandboxNetwork" | "sandboxExcludedCommands" | "sandboxGitIntegration" | "workspaceOnly">
}

export type ExecutionBackend = "local" | "vm"

/** ZAPCODE_EXECUTION wins over settings; anything but "vm" means local. */
export function resolveExecutionBackend(configured?: ExecutionBackend): ExecutionBackend {
  const env = process.env.ZAPCODE_EXECUTION?.trim().toLowerCase()
  if (env === "vm" || env === "local") return env
  return configured === "vm" ? "vm" : "local"
}

function resolveRuntime(cwd: string, backend: ExecutionBackend) {
  const resident = process.env.ZAPCODE_RESIDENT_AGENT === "1"
  // Local is the default: commands run on the host under the OS sandbox and
  // an installed zapVM is only used when the user selects it. A resident
  // process already has an outer execution boundary, so never discover and
  // recursively launch another VM from inside it.
  const useVm = backend === "vm" && !resident
  const cloud = useVm
    ? selectZapVmCloudConfigForWorkspace(discoverZapVmCloudConfig(), cwd)
    : undefined
  const installation = useVm && !cloud ? discoverZapVmInstallation() : undefined
  const capabilities = installation ? readZapVmCapabilities(installation) : undefined
  return { resident, cloud, installation, capabilities }
}

/** Descriptive data only: the Agent owns all decisions based on these facts. */
function describeExecutionEnvironment({ resident, cloud, installation, capabilities }: ReturnType<typeof resolveRuntime>, localSandboxAvailable: boolean): ExecutionEnvironmentFacts {
  if (!resident && !cloud && !installation) return {
    processPlatform: process.platform,
    shell: localExecutionShell().executable,
    workspace: "native",
    rootFilesystem: "read-write",
    // Escaped/unsandboxed commands retain the host's own temp lifecycle.
    temporaryStorage: "unknown",
    network: "runtime-policy",
    ...(localSandboxAvailable ? { sandboxTemporaryDirectory: {
      environmentVariables: ["TMPDIR", "TMP", "TEMP"],
      scope: "workspace" as const,
      cleanup: "workspace-storage" as const,
    } } : {}),
  }
  const persistent = resident || cloud?.computer_profile === "work" ||
    capabilities?.runtime_package_management === "persistent-rootless"
  return {
    processPlatform: "linux",
    shell: "sh",
    workspace: resident ? "native" : "mapped",
    rootFilesystem: "read-only",
    temporaryStorage: resident ? "unknown" : "request",
    workspaceMode: cloud ? (cloud.workspace_read_only ? "read-only" : "read-write-executable") : capabilities?.workspace_mode,
    network: cloud ? (cloud.network === "off" ? "off" : "computer-allowlist")
      : resident ? "runtime-policy" : "per-command-declaration",
    commands: capabilities?.commands.slice(),
    outputDirectory: resident ? process.env.ZAPVM_ARTIFACT_DIR : undefined,
    packageManager: persistent ? { command: "zap-pkg install", persistence: "computer" } : undefined,
  }
}

export interface SandboxNetworkConfig {
  mode?: "allowlist" | "open"
  allowedDomains?: string[]
  deniedDomains?: string[]
}

/** Each command owns a proxy with a policy snapshot, including subagents.
 * Configuration changes cannot close a running background command's proxy. */
function networkProxyFor(config: SandboxNetworkConfig | undefined): NetworkProxy | undefined {
  if (process.platform !== "darwin") return undefined
  if (process.env.ZAPCODE_SANDBOX_NETWORK?.trim().toLowerCase() === "open" || config?.mode === "open") return undefined
  const allowedDomains = [...DEFAULT_ALLOWED_DOMAINS, ...(config?.allowedDomains ?? [])]
  const deniedDomains = [...(config?.deniedDomains ?? [])]
  // Initialization failure must not silently turn an allowlist into open egress.
  return new NetworkProxy(() => ({ allowedDomains, deniedDomains }))
}

export function createExecutionEnvironment(
  cwd: string,
  sandboxMode: SandboxMode,
  backend: ExecutionBackend = resolveExecutionBackend(),
  /** Host policy for the per-call `dangerouslyDisableSandbox` retry. */
  allowUnsandboxed = true,
  sandboxNetwork?: SandboxNetworkConfig,
  /** Command patterns that always run outside the host sandbox. */
  sandboxExcludedCommands?: string[],
  serviceOwner?: AuthorizedServiceBackend,
): ExecutionEnvironment {
  const runtime = resolveRuntime(cwd, backend)
  const { resident, cloud, installation } = runtime
  if (serviceOwner && (backend !== "local" || resident || cloud || installation || sandboxMode !== "required" || allowUnsandboxed)) {
    throw new Error("Local service owner requires the selected local required sandbox with escapes disabled")
  }
  if (serviceOwner) {
    const open = process.env.ZAPCODE_SANDBOX_NETWORK?.trim().toLowerCase() === "open" || sandboxNetwork?.mode === "open"
    const network = open ? { mode: "open" as const } : { mode: "allowlist" as const, allowedDomains: [...DEFAULT_ALLOWED_DOMAINS, ...(sandboxNetwork?.allowedDomains ?? [])], deniedDomains: sandboxNetwork?.deniedDomains ?? [] }
    if (serviceOwner.capabilities.networkPolicyDigest !== localServiceOwnerNetworkPolicyDigest(network)) throw new Error("Service owner network policy differs from selected Host policy")
  }
  const local = new DefaultExecutionBroker({
    services: serviceOwner,
    sandbox: createPlatformSandbox({
      rootWorkspaceGitWrites: true,
      workspaceStateRoot: resident || installation || cloud ? undefined : join(getAppDataDir(), "sandbox", "workspaces"),
      // Trusted outer mounts/egress are enforcement details, not Agent policy.
      trustedWritablePaths: resident ? ["/nix"] : (installation || cloud ? [] : hostPackageWriteRoots()),
      networkProxy: resident || installation || cloud ? undefined : () => networkProxyFor(sandboxNetwork),
      trustedEnvironmentNames: resident
        ? ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]
        : [],
    }),
    sandboxMode,
    allowUnsandboxed,
  })
  // A VM or resident boundary has no host sandbox to step out of, and a VM
  // failure must never fall back to an arbitrary host shell.
  const hostSandboxed = !installation && !cloud && !resident
  return {
    ...(serviceOwner ? { workspaceId: serviceOwner.capabilities.workspaceId } : {}),
    facts: describeExecutionEnvironment(runtime, sandboxMode !== "disabled" && local.sandboxStatus().available),
    // A VM transport has its own execution resources. Never substitute Host observations.
    capacity: !installation && !cloud ? observeLocalExecutionCapacity() : undefined,
    broker: new TransparentExecutionBroker({
      local,
      runtime: installation ? new ZapVmRuntime({ installation }) : undefined,
      vm: cloud ? createZapVmCloudExecutionBroker(cloud) : undefined,
    }),
    commandOptions: {
      sandboxGitIntegration: hostSandboxed && sandboxMode !== "disabled" && local.sandboxStatus().available,
      // These transports cannot retain a detached child beyond its lease.
      // Other backends defer to the user's env setting instead of overriding it.
      disableBackgroundTasks: cloud !== undefined || resident ? true : undefined,
      restrictedNetwork: cloud !== undefined || installation !== undefined || resident,
      preserveEnvironment: resident ? ["ZAPVM_ARTIFACT_DIR"] : undefined,
      allowUnsandboxed: allowUnsandboxed && hostSandboxed,
      sandboxExcludedCommands: hostSandboxed && sandboxExcludedCommands?.length ? sandboxExcludedCommands : undefined,
      // Host sandbox confines writes to the workspace; network stays open so
      // installs and fetches work, like Claude Code's default sandbox.
      sandboxNetwork: hostSandboxed ? true : undefined,
    },
  }
}
