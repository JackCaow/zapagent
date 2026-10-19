import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import type { AgentEvent } from "../../zapsdk/agent/events.js"
import type { MdMemoryRecord } from "../../zapsdk/memory/md-store.js"
import {
  buildMemoryUtilityCandidates,
  DEFAULT_MEMORY_UTILITY_OVERLAP_POLICY,
  fingerprintMemoryUtilityText,
  MemoryUtilityTracker,
  type MemoryUtilityOverlapPolicy,
} from "../../src/agent/memoryUtility.js"
import {
  assessMemoryUtilityQuality,
  evaluateMemoryUtility,
  formatMemoryUtilityEvalReport,
  type MemoryUtilityEvalCase,
} from "../../src/agent/memoryUtilityEval.js"

const MEMORY_DIR = "/tmp/zap-memory-utility-eval"

interface MemoryUtilityFixture {
  records: Array<{ name: string; body: string; excerpted?: boolean }>
  input: string
  baseline?: string
  events: AgentEvent[]
}

const scenarios: Array<MemoryUtilityEvalCase<MemoryUtilityFixture>> = [
  {
    id: "positive-exact-unique-line",
    expectedUsed: true,
    payload: fixture(
      "cache_rule",
      "Compare the stable system prefix hash before changing provider prompt assembly.",
      "Investigate cache behavior.",
      [text("Compare the stable system prefix hash before changing provider prompt assembly.")],
    ),
  },
  {
    id: "positive-english-phrase-evidence",
    expectedUsed: true,
    payload: fixture(
      "release_rule",
      "Always verify signed artifact checksum before publishing a release.",
      "Prepare the release.",
      [text("We must verify signed artifact checksum before publishing.")],
    ),
  },
  {
    id: "positive-cjk-phrase-evidence",
    expectedUsed: true,
    payload: fixture(
      "release_rule_zh",
      "\u53d1\u5e03\u524d\u5fc5\u987b\u9a8c\u8bc1\u5b89\u88c5\u5305\u7b7e\u540d\u548c\u6821\u9a8c\u548c\u3002",
      "\u51c6\u5907\u53d1\u5e03\u3002",
      [text("\u9700\u8981\u9a8c\u8bc1\u5b89\u88c5\u5305\u7b7e\u540d\u548c\u6821\u9a8c\u548c\u624d\u80fd\u53d1\u5e03\u3002")],
    ),
  },
  {
    id: "positive-explicit-read-of-excerpt",
    expectedUsed: true,
    payload: {
      records: [{
        name: "excerpted_release",
        body: "The complete release process requires architecture and signature evidence.",
        excerpted: true,
      }],
      input: "Read the full release process.",
      events: [
        toolCall("read-1", "read_file", { path: join(MEMORY_DIR, "excerpted_release.md") }),
        toolResult("read-1", "read_file", true, "memory body"),
      ],
    },
  },
  {
    id: "positive-tool-argument-evidence",
    expectedUsed: true,
    payload: fixture(
      "release_command",
      "Release checksum verification must run before artifact publication.",
      "Publish the artifact.",
      [toolCall("bash-1", "bash", {
        command: "run release checksum verification before artifact publication now",
      })],
    ),
  },
  {
    id: "positive-bounded-maximum-candidate-set",
    expectedUsed: true,
    payload: largeCandidateFixture(),
  },
  {
    id: "negative-current-input-echo",
    expectedUsed: false,
    payload: fixture(
      "echoed_request",
      "Preserve complete pasted text in model input and restore state.",
      "Preserve complete pasted text in model input and restore state.",
      [text("Preserve complete pasted text in model input and restore state.")],
    ),
  },
  {
    id: "negative-recall-baseline-echo",
    expectedUsed: false,
    payload: {
      ...fixture(
        "continuation_context",
        "Historical cache diagnosis compares provider usage before changing prompts.",
        "Continue.",
        [text("Historical cache diagnosis compares provider usage before changing prompts.")],
      ),
      baseline: "Historical cache diagnosis compares provider usage before changing prompts.",
    },
  },
  {
    id: "negative-shared-generic-evidence",
    expectedUsed: false,
    payload: {
      records: [
        { name: "generic_first", body: "Always verify the current state before making a production change." },
        { name: "generic_second", body: "Always verify the current state before making a production change." },
      ],
      input: "Continue.",
      events: [text("Always verify the current state before making a production change.")],
    },
  },
  {
    id: "negative-single-phrase-match",
    expectedUsed: false,
    payload: fixture(
      "single_phrase",
      "Verify release checksum before publishing signed artifacts.",
      "Review the release.",
      [text("We should verify release checksum during this run.")],
    ),
  },
  {
    id: "negative-english-sentence-boundary",
    expectedUsed: false,
    payload: fixture(
      "fragmented_english",
      "cache prefix. shape stability",
      "Continue.",
      [text("cache prefix shape stability")],
    ),
  },
  {
    id: "negative-cjk-sentence-boundary",
    expectedUsed: false,
    payload: fixture(
      "fragmented_cjk",
      "\u7f13\u5b58\u7a33\u5b9a\u3002\u524d\u7f00\u7ed3\u6784",
      "\u7ee7\u7eed\u3002",
      [text("\u7f13\u5b58\u7a33\u5b9a\u524d\u7f00\u7ed3\u6784")],
    ),
  },
  {
    id: "negative-excerpt-overlap-without-read",
    expectedUsed: false,
    payload: {
      ...fixture(
        "excerpt_overlap",
        "A partial working-pack excerpt cannot prove use of the complete memory body.",
        "Continue.",
        [text("A partial working-pack excerpt cannot prove use of the complete memory body.")],
      ),
      records: [{
        name: "excerpt_overlap",
        body: "A partial working-pack excerpt cannot prove use of the complete memory body.",
        excerpted: true,
      }],
    },
  },
  {
    id: "negative-failed-explicit-read",
    expectedUsed: false,
    payload: {
      records: [{ name: "failed_read", body: "Failed reads must not count as memory use." }],
      input: "Read the memory.",
      events: [
        toolCall("read-failed", "read_file", { path: join(MEMORY_DIR, "failed_read.md") }),
        toolResult("read-failed", "read_file", false, "", "missing"),
      ],
    },
  },
  {
    id: "negative-subagent-only-evidence",
    expectedUsed: false,
    payload: fixture(
      "subagent_private",
      "Only root assistant evidence may affect utility attribution.",
      "Continue.",
      [{ ...text("Only root assistant evidence may affect utility attribution."), path: ["subagent-1"] }],
    ),
  },
  {
    id: "negative-tool-result-only-evidence",
    expectedUsed: false,
    payload: fixture(
      "tool_output",
      "Tool result bodies are not assistant memory-use evidence.",
      "Continue.",
      [toolResult(
        "search-1",
        "search",
        true,
        "Tool result bodies are not assistant memory-use evidence.",
      )],
    ),
  },
  {
    id: "negative-unrelated-output",
    expectedUsed: false,
    payload: fixture(
      "billing_reference",
      "Reconcile invoice events against payment processor settlement records.",
      "Investigate cache behavior.",
      [text("The provider cache prefix stayed stable across both requests.")],
    ),
  },
]

