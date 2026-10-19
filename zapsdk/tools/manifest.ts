import type { Tool, ToolHandler } from "./types.js";
import type {
  ToolEffectContext,
  ToolEffects,
  ToolResourceLimits,
} from "./effects.js";
import { resolveDefinitionEffects } from "./compatibility.js";

export type ToolNamespace = "builtin" | "mcp" | "plugin" | "agent";

export interface ToolId {
  namespace: ToolNamespace;
  name: string;
  version?: string;
}

export interface ToolSource {
  kind: ToolNamespace;
  owner?: string;
  trust: "first-party" | "configured" | "untrusted";
}

/** Runtime-facing representation of a tool. Provider schemas remain on the
 * legacy ToolDefinition during migration, while policy/scheduling consume this
 * normalized manifest. */
export interface ToolManifest {
  id: ToolId;
  providerName: string;
  source: ToolSource;
  description: string;
  prompt?: string;
  inputSchema: Tool["definition"]["parameters"];
  rawSchema?: Record<string, unknown>;
  limits?: Partial<ToolResourceLimits>;
  resolveEffects(
    input: Record<string, unknown>,
    context: Readonly<ToolEffectContext>,
  ): ToolEffects;
  execute: ToolHandler;
}

export function inferToolSource(providerName: string): ToolSource {
  if (providerName === "agent") {
    return { kind: "agent", trust: "first-party" };
  }
  if (providerName.startsWith("mcp__")) {
    const [, owner] = providerName.split("__", 3);
    return { kind: "mcp", owner, trust: "configured" };
  }
  if (providerName.startsWith("plugin__")) {
    const [, owner] = providerName.split("__", 3);
    return { kind: "plugin", owner, trust: "configured" };
  }
  return { kind: "builtin", trust: "first-party" };
}

export function adaptLegacyTool(tool: Tool, cwd: string = process.cwd()): ToolManifest {
  const source = inferToolSource(tool.definition.name);
  return {
    id: {
      namespace: source.kind,
      name: tool.definition.name,
    },
    providerName: tool.definition.name,
    source,
    description: tool.definition.description,
    prompt: tool.definition.prompt,
    inputSchema: tool.definition.parameters,
    rawSchema: tool.definition.rawSchema,
    limits: tool.definition.limits,
    resolveEffects(input, context) {
      return resolveDefinitionEffects(tool.definition, input, context.cwd || cwd);
    },
    execute: tool.handler,
  };
}
