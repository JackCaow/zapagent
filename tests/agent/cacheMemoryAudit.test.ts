import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendCacheMemoryAudit,
  buildCacheMemoryAuditEntry,
  cacheMemoryAuditPath,
  CacheMemoryAuditTracker,
  parseCacheMemoryAuditJsonl,
  readRecentCacheMemoryAudit,
} from "../../src/agent/cacheMemoryAudit.js"
import { buildMemoryUtilityCandidates } from "../../src/agent/memoryUtility.js"

describe("cache/memory audit entries", () => {
  it("keeps only bounded diagnostics and never persists raw context fields", () => {
    const secret = "raw private memory body"
    const entry = buildCacheMemoryAuditEntry({
      timestamp: "2026-07-22T00:00:00.000Z",
      sessionId: `session-${"x".repeat(400)}`,
      cacheScope: { providerId: "provider-a", model: "model-a" },
      durationMs: -5,
      steps: Number.POSITIVE_INFINITY,
      usage: {
        inputTokens: 10,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 10,
        outputTokens: 4,
      },
      promptCacheDiagnostics: {
        boundaryPresent: true,
        staticPrefix: { chars: 400, estimatedTokens: 100, hash: "static-hash" },
      },
      contextDiagnostics: {
        totalChars: 200,
        estimatedTokens: 50,
        hash: "context-hash",
        segments: [{
          name: "memory_working_pack",
          chars: 200,
          estimatedTokens: 50,
          hash: "memory-hash",
          meta: {
            included: ["project_state.md"],
            queryHash: "query-hash",
            rawBody: secret,
          },
        }],
      },
      telemetry: {
        usageSamples: 3.9,
        cacheAccountingSamples: 9,
        contextSamples: 3,
        contextShapes: 8,
        conversationPrefixShapes: 2,
      },
      memoryUtility: {
        selected: 999,
        read: 999,
        used: 999,
        revised: 999,
        contradicted: 999,
        avoidedReRead: 999,
        records: [{
          scope: "project",
          filename: "project_state.md",
          used: true,
          avoidedReRead: true,
          overlapScore: 5,
          evidence: ["content_overlap"],
        }],
      },
    })

    expect(entry.durationMs).toBe(0)
    expect(entry.steps).toBe(0)
    expect(entry.sessionId?.length).toBeLessThanOrEqual(256)
    expect(entry.usage.totalPromptInputTokens).toBe(100)
    expect(entry.usage.cacheReuseRatio).toBeCloseTo(80 / 90)
    expect(entry.telemetry).toEqual({
      usageSamples: 3,
      cacheAccountingSamples: 3,
      contextSamples: 3,
      contextShapes: 3,
      conversationPrefixShapes: 2,
    })
    expect(entry.memoryUtility).toEqual({
      selected: 1,
      read: 0,
      used: 1,
      revised: 0,
      contradicted: 0,
      avoidedReRead: 1,
      records: [{
        scope: "project",
        filename: "project_state.md",
        used: true,
        avoidedReRead: true,
        overlapScore: 1,
        evidence: ["content_overlap"],
      }],
    })
    expect(JSON.stringify(entry)).not.toContain(secret)
    expect(entry.contextDiagnostics?.segments[0]?.meta).toEqual({
      included: ["project_state.md"],
      queryHash: "query-hash",
    })
  })

  it("ignores malformed and unsupported JSONL rows", () => {
    const valid = buildCacheMemoryAuditEntry({
      timestamp: "2026-07-22T00:00:00.000Z",
      usage: { inputTokens: 12, outputTokens: 2 },
    })
    const parsed = parseCacheMemoryAuditJsonl([
      "not-json",
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, timestamp: "not-a-date" }),
      JSON.stringify(valid),
    ].join("\n"))

    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.usage.inputTokens).toBe(12)
  })
})

