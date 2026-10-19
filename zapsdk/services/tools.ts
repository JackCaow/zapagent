import { executionDigest } from "../execution/observation.js";
import type { ExecutionBroker } from "../execution/types.js";
import type { WorkspaceIdentity } from "../policy/types.js";
import { emptyToolEffects, type ToolEffects } from "../tools/effects.js";
import type { Tool } from "../tools/types.js";
import type { ServiceCapabilities } from "./contracts.js";
import { ServiceStartArguments, ServiceStatusArguments, ServiceStopArguments, type ServiceOperation } from "./execution.js";

export function serviceEffects(kind: ServiceOperation, cap: ServiceCapabilities, workspace: WorkspaceIdentity, args: Record<string, unknown>): ToolEffects {
  const start = kind === "start" ? ServiceStartArguments.parse(args) : undefined;
  return { ...emptyToolEffects(),
    ...(start ? { filesystem: [{ kind: "filesystem" as const, operation: "read" as const, paths: [workspace.root] },
      { kind: "filesystem" as const, operation: "modify" as const, paths: [workspace.root] }],
      process: [{ kind: "process" as const, operation: "spawn" as const, commandClass: "shell", background: true }],
      network: start.network ? [{ kind: "network" as const, operation: "connect" as const, destinations: ["*"], methods: [] }] : [],
      workspace: { mode: "root-integration" as const } } : {}),
    external: (kind === "stop" ? ["read", "destructive"] as const : [kind === "status" ? "read" : "mutate"] as const).map(operation => ({ kind: "external" as const, system: `service-owner:${cap.backendId}`, operation,
      resource: executionDigest({ cap, workspace: { id: workspace.id, root: workspace.root }, kind, args }) })),
  };
}

/** Explicit Host registration, only against the selected broker/workspace.
 * No owner means no service tools. Handlers cannot launch local processes. */
export function serviceTools(broker: ExecutionBroker, workspace: WorkspaceIdentity): Tool[] {
  const cap = broker.serviceCapabilities?.(workspace);
  if (!cap) return [];
  return (["start", "status", "stop"] as const).map(kind => ({
    definition: { name: `service_${kind}`, serviceOperation: kind, executionLocation: "workspace" as const,
      description: kind === "start" ? `Start a Host-owned ${cap.ownerScope} service with a bounded lease. The owner is ${cap.backendId}. Ordinary background tasks retain their own lifecycle.${cap.ownerFailure ? " If this owner is lost, process state and lease enforcement are unknown until the Host reconciles the environment." : ""}`
        : kind === "status" ? "Inspect a bound service start operation by its operation_id. A missing receipt does not permit another start."
        : "Ask the configured Host owner to stop its service_id. Inspect the returned state; a request alone does not prove it stopped.",
      parameters: kind === "start" ? ServiceStartArguments : kind === "status" ? ServiceStatusArguments : ServiceStopArguments,
      permission: kind === "status" ? "auto" as const : "confirm" as const,
      readOnly: kind === "status", sandboxAware: true,
      ...(kind === "start" ? { resolveShellCommands: (args: Record<string, unknown>) => [String(args.command ?? "")] } : {}),
      resolveEffects: (args: Record<string, unknown>) => serviceEffects(kind, cap, workspace, args),
    },
    handler: async () => ({ success: false, output: "", error: "Service tools require the selected broker's authorized owner channel" }),
  }));
}
