import type { PolicyDecision, PolicyRequest, ToolPolicyEngine } from "../policy/types.js";
import type { ResolvedHarnessPolicy } from "./policy.js";

export const HARNESS_CAPABILITIES = ["read", "write", "delete", "network", "process", "external", "unknown"] as const;

/** Restricts the host engine; it never upgrades a denied grant. */
export class HarnessToolPolicyEngine implements ToolPolicyEngine {
  constructor(private readonly host: ToolPolicyEngine, private readonly policy: ResolvedHarnessPolicy) {
    for (const capability of policy.execution.allowedCapabilities ?? []) {
      if (!(HARNESS_CAPABILITIES as readonly string[]).includes(capability)) {
        throw new Error(`Unsupported harness capability: ${capability}`);
      }
    }
  }

  async evaluate(request: Readonly<PolicyRequest>): Promise<PolicyDecision> {
    const effects = request.effects;
    const capabilities = new Set<string>();
    for (const effect of effects.filesystem) {
      capabilities.add(effect.operation === "read" ? "read" : "write");
      if (effect.operation === "delete") capabilities.add("delete");
    }
    if (effects.network.length) capabilities.add("network");
    if (effects.process.length) capabilities.add("process");
    if (effects.external.length) capabilities.add("external");
    if (effects.confidence === "unknown") capabilities.add("unknown");
    if (effects.workspace.mode === "isolated-write" || effects.workspace.mode === "root-integration") capabilities.add("write");
    const allowed = this.policy.execution.allowedCapabilities;
    if (allowed && [...capabilities].some((capability) => !allowed.includes(capability))) {
      return { decision: "deny", reason: `Harness capability restriction: ${[...capabilities].filter((capability) => !allowed.includes(capability)).join(", ")}` };
    }
    const mutating = effects.confidence === "unknown"
      || effects.filesystem.some((effect) => effect.operation !== "read")
      || effects.process.some((effect) => !effect.readOnly)
      || effects.network.some((effect) => effect.operation === "mutate")
      || effects.external.some((effect) => effect.operation !== "read")
      || effects.workspace.mode === "isolated-write" || effects.workspace.mode === "root-integration";
    // A root agent can delegate an isolated write, but cannot perform a direct
    // root mutation while its policy requires isolation.
    const isolatedDelegation = request.source.kind === "agent" && effects.workspace.mode === "isolated-write"
      && !effects.filesystem.length && !effects.process.length && !effects.network.length && !effects.external.length;
    if (this.policy.execution.workspaceMode === "isolated-write" && mutating
      && request.workspace.mode !== "isolated-write" && !isolatedDelegation) {
      return { decision: "deny", reason: "Harness requires an isolated workspace for writes" };
    }
    const decision = await this.host.evaluate(request);
    if (decision.decision === "deny") return decision;
    if (this.policy.autonomy === "bounded" && decision.decision === "ask") {
      return { decision: "deny", reason: "Bounded autonomy cannot escalate approval" };
    }
    if (this.policy.autonomy === "supervised" && mutating && decision.decision === "allow") {
      return {
        decision: "ask", reason: "Supervised autonomy requires approval for mutations",
        request: { call: request.call, effects, proposedGrant: decision.grant },
      };
    }
    return decision;
  }
}
