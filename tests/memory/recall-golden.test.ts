import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  buildMemoryQueryForRun,
  buildPerTurnAttachments,
} from "../../src/agent/contextAttachments.js"
import { openMdStore } from "../../zapsdk/memory/md-store.js"
import { LocalSparseMemoryRetriever } from "../../zapsdk/memory/local-semantic.js"
import {
  assessMemoryRecallQuality,
  evaluateMemoryRecall,
  formatMemoryRecallEvalReport,
} from "../../zapsdk/memory/recall-eval.js"
import type { AutoMemory } from "../../zapsdk/memory/auto-memory.js"
import type { MdMemoryType } from "../../zapsdk/memory/md-types.js"

let dir: string

beforeEach(() => {
  dir = join(tmpdir(), `zapcode-recall-golden-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("memory recall golden scenarios", () => {
  it("meets the quantified top-one recall quality gate", async () => {
    const scenarios = [
      {
        id: "zh-long-paste",
        query: "复制长文本到输入粘贴 发送后消息中的文本显示不完整",
        relevant: ["long_paste_ui.md"],
        forbidden: ["cache_hit_rate.md", "billing_workflow.md"],
      },
      {
        id: "zh-cache",
        query: "Agent缓存命中率很低，大部分模型应该在90%以上",
        relevant: ["cache_hit_rate.md"],
        forbidden: ["long_paste_ui.md", "billing_workflow.md"],
      },
      {
        id: "zh-compaction",
        query: "帮我看下当前的记忆压缩机制",
        relevant: ["memory_compaction_design.md"],
        forbidden: ["long_paste_ui.md", "billing_workflow.md"],
      },
      {
        id: "zh-billing",
        query: "账单发票和支付事件应该如何对账",
        relevant: ["billing_workflow.md"],
        forbidden: ["cache_hit_rate.md", "long_paste_ui.md"],
      },
      {
        id: "zh-terminal-preference",
        query: "终端输出保持简洁并说明验证命令",
        relevant: ["shell_preference.md"],
        forbidden: ["billing_workflow.md", "long_paste_ui.md"],
      },
      {
        id: "zh-continuation",
        query: buildMemoryQueryForRun("继续", [
          "复制长文本到输入粘贴 发送后消息中的文本显示不完整",
          "[Pasted #1 · 180 lines · 90000 chars]",
        ]),
        relevant: ["long_paste_ui.md"],
        forbidden: ["cache_hit_rate.md", "billing_workflow.md"],
      },
    ]
    const report = await evaluateMemoryRecall(scenarios, async (query) => {
      const result = await runRecall(query)
      return { selected: result.workingPackIncluded }
    }, { k: 1 })
    const assessment = assessMemoryRecallQuality(report, {
      minHitRateAtK: 1,
      minRecallAtK: 1,
      minPrecisionAtK: 1,
      minMeanReciprocalRankAtK: 1,
      maxForbiddenCaseRateAtK: 0,
      maxDuplicateCaseRateAtK: 0,
      maxRetrievalErrorRate: 0,
      maxP95LatencyMs: 1_000,
    })

    if (!assessment.passed) {
      const cases = report.cases
        .filter((result) => !result.hitAtK || result.forbiddenHits.length > 0 || result.error)
        .map((result) => `${result.id}: selected=${result.selectedAtK.join(",") || "(none)"} missing=${result.missingRelevant.join(",") || "(none)"}${result.error ? ` error=${result.error}` : ""}`)
      throw new Error([
        formatMemoryRecallEvalReport(report),
        ...assessment.failures,
        ...cases,
      ].join("\n"))
    }
  })

  it("recalls long-paste UI memory from a Chinese long-text display issue", async () => {
    const result = await runRecall("复制长文本到输入粘贴 发送后消息中的文本显示不完整")

    expect(result.memoryIndexIncluded).toContain("long_paste_ui.md")
    expect(result.memoryIndexIncluded).not.toContain("cache_hit_rate.md")
    expect(result.memoryIndexIncluded).not.toContain("billing_workflow.md")
    expect(result.workingPackIncluded).toContain("long_paste_ui.md")
    expect(result.workingPackIncluded).not.toContain("cache_hit_rate.md")
    expect(result.workingPackIncluded).not.toContain("billing_workflow.md")
    expect(result.workingPackAttachment).toContain("restoreText keeps the full pasted body")
  })

  it("recalls cache diagnostics without pulling long-paste UI memory", async () => {
    const result = await runRecall("Agent缓存命中率很低，大部分模型应该在90%以上")

    expect(result.memoryIndexIncluded).toContain("cache_hit_rate.md")
    expect(result.memoryIndexIncluded).not.toContain("long_paste_ui.md")
    expect(result.memoryIndexIncluded).not.toContain("billing_workflow.md")
    expect(result.workingPackIncluded).toContain("cache_hit_rate.md")
    expect(result.workingPackIncluded).not.toContain("long_paste_ui.md")
    expect(result.workingPackIncluded).not.toContain("billing_workflow.md")
    expect(result.workingPackAttachment).toContain("Compare cache read tokens")
  })

  it("recalls cache diagnostics from a CJK anchored single-token long paste", async () => {
    const result = await runRecall(`帮我排查缓存命中率：${"甲".repeat(1400)}`)

    expect(result.memoryIndexIncluded).toContain("cache_hit_rate.md")
    expect(result.memoryIndexIncluded).not.toContain("billing_workflow.md")
    expect(result.workingPackIncluded).toContain("cache_hit_rate.md")
    expect(result.workingPackIncluded).not.toContain("billing_workflow.md")
    expect(result.workingPackAttachment).toContain("Compare cache read tokens")
  })

  it("recalls memory architecture records from a Chinese architecture request", async () => {
    const result = await runRecall("给我这个整体的 记忆层设计架构", {
      mutateRecords(records) {
        records.push({
          name: "memory_layer_architecture",
          description: "memory layer architecture design",
          type: "project",
          tags: ["memory", "architecture"],
          body: [
            "The memory layer separates stable instructions, per-turn recall attachments, and compact summary persistence.",
            "Recall diagnostics should identify query, selection, and context attachment churn separately.",
          ].join("\n"),
        })
      },
    })

    expect(result.memoryIndexIncluded[0]).toBe("memory_layer_architecture.md")
    expect(result.workingPackIncluded[0]).toBe("memory_layer_architecture.md")
    expect(result.workingPackIncluded).not.toContain("billing_workflow.md")
    expect(result.workingPackAttachment).toContain("stable instructions, per-turn recall attachments")
  })

  it("recalls global personal memory dedupe records from a Chinese scope request", async () => {
    const result = await runRecall("全局个人记忆和项目记忆作用域去重策略", {
      mutateRecords(records) {
        records.push({
          name: "global_personal_memory_dedupe",
          description: "global personal memory duplicate filtering across project scope",
          type: "project",
          tags: ["global", "personal", "memory", "dedupe", "scope"],
          body: [
            "Global personal memory should attach user and feedback records before project memory.",
            "Project-side legacy personal duplicates should be filtered only when the selected global record is relevant or pinned.",
          ].join("\n"),
        })
      },
    })

    expect(result.memoryIndexIncluded[0]).toBe("global_personal_memory_dedupe.md")
    expect(result.workingPackIncluded[0]).toBe("global_personal_memory_dedupe.md")
    expect(result.workingPackIncluded).not.toContain("billing_workflow.md")
    expect(result.workingPackAttachment).toContain("legacy personal duplicates")
  })

  it("recalls long-text preservation records from a Chinese completeness request", async () => {
    const result = await runRecall("复制长文本发送完整性和保留", {
      mutateRecords(records) {
        records.push({
          name: "long_text_preservation",
          description: "long pasted input full body preservation",
          type: "project",
          tags: ["paste", "preservation"],
          body: [
            "Preserve the complete pasted text for model send, restoreText, copy-input, and resend.",
            "Compact transcript display must not imply that the model received truncated text.",
          ].join("\n"),
        })
      },
    })

    expect(result.memoryIndexIncluded[0]).toBe("long_text_preservation.md")
    expect(result.workingPackIncluded[0]).toBe("long_text_preservation.md")
    expect(result.workingPackIncluded).not.toContain("cache_hit_rate.md")
    expect(result.workingPackAttachment).toContain("Preserve the complete pasted text")
  })

  it("uses the latest meaningful long-paste request for continuation recall", async () => {
    const query = buildMemoryQueryForRun("继续", [
      "复制长文本到输入粘贴 发送后消息中的文本显示不完整",
      "[Pasted #1 · 180 lines · 90000 chars]",
    ])
    const result = await runRecall(query)

    expect(result.workingPackIncluded).toContain("long_paste_ui.md")
    expect(result.workingPackIncluded).not.toContain("billing_workflow.md")
    expect(result.memoryQueryHash).toBeDefined()
  })

  it("keeps generated file content noise from displacing the requested cache memory", async () => {
    const result = await runRecall([
      "review cache hit behavior and prompt cache stability",
      '<file_content path="/repo/billing.ts">',
      "billing invoice reconciliation payment workflow billing workflow",
      "</file_content>",
    ].join("\n"))

    expect(result.workingPackIncluded[0]).toBe("cache_hit_rate.md")
    expect(result.memoryIndexIncluded[0]).toBe("cache_hit_rate.md")
    expect(result.workingPackIncluded).not.toContain("billing_workflow.md")
    expect(result.memoryIndexIncluded).not.toContain("billing_workflow.md")
  })

  it("recalls morphologically related memory when whole-word lexical matching has no hit", async () => {
    const result = await runRecall("configure deployment rollout", {
      mutateRecords(records) {
        records.push({
          name: "runtime_policy",
          description: "deployed configuration lifecycle",
          type: "project",
          body: "Persist the finalized settings after validation.",
        })
      },
    })

    expect(result.memoryIndexIncluded[0]).toBe("runtime_policy.md")
    expect(result.workingPackIncluded[0]).toBe("runtime_policy.md")
    expect(result.workingPackRecall?.selected[0]).toMatchObject({
      filename: "runtime_policy.md",
      lexicalScore: 0,
    })
    expect(result.workingPackRecall?.selected[0]?.semanticScore).toBeGreaterThan(0.08)
    expect(result.workingPackIncluded).not.toContain("billing_workflow.md")
  })

  it("keeps oversized compact state recoverable under a small context window", async () => {
    const result = await runRecall("继续", {
      contextWindow: 8192,
      mutateRecords(records) {
        records.push({
          name: "project_compact_state",
          description: "Durable snapshot from the most recent compact pass.",
          type: "project",
          tags: ["compact", "summary", "status", "pinned"],
          body: [
            ...Array.from({ length: 120 }, (_, i) => `historical compact detail ${i}`),
            "## Current task status",
            "- Continue memory layer, prompt cache stability, and long pasted input work.",
            "## Next steps",
            "- Add golden recall evals and verify with tmux.",
            ...Array.from({ length: 120 }, (_, i) => `older compact tail ${i}`),
          ].join("\n"),
        })
      },
    })

    expect(result.workingPackIncluded[0]).toBe("project_compact_state.md")
    expect(result.workingPackAttachment).toContain('excerpt="true"')
    expect(result.workingPackAttachment).toContain("Continue memory layer")
  })
})

interface MemoryFixtureRecord {
  name: string
  description: string
  type: MdMemoryType
  body: string
  tags?: string[]
}

interface RunRecallOptions {
  contextWindow?: number
  mutateRecords?: (records: MemoryFixtureRecord[]) => void
}

async function runRecall(query: string | undefined, options: RunRecallOptions = {}) {
  const store = openMdStore(dir)
  const records = baseRecords()
  options.mutateRecords?.(records)
  for (const record of records) store.save(record)
  return buildPerTurnAttachments(fakeAutoMemory(dir), {
    memoryQuery: query,
    memoryStore: store,
    semanticRetriever: new LocalSparseMemoryRetriever(),
    ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
  })
}

function baseRecords(): MemoryFixtureRecord[] {
  return [
    {
      name: "long_paste_ui",
      description: "long pasted input display and restore behavior",
      type: "project",
      tags: ["paste", "input", "ui"],
      body: [
        "Long pasted text should display as a compact placeholder in transcript rows.",
        "The model receives the full pasted text, while restoreText keeps the full pasted body for copy-input and resend.",
        "Use the compact display text as memoryQueryText so pasted payload bytes do not churn recall.",
      ].join("\n"),
    },
    {
      name: "cache_hit_rate",
      description: "provider cache hit ratio diagnostics",
      type: "project",
      tags: ["cache", "provider"],
      body: [
        "Compare cache read tokens, cache creation tokens, and fresh input tokens separately.",
        "Low cache reuse usually means prompt shape, tool schemas, or transient context changed.",
        "Inspect context attachment hashes before changing model settings.",
      ].join("\n"),
    },
    {
      name: "memory_compaction_design",
      description: "memory compact summary and recall design",
      type: "project",
      tags: ["memory", "compact"],
      body: [
        "Compact summaries should persist durable current status and next steps into project memory.",
        "Continuation turns should recall compact state without letting runtime XML dominate the query.",
      ].join("\n"),
    },
    {
      name: "shell_preference",
      description: "terminal output preference",
      type: "user",
      body: "Keep terminal summaries concise and mention verification commands.\n",
    },
    {
      name: "billing_workflow",
      description: "billing invoice reconciliation workflow",
      type: "project",
      tags: ["billing"],
      body: "Billing invoices are reconciled against payment provider events.\n",
    },
  ]
}

function fakeAutoMemory(memoryDir: string): AutoMemory {
  return {
    memoryDir,
    ensure: async () => {},
    ensureSync: () => {},
  } as unknown as AutoMemory
}
