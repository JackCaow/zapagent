import { resolve } from "node:path";
import type { ToolDefinition } from "./types.js";
import {
  inferredReadOnlyEffects,
  isEffectivelyReadOnly,
  type ToolEffects,
  unknownToolEffects,
} from "./effects.js";

export function resolveDefinitionEffects(
  definition: ToolDefinition | undefined,
  args: Record<string, unknown>,
  cwd: string = process.cwd(),
): ToolEffects {
  if (!definition) return unknownToolEffects();
  if (definition.resolveEffects) {
    try {
      return definition.resolveEffects(args, { cwd, toolName: definition.name });
    } catch {
      return unknownToolEffects();
    }
  }

  if (definition.writesPath) {
    try {
      const paths = definition.writesPath(args)?.map((path) => resolve(cwd, path)) ?? [];
      if (paths.length > 0) {
        return {
          filesystem: [{ kind: "filesystem", operation: "modify", paths }],
          network: [],
          process: [],
          external: [],
          workspace: { mode: "root-integration" },
          confidence: "inferred",
        };
      }
    } catch {
      return unknownToolEffects();
    }
  }

  if (definition.readOnly === true) return inferredReadOnlyEffects();
  try {
    if (definition.isReadOnlyCall?.(args) === true) return inferredReadOnlyEffects();
  } catch {
    return unknownToolEffects();
  }
  return unknownToolEffects();
}

export function isDefinitionCallReadOnly(
  definition: ToolDefinition | undefined,
  args: Record<string, unknown>,
  cwd?: string,
): boolean {
  return isEffectivelyReadOnly(resolveDefinitionEffects(definition, args, cwd));
}
