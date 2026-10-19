import { createHash } from "node:crypto";
import type { ToolResult } from "../tools/types.js";

export interface ToolProgressCall {
  name: string;
  arguments: Record<string, unknown>;
  readOnly: boolean;
  mayChangeWorkspace?: boolean;
  result?: ToolResult;
}

/** Execution success and mutation are observations, not proof of convergence. */
export class ToolProgressTracker {
  consecutiveNoProgress = 0;
  workspaceChanged = false;
  private readonly evidence = new Set<string>();
  private readonly observations = new Set<string>();

  observeRound(calls: readonly ToolProgressCall[]): {
    executionSucceeded: boolean;
    workspaceChanged: boolean;
    newEvidence: boolean;
    /** New command output is an observation, not proof of task progress. */
    newObservation: boolean;
    verificationPassed: boolean;
    consecutiveNoProgress: number;
  } {
    let newEvidence = false;
    let newObservation = false;
    let verificationPassed = false;
    for (const call of calls) {
      const result = call.result;
      if (!result) continue;
      const writes = result.runtime?.writeEvidence?.paths;
      // Shell effects without fingerprints remain conservatively unverified.
      const changed = writes
        ? writes.some(({ before, after }) => {
          if (before.exists !== after.exists) return true;
          if (!before.exists && !after.exists && !before.error && !after.error) return false;
          if (before.sha256 && after.sha256 && !before.error && !after.error) return before.sha256 !== after.sha256;
          // Directory fingerprints and missing hashes cannot prove that a
          // shell left the workspace unchanged.
          return call.mayChangeWorkspace !== false;
        })
        : result.success && (call.mayChangeWorkspace ?? !call.readOnly);
      if (changed) this.workspaceChanged = true;
      const verification = result.runtime?.verification;
      if (verification?.passed) {
        verificationPassed = true;
        // A passing check does not establish coverage of every changed file.
        // Delivery evidence is discharged by the explicit completion contract.
      }
      // Shells can both mutate files and produce useful diagnostics. Keep
      // output novelty separate from read/check evidence and verification.
      // Ignore command spelling/IDs: changing flags with the same output does
      // not itself establish a new observation.
      if (result.runtime?.command && (result.output.trim() || result.error?.trim())) {
        const key = createHash("sha256").update(JSON.stringify([
          call.name, result.success, result.output, result.error,
        ])).digest("hex");
        if (!this.observations.has(key)) {
          newObservation = true;
          this.observations.add(key);
          if (this.observations.size > 256) this.observations.delete(this.observations.values().next().value!);
        }
      }
      // Successful writes alone do not establish evidence. Repeating the same
      // failure under changed arguments also does not establish new evidence.
      if (call.readOnly || !result.success || verification) {
        const key = createHash("sha256").update(JSON.stringify([
          call.name, result.success ? call.arguments : undefined, result.success, result.output, result.error,
        ])).digest("hex");
        if (!this.evidence.has(key)) {
          newEvidence = true;
          this.evidence.add(key);
          if (this.evidence.size > 256) this.evidence.delete(this.evidence.values().next().value!);
        }
      }
    }
    this.consecutiveNoProgress = newEvidence || newObservation ? 0 : this.consecutiveNoProgress + 1;
    return {
      executionSucceeded: calls.some((call) => call.result?.success),
      workspaceChanged: this.workspaceChanged,
      newEvidence,
      newObservation,
      verificationPassed,
      consecutiveNoProgress: this.consecutiveNoProgress,
    };
  }
}
