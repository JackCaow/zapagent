import { isAbsolute, relative, resolve } from "node:path";

export type EffectConfidence = "declared" | "inferred" | "unknown";

export interface FileSystemEffect {
  kind: "filesystem";
  operation: "read" | "create" | "modify" | "delete";
  paths: string[];
}

export interface NetworkEffect {
  kind: "network";
  operation: "connect" | "mutate";
  destinations: string[];
  methods?: string[];
}

export interface ProcessEffect {
  kind: "process";
  operation: "spawn";
  commandClass?: string;
  background?: boolean;
  /** True only when the child is observational and cannot mutate workspace or
   * external state (for example sandboxed ripgrep). Omission is conservative. */
  readOnly?: boolean;
  /** The caller asks to run outside the OS sandbox. Approval must be explicit
   * and the broker may refuse when the host disables the escape hatch. */
  unsandboxed?: boolean;
}

export interface ExternalEffect {
  kind: "external";
  system: string;
  operation: "read" | "mutate" | "destructive";
  resource?: string;
}

export type WorkspaceEffect =
  | { mode: "none" }
  | { mode: "shared-readonly" }
  | { mode: "isolated-write" }
  | { mode: "root-integration" };

export interface ToolEffects {
  filesystem: FileSystemEffect[];
  network: NetworkEffect[];
  process: ProcessEffect[];
  external: ExternalEffect[];
  workspace: WorkspaceEffect;
  confidence: EffectConfidence;
}

export interface ToolEffectContext {
  cwd: string;
  toolName: string;
}

export interface ToolResourceLimits {
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxDepth: number;
  maxNetworkBytes: number;
  maxBackgroundOutputBytes: number;
}

export interface ResourceClaim {
  key: string;
  mode: "shared" | "exclusive";
}

export const DEFAULT_TOOL_RESOURCE_LIMITS: ToolResourceLimits = {
  timeoutMs: 30_000,
  maxInputBytes: 1_000_000,
  maxOutputBytes: 2_000_000,
  maxFiles: 10_000,
  maxFileBytes: 25_000_000,
  maxDepth: 64,
  maxNetworkBytes: 2_000_000,
  maxBackgroundOutputBytes: 256 * 1024 * 1024,
};

export function emptyToolEffects(
  confidence: EffectConfidence = "declared",
): ToolEffects {
  return {
    filesystem: [],
    network: [],
    process: [],
    external: [],
    workspace: { mode: "none" },
    confidence,
  };
}

export function unknownToolEffects(): ToolEffects {
  return {
    ...emptyToolEffects("unknown"),
    workspace: { mode: "root-integration" },
  };
}

export function inferredReadOnlyEffects(): ToolEffects {
  return {
    ...emptyToolEffects("inferred"),
    workspace: { mode: "shared-readonly" },
  };
}

export function isEffectivelyReadOnly(effects: ToolEffects): boolean {
  if (effects.confidence === "unknown") return false;
  if (effects.workspace.mode === "isolated-write" || effects.workspace.mode === "root-integration") {
    return false;
  }
  if (effects.filesystem.some((effect) => effect.operation !== "read")) return false;
  if (effects.network.some((effect) => effect.operation !== "connect")) return false;
  if (effects.process.some((effect) => effect.readOnly !== true)) return false;
  if (effects.external.some((effect) => effect.operation !== "read")) return false;
  return true;
}

export function effectsToResourceClaims(effects: ToolEffects): ResourceClaim[] {
  if (effects.confidence === "unknown") {
    return [{ key: "global:unknown", mode: "exclusive" }];
  }

  const claims = new Map<string, ResourceClaim["mode"]>();
  const add = (key: string, mode: ResourceClaim["mode"]) => {
    const previous = claims.get(key);
    if (previous === "exclusive" || mode === previous) return;
    claims.set(key, mode === "exclusive" ? "exclusive" : previous ?? "shared");
  };

  for (const effect of effects.filesystem) {
    const mode = effect.operation === "read" ? "shared" : "exclusive";
    for (const path of effect.paths) add(`fs:${resolve(path)}`, mode);
  }
  for (const effect of effects.network) {
    const mode = effect.operation === "connect" ? "shared" : "exclusive";
    for (const destination of effect.destinations) add(`network:${destination}`, mode);
  }
  for (const effect of effects.external) {
    add(`external:${effect.system}:${effect.resource ?? "*"}`, effect.operation === "read" ? "shared" : "exclusive");
  }
  if (effects.process.length > 0) {
    add("process:spawn", effects.process.every((effect) => effect.readOnly === true) ? "shared" : "exclusive");
  }
  if (effects.workspace.mode === "shared-readonly") add("workspace:root", "shared");
  if (effects.workspace.mode === "root-integration") add("workspace:root", "exclusive");
  if (effects.workspace.mode === "isolated-write") add("workspace:isolated", "shared");

  if (claims.size === 0) add("runtime:pure", "shared");
  return [...claims].map(([key, mode]) => ({ key, mode }));
}

export function pathIsInsideRoot(path: string, root: string): boolean {
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const absoluteRoot = resolve(root);
  const rel = relative(absoluteRoot, absolutePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
