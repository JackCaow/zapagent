import type { ToolDefinition } from "./types.js";
import { isEffectivelyReadOnly, type ToolEffects } from "./effects.js";

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
  });
}
