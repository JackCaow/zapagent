import type { ToolDefinition } from "./types.js";
import { isEffectivelyReadOnly, type ToolEffects } from "./effects.js";

/** A reusable unit of consent. File scopes are paths, network scopes are
 * hosts, external scopes are the adapter's system name. */
export type CapabilityKind = "fs.write" | "fs.delete" | "net.read" | "net.write" | "external.read" | "external.write";

export interface ToolCapability {
  readonly kind: CapabilityKind;
  readonly scope: string;
}

/** Host facts from the registered adapter, never model-supplied authority. */
export interface ToolApprovalFacts {
  /** Adapter predates structured effects; hosts may apply a bounded legacy adapter. */
  readonly legacy?: boolean;
  readonly readOnly: boolean;
  readonly editOnly: boolean;
  readonly sandboxEscape: boolean;
  readonly workspaceShell: boolean;
  /** undefined = not a shell tool; null = shell payload unavailable. */
  readonly shellCommands?: readonly string[] | null;
  /** Every effect as a capability, or undefined when some effect has no
   * reusable form (processes, wildcard destinations, destructive external
   * operations, unknown effects). Such calls keep tool-level consent. */
  readonly capabilities?: readonly ToolCapability[];
}

function networkHost(destination: string): string | null {
  if (!destination || destination.includes("*")) return null;
  try { return new URL(destination).hostname.toLowerCase() || null; }
  catch { return /^[a-z0-9.-]+$/i.test(destination) ? destination.toLowerCase() : null; }
}

/** Capabilities exactly covering the declared effects, or undefined. */
export function resolveToolCapabilities(effects: ToolEffects): readonly ToolCapability[] | undefined {
  if (effects.confidence === "unknown" || effects.process.length > 0) return undefined;
  const out: ToolCapability[] = [];
  for (const effect of effects.filesystem) {
    if (effect.operation === "read") continue;
    const kind = effect.operation === "delete" ? "fs.delete" : "fs.write";
    for (const path of effect.paths) out.push({ kind, scope: path });
  }
  for (const effect of effects.network) {
    for (const destination of effect.destinations) {
      const host = networkHost(destination);
      if (!host) return undefined;
      out.push({ kind: effect.operation === "mutate" ? "net.write" : "net.read", scope: host });
    }
  }
  for (const effect of effects.external) {
    if (effect.operation === "destructive" || !effect.system) return undefined;
    out.push({ kind: effect.operation === "read" ? "external.read" : "external.write", scope: effect.system });
  }
  const seen = new Set<string>();
  return Object.freeze(out.filter(cap => !seen.has(`${cap.kind}\0${cap.scope}`) && !!seen.add(`${cap.kind}\0${cap.scope}`)).map(cap => Object.freeze(cap)));
}

export function resolveToolApprovalFacts(definition: ToolDefinition, args: Record<string, unknown>, effects: ToolEffects): Readonly<ToolApprovalFacts> {
  const shell = !!definition.resolveShellCommands || effects.process.some(effect => effect.commandClass === "shell");
  let commands: readonly string[] | null | undefined;
  if (shell) {
    commands = null;
    try {
      const resolved = definition.resolveShellCommands?.(args);
      if (resolved?.length && resolved.every(command => typeof command === "string" && command.trim())) commands = Object.freeze([...resolved]);
    } catch { /* Missing adapter evidence cannot support narrow command grants. */ }
  }
  return Object.freeze({
    legacy: effects.confidence === "unknown" && !definition.resolveShellCommands,
    readOnly: isEffectivelyReadOnly(effects),
    editOnly: effects.confidence !== "unknown" && effects.filesystem.some(effect => effect.operation !== "read")
      && effects.filesystem.every(effect => effect.operation !== "delete")
      && effects.process.length === 0 && effects.network.length === 0 && effects.external.length === 0,
    sandboxEscape: effects.process.some(effect => effect.unsandboxed === true),
    // External effects are not contained by the workspace process sandbox.
    workspaceShell: shell && definition.executionLocation === "workspace" && effects.external.length === 0,
    ...(shell ? { shellCommands: commands } : {}),
    ...(!shell ? { capabilities: resolveToolCapabilities(effects) } : {}),
  });
}
