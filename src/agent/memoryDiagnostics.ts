import type { AutoMemory } from "../../zapsdk/memory/auto-memory.js"
import { persistCompactSummary } from "../../zapsdk/index.js"

export interface MemoryFailureDiagnostic {
  operation: "instructions" | "compact_summary"
  error: string
}

export interface MemoryDiagnosticsLogger {
  warn(event: string, fields?: Record<string, unknown>): void
}

export type PersistCompactSummary = typeof persistCompactSummary

export function normalizeMemoryFailure(
  fields: Record<string, unknown> | undefined,
): MemoryFailureDiagnostic {
  const operation = fields?.operation === "compact_summary" ? "compact_summary" : "instructions"
  return {
    operation,
    error: typeof fields?.error === "string" ? fields.error : "unknown error",
  }
}

export function reportMemoryFailure(
  fields: Record<string, unknown> | undefined,
  options: {
    logger?: MemoryDiagnosticsLogger
    onMemoryFailure?: (failure: MemoryFailureDiagnostic | undefined) => void
  } = {},
): void {
  const diagnostic = normalizeMemoryFailure(fields)
  try {
    options.logger?.warn("memory_operation_failed", { ...diagnostic })
  } catch {
    // Diagnostics must not make memory operations a hard dependency.
  }
  options.onMemoryFailure?.(diagnostic)
}

export function persistCompactSummaryBestEffort(
  summary: string,
  autoMemory: AutoMemory,
  options: {
    logger?: MemoryDiagnosticsLogger
    onMemoryFailure?: (failure: MemoryFailureDiagnostic | undefined) => void
    persist?: PersistCompactSummary
  } = {},
): void {
  const persist = options.persist ?? persistCompactSummary
  let failureReported = false
  void persist(summary, autoMemory, {
    warn(event, fields) {
      if (event !== "memory_operation_failed") return
      failureReported = true
      reportMemoryFailure(fields, options)
    },
  }).then(() => {
    if (!failureReported) options.onMemoryFailure?.(undefined)
  }).catch((err) => {
    reportMemoryFailure({
      operation: "compact_summary",
      error: err instanceof Error ? err.message : String(err),
    }, options)
  })
}
