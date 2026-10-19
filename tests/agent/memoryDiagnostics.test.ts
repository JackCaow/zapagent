import { describe, expect, it } from "bun:test"
import {
  normalizeMemoryFailure,
  persistCompactSummaryBestEffort,
  reportMemoryFailure,
} from "../../src/agent/memoryDiagnostics.js"
import type { AutoMemory } from "../../zapsdk/memory/auto-memory.js"

describe("memory diagnostics", () => {
  it("normalizes unknown memory operation failures defensively", () => {
    expect(normalizeMemoryFailure({ operation: "compact_summary", error: "disk full" })).toEqual({
      operation: "compact_summary",
      error: "disk full",
    })
    expect(normalizeMemoryFailure({ operation: "other" })).toEqual({
      operation: "instructions",
      error: "unknown error",
    })
  })

  it("logs and forwards memory failures without exposing raw fields", () => {
    const warnings: Array<{ event: string; fields?: Record<string, unknown> }> = []
    const failures: unknown[] = []

    reportMemoryFailure(
      { operation: "instructions", error: "permission denied", ignored: "raw" },
      {
        logger: { warn: (event, fields) => { warnings.push({ event, fields }) } },
        onMemoryFailure: (failure) => { failures.push(failure) },
      },
    )

    expect(warnings).toEqual([
      {
        event: "memory_operation_failed",
        fields: {
          operation: "instructions",
          error: "permission denied",
        },
      },
    ])
    expect(failures).toEqual([
      {
        operation: "instructions",
        error: "permission denied",
      },
    ])
  })

  it("reports async compact-summary persistence failures", async () => {
    const failures: unknown[] = []

    persistCompactSummaryBestEffort(
      "# Decisions made\n- keep diagnostics visible",
      { memoryDir: "/tmp/unreachable" } as AutoMemory,
      {
        onMemoryFailure: (failure) => { failures.push(failure) },
        persist: async () => {
          throw new Error("write failed")
        },
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(failures).toEqual([
      {
        operation: "compact_summary",
        error: "write failed",
      },
    ])
  })

  it("does not report compact-summary no-ops as failures", async () => {
    const failures: unknown[] = []

    persistCompactSummaryBestEffort(
      "# Current work\n- no durable sections",
      { memoryDir: "/tmp/unused" } as AutoMemory,
      {
        onMemoryFailure: (failure) => { failures.push(failure) },
        persist: async () => null,
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(failures).toEqual([undefined])
  })

  it("clears stale compact-summary failures after successful persistence", async () => {
    const failures: unknown[] = [{ operation: "compact_summary", error: "old failure" }]

    persistCompactSummaryBestEffort(
      "# Decisions made\n- keep diagnostics visible",
      { memoryDir: "/tmp/unused" } as AutoMemory,
      {
        onMemoryFailure: (failure) => { failures.push(failure) },
        persist: async () => "/tmp/unused/project_compact_state.md",
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(failures).toEqual([
      { operation: "compact_summary", error: "old failure" },
      undefined,
    ])
  })

  it("does not clear when persistence reports a handled write failure", async () => {
    const failures: unknown[] = []

    persistCompactSummaryBestEffort(
      "# Decisions made\n- keep diagnostics visible",
      { memoryDir: "/tmp/unused" } as AutoMemory,
      {
        onMemoryFailure: (failure) => { failures.push(failure) },
        persist: async (_summary, _autoMemory, diagnosticsLogger) => {
          diagnosticsLogger?.warn("memory_operation_failed", {
            operation: "compact_summary",
            error: "write failed",
          })
          return null
        },
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(failures).toEqual([
      {
        operation: "compact_summary",
        error: "write failed",
      },
    ])
  })
})
