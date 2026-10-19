import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { CompletionEvidenceInput, CompletionEvidenceProviderContext } from "../harness/completion.js";
import type { ToolResult } from "../tools/types.js";
import type { PersistedToolRunState } from "./state-types.js";
import type { RuntimeStateStore } from "./state-store.js";

/** Current-turn receipts only. Recovery/history must never satisfy new work. */
export async function collectRuntimeCompletionEvidence(
  store: RuntimeStateStore,
  context: CompletionEvidenceProviderContext,
): Promise<CompletionEvidenceInput> {
  const state = await store.load(context.threadId);
  const approvals = Object.values(state?.approvals ?? {}).filter((item) => item.turnId === context.turnId);
  const merges = Object.values(state?.merges ?? {}).filter((item) => item.turnId === context.turnId);
  type Fingerprint = NonNullable<NonNullable<ToolResult["runtime"]>["writeEvidence"]>["paths"][number]["after"];
  const writes = new Map<string, Fingerprint>();
  let mutated = false;
  let unobservedMutation = false;
  for (const result of context.result.toolResults) {
    const effects = result.runtime?.effects;
    const mutating = effects && (effects.confidence === "unknown"
      || effects.filesystem.some((effect) => effect.operation !== "read")
      || effects.process.some((effect) => !effect.readOnly)
      || effects.network.some((effect) => effect.operation === "mutate")
      || effects.external.some((effect) => effect.operation !== "read")
      || effects.workspace.mode === "isolated-write" || effects.workspace.mode === "root-integration");
    // Failed calls may leave partial writes; retain their observed final state.
    for (const path of result.runtime?.writeEvidence?.paths ?? []) writes.set(path.path, path.after);
    mutated ||= Boolean(mutating) || Boolean(result.runtime?.writeEvidence?.paths.length);
    if (mutating && !result.runtime?.writeEvidence?.paths.length) unobservedMutation = true;
  }
  const artifacts = [];
  const gaps: string[] = [];
  for (const [path, expected] of writes) {
    try {
      const entry = await lstat(path);
      const sha256 = entry.isFile() && entry.size <= 1024 * 1024
        ? createHash("sha256").update(await readFile(path)).digest("hex") : undefined;
      const changed = !expected.exists || Boolean(expected.error)
        || (expected.sha256 !== undefined && sha256 !== expected.sha256)
        || (expected.size !== undefined && expected.size !== entry.size);
      if (expected.sha256 === undefined) unobservedMutation = true;
      artifacts.push({ path, exists: true, sha256, source: "runtime" as const });
      if (changed) gaps.push(`artifact changed after tool execution: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      artifacts.push({ path, exists: false, source: "runtime" as const });
      if (expected.exists || expected.error) gaps.push(`artifact missing: ${path}`);
    }
  }
  const unresolvedTools = new Map<string, PersistedToolRunState>();
  for (const tool of Object.values(state?.toolRuns ?? {}).filter((item) => item.turnId === context.turnId).sort((a, b) => a.updatedAt - b.updatedAt)) {
    // Only a successful retry of the same invocation in the same agent run
    // resolves a boundary failure. Old records without identity stay blocked.
    const key = JSON.stringify([tool.runId, tool.toolName, tool.argumentsHash ?? tool.toolRunId]);
    if (tool.failure && [
      "POLICY_DENIED", "APPROVAL_REQUIRED", "CHECKPOINT_REQUIRED", "RESOURCE_LIMIT",
      "CAPABILITY_UNSUPPORTED", "BACKEND_UNAVAILABLE", "CANCELLED",
    ].includes(tool.failure.code)) unresolvedTools.set(key, tool);
    else if (tool.success === true && tool.status === "completed") unresolvedTools.delete(key);
  }
  if (unresolvedTools.size > 0) gaps.push("current turn has an unresolved execution boundary failure");
  const unresolvedApproval = approvals.some((item) => item.status !== "approved");
  const unresolvedMerge = merges.some((item) => item.status !== "completed");
  if (unresolvedApproval) gaps.push("current turn has unresolved or denied approvals");
  if (unresolvedMerge) gaps.push("current turn has an incomplete merge");
  return {
    artifacts,
    commands: context.result.toolResults.flatMap((result) => result.runtime?.command
      ? [{ ...result.runtime.command, source: "tool" as const }] : []),
    approvals: approvals.map((item) => ({
      capability: item.toolName,
      status: item.status === "interrupted" ? "failed" as const : item.status,
      source: "runtime" as const,
      detail: `approval ${item.approvalId}: ${item.status}`,
    })),
    merges: merges.map((item) => ({ mergeId: item.mergeId, success: item.status === "completed", source: "runtime" as const })),
    delivery: {
      mutated, observed: !unobservedMutation && gaps.length === 0, blocked: gaps.length > 0,
      detail: gaps.length ? gaps.join("; ") : unobservedMutation
        ? "mutation has no artifact fingerprint; host verification is required" : "current-turn effects checked",
    },
  };
}

export function mergeCompletionEvidence(runtime: CompletionEvidenceInput, host: CompletionEvidenceInput = {}): CompletionEvidenceInput {
  return {
    artifacts: [...(host.artifacts ?? []), ...(runtime.artifacts ?? [])],
    commands: [...(runtime.commands ?? []), ...(host.commands ?? [])],
    approvals: [...(runtime.approvals ?? []), ...(host.approvals ?? [])],
    merges: [...(runtime.merges ?? []), ...(host.merges ?? [])],
    infrastructure: [...(runtime.infrastructure ?? []), ...(host.infrastructure ?? [])],
    // A host verifier can validate opaque process/external effects, but cannot
    // erase an observed changed artifact or an unresolved approval/merge.
    delivery: runtime.delivery,
    verification: host.verification,
  };
}
