import { compactSummaryFailureReason } from "../../zapsdk/context/autocompact.js"

export interface CompactResultLike {
  summary?: string
}

export function compactFailureReason(
  result: CompactResultLike | null | undefined,
  failureReason?: string,
): string | undefined {
  if (failureReason) return failureReason
  if (!result) return "summarizer returned no usable compact summary"
  return compactSummaryFailureReason(result.summary ?? "") ?? undefined
}

export function manualCompactFailureReason(
  result: CompactResultLike | null | undefined,
  options: {
    messageCountBefore: number
    /** Compression keeps recent history at turn granularity. A tool turn can
     *  expand into multiple wire messages, so messageCountBefore is not a
     *  safe proxy for deciding whether the keep-recent window caused a
     *  genuine no-op. */
    turnCountBefore?: number
    contextTokensBefore: number
    triggerAtTokens: number
    keepRecentMessages?: number
    failureReason?: string
  },
): string | undefined {
  // ConversationManager records provider/validation diagnostics separately
  // when compression returns null. Preserve that explicit reason even when
  // the history is inside the normal keep-recent window.
  if (options.failureReason) return options.failureReason
  if (result) return compactFailureReason(result)
  const keepRecentMessages = options.keepRecentMessages ?? 10
  const historyUnitsBefore = options.turnCountBefore ?? options.messageCountBefore
  const overKeepRecent = historyUnitsBefore > keepRecentMessages
  const overTrigger = options.triggerAtTokens > 0 && options.contextTokensBefore > options.triggerAtTokens
  return overKeepRecent || overTrigger ? compactFailureReason(result) : undefined
}