describe("memory utility golden calibration", () => {
  it("meets the conservative default-policy quality gate", async () => {
    const report = await evaluateMemoryUtility(
      scenarios,
      (payload) => classify(payload, DEFAULT_MEMORY_UTILITY_OVERLAP_POLICY),
    )
    const assessment = assessMemoryUtilityQuality(report, {
      minPrecision: 1,
      minRecall: 1,
      minSpecificity: 1,
      minAccuracy: 1,
      maxFalsePositiveRate: 0,
      maxClassificationErrorRate: 0,
      maxP95LatencyMs: 250,
    })

    if (!assessment.passed) {
      const failures = report.cases
        .filter((item) => !item.correct || item.error)
        .map((item) => `${item.id}: expected=${item.expectedUsed} predicted=${item.predictedUsed ?? "error"}`)
      throw new Error([
        formatMemoryUtilityEvalReport(report),
        ...assessment.failures,
        ...failures,
      ].join("\n"))
    }
  })

  it("rejects a permissive one-phrase policy through the false-positive gate", async () => {
    const report = await evaluateMemoryUtility(scenarios, (payload) => classify(payload, {
      minMatchedLines: 1,
      minMatchedPhrases: 1,
    }))
    const assessment = assessMemoryUtilityQuality(report, {
      minPrecision: 1,
      minSpecificity: 1,
      maxFalsePositiveRate: 0,
    })

    expect(assessment.passed).toBe(false)
    expect(report.falsePositive).toBeGreaterThan(0)
    expect(report.cases.find((item) => item.id === "negative-single-phrase-match"))
      .toMatchObject({ expectedUsed: false, predictedUsed: true })
  })
})

function classify(
  payload: MemoryUtilityFixture,
  policy: MemoryUtilityOverlapPolicy,
): { used: boolean } {
  const records: MdMemoryRecord[] = payload.records.map(({ name, body }) => ({
    filename: `${name}.md`,
    frontmatter: { name, description: `${name} calibration fixture`, type: "project" },
    body,
  }))
  const candidates = buildMemoryUtilityCandidates({
    scope: "project",
    memoryDir: MEMORY_DIR,
    records,
    included: records.map((record) => record.filename),
    excerpted: payload.records.filter((record) => record.excerpted).map((record) => `${record.name}.md`),
  })
  const tracker = new MemoryUtilityTracker(
    candidates,
    "/repo",
    payload.baseline ? fingerprintMemoryUtilityText(payload.baseline) : undefined,
    policy,
  )
  tracker.handle({ type: "run_started", input: payload.input })
  for (const event of payload.events) tracker.handle(event)
  return { used: tracker.summarize().used > 0 }
}

function fixture(name: string, body: string, input: string, events: AgentEvent[]): MemoryUtilityFixture {
  return { records: [{ name, body }], input, events }
}

function largeCandidateFixture(): MemoryUtilityFixture {
  const records = Array.from({ length: 12 }, (_, candidate) => ({
    name: `bounded_candidate_${candidate}`,
    body: Array.from(
      { length: 600 },
      (_, line) => `candidate ${candidate} unique calibration evidence line ${line} remains bounded and deterministic`,
    ).join("\n"),
  }))
  return {
    records,
    input: "Exercise the bounded candidate set.",
    events: [text("candidate 11 unique calibration evidence line 500 remains bounded and deterministic")],
  }
}

function text(value: string): AgentEvent {
  return { type: "content_final", kind: "text", id: `text-${value.length}`, text: value }
}

function toolCall(id: string, toolName: string, args: Record<string, unknown>): AgentEvent {
  return { type: "content_final", kind: "tool_call", id, step: 1, toolName, arguments: args }
}

function toolResult(
  id: string,
  toolName: string,
  success: boolean,
  output: string,
  error?: string,
): AgentEvent {
  return {
    type: "content_final",
    kind: "tool_result",
    id,
    step: 1,
    toolName,
    result: { success, output, ...(error ? { error } : {}) },
  }
}
