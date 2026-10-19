import { z } from "zod";
import { createHash } from "node:crypto";
import { executionDigest } from "../execution/observation.js";
import { operationFailure } from "../execution/failure.js";
import type { ToolResult } from "./types.js";

export const ResultSourcePolicySchema = z.object({
  version: z.literal(1),
  tools: z.array(z.string().min(1).max(128)).min(1).max(64),
  denyUrlContains: z.array(z.object({ id: z.string().min(1).max(128), value: z.string().min(1).max(256) }).strict()).min(1).max(64),
  maxScanChars: z.number().int().min(1024).max(8 * 1024 * 1024).default(2 * 1024 * 1024),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.tools).size !== value.tools.length || new Set(value.denyUrlContains.map(rule => rule.id)).size !== value.denyUrlContains.length) {
    ctx.addIssue({ code: "custom", message: "Source policy tool/rule identities must be unique" });
  }
});
export type ResultSourcePolicy = z.infer<typeof ResultSourcePolicySchema>;
export type ToolResultGuard = (name: string, args: Record<string, unknown>, result: ToolResult) => ToolResult;
export interface ResultSourcePolicyObservation {
  version: 1;
  policyDigest: string;
  /** CLI Host binding to the exact file loaded before execution. */
  configuredFileSha256?: string;
  decision: "allowed" | "withheld";
  reason: "no_literal_match" | "excluded_source" | "scan_limit" | "guard_error";
  matchedRuleIds: string[];
  inspectedOutputSha256?: string;
}

function decoded(value: string): string {
  for (let pass = 0; pass < 2; pass++) {
    value = value.replace(/(?:%[a-f0-9]{2})+/gi, part => {
      try { return decodeURIComponent(part); } catch { return part; }
    });
  }
  return value;
}

/** Explicit Host content scope only. No default exclusions, network policy,
 * authority grant, task knowledge or retry/completion behavior lives here.
 * This screens literal URL-bearing text, not images, redirects or mirrors. */
export function createResultSourceGuard(input: ResultSourcePolicy): ToolResultGuard {
  const policy = ResultSourcePolicySchema.parse(input);
  const policyDigest = executionDigest(policy);
  const tools = new Set(policy.tools);
  const rules = policy.denyUrlContains.map(rule => ({ id: rule.id, value: rule.value.toLowerCase() }));
  return (name, args, result) => {
    if (!tools.has(name)) return result;
    const texts = [JSON.stringify(args), result.output, result.error ?? "",
      ...(result.contentBlocks ?? []).flatMap(block => block.type === "text" ? [block.text] : [])];
    let remaining = policy.maxScanChars;
    const matches = new Set<string>();
    let oversized = false;
    for (const text of texts) {
      if (typeof text !== "string" || text.length > remaining) { oversized = true; break; }
      remaining -= text.length;
      for (const match of decoded(text).matchAll(/https?:\/\/[^\s<>"']+/gi)) {
        const url = match[0].toLowerCase();
        for (const rule of rules) if (url.includes(rule.value)) matches.add(rule.id);
      }
    }
    const withheld = oversized || matches.size > 0;
    const observation: ResultSourcePolicyObservation = { version: 1, policyDigest,
      decision: withheld ? "withheld" : "allowed", reason: oversized ? "scan_limit" : matches.size ? "excluded_source" : "no_literal_match",
      matchedRuleIds: [...matches],
      ...(result.output.length <= policy.maxScanChars ? { inspectedOutputSha256: createHash("sha256").update(result.output).digest("hex") } : {}) };
    // Re-sanitize a prior denial even if another callback appended opaque
    // text without its original URL. A denial must never restore content.
    const previous = result.runtime?.resultSourcePolicy;
    const denial = previous?.decision === "withheld" ? previous : withheld ? observation : undefined;
    if (!denial) return { ...result, runtime: { ...result.runtime, resultSourcePolicy: observation } };
    return { success: false, output: "", error: "Tool result withheld by the Host's configured source policy. Use sources permitted by the Host.",
      failure: operationFailure("POLICY_DENIED", "policy"),
      runtime: { execution: result.runtime?.execution, command: result.runtime?.command,
        service: result.runtime?.service, serviceOperation: result.runtime?.serviceOperation,
        resultSourcePolicy: denial } };
  };
}