describe("cache/memory audit persistence", () => {
  it("uses project scope and compacts the JSONL before exceeding its byte cap", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-cache-audit-data-"))
    const cwd = mkdtempSync(join(tmpdir(), "zap-cache-audit-project-"))
    const maxBytes = 2_400
    try {
      for (let i = 0; i < 20; i++) {
        appendCacheMemoryAudit(cwd, buildCacheMemoryAuditEntry({
          timestamp: new Date(Date.UTC(2026, 6, 22, 0, 0, i)).toISOString(),
          sessionId: `session-${i}`,
          cacheScope: { providerId: "provider-a", model: "model-a" },
          usage: {
            inputTokens: 10,
            cacheReadInputTokens: 90,
            cacheCreationInputTokens: 0,
            outputTokens: 2,
          },
          contextDiagnostics: {
            totalChars: 100,
            estimatedTokens: 25,
            hash: `context-${i}`,
            segments: [],
          },
        }), { dataDir, maxBytes })
      }

      const path = cacheMemoryAuditPath(cwd, dataDir)
      expect(path).toContain(join(dataDir, "projects"))
      expect(statSync(path).size).toBeLessThanOrEqual(maxBytes)
      const recent = readRecentCacheMemoryAudit(cwd, 40, dataDir)
      expect(recent.length).toBeGreaterThan(0)
      expect(recent.length).toBeLessThan(20)
      expect(recent.at(-1)?.sessionId).toBe("session-19")
      expect(readFileSync(path, "utf-8").trim().split("\n").length).toBe(recent.length)
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600)
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe("CacheMemoryAuditTracker", () => {
  it("writes one sanitized aggregate record for each root run", () => {
    const entries: ReturnType<typeof buildCacheMemoryAuditEntry>[] = []
    const times = [1_000, 1_600]
    const tracker = new CacheMemoryAuditTracker({
      sessionId: "session-root",
      cacheScope: { providerId: "provider-a", model: "model-a" },
      now: () => times.shift() ?? 1_600,
      getPromptCacheDiagnostics: () => ({
        boundaryPresent: true,
        staticPrefix: { chars: 100, estimatedTokens: 25, hash: "static-hash" },
      }),
      append: (entry) => { entries.push(entry) },
    })

    tracker.handle({ type: "run_started", input: "do not persist this prompt" })
    tracker.handle({
      type: "run_step",
      step: 1,
      messageCount: 3,
      context: {
        totalChars: 80,
        estimatedTokens: 20,
        hash: "context-hash",
        segments: [],
        conversationCache: {
          prefix: {
            messageCount: 1,
            chars: 20,
            estimatedTokens: 5,
            hash: "prefix-a",
            messageHashes: ["message-a"],
          },
          tail: { messageCount: 1, chars: 10, estimatedTokens: 3, hash: "tail-a" },
        },
      },
    })
    tracker.handle({
      type: "run_usage",
      step: 1,
      inputTokens: 100,
      outputTokens: 2,
    })
    tracker.handle({
      type: "run_step",
      step: 2,
      messageCount: 5,
      context: {
        totalChars: 100,
        estimatedTokens: 25,
        hash: "context-hash-2",
        segments: [],
        conversationCache: {
          prefix: {
            messageCount: 3,
            chars: 60,
            estimatedTokens: 15,
            hash: "prefix-b",
            messageHashes: ["message-a", "message-b", "message-c"],
          },
          tail: { messageCount: 1, chars: 10, estimatedTokens: 3, hash: "tail-b" },
        },
      },
    })
    tracker.handle({
      type: "run_usage",
      step: 2,
      inputTokens: 10,
      cacheReadInputTokens: 90,
      cacheCreationInputTokens: 0,
      outputTokens: 3,
    })
    tracker.handle({ type: "observation", kind: "autocompact_start" })
    tracker.handle({ type: "observation", kind: "autocompact_done", detail: { failed: false } })
    tracker.handle({ type: "observation", kind: "reactive_compact" })
    tracker.handle({
      type: "run_ended",
      steps: 2,
      usage: {
        inputTokens: 10,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 0,
        outputTokens: 5,
      },
      stopped: "max_steps",
      finishReason: "end_turn",
    })
    tracker.handle({
      type: "run_ended",
      steps: 2,
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    tracker.handle({
      type: "run_ended",
      path: ["subagent-1"],
      steps: 1,
      usage: { inputTokens: 2, outputTokens: 1 },
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      sessionId: "session-root",
      durationMs: 600,
      steps: 2,
      stopped: "max_steps",
      usage: {
        inputTokens: 10,
        cacheReadInputTokens: 90,
        totalPromptInputTokens: 100,
      },
      compaction: {
        autoAttempts: 1,
        autoSucceeded: 1,
        autoFailed: 0,
        reactiveCompactions: 1,
      },
      telemetry: {
        usageSamples: 2,
        cacheAccountingSamples: 1,
        contextSamples: 2,
        contextShapes: 2,
        conversationPrefixShapes: 2,
      },
    })
    expect(JSON.stringify(entries[0])).not.toContain("do not persist this prompt")
  })

  it("reports append failures without throwing into the agent event loop", () => {
    const errors: string[] = []
    const tracker = new CacheMemoryAuditTracker({
      append: () => { throw new Error("disk full") },
      onError: (error) => { errors.push(error.message) },
    })

    expect(() => tracker.handle({
      type: "run_ended",
      steps: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    })).not.toThrow()
    expect(errors).toEqual(["disk full"])
  })

  it("persists conservative online utility evidence without raw memory content", () => {
    const body = "Use the stable cache prefix hash before changing provider prompt assembly.\n"
    const candidates = buildMemoryUtilityCandidates({
      scope: "project",
      memoryDir: "/tmp/memory",
      records: [{
        filename: "cache_rule.md",
        frontmatter: {
          name: "cache_rule",
          description: "cache rule",
          type: "project",
        },
        body,
      }],
      included: ["cache_rule.md"],
    })
    const entries: ReturnType<typeof buildCacheMemoryAuditEntry>[] = []
    const tracker = new CacheMemoryAuditTracker({
      sessionId: "session-utility",
      memoryUtility: { candidates, cwd: "/repo" },
      append: (entry) => { entries.push(entry) },
    })

    tracker.handle({ type: "run_started", input: "Investigate cache behavior." })
    tracker.handle({ type: "content_final", kind: "text", id: "text-1", text: body })
    tracker.handle({
      type: "content_final",
      path: ["subagent-1"],
      kind: "text",
      id: "sub-text",
      text: "subagent private text",
    })
    tracker.handle({
      type: "run_ended",
      steps: 1,
      usage: { inputTokens: 10, outputTokens: 2 },
    })

    expect(entries[0]?.memoryUtility).toMatchObject({
      selected: 1,
      read: 0,
      used: 1,
      avoidedReRead: 1,
      records: [{
        scope: "project",
        filename: "cache_rule.md",
        used: true,
        avoidedReRead: true,
      }],
    })
    expect(JSON.stringify(entries[0])).not.toContain(body.trim())
    expect(JSON.stringify(entries[0])).not.toContain("subagent private")
  })
})

it("persists bounded prune/wire diagnostics without manufacturing missing cache accounting", () => {
  const entries: any[] = [];
  const tracker = new CacheMemoryAuditTracker({ append: entry => entries.push(entry) });
  tracker.handle({ type: "run_started", input: "private task" });
  tracker.handle({ type: "observation", kind: "prune_start" });
  tracker.handle({ type: "observation", kind: "prune_done", detail: { inputTokens: 15000, outputTokens: 6000, messagesPruned: 5, messages: "must not persist" } });
  tracker.handle({ type: "observation", kind: "request_cache_shape", detail: { change: "rewrite", reason: "prune", commonPrefixMessages: 3,
    previousMessages: 20, messages: 20, sampled: false, afterHash: "a".repeat(64), scopeHash: "b".repeat(64), staticHash: "c".repeat(64), rawBody: "must not persist" } });
  tracker.handle({ type: "run_ended", steps: 1, usage: { inputTokens: 6000, outputTokens: 20 } });
  const restored = parseCacheMemoryAuditJsonl(JSON.stringify(entries[0]) + "\n")[0]!;
  expect(restored.compaction).toMatchObject({ pruneAttempts: 1, pruneSucceeded: 1, prunedTokens: 9000, prunedMessages: 5 });
  expect(restored.telemetry).toMatchObject({ wireRequests: 1, wireRewrites: 1 });
  expect(restored.requestCache?.reason).toBe("prune");
  expect(restored.usage.cacheHitRatio).toBeUndefined();
  expect(restored.usage.cacheReadInputTokens).toBeUndefined();
  expect(JSON.stringify(restored)).not.toContain("must not persist");
  expect(JSON.stringify(restored)).not.toContain("private task");
});
