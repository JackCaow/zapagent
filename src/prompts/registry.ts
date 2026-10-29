import type { PromptContext } from "./context.js"
import {
  DYNAMIC_BOUNDARY as _DYNAMIC_BOUNDARY,
  escapeDynamicBoundaryText,
  splitAtBoundary,
} from "../../zapsdk/core/prompt-boundary.js"

/** Re-exported from zapsdk — kept stable so both app and providers share
 *  the exact same marker bytes. Don't redefine locally. */
export const DYNAMIC_BOUNDARY = _DYNAMIC_BOUNDARY

/**
 * A single named, independently-computable chunk of the system prompt.
 *
 * Sections are pure functions of PromptContext. They return a string to
 * include, or null to skip entirely (e.g. "tool X usage" skipped when tool X
 * isn't registered).
 *
 * The `dynamic` flag marks sections whose output changes per-turn or
 * per-session — they go after the static/dynamic boundary so provider prompt
 * cache can keep the prefix warm. Default false (static, cacheable).
 *
 * Design reference: CCB's systemPromptSection / DANGEROUS_uncachedSystemPromptSection
 * pattern, simplified. We don't have an experiment platform yet, so we skip
 * the memoization layer — prompts get rebuilt per call, but each call is
 * cheap (pure string concatenation). Caching is upstream (provider layer)
 * when we wire cache_control.
 */
export type PromptPurpose = "protocol" | "identity" | "behavior" | "authority" | "tool-contract" | "discovery" | "project" | "environment" | "user" | "unspecified"

export interface PromptSection {
  /** Semantic purpose is independent of cache placement. Unclassified extensions are retained. */
  purpose?: PromptPurpose
  name: string
  compute: (ctx: PromptContext) => string | null
  /** When true: output may vary per turn; belongs after the dynamic boundary. */
  dynamic?: boolean
}

export interface PromptDiagnosticsLogger {
  warn: (event: string, fields?: Record<string, unknown>) => void
}

let diagnosticsLogger: PromptDiagnosticsLogger | null = null

export function setPromptDiagnosticsLogger(logger: PromptDiagnosticsLogger | null): void {
  diagnosticsLogger = logger
}

/** Diagnostics must not alter prompt assembly or agent behavior. */
export function recordPromptSection(ctx: PromptContext, section: PromptSection, text: string, sourceText?: string): void {
  try {
    ctx.onSection?.(section.name, section.purpose ?? "unspecified", section.dynamic === true, text,
      section.purpose === "project" ? sourceText : undefined)
  } catch {
    // The prompt remains usable when an optional host diagnostic sink fails.
  }
}

/**
 * Resolve a list of sections into a single system prompt string, with the
 * dynamic boundary marker preserved so callers can split on it.
 */
export function assemblePrompt(ctx: PromptContext, sections: PromptSection[]): string {
  const staticParts: string[] = []
  const dynamicParts: string[] = []

  for (const section of sections) {
    let value: string | null = null
    try {
      value = section.compute(ctx)
    } catch (err) {
      // A broken section should not prevent the agent from running.
      logPromptSectionFailure(section, err)
      value = null
    }
    if (!value) continue
    const trimmed = escapeDynamicBoundaryText(value).trim()
    if (!trimmed) continue
    recordPromptSection(ctx, section, trimmed, value)
    if (section.dynamic) dynamicParts.push(trimmed)
    else staticParts.push(trimmed)
  }

  const parts: string[] = [...staticParts]
  if (dynamicParts.length > 0) {
    parts.push(DYNAMIC_BOUNDARY)
    parts.push(...dynamicParts)
  }
  return parts.join("\n\n")
}

/** Re-exported for callers that work at the prompt-assembly layer. */
export const splitOnBoundary = splitAtBoundary

function logPromptSectionFailure(section: PromptSection, err: unknown): void {
  try {
    diagnosticsLogger?.warn("prompt_section_failed", {
      section: section.name,
      dynamic: section.dynamic === true,
      error: err instanceof Error ? err.message : String(err),
    })
  } catch {
    // Diagnostics must never become a prompt-build failure path.
  }
}
