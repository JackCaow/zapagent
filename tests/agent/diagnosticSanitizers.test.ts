import { describe, expect, it } from "bun:test"
import { sanitizeContextDiagnostics, sanitizePromptCacheDiagnostics } from "../../src/agent/diagnosticSanitizers.js"

describe("diagnostic sanitizers", () => {
  it("bounds restored context diagnostics metadata before status rendering", () => {
    const long = "x".repeat(200)
    const diagnostics = sanitizeContextDiagnostics({
      totalChars: 123,
      estimatedTokens: 45,
      hash: long,
      segments: Array.from({ length: 20 }, (_, index) => ({
        name: index === 0 ? long : `segment_${index}`,
        chars: index + 1,
        estimatedTokens: index + 2,
        hash: long,
        meta: {
          included: Array.from({ length: 30 }, (__, i) => i === 0 ? long : `file_${i}.md`),
          excerpted: Array.from({ length: 30 }, (__, i) => i === 0 ? long : `excerpt_${i}.md`),
          skipped: Object.fromEntries(Array.from({ length: 30 }, (__, i) => [`reason_${i}`, i])),
          selected: Array.from({ length: 30 }, (__, i) => ({
            filename: i === 0 ? long : `selected_${i}.md`,
            score: i + 0.25,
            relevanceScore: i,
            lexicalScore: i - 1,
            semanticScore: i === 0 ? 4 : 0.5,
            recencyBoost: Number.POSITIVE_INFINITY,
            confidence: i === 0 ? "medium" : "not-a-confidence",
            lifecycleState: i === 0 ? "active" : "not-a-state",
            pinned: i === 1,
            excerpted: i === 2,
            extraField: "drop me",
          })),
          topSkipped: Array.from({ length: 30 }, (__, i) => ({
            filename: i === 0 ? long : `skipped_${i}.md`,
            score: i,
            relevanceScore: i - 1,
            recencyBoost: 0,
            skippedReason: i === 0 ? long : "min_score",
            confidence: i === 0 ? "high" : "not-a-confidence",
            lifecycleState: i === 0 ? "superseded" : "not-a-state",
          })),
          queryHash: long,
          budgetTokens: 2048.7,
          todoCount: Number.POSITIVE_INFINITY,
          inProgressCount: -2,
          hugeFutureField: "drop me",
        },
      })),
    })

    expect(diagnostics?.hash).toHaveLength(160)
    expect(diagnostics?.segments).toHaveLength(16)
    expect(diagnostics?.segments[0]?.name).toHaveLength(160)
    expect(diagnostics?.segments[0]?.hash).toHaveLength(160)
    expect(diagnostics?.segments[0]?.meta).toEqual({
      included: [
        "x".repeat(160),
        ...Array.from({ length: 23 }, (_, i) => `file_${i + 1}.md`),
      ],
      excerpted: [
        "x".repeat(160),
        ...Array.from({ length: 23 }, (_, i) => `excerpt_${i + 1}.md`),
      ],
      skipped: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`reason_${i}`, i])),
      selected: [
        {
          filename: "x".repeat(160),
          score: 0.25,
          relevanceScore: 0,
          lexicalScore: 0,
          semanticScore: 1,
          recencyBoost: 0,
          confidence: "medium",
          lifecycleState: "active",
        },
        {
          filename: "selected_1.md",
          score: 1.25,
          relevanceScore: 1,
          lexicalScore: 0,
          semanticScore: 0.5,
          recencyBoost: 0,
          pinned: true,
        },
        {
          filename: "selected_2.md",
          score: 2.25,
          relevanceScore: 2,
          lexicalScore: 1,
          semanticScore: 0.5,
          recencyBoost: 0,
          excerpted: true,
        },
        ...Array.from({ length: 21 }, (_, i) => ({
          filename: `selected_${i + 3}.md`,
          score: i + 3.25,
          relevanceScore: i + 3,
          lexicalScore: i + 2,
          semanticScore: 0.5,
          recencyBoost: 0,
        })),
      ],
      topSkipped: [
        {
          filename: "x".repeat(160),
          score: 0,
          relevanceScore: 0,
          recencyBoost: 0,
          skippedReason: "x".repeat(160),
          confidence: "high",
          lifecycleState: "superseded",
        },
        ...Array.from({ length: 23 }, (_, i) => ({
          filename: `skipped_${i + 1}.md`,
          score: i + 1,
          relevanceScore: i,
          recencyBoost: 0,
          skippedReason: "min_score",
        })),
      ],
      queryHash: "x".repeat(160),
      budgetTokens: 2048.7,
      todoCount: 0,
      inProgressCount: 0,
    })
  })

  it("orders restored skipped diagnostics by reason", () => {
    const diagnostics = sanitizeContextDiagnostics({
      totalChars: 10,
      estimatedTokens: 3,
      hash: "context_hash",
      segments: [{
        name: "memory_working_pack",
        chars: 10,
        estimatedTokens: 3,
        hash: "segment_hash",
        meta: {
          skipped: {
            min_score: 2,
            budget: 1,
            max_records: 3,
          },
        },
      }],
    })

    const skipped = diagnostics?.segments[0]?.meta?.skipped as Record<string, number> | undefined
    expect(Object.keys(skipped ?? {})).toEqual(["budget", "max_records", "min_score"])
    expect(skipped).toEqual({
      budget: 1,
      max_records: 3,
      min_score: 2,
    })
  })

  it("bounds restored diagnostics text by Unicode character count", () => {
    const exact = "😀".repeat(160)
    const over = `${exact}🚀`
    const diagnostics = sanitizeContextDiagnostics({
      totalChars: 10,
      estimatedTokens: 3,
      hash: over,
      segments: [{
        name: over,
        chars: 10,
        estimatedTokens: 3,
        hash: over,
        meta: {
          included: [over],
          selected: [{
            filename: over,
            score: 1,
            relevanceScore: 1,
            recencyBoost: 0,
          }],
        },
      }],
    })

    expect(over.length).toBeGreaterThan(161)
    expect(diagnostics?.hash).toBe(exact)
    expect(diagnostics?.segments[0]?.name).toBe(exact)
    expect(diagnostics?.segments[0]?.hash).toBe(exact)
    expect((diagnostics?.segments[0]?.meta?.included as string[] | undefined)?.[0]).toBe(exact)
    expect((diagnostics?.segments[0]?.meta?.selected as Array<{ filename: string }> | undefined)?.[0]?.filename).toBe(exact)
  })

  it("sanitizes bounded conversation cache fingerprints", () => {
    const diagnostics = sanitizeContextDiagnostics({
      totalChars: 0,
      estimatedTokens: 0,
      hash: "empty",
      segments: [],
      conversationCache: {
        prefix: {
          messageCount: 140.9,
          chars: 1200.5,
          estimatedTokens: 300.25,
          hash: "prefix",
          messageHashes: Array.from({ length: 140 }, (_, index) => `message-${index}`),
        },
        tail: {
          messageCount: -2,
          chars: Number.POSITIVE_INFINITY,
          estimatedTokens: 20,
          hash: "tail",
        },
      },
    })

    expect(diagnostics?.conversationCache).toEqual({
      prefix: {
        messageCount: 140,
        chars: 1200.5,
        estimatedTokens: 300.25,
        hash: "prefix",
        messageHashes: Array.from({ length: 128 }, (_, index) => `message-${index}`),
      },
      tail: {
        messageCount: 0,
        chars: 0,
        estimatedTokens: 20,
        hash: "tail",
      },
    })
  })

  it("bounds restored prompt cache tool diagnostics", () => {
    const long = "tool_".repeat(50)
    const diagnostics = sanitizePromptCacheDiagnostics({
      boundaryPresent: true,
      boundaryCount: 2.9,
      staticPrefix: {
        chars: 10,
        estimatedTokens: 3,
        hash: "static_hash",
      },
      toolSchemas: {
        count: 99.9,
        chars: 1200.8,
        estimatedTokens: 300.2,
        hash: long,
        names: Array.from({ length: 30 }, (_, i) => i === 0 ? long : `tool_${i}`),
      },
    })

    expect(diagnostics?.boundaryCount).toBe(2)
    expect(diagnostics?.toolSchemas?.count).toBe(99)
    expect(diagnostics?.toolSchemas?.chars).toBe(1200.8)
    expect(diagnostics?.toolSchemas?.estimatedTokens).toBe(300.2)
    expect(diagnostics?.toolSchemas?.hash).toHaveLength(160)
    expect(diagnostics?.toolSchemas?.names).toHaveLength(24)
    expect(diagnostics?.toolSchemas?.names[0]).toHaveLength(160)
    expect(diagnostics?.toolSchemas?.names[23]).toBe("tool_23")
  })
})
