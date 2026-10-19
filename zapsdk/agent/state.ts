export interface LoopState {
  /** How many max_output_tokens recovery messages have been injected this run */
  maxOutputTokensRecoveryCount: number;
  /** True once autocompact has been attempted in this run. */
  hasAttemptedAutoCompact: boolean;
  /** Size of the context at the last autocompact attempt. Used to avoid
   *  retrying the same over-limit context repeatedly after a failed/no-op
   *  compact while still allowing later attempts after substantial growth. */
  lastAutoCompactAttemptTokens?: number;
  lastAutoCompactAttemptChars?: number;
  /** Size of the context immediately after the last successful/no-op/failed
   *  attempt. A later attempt is allowed once the context has grown beyond
   *  this baseline by a meaningful margin. */
  lastAutoCompactAfterTokens?: number;
  lastAutoCompactAfterChars?: number;
  /**
   * How many consecutive autocompact attempts have failed (summarizer call
   * threw, or produced no usable output). Persists across steps within a
   * single run. Breaker trips at MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES.
   */
  consecutiveAutoCompactFailures: number;
  /**
   * Set once after the loop has self-healed an image-rejection 400 in this
   * run (provider was flipped to strip-images). Prevents an infinite retry
   * loop if the strip somehow doesn't take effect — second occurrence
   * propagates the error instead. Optional so older external constructors
   * of LoopState literals stay type-compatible.
   */
  imageStripAttempted?: boolean;
}

/** Port of Claude Code's MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES. After this
 *  many failures, we stop trying — otherwise a flaky summarizer wedges the
 *  agent in an infinite compact/retry loop at the context ceiling. */
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

export function createInitialLoopState(): LoopState {
  return {
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedAutoCompact: false,
    lastAutoCompactAttemptTokens: undefined,
    lastAutoCompactAttemptChars: undefined,
    lastAutoCompactAfterTokens: undefined,
    lastAutoCompactAfterChars: undefined,
    consecutiveAutoCompactFailures: 0,
    imageStripAttempted: false,
  };
}

/** Whether finishReason indicates the model was cut off by output token limit */
export function isOutputTokenLimit(finishReason?: string): boolean {
  return finishReason === "length" || finishReason === "max_tokens";
}
