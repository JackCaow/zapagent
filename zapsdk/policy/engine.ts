import { pathIsInsideRoot, type ToolEffects } from "../tools/effects.js";
import type {
  CapabilityGrant,
  PolicyDecision,
  PolicyRequest,
  ToolPolicyEngine,
} from "./types.js";

export interface DefaultToolPolicyOptions {
  /** During migration, legacy auto tools with unknown effects remain allowed.
   * Strict deployments should set this to true. */
  askOnUnknownEffects?: boolean;
  grantTtlMs?: number;
}

function isolatedWorkspaceViolation(request: Readonly<PolicyRequest>): string | undefined {
  if (request.workspace.mode !== "isolated-write") return undefined;
  if (request.effects.confidence === "unknown") {
    return "isolated workspaces deny tools with unknown effects";
  }
  if (request.effects.process.some((effect) => effect.unsandboxed === true)) {
    return "isolated workspaces deny unsandboxed process execution";
  }
  if (request.effects.process.length > 0) {
    if (request.workspace.sandbox !== "enforced") {
      return "isolated workspaces deny process execution without an OS sandbox";
    }
  }
  const outsidePaths = request.effects.filesystem
    .flatMap((effect) => effect.paths)
    .filter((path) => !pathIsInsideRoot(path, request.workspace.root));
  if (outsidePaths.length > 0) {
    return `tool effects escape the isolated workspace: ${outsidePaths.join(", ")}`;
  }
  return undefined;
}

export function createCapabilityGrant(
  callId: string,
  effects: ToolEffects,
  expiresAt: number,
): CapabilityGrant {
  const read: string[] = [];
  const write: string[] = [];
  for (const effect of effects.filesystem) {
    (effect.operation === "read" ? read : write).push(...effect.paths);
  }

  const destinations = effects.network.flatMap((effect) => effect.destinations);
  const methods = effects.network.flatMap((effect) => effect.methods ?? []);

  return {
    callId,
    expiresAt,
    filesystem: read.length || write.length ? { read, write } : undefined,
    network: destinations.length ? { destinations, methods } : undefined,
    process: effects.process.length ? { spawn: true } : undefined,
    external: effects.external.length
      ? effects.external.map((effect) => ({
          system: effect.system,
          operations: [effect.operation],
          resource: effect.resource,
        }))
      : undefined,
    workspace: effects.workspace,
  };
}

/** Compatibility policy for the migration period. All permission decisions
 * pass through one engine, but existing auto tools keep working until their
 * manifests declare effects. */
export class DefaultToolPolicyEngine implements ToolPolicyEngine {
  private askOnUnknownEffects: boolean;
  private grantTtlMs: number;

  constructor(options: DefaultToolPolicyOptions = {}) {
    this.askOnUnknownEffects = options.askOnUnknownEffects === true;
    this.grantTtlMs = options.grantTtlMs ?? 5 * 60_000;
  }

  evaluate(request: Readonly<PolicyRequest>): PolicyDecision {
    const permission = request.definition.permission ?? "auto";
    if (permission === "deny") {
      return { decision: "deny", reason: "tool permission is deny" };
    }

    const isolationViolation = isolatedWorkspaceViolation(request);
    if (isolationViolation) {
      return { decision: "deny", reason: isolationViolation };
    }

    const grant = createCapabilityGrant(
      request.call.id,
      request.effects,
      Date.now() + this.grantTtlMs,
    );
    if (permission === "confirm") {
      return {
        decision: "ask",
        request: { call: request.call, effects: request.effects, proposedGrant: grant, grantTtlMs: this.grantTtlMs },
        reason: "tool requires confirmation",
      };
    }
    if (request.effects.confidence === "unknown" && this.askOnUnknownEffects) {
      return {
        decision: "ask",
        request: { call: request.call, effects: request.effects, proposedGrant: grant, grantTtlMs: this.grantTtlMs },
        reason: "tool effects are unknown",
      };
    }
    return {
      decision: "allow",
      grant,
      reason: request.effects.confidence === "unknown"
        ? "legacy auto permission compatibility"
        : "tool policy allows declared effects",
    };
  }
}
