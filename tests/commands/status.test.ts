import { describe, expect, it } from "bun:test"
import { buildStatusText } from "../../src/commands/status.js"
import type { AppConfig } from "../../src/config.js"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"
import { buildCacheMemoryAuditEntry } from "../../src/agent/cacheMemoryAudit.js"

describe("buildStatusText", () => {
  it("renders prompt cache details when usage is provided", () => {
    const text = buildStatusText(makeConfig(), "/repo", 100, {
      inputTokens: 10,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 10,
      outputTokens: 7,
    })

    expect(text).toContain("Prompt cache:")
    expect(text).toContain("89% reuse hit")
    expect(text).toContain("80% effective")
    expect(text).toContain("10% write")
    expect(text).toContain("fresh 10")
    expect(text).toContain("read 80")
    expect(text).toContain("write 10")
    expect(text).toContain("Cache diagnosis: partial")
    expect(text).toContain("Output tokens:   7")
  })

  it("marks 90%+ reuse hits as healthy", () => {
    const text = buildStatusText(makeConfig(), "/repo", 100, {
      inputTokens: 5,
      cacheReadInputTokens: 95,
      cacheCreationInputTokens: 0,
      outputTokens: 7,
    })

    expect(text).toContain("95% reuse hit")
    expect(text).toContain("Cache diagnosis: healthy")
  })

  it("renders recent prompt cache trend from usage history", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 10,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      undefined,
      [],
      [
        {
          inputTokens: 20,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 0,
          outputTokens: 5,
        },
        {
          inputTokens: 10,
          cacheReadInputTokens: 90,
          cacheCreationInputTokens: 0,
          outputTokens: 7,
        },
      ],
    )

    expect(text).toContain("Cache trend:")
    expect(text).toContain("85% avg reuse over 2 calls")
    expect(text).toContain("85% effective")
    expect(text).toContain("0% write")
    expect(text).toContain("1/2 at ≥90%")
    expect(text).toContain("0/2 wrote cache")
    expect(text).toContain("fresh 30")
    expect(text).toContain("read 170")
    expect(text).toContain("write 0")
  })

  it("does not mix prompt cache trends across provider/model scopes", () => {
    const currentScope = { providerId: "p1", model: "m1" }
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 10,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
        cacheScope: currentScope,
      },
      undefined,
      [],
      [
        {
          inputTokens: 90,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 0,
          outputTokens: 5,
          cacheScope: { providerId: "p1", model: "old-model" },
        },
        {
          inputTokens: 20,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 0,
          outputTokens: 5,
          cacheScope: currentScope,
        },
      ],
    )

    expect(text).toContain("85% avg reuse over 2 calls")
    expect(text).not.toContain("60% avg reuse over 3 calls")
  })

  it("does not present a previous model's cache sample as current", () => {
    const text = buildStatusText(makeConfig(), "/repo", 100, {
      inputTokens: 5,
      cacheReadInputTokens: 95,
      cacheCreationInputTokens: 0,
      outputTokens: 7,
      cacheScope: { providerId: "p1", model: "old-model" },
    })

    expect(text).toContain("Prompt cache:    no sample for current provider/model")
    expect(text).not.toContain("95% reuse hit")
    expect(text).not.toContain("Output tokens:   7")
  })

  it("surfaces cache-write churn in the prompt cache trend", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 10,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 10,
        outputTokens: 7,
      },
      undefined,
      [],
      [
        {
          inputTokens: 20,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 20,
          outputTokens: 5,
        },
      ],
    )

    expect(text).toContain("Cache trend:")
    expect(text).toContain("84% avg reuse over 2 calls")
    expect(text).toContain("73% effective")
    expect(text).toContain("14% write")
    expect(text).toContain("0/2 at ≥90%")
    expect(text).toContain("2/2 wrote cache")
    expect(text).toContain("fresh 30")
    expect(text).toContain("read 160")
    expect(text).toContain("write 30")
  })

  it("includes the current usage sample in prompt cache trend when history lags", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 10,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      undefined,
      [],
      [
        {
          inputTokens: 20,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 0,
          outputTokens: 5,
        },
      ],
    )

    expect(text).toContain("Cache trend:")
    expect(text).toContain("85% avg reuse over 2 calls")
    expect(text).toContain("1/2 at ≥90%")
    expect(text).toContain("fresh 30")
    expect(text).toContain("read 170")
  })

  it("does not duplicate the current usage sample when history already contains it", () => {
    const current = {
      inputTokens: 10,
      cacheReadInputTokens: 90,
      cacheCreationInputTokens: 0,
      outputTokens: 7,
    }
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      current,
      undefined,
      [],
      [
        {
          inputTokens: 20,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 0,
          outputTokens: 5,
        },
        current,
      ],
    )

    expect(text).toContain("85% avg reuse over 2 calls")
    expect(text).toContain("1/2 at ≥90%")
    expect(text).not.toContain("over 3 calls")
  })

  it("filters provider-synthesized usage out of prompt cache trend", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 10,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      undefined,
      [],
      [
        {
          inputTokens: 1000,
          outputTokens: 0,
          providerUsageReported: false,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        {
          inputTokens: 20,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 0,
          outputTokens: 5,
        },
        {
          inputTokens: 10,
          cacheReadInputTokens: 90,
          cacheCreationInputTokens: 0,
          outputTokens: 7,
        },
      ],
    )

    expect(text).toContain("85% avg reuse over 2 calls")
    expect(text).toContain("1/2 at ≥90%")
    expect(text).not.toContain("over 3 calls")
  })

  it("filters invalid cache accounting out of prompt cache trend", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 10,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      undefined,
      [],
      [
        {
          inputTokens: 999,
          cacheReadInputTokens: Number.NaN,
          cacheCreationInputTokens: Number.NEGATIVE_INFINITY,
          outputTokens: 5,
        },
        {
          inputTokens: 20,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 0,
          outputTokens: 5,
        },
      ],
    )

    expect(text).toContain("85% avg reuse over 2 calls")
    expect(text).toContain("1/2 at ≥90%")
    expect(text).toContain("fresh 30")
    expect(text).toContain("read 170")
    expect(text).not.toContain("fresh 1029")
    expect(text).not.toContain("over 3 calls")
  })

  it("filters zero-prompt cache accounting out of prompt cache trend", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 10,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      undefined,
      [],
      [
        {
          inputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 12,
        },
        {
          inputTokens: 20,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 0,
          outputTokens: 5,
        },
      ],
    )

    expect(text).toContain("85% avg reuse over 2 calls")
    expect(text).toContain("1/2 at ≥90%")
    expect(text).toContain("fresh 30")
    expect(text).toContain("read 170")
    expect(text).not.toContain("over 3 calls")
  })

  it("does not show prompt cache trend from zero-prompt cache samples alone", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 10,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      undefined,
      [],
      [
        {
          inputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 12,
        },
      ],
    )

    expect(text).toContain("Prompt cache:")
    expect(text).not.toContain("Cache trend:")
  })

  it("omits prompt cache trend until at least two real cache samples exist", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 10,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      undefined,
      [],
      [
        {
          inputTokens: 10,
          cacheReadInputTokens: 90,
          cacheCreationInputTokens: 0,
          outputTokens: 7,
        },
      ],
    )

    expect(text).not.toContain("Cache trend:")
  })

  it("explains high cache writes as warm-up or prompt churn", () => {
    const text = buildStatusText(makeConfig(), "/repo", 100, {
      inputTokens: 10,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 60,
      outputTokens: 7,
    })

    expect(text).toContain("Prompt cache:")
    expect(text).toContain("Cache diagnosis:")
    expect(text).toContain("warming or prompt churn")
    expect(text).toContain("high cache-write share")
    expect(text).toContain("Cache cause:")
    expect(text).toContain("high cache writes")
  })

  it("explains low reuse hits as unstable reusable prefix", () => {
    const text = buildStatusText(makeConfig(), "/repo", 100, {
      inputTokens: 90,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 0,
      outputTokens: 7,
    })

    expect(text).toContain("10% reuse hit")
    expect(text).toContain("Cache diagnosis: low")
    expect(text).toContain("stable prefix is not being reused")
  })

  it("points low cache reuse at recently changed transient context segments", () => {
    const first = makeContext("ctx_a", 925, [
      ["memory_index", "mem_a", 900],
      ["active_plan", "todo_a", 25],
    ])
    const second = makeContext("ctx_b", 1080, [
      ["memory_index", "mem_a", 900],
      ["active_plan", "todo_b", 180],
    ])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
    )

    expect(text).toContain("20% reuse hit")
    expect(text).toContain("Cache cause:")
    expect(text).toContain("recent transient context changed: changed active_plan")
    expect(text).toContain("+155 tok")
    expect(text).toContain("now 180 tok")
  })

  it("reports append-only conversation cache prefix growth", () => {
    const first = withConversationCache(
      makeContext("empty", 0, []),
      ["m1", "m2"],
      200,
      20,
    )
    const second = withConversationCache(
      makeContext("empty", 0, []),
      ["m1", "m2", "m3"],
      300,
      25,
    )
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      second,
      [first, second],
    )

    expect(text).toContain("Conversation:    prefix 300 tok / 3 msg")
    expect(text).toContain("fresh tail 25 tok / 1 msg")
    expect(text).toContain("Prefix trend:    append-only across last 2 snapshots")
    expect(text).not.toContain("Context attach:")
  })

  it("attributes low cache reuse to rewritten conversation history", () => {
    const first = withConversationCache(
      makeContext("empty", 0, []),
      ["m1", "m2", "m3"],
      300,
      20,
    )
    const second = withConversationCache(
      makeContext("empty", 0, []),
      ["m1", "changed", "m3", "m4"],
      400,
      20,
    )
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
    )

    expect(text).toContain("Prefix trend:    rewritten from message 2")
    expect(text).toContain("Cache cause:")
    expect(text).toContain("conversation cache prefix was rewritten from message 2")
    expect(text).toContain("previously-cacheable history bytes changed")
  })

  it("includes stable conversation history in the known cacheable share", () => {
    const context = withConversationCache(
      makeContext("ctx", 100, [["memory_index", "memory", 100]]),
      ["m1", "m2", "m3"],
      920,
      0,
    )
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      context,
      [context],
      [],
      { promptCache: makePromptCache("stable", 100, "dynamic", 10) },
    )

    expect(text).toContain("transient context is 100 tokens")
    expect(text).not.toContain("cacheable static prefix is about")
    expect(text).not.toContain("unaccounted provider tail")
  })

  it("does not hide recent transient context churn when the latest snapshot is stable", () => {
    const first = makeContext("ctx_a", 925, [
      ["memory_index", "mem_a", 900],
      ["active_plan", "todo_a", 25],
    ])
    const second = makeContext("ctx_b", 1080, [
      ["memory_index", "mem_a", 900],
      ["active_plan", "todo_b", 180],
    ])
    const third = makeContext("ctx_b", 1080, [
      ["memory_index", "mem_a", 900],
      ["active_plan", "todo_b", 180],
    ])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      third,
      [first, second, third],
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("recent transient context changed: changed active_plan")
    expect(text).toContain("+155 tok")
    expect(text).toContain("now 180 tok")
    expect(text).toContain("latest context is stable, but this changed 1 sample ago")
    expect(text).not.toContain("transient context text stable at 1.1K tokens")
  })

  it("orders changed transient context segments by token impact in cache causes", () => {
    const first = makeContext("ctx_a", 1200, [
      ["memory_index", "mem_a", 200],
      ["active_plan", "todo_a", 40],
      ["project_files", "files_a", 500],
    ])
    const second = makeContext("ctx_b", 2400, [
      ["memory_index", "mem_b", 1100],
      ["active_plan", "todo_b", 45],
      ["project_files", "files_a", 500],
    ])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
    )

    const memoryIdx = text.indexOf("changed memory_index")
    const planIdx = text.indexOf("changed active_plan")
    expect(memoryIdx).toBeGreaterThan(0)
    expect(planIdx).toBeGreaterThan(memoryIdx)
    expect(text).toContain("changed memory_index (+900 tok, now 1.1K tok)")
    expect(text).toContain("changed active_plan (+5 tok, now 45 tok)")
  })

  it("keeps memory recall query-only churn separate from prompt-byte context churn", () => {
    const first = makeContext("ctx_same", 120, [
      ["memory_working_pack", "pack_same", 120, { queryHash: "queryold111" }],
    ])
    const second = makeContext("ctx_same", 120, [
      ["memory_working_pack", "pack_same", 120, { queryHash: "querynew222" }],
    ])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("transient context text stable at 120 tokens")
    expect(text).toContain("diagnostic metadata changed without prompt-byte changes")
    expect(text).toContain("changed memory_working_pack")
    expect(text).toContain("query queryold111 -> querynew222")
    expect(text).not.toContain("recent transient context changed: changed memory_working_pack")
    expect(text).not.toContain("memory recall query changed; check recent long-paste/continue input")
    expect(text).not.toContain("帮我排查")
  })

  it("does not let high cache writes hide the changed transient context segment", () => {
    const first = makeContext("ctx_a", 200, [["memory_index", "mem_a", 200]])
    const second = makeContext("ctx_b", 900, [["memory_index", "mem_b", 900]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 10,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 60,
        outputTokens: 7,
      },
      second,
      [first, second],
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("recent transient context changed: changed memory_index")
    expect(text).toContain("+700 tok")
    expect(text).toContain("high cache writes indicate new cache blocks")
    expect(text).not.toContain("Cache cause:     high cache writes;")
  })

  it("calls out memory selection churn in cache causes", () => {
    const first = makeContext("ctx_a", 600, [
      ["memory_working_pack", "pack_a", 600, {
        included: ["cache_notes.md", "project_state.md"],
        skipped: { min_score: 1 },
        queryHash: "samequery111",
      }],
    ])
    const second = makeContext("ctx_b", 900, [
      ["memory_working_pack", "pack_b", 900, {
        included: ["long_paste_ui.md", "project_state.md"],
        skipped: { min_score: 3 },
        queryHash: "samequery111",
      }],
    ])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("recent transient context changed: changed memory_working_pack")
    expect(text).toContain("included [cache_notes.md, project_state.md] -> [long_paste_ui.md, project_state.md]")
    expect(text).toContain("skipped min_score 1 -> min_score 3")
    expect(text).toContain("memory selection changed; inspect memory query, MEMORY.md updates, or pinned memories")
    expect(text).not.toContain("memory recall query changed")
  })

  it("calls out global memory selection churn in cache causes", () => {
    const first = makeContext("ctx_a", 160, [
      ["global_memory_working_pack", "pack_a", 160, {
        included: ["reply_style.md"],
        queryHash: "samequery111",
      }],
    ])
    const second = makeContext("ctx_b", 220, [
      ["global_memory_working_pack", "pack_b", 220, {
        included: ["testing_feedback.md"],
        queryHash: "samequery111",
      }],
    ])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("recent transient context changed: changed global_memory_working_pack")
    expect(text).toContain("included [reply_style.md] -> [testing_feedback.md]")
    expect(text).toContain("memory selection changed; inspect memory query, MEMORY.md updates, or pinned memories")
  })

  it("keeps missing prompt boundary visible when another cache cause is stronger", () => {
    const first = makeContext("ctx_a", 900, [["memory_index", "mem_a", 900]])
    const second = makeContext("ctx_b", 1400, [["memory_index", "mem_b", 1400]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
      [],
      {
        promptCache: {
          boundaryPresent: false,
          staticPrefix: {
            chars: 1200,
            estimatedTokens: 300,
            hash: "staticonly12",
          },
        },
      },
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("recent transient context changed: changed memory_index")
    expect(text).toContain("prompt cache boundary missing")
    expect(text).toContain("static hash staticonly12")
  })

  it("keeps prompt shape churn visible when transient context also changed", () => {
    const first = makeContext("ctx_a", 900, [["memory_index", "mem_a", 900]])
    const second = makeContext("ctx_b", 1400, [["memory_index", "mem_b", 1400]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
      [
        {
          inputTokens: 80,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 0,
          promptCacheDiagnostics: makePromptCache("oldstatic", 10000, "dynsame", 100),
        },
      ],
      {
        promptCache: makePromptCache("newstatic", 10000, "dynsame", 100),
      },
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("recent transient context changed: changed memory_index")
    expect(text).toContain("recent prompt shape changed")
    expect(text).toContain("static prefix changed")
    expect(text).toContain("10.0K -> 10.0K tok")
  })

  it("points stable transient context low reuse at cacheable prompt and tool state", () => {
    const first = makeContext("ctx_same", 1200, [["memory_index", "mem_a"]])
    const second = makeContext("ctx_same", 1200, [["memory_index", "mem_a"]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
      [],
      {
        toolSchema: {
          count: 2,
          hash: "toolhash1234",
          names: ["bash", "read_file"],
        },
        promptCache: {
          boundaryPresent: true,
          staticPrefix: {
            chars: 40000,
            estimatedTokens: 10000,
            hash: "promptstatic",
          },
          dynamicSuffix: {
            chars: 600,
            estimatedTokens: 150,
            hash: "promptdyn123",
          },
        },
      },
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("transient context text stable at 1.2K tokens")
    expect(text).toContain("cacheable static prefix is about 88% of known prompt/context tokens")
    expect(text).toContain("static 10.0K of 11.3K")
    expect(text).toContain("non-cacheable dynamic memory/todo context can cap observed hit rate below 90%")
    expect(text).toContain("prompt static hash promptstatic")
    expect(text).toContain("dynamic hash promptdyn123")
    expect(text).toContain("inspect cacheable system prompt")
    expect(text).toContain("tool definitions")
    expect(text).toContain("tool schema hash toolhash1234")
    expect(text).not.toContain("memory/todo context can lower total cache share")
  })

  it("does not double-count a relocated runtime environment in cacheable share hints", () => {
    const context = makeContext("ctx_same", 1100, [
      ["runtime_environment", "env_hash", 100],
      ["memory_index", "mem_hash", 1000],
    ])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      context,
      [context],
      [],
      {
        promptCache: makePromptCache("promptstatic", 10_000, "promptdyn123", 100),
      },
    )

    expect(text).not.toContain("cacheable static prefix is about 89%")
    expect(text).not.toContain("cap observed hit rate below 90%")
  })

  it("does not let cacheable share hints over-explain very low reuse", () => {
    const current = makeContext("ctx_same", 1200, [["memory_index", "mem_a", 1200]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      current,
      [current],
      [],
      {
        promptCache: makePromptCache("promptstatic", 10_000, "promptdyn123", 150),
      },
    )

    expect(text).toContain("cacheable static prefix is about 88% of known prompt/context tokens")
    expect(text).toContain("observed reuse 20% is below that known cacheable share")
    expect(text).toContain("dynamic context alone does not explain the miss")
  })

  it("counts prompt-cache tool schema size as part of the cacheable prefix share", () => {
    const first = makeContext("ctx_same", 2000, [["memory_index", "mem_a", 2000]])
    const second = makeContext("ctx_same", 2000, [["memory_index", "mem_a", 2000]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
      [],
      {
        promptCache: makePromptCache("promptstatic", 10_000, "promptdyn123", 400, {
          count: 2,
          chars: 2400,
          estimatedTokens: 600,
          hash: "toolswithsize",
          names: ["bash", "read_file"],
        }),
      },
    )

    expect(text).toContain("cacheable static+tool prefix is about 82% of known prompt/context tokens")
    expect(text).toContain("static 10.0K + tools 600 of 13.0K")
    expect(text).toContain("dynamic/context 2.4K")
    expect(text).toContain("non-cacheable dynamic memory/todo context can cap observed hit rate below 90%")
  })

  it("does not treat stable prompt-cache tool schemas as a cache-hit cap", () => {
    const first = makeContext("ctx_same", 500, [["memory_index", "mem_a", 500]])
    const second = makeContext("ctx_same", 500, [["memory_index", "mem_a", 500]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
      [],
      {
        promptCache: makePromptCache("promptstatic", 10_000, "promptdyn123", 100, {
          count: 2,
          chars: 2400,
          estimatedTokens: 600,
          hash: "toolswithsize",
          names: ["bash", "read_file"],
        }),
      },
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("transient context text stable at 500 tokens")
    expect(text).not.toContain("cacheable static prefix is about")
    expect(text).not.toContain("cacheable static+tool prefix is about")
    expect(text).not.toContain("cap observed hit rate below 90%")
  })

  it("accounts for provider-observed prompt tail outside local cache diagnostics", () => {
    const first = makeContext("ctx_same", 300, [["memory_index", "mem_a", 300]])
    const second = makeContext("ctx_same", 300, [["memory_index", "mem_a", 300]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 5000,
        cacheReadInputTokens: 10000,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
      [],
      {
        promptCache: makePromptCache("promptstatic", 10_000, "promptdyn123", 100),
      },
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("transient context text stable at 300 tokens")
    expect(text).toContain("cacheable static prefix is about 67% of provider-observed reusable prompt tokens")
    expect(text).toContain("static 10.0K of 15.0K")
    expect(text).toContain("dynamic/context 400")
    expect(text).toContain("unaccounted provider tail 4.6K")
    expect(text).toContain("provider reported 4.6K additional prompt tokens outside static/tools/conversation/dynamic context diagnostics")
    expect(text).toContain("likely current user input or uncached conversation tail")
    expect(text).not.toContain("known prompt/context tokens")
  })

  it("uses current tool schema diagnostics as the cacheable share fallback", () => {
    const first = makeContext("ctx_same", 1100, [["memory_index", "mem_a", 1100]])
    const second = makeContext("ctx_same", 1100, [["memory_index", "mem_a", 1100]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
      [],
      {
        toolSchema: {
          count: 2,
          chars: 4800,
          estimatedTokens: 1200,
          hash: "registrytools",
          names: ["bash", "read_file"],
        },
        promptCache: makePromptCache("promptstatic", 10_000, "promptdyn123", 100),
      },
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("transient context text stable at 1.1K tokens")
    expect(text).toContain("tool schema hash registrytools")
    expect(text).toContain("Tool schemas:    2 tools · 1.2K tok · 4.8K chars · hash registrytools")
    expect(text).not.toContain("cacheable static prefix is about 88%")
    expect(text).not.toContain("cacheable static+tool prefix is about")
    expect(text).not.toContain("cap observed hit rate below 90%")
  })

  it("omits cacheable prefix share hint when known cacheable share is above the 90% target", () => {
    const first = makeContext("ctx_same", 500, [["memory_index", "mem_a", 500]])
    const second = makeContext("ctx_same", 500, [["memory_index", "mem_a", 500]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
      [],
      {
        promptCache: {
          boundaryPresent: true,
          staticPrefix: {
            chars: 40000,
            estimatedTokens: 10000,
            hash: "promptstatic",
          },
          dynamicSuffix: {
            chars: 400,
            estimatedTokens: 100,
            hash: "promptdyn123",
          },
        },
      },
    )

    expect(text).toContain("transient context text stable at 500 tokens")
    expect(text).not.toContain("cacheable static prefix is about")
    expect(text).not.toContain("cap observed hit rate below 90%")
  })

  it("prefers effective prompt-cache tool schemas over the current registry in cache causes", () => {
    const first = makeContext("ctx_same", 1200, [["memory_index", "mem_a"]])
    const second = makeContext("ctx_same", 1200, [["memory_index", "mem_a"]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
      [],
      {
        toolSchema: {
          count: 1,
          hash: "basetools111",
          names: ["read_file"],
        },
        promptCache: makePromptCache("promptstatic", 10_000, "promptdyn123", 150, {
          count: 2,
          chars: 3200,
          estimatedTokens: 800,
          hash: "runtime22222",
          names: ["agent", "read_file"],
        }),
      },
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("tool schema hash runtime22222")
    expect(text).toContain("Tool schemas:    2 tools · 800 tok · 3.2K chars · hash runtime22222")
    expect(text).not.toContain("tool schema hash basetools111")
    expect(text).not.toContain("Tool schemas:    1 tools · hash basetools111")
  })

  it("points low cache reuse at recent prompt shape churn when transient context is stable", () => {
    const first = makeContext("ctx_same", 1200, [["memory_index", "mem_a"]])
    const second = makeContext("ctx_same", 1200, [["memory_index", "mem_a"]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
      [
        {
          inputTokens: 80,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 0,
          outputTokens: 7,
          promptCacheDiagnostics: makePromptCache("static_a", 10_000, "dynamic_a", 150),
        },
        {
          inputTokens: 80,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 0,
          outputTokens: 7,
          promptCacheDiagnostics: makePromptCache("static_b", 10_300, "dynamic_b", 120),
        },
      ],
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("recent prompt shape changed:")
    expect(text).toContain("static prefix changed (10.0K -> 10.3K tok, +300 tok)")
    expect(text).toContain("dynamic suffix changed (150 -> 120 tok, -30 tok)")
    expect(text).toContain("provider cache sees different prompt bytes")
    expect(text).not.toContain("transient context stable at")
  })

  it("does not hide recent prompt shape churn when the latest diagnostics are stable", () => {
    const first = makeContext("ctx_same", 1200, [["memory_index", "mem_a"]])
    const second = makeContext("ctx_same", 1200, [["memory_index", "mem_a"]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      second,
      [first, second],
      [
        {
          inputTokens: 80,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 0,
          outputTokens: 7,
          promptCacheDiagnostics: makePromptCache("static_a", 10_000, "dynamic_same", 150),
        },
        {
          inputTokens: 80,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 0,
          outputTokens: 7,
          promptCacheDiagnostics: makePromptCache("static_b", 10_300, "dynamic_same", 150),
        },
        {
          inputTokens: 80,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 0,
          outputTokens: 7,
          promptCacheDiagnostics: makePromptCache("static_b", 10_300, "dynamic_same", 150),
        },
      ],
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("recent prompt shape changed:")
    expect(text).toContain("static prefix changed (10.0K -> 10.3K tok, +300 tok)")
    expect(text).toContain("latest prompt shape is stable, but this changed 1 sample ago")
    expect(text).toContain("provider cache sees different prompt bytes")
    expect(text).not.toContain("transient context text stable at 1.2K tokens")
  })

  it("uses current prompt cache diagnostics as cache-cause evidence when usage history lags", () => {
    const previous = makePromptCache("static_same", 10_000, "dynamic_a", 150)
    const current = makePromptCache("static_same", 10_000, "dynamic_b", 180)
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      undefined,
      [],
      [
        {
          inputTokens: 80,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 0,
          outputTokens: 7,
          promptCacheDiagnostics: previous,
        },
      ],
      { promptCache: current },
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("recent dynamic suffix changed:")
    expect(text).toContain("dynamic suffix changed (150 -> 180 tok, +30 tok)")
    expect(text).toContain("cacheable static prefix/tool schemas stayed stable")
    expect(text).toContain("provider cache warm-up/settings")
    expect(text).not.toContain("provider cache sees different prompt bytes")
  })

  it("points low cache reuse at prompt boundary count churn", () => {
    const previous = makePromptCache("static_same", 10_000, "dynamic_same", 150, undefined, 1)
    const current = makePromptCache("static_same", 10_000, "dynamic_same", 150, undefined, 2)
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      undefined,
      [],
      [
        {
          inputTokens: 80,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 0,
          outputTokens: 7,
          promptCacheDiagnostics: previous,
        },
      ],
      { promptCache: current },
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("recent prompt shape changed:")
    expect(text).toContain("boundary count 1 -> 2")
    expect(text).toContain("provider cache sees different prompt bytes")
  })

  it("points low cache reuse at tool schema churn from prompt cache history", () => {
    const previous = makePromptCache("static_same", 10_000, "dynamic_same", 150, {
      count: 4,
      hash: "toolsbefore1",
      names: ["bash", "read_file", "write_file", "edit_file"],
    })
    const current = makePromptCache("static_same", 10_000, "dynamic_same", 150, {
      count: 5,
      hash: "toolsafter22",
      names: ["bash", "read_file", "write_file", "edit_file", "agent"],
    })
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 85,
        cacheReadInputTokens: 15,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      undefined,
      [],
      [
        {
          inputTokens: 85,
          cacheReadInputTokens: 15,
          cacheCreationInputTokens: 0,
          outputTokens: 7,
          promptCacheDiagnostics: previous,
        },
      ],
      { promptCache: current },
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("tool schemas changed (4 -> 5 tools, +1 tool; toolsbefore1 -> toolsafter22; added [agent])")
    expect(text).toContain("provider cache sees different prompt bytes")
  })

  it("names tool schema additions and removals when tool count is unchanged", () => {
    const previous = makePromptCache("static_same", 10_000, "dynamic_same", 150, {
      count: 4,
      hash: "toolsbefore1",
      names: ["bash", "read_file", "write_file", "edit_file"],
    })
    const current = makePromptCache("static_same", 10_000, "dynamic_same", 150, {
      count: 4,
      hash: "toolsafter22",
      names: ["bash", "read_file", "write_file", "agent"],
    })
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 85,
        cacheReadInputTokens: 15,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      undefined,
      [],
      [
        {
          inputTokens: 85,
          cacheReadInputTokens: 15,
          cacheCreationInputTokens: 0,
          outputTokens: 7,
          promptCacheDiagnostics: previous,
        },
      ],
      { promptCache: current },
    )

    expect(text).toContain("tool schemas changed (4 -> 4 tools; toolsbefore1 -> toolsafter22; added [agent], removed [edit_file])")
  })

  it("distinguishes same-name tool schema content churn from tool set churn", () => {
    const previous = makePromptCache("static_same", 10_000, "dynamic_same", 150, {
      count: 3,
      hash: "schemaold111",
      names: ["bash", "read_file", "write_file"],
    })
    const current = makePromptCache("static_same", 10_000, "dynamic_same", 150, {
      count: 3,
      hash: "schemanew222",
      names: ["bash", "read_file", "write_file"],
    })
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 85,
        cacheReadInputTokens: 15,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      undefined,
      [],
      [
        {
          inputTokens: 85,
          cacheReadInputTokens: 15,
          cacheCreationInputTokens: 0,
          outputTokens: 7,
          promptCacheDiagnostics: previous,
        },
      ],
      { promptCache: current },
    )

    expect(text).toContain("tool schemas changed (3 -> 3 tools; schemaold111 -> schemanew222; same tool names; schema content changed)")
  })

  it("renders tool schema diagnostics without exposing schemas", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      {
        toolSchema: {
          count: 5,
          chars: 6400,
          estimatedTokens: 1600,
          hash: "abc123def456",
          names: ["bash", "edit_file", "read_file", "write_file", "agent"],
        },
      },
    )

    expect(text).toContain("Tool schemas:")
    expect(text).toContain("5 tools")
    expect(text).toContain("1.6K tok")
    expect(text).toContain("6.4K chars")
    expect(text).toContain("hash abc123def456")
    expect(text).toContain("[bash, edit_file, read_file, +2 more]")
    expect(text).not.toContain("properties")
    expect(text).not.toContain("input_schema")
  })

  it("renders prompt cache shape diagnostics without exposing prompt text", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      {
        promptCache: {
          boundaryPresent: true,
          staticPrefix: {
            chars: 43210,
            estimatedTokens: 10802,
            hash: "staticabc123",
          },
          dynamicSuffix: {
            chars: 800,
            estimatedTokens: 200,
            hash: "dynamicxyz9",
          },
          toolSchemas: {
            count: 5,
            chars: 8400,
            estimatedTokens: 2100,
            hash: "toolsabc1234",
            names: ["bash", "edit_file", "read_file", "write_file", "agent"],
          },
        },
      },
    )

    expect(text).toContain("Prompt shape:")
    expect(text).toContain("static 10.8K tok")
    expect(text).toContain("43.2K chars")
    expect(text).toContain("staticabc123")
    expect(text).toContain("dynamic 200 tok")
    expect(text).toContain("dynamicxyz9")
    expect(text).toContain("tools 5 · 2.1K tok · 8.4K chars · toolsabc1234")
    expect(text).toContain("[bash, edit_file, read_file, +2 more]")
    expect(text).not.toContain("base rules")
    expect(text).not.toContain("Today: 2026-07-01")
  })

  it("flags missing prompt boundary in prompt cache diagnostics", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      {
        promptCache: {
          boundaryPresent: false,
          staticPrefix: {
            chars: 1200,
            estimatedTokens: 300,
            hash: "staticonly12",
          },
        },
      },
    )

    expect(text).toContain("Prompt shape:")
    expect(text).toContain("dynamic none")
    expect(text).toContain("no boundary")
  })

  it("flags duplicate prompt boundaries in prompt cache diagnostics", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      {
        promptCache: {
          boundaryPresent: true,
          boundaryCount: 2,
          staticPrefix: {
            chars: 1200,
            estimatedTokens: 300,
            hash: "staticdupe1",
          },
          dynamicSuffix: {
            chars: 400,
            estimatedTokens: 100,
            hash: "dynamicdupe",
          },
        },
      },
    )

    expect(text).toContain("Prompt shape:")
    expect(text).toContain("2 boundaries")
  })

  it("points low cache reuse at a missing prompt cache boundary", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      undefined,
      [],
      [],
      {
        promptCache: {
          boundaryPresent: false,
          staticPrefix: {
            chars: 1200,
            estimatedTokens: 300,
            hash: "staticonly12",
          },
        },
      },
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("prompt cache boundary missing")
    expect(text).toContain("static hash staticonly12")
    expect(text).not.toContain("no transient context churn recorded")
  })

  it("points low cache reuse at duplicate prompt cache boundaries", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      undefined,
      [],
      [],
      {
        promptCache: {
          boundaryPresent: true,
          boundaryCount: 2,
          staticPrefix: {
            chars: 1200,
            estimatedTokens: 300,
            hash: "staticdupe1",
          },
          dynamicSuffix: {
            chars: 400,
            estimatedTokens: 100,
            hash: "dynamicdupe",
          },
        },
      },
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("multiple prompt cache boundaries (2)")
    expect(text).toContain("only the first split is cacheable")
    expect(text).not.toContain("no transient context churn recorded")
  })

  it("uses the current context as cache-cause evidence when history has not caught up", () => {
    const current = makeContext("ctx_current", 1800, [["memory_index", "mem_current", 1800]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 7,
      },
      current,
      [],
    )

    expect(text).toContain("Cache cause:")
    expect(text).toContain("transient context is 1.8K tokens")
    expect(text).not.toContain("no transient context churn recorded")
  })

  it("compares stale context history against the current context for churn", () => {
    const previous = makeContext("ctx_previous", 900, [["memory_index", "mem_a", 900]])
    const current = makeContext("ctx_current", 1400, [["memory_index", "mem_b", 1400]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      current,
      [previous],
    )

    expect(text).toContain("Context churn:")
    expect(text).toContain("2 unique hashes in last 2 snapshots")
    expect(text).toContain("token delta +500")
    expect(text).toContain("changed memory_index")
  })

  it("renders transient context attachment diagnostics with segment hashes", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      {
        totalChars: 12345,
        estimatedTokens: 2345,
        hash: "ctxabc123456",
        segments: [
          {
            name: "memory_index",
            chars: 2000,
            estimatedTokens: 500,
            hash: "memhash123456",
            meta: {
              included: ["a.md", "b.md"],
              excerpted: ["b.md"],
              skipped: { budget: 2, min_score: 1 },
              selected: [
                {
                  filename: "a.md",
                  score: 24,
                  relevanceScore: 22,
                  lexicalScore: 10,
                  semanticScore: 1,
                  recencyBoost: 2,
                },
                {
                  filename: "b.md",
                  score: 11.5,
                  relevanceScore: 10,
                  recencyBoost: 1.5,
                  excerpted: true,
                },
              ],
              topSkipped: [
                {
                  filename: "c.md",
                  score: 3,
                  relevanceScore: 3,
                  recencyBoost: 0,
                  skippedReason: "min_score",
                },
              ],
              queryHash: "queryabc1234",
              queryKind: "low_signal",
              queryFallback: true,
              budgetTokens: 768,
            },
          },
          {
            name: "active_plan",
            chars: 300,
            estimatedTokens: 80,
            hash: "todohash1234",
            meta: { todoCount: 3, inProgressCount: 1 },
          },
        ],
      },
    )

    expect(text).toContain("Context attach:")
    expect(text).toContain("2.3K tokens")
    expect(text).toContain("12.3K chars")
    expect(text).toContain("hash ctxabc123456")
    expect(text).toContain("memory_index: 500 tok")
    expect(text).toContain("memhash123456")
    expect(text).toContain("included 2")
    expect(text).toContain("[a.md, b.md]")
    expect(text).toContain("excerpted 1 [b.md]")
    expect(text).toContain("skipped budget 2, min_score 1")
    expect(text).toContain("selected [a.md s24 r22 l10 sem1, b.md s11.5 r10 excerpt]")
    expect(text).toContain("top_skipped [c.md min_score s3 r3]")
    expect(text).toContain("query queryabc1234 (low_signal+fallback)")
    expect(text).toContain("budget 768 tok")
    expect(text).toContain("active_plan: 80 tok")
    expect(text).toContain("todos 3")
    expect(text).toContain("in_progress 1")
  })

  it("caps long memory include lists in context segment diagnostics", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      {
        totalChars: 1234,
        estimatedTokens: 300,
        hash: "ctxhash",
        segments: [
          {
            name: "memory_working_pack",
            chars: 1000,
            estimatedTokens: 250,
            hash: "packhash",
            meta: {
              included: ["a.md", "b.md", "c.md", "d.md", "e.md"],
              excerpted: ["a.md", "b.md", "c.md", "d.md", "e.md"],
              skipped: { max_records: 2 },
            },
          },
        ],
      },
    )

    expect(text).toContain("included 5 [a.md, b.md, c.md, +2 more]")
    expect(text).toContain("excerpted 5 [a.md, b.md, c.md, +2 more]")
    expect(text).toContain("skipped max_records 2")
    expect(text).not.toContain("d.md")
  })

  it("caps rendered context segments in the status panel", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      {
        totalChars: 600,
        estimatedTokens: 120,
        hash: "ctx",
        segments: Array.from({ length: 6 }, (_, i) => ({
          name: `segment_${i}`,
          chars: 100,
          estimatedTokens: 20,
          hash: `hash_${i}`,
        })),
      },
    )

    expect(text).toContain("segment_0")
    expect(text).toContain("segment_3")
    expect(text).not.toContain("segment_4")
    expect(text).toContain("... 2 more context segments")
  })

  it("summarizes recent context churn across snapshots", () => {
    const first = makeContext("ctx_a", 120, [
      ["memory_index", "mem_a"],
      ["active_plan", "todo_a"],
    ])
    const second = makeContext("ctx_b", 180, [
      ["memory_index", "mem_a"],
      ["active_plan", "todo_b"],
    ])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      second,
      [first, second],
    )

    expect(text).toContain("Context churn:")
    expect(text).toContain("2 unique hashes in last 2 snapshots")
    expect(text).toContain("token delta +60")
    expect(text).toContain("changed active_plan")
    expect(text).not.toContain("changed changed active_plan")
    expect(text).not.toContain("changed memory_index")
  })

  it("shows segment hash churn when tokens and metadata stay unchanged", () => {
    const first = makeContext("ctx_a", 120, [
      ["memory_index", "mem_old", 120],
    ])
    const second = makeContext("ctx_b", 120, [
      ["memory_index", "mem_new", 120],
    ])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      second,
      [first, second],
    )

    expect(text).toContain("Context churn:")
    expect(text).toContain("token delta 0")
    expect(text).toContain("changed memory_index")
    expect(text).toContain("now 120 tok")
    expect(text).toContain("hash mem_old -> mem_new")
  })

  it("explains the latest changed context segment when the newest pair is stable", () => {
    const first = makeContext("ctx_a", 925, [
      ["memory_index", "mem_a", 900],
      ["active_plan", "todo_a", 25],
    ])
    const second = makeContext("ctx_b", 1080, [
      ["memory_index", "mem_a", 900],
      ["active_plan", "todo_b", 180],
    ])
    const third = makeContext("ctx_b", 1080, [
      ["memory_index", "mem_a", 900],
      ["active_plan", "todo_b", 180],
    ])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      third,
      [first, second, third],
    )

    expect(text).toContain("Context churn:")
    expect(text).toContain("2 unique hashes in last 3 snapshots")
    expect(text).toContain("token delta 0")
    expect(text).toContain("latest changed 1 sample ago: changed active_plan (+155 tok, now 180 tok)")
    expect(text).not.toContain("changed memory_index")
  })

  it("includes memory include and skip changes in context churn diagnostics", () => {
    const first = makeContext("ctx_a", 120, [
      [
        "memory_working_pack",
        "pack_a",
        80,
        {
          included: ["old_compact.md", "old_rules.md"],
          excerpted: ["old_compact.md"],
          skipped: { budget: 1 },
          budgetTokens: 2048,
        },
      ],
    ])
    const second = makeContext("ctx_b", 150, [
      [
        "memory_working_pack",
        "pack_b",
        110,
        {
          included: ["new_compact.md", "new_rules.md"],
          excerpted: ["new_compact.md", "new_rules.md"],
          skipped: { min_score: 2 },
          budgetTokens: 1024,
        },
      ],
    ])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      second,
      [first, second],
    )

    expect(text).toContain("changed memory_working_pack")
    expect(text).toContain("included [old_compact.md, old_rules.md] -> [new_compact.md, new_rules.md]")
    expect(text).toContain("excerpted [old_compact.md] -> [new_compact.md, new_rules.md]")
    expect(text).toContain("skipped budget 1 -> min_score 2")
    expect(text).toContain("budget 2.0K -> 1.0K")
  })

  it("marks repeated context snapshots as stable", () => {
    const first = makeContext("ctx_same", 120, [["memory_index", "mem_a"]])
    const second = makeContext("ctx_same", 120, [["memory_index", "mem_a"]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      second,
      [first, second],
    )

    expect(text).toContain("Context churn:   stable across last 2 snapshots")
    expect(text).toContain("token delta 0")
  })

  it("keeps current context history when only segment metadata changes", () => {
    const first = makeContext("ctx_same", 120, [
      ["memory_index", "mem_a", 120, { budgetTokens: 2048 }],
    ])
    const second = makeContext("ctx_same", 120, [
      ["memory_index", "mem_a", 120, { budgetTokens: 1024 }],
    ])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      second,
      [first],
    )

    expect(text).toContain("Context churn:")
    expect(text).toContain("1 unique text hash in last 2 snapshots")
    expect(text).toContain("changed memory_index")
    expect(text).toContain("budget 2.0K -> 1.0K")
  })

  it("shows memory query hash churn without exposing the query text", () => {
    const first = makeContext("ctx_same", 120, [
      ["memory_working_pack", "pack_same", 120, { queryHash: "queryold111" }],
    ])
    const second = makeContext("ctx_same", 120, [
      ["memory_working_pack", "pack_same", 120, { queryHash: "querynew222" }],
    ])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      second,
      [first],
    )

    expect(text).toContain("changed memory_working_pack")
    expect(text).toContain("query queryold111 -> querynew222")
    expect(text).toContain("query querynew222")
    expect(text).not.toContain("帮我排查")
  })

  it("labels added and removed context segments in churn diagnostics", () => {
    const first = makeContext("ctx_a", 120, [
      ["memory_index", "mem_a"],
      ["active_plan", "todo_a"],
    ])
    const second = makeContext("ctx_b", 180, [
      ["memory_index", "mem_a"],
      ["project_files", "files_a"],
    ])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      second,
      [first, second],
    )

    expect(text).toContain("added project_files")
    expect(text).toContain("removed active_plan")
    expect(text).not.toContain("changed memory_index")
  })

  it("keeps the negative sign when recent context shrinks", () => {
    const first = makeContext("ctx_a", 240, [["memory_index", "mem_a"]])
    const second = makeContext("ctx_b", 120, [["memory_index", "mem_b"]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      second,
      [first, second],
    )

    expect(text).toContain("token delta -120")
  })

  it("does not show stale context churn when the current run has no context attachment", () => {
    const first = makeContext("ctx_a", 120, [["memory_index", "mem_a"]])
    const second = makeContext("ctx_b", 180, [["memory_index", "mem_b"]])
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [first, second],
    )

    expect(text).not.toContain("Context attach:")
    expect(text).not.toContain("Context churn:")
  })

  it("omits prompt cache details when usage is unavailable", () => {
    const text = buildStatusText(makeConfig(), "/repo", 100)

    expect(text).not.toContain("Prompt cache:")
    expect(text).not.toContain("Output tokens:")
  })

  it("renders memory attachment failures as status diagnostics", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      {
        memoryAttachmentFailure: {
          stage: "working_pack",
          memoryDir: "/tmp/mem",
          queryPresent: true,
          error: "failed\nbecause store is unavailable",
        },
      },
    )

    expect(text).toContain("Memory attach:")
    expect(text).toContain("failed building working pack for current query")
    expect(text).toContain("failed because store is unavailable")
  })

  it("does not split non-BMP characters when truncating status diagnostics", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      {
        memoryAttachmentFailure: {
          stage: "working_pack",
          error: `${"😀".repeat(130)} tail`,
        },
      },
    )

    expect(text).toContain("Memory attach:")
    expect(text).toContain("…")
    expect(hasUnpairedSurrogate(text)).toBe(false)
  })

  it("renders memory operation failures as status diagnostics", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      {
        memoryFailure: {
          operation: "compact_summary",
          error: "permission denied\nwhile writing MEMORY.md",
        },
      },
    )

    expect(text).toContain("Memory:")
    expect(text).toContain("compact summary persistence failed")
    expect(text).toContain("permission denied while writing MEMORY.md")
  })

  it("renders prompt section failures as status diagnostics", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      {
        promptSectionFailure: {
          section: "agents-md",
          dynamic: false,
          error: "read failed\npermission denied",
        },
      },
    )

    expect(text).toContain("Prompt section:")
    expect(text).toContain("static section agents-md failed")
    expect(text).toContain("read failed permission denied")
  })

  it("renders compact failures as status diagnostics", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      {
        compactFailure: {
          phase: "in_loop",
          error: "summary\nmissing required headings",
          consecutiveFailures: 3,
          breakerTripped: true,
        },
      },
    )

    expect(text).toContain("Compact:")
    expect(text).toContain("in-loop auto-compact failed after 3 failed attempts")
    expect(text).toContain("circuit breaker tripped")
    expect(text).toContain("summary missing required headings")
  })

  it("renders manual compact failures as status diagnostics", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      {
        compactFailure: {
          phase: "manual",
          error: "provider unavailable",
        },
      },
    )

    expect(text).toContain("Compact:")
    expect(text).toContain("manual /compact failed")
    expect(text).toContain("provider unavailable")
  })

  it("renders usage persistence failures as status diagnostics", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      {
        usagePersistenceFailure: {
          error: "permission denied\nwriting history.jsonl",
        },
      },
    )

    expect(text).toContain("Usage history:")
    expect(text).toContain("failed saving latest token/cache usage")
    expect(text).toContain("permission denied writing history.jsonl")
  })

  it("renders session persistence backlog and latest failure", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      {
        sessionPersistence: {
          pendingWrites: 2,
          lastFailure: {
            operation: "flush",
            message: "EACCES: permission denied\nappend session",
            path: "/tmp/zap/session.jsonl",
            pendingEntries: 2,
          },
        },
      },
    )

    expect(text).toContain("Persistence:")
    expect(text).toContain("2 pending session writes")
    expect(text).toContain("flush failed at /tmp/zap/session.jsonl")
    expect(text).toContain("EACCES: permission denied append session")
    expect(text).toContain("2 entries buffered at failure")
  })

  it("distinguishes missing provider cache accounting from a real 0% hit rate", () => {
    const text = buildStatusText(makeConfig(), "/repo", 100, {
      inputTokens: 123,
      outputTokens: 7,
    })

    expect(text).toContain("Prompt cache:")
    expect(text).toContain("provider endpoint did not report cache accounting")
    expect(text).toContain("fresh 123")
    expect(text).toContain("Cache diagnosis:")
    expect(text).toContain("cache accounting unavailable")
    expect(text).toContain("cannot verify hit rate from provider usage")
    expect(text).toContain("model/provider prompt-cache support")
    expect(text).not.toContain("0% reuse hit")
    expect(text).toContain("Output tokens:   7")
  })

  it("identifies endpoints that omit cache accounting across repeated calls", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      125,
      { inputTokens: 125, outputTokens: 7 },
      undefined,
      [],
      [
        { inputTokens: 123, outputTokens: 5 },
        { inputTokens: 124, outputTokens: 6 },
      ],
    )

    expect(text).toContain("provider endpoint did not report cache accounting across 3 recent calls")
    expect(text).toContain("cannot verify hit rate")
    expect(text).not.toContain("0% reuse hit")
  })

  it("surfaces intermittent cache accounting instead of treating the latest omission as unsupported", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      110,
      { inputTokens: 110, outputTokens: 7 },
      undefined,
      [],
      [
        {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 90,
          cacheCreationInputTokens: 0,
        },
      ],
    )

    expect(text).toContain("did not report cache accounting on the latest call")
    expect(text).toContain("reported on 1/2 recent calls")
  })

  it("shows partial reporting coverage when the latest call includes cache accounting", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      {
        inputTokens: 10,
        outputTokens: 7,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 0,
      },
      undefined,
      [],
      [{ inputTokens: 100, outputTokens: 5 }],
    )

    expect(text).toContain("Cache reports:   1/2 recent calls exposed cache accounting")
    expect(text).toContain("90% reuse hit")
  })

  it("distinguishes missing provider usage from provider-reported zero usage", () => {
    const missing = buildStatusText(makeConfig(), "/repo", 100, {
      inputTokens: 0,
      outputTokens: 0,
      providerUsageReported: false,
    })
    const zero = buildStatusText(makeConfig(), "/repo", 100, {
      inputTokens: 0,
      outputTokens: 0,
      providerUsageReported: true,
    })

    expect(missing).toContain("usage not reported by provider")
    expect(missing).not.toContain("Cache diagnosis:")
    expect(missing).not.toContain("Output tokens:")
    expect(zero).toContain("provider endpoint did not report cache accounting")
    expect(zero).toContain("cache accounting unavailable")
    expect(zero).toContain("fresh 0")
    expect(zero).toContain("Output tokens:   0")
  })

  it("sanitizes invalid token counts before rendering", () => {
    const text = buildStatusText(makeConfig(), "/repo", Number.NaN, {
      inputTokens: Number.POSITIVE_INFINITY,
      outputTokens: -7,
      cacheReadInputTokens: -80,
      cacheCreationInputTokens: 10,
    })

    expect(text).toContain("100% left (0 / 1.0K)")
    expect(text).toContain("fresh 0")
    expect(text).toContain("read 0")
    expect(text).toContain("write 10")
    expect(text).toContain("Output tokens:   0")
    expect(text).not.toContain("NaN")
    expect(text).not.toContain("Output tokens:   -7")
    expect(text).not.toContain("read -80")
  })

  it("marks context usage as pending when restored usage has not been measured", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      900,
      undefined,
      undefined,
      [],
      [],
      {},
      true,
    )

    expect(text).toContain("Context window:  pending")
    expect(text).toContain("? / 1.0K")
    expect(text).toContain("local estimate 900")
    expect(text).not.toContain("10% left")
    expect(text).not.toContain("(900 / 1.0K)")
  })

  it("detects AGENTS.md in the current non-git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-status-agents-"))
    try {
      writeFileSync(join(dir, "AGENTS.md"), "Use Bun tests.\n")

      const text = buildStatusText(makeConfig(), dir, 100)

      expect(text).toContain("AGENTS.md:       AGENTS.md")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("detects the git-root AGENTS.md when status runs from a subdirectory", () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-status-agents-git-"))
    try {
      execSync("git init", { cwd: dir, stdio: "ignore" })
      writeFileSync(join(dir, "AGENTS.md"), "Use Bun tests.\n")
      const subdir = join(dir, "packages", "cli")
      mkdirSync(subdir, { recursive: true })

      const text = buildStatusText(makeConfig(), subdir, 100)

      expect(text).toContain("AGENTS.md:       ../../AGENTS.md")
      expect(text).not.toContain("AGENTS.md:       (none detected)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("detects AGENTS.md from a .git marker without shelling out to git", () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-status-agents-marker-"))
    try {
      mkdirSync(join(dir, ".git"), { recursive: true })
      writeFileSync(join(dir, "AGENTS.md"), "Use Bun tests.\n")
      const subdir = join(dir, "packages", "cli")
      mkdirSync(subdir, { recursive: true })

      const text = buildStatusText(makeConfig(), subdir, 100)

      expect(text).toContain("AGENTS.md:       ../../AGENTS.md")
      expect(text).not.toContain("AGENTS.md:       (none detected)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("buildStatusText cache/memory audit", () => {
  it("aggregates only runs from the active provider and model", () => {
    const matching = [0, 1].map((index) => buildCacheMemoryAuditEntry({
      timestamp: new Date(Date.UTC(2026, 6, 22, 0, 0, index)).toISOString(),
      cacheScope: { providerId: "p1", model: "m1" },
      usage: {
        inputTokens: 10,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 0,
        outputTokens: 2,
      },
      promptCacheDiagnostics: {
        boundaryPresent: true,
        staticPrefix: { chars: 100, estimatedTokens: 25, hash: "stable-prompt" },
        toolSchemas: { count: 1, hash: "stable-tools", names: ["read_file"] },
      },
      contextDiagnostics: {
        totalChars: 40,
        estimatedTokens: 10,
        hash: `context-${index}`,
        segments: [],
      },
      telemetry: {
        usageSamples: 2,
        cacheAccountingSamples: 1,
        contextSamples: 2,
        contextShapes: index + 1,
        conversationPrefixShapes: 1,
      },
    }))
    const otherModel = buildCacheMemoryAuditEntry({
      cacheScope: { providerId: "p1", model: "m2" },
      usage: {
        inputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 2,
      },
    })

    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      {
        cacheMemoryAudit: {
          path: "/tmp/cache-memory-audit.jsonl",
          entries: [...matching, otherModel],
        },
      },
    )

    expect(text).toContain("Cache audit:     2 runs · reuse 90%")
    expect(text).toContain("cache reports 2/4 usage samples")
    expect(text).toContain("prompt shapes 1 · context shapes 2")
    expect(text).toContain("max in-run shapes context 2, prefix 1")
    expect(text).not.toContain("3 runs")
  })

  it("distinguishes missing provider cache accounting from a zero hit rate", () => {
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      {
        cacheMemoryAudit: {
          path: "/tmp/cache-memory-audit.jsonl",
          entries: [buildCacheMemoryAuditEntry({
            cacheScope: { providerId: "p1", model: "m1" },
            usage: {
              inputTokens: 100,
              providerUsageReported: false,
              outputTokens: 0,
            },
          })],
        },
      },
    )

    expect(text).toContain("1 runs · cache accounting unavailable")
    expect(text).not.toContain("reuse 0%")
  })

  it("reports scoped online memory utility without treating selection as use", () => {
    const entries = [
      buildCacheMemoryAuditEntry({
        cacheScope: { providerId: "p1", model: "m1" },
        usage: { inputTokens: 10, outputTokens: 2 },
        memoryUtility: {
          selected: 2,
          read: 1,
          used: 2,
          revised: 1,
          contradicted: 1,
          avoidedReRead: 1,
          records: [
            {
              scope: "project",
              filename: "used_from_pack.md",
              used: true,
              avoidedReRead: true,
              evidence: ["content_overlap"],
            },
            {
              scope: "project",
              filename: "read_and_replaced.md",
              read: true,
              used: true,
              revised: true,
              contradicted: true,
              evidence: ["explicit_read", "superseded"],
            },
          ],
        },
      }),
      buildCacheMemoryAuditEntry({
        cacheScope: { providerId: "p1", model: "m1" },
        usage: { inputTokens: 10, outputTokens: 2 },
        memoryUtility: {
          selected: 1,
          read: 0,
          used: 0,
          revised: 0,
          contradicted: 0,
          avoidedReRead: 0,
          records: [{ scope: "global", filename: "selected_only.md" }],
        },
      }),
      buildCacheMemoryAuditEntry({
        cacheScope: { providerId: "p1", model: "m2" },
        usage: { inputTokens: 10, outputTokens: 2 },
        memoryUtility: {
          selected: 1,
          read: 0,
          used: 1,
          revised: 0,
          contradicted: 0,
          avoidedReRead: 1,
          records: [{
            scope: "project",
            filename: "other_model.md",
            used: true,
            avoidedReRead: true,
          }],
        },
      }),
    ]

    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      undefined,
      undefined,
      [],
      [],
      { cacheMemoryAudit: { path: "/tmp/cache-memory-audit.jsonl", entries } },
    )

    expect(text).toContain(
      "Memory utility:  2 instrumented runs · selected 3 across 2 runs · used 2/3 (67%)",
    )
    expect(text).toContain("explicit reads 1 · avoided re-reads 1 · revised 1 · contradicted 1")
    expect(text).not.toContain("other_model.md")
  })

  it("attributes missing accounting to the endpoint when cacheable shapes stay stable", () => {
    const entries = [0, 1].map((index) => buildCacheMemoryAuditEntry({
      timestamp: new Date(Date.UTC(2026, 6, 22, 0, 0, index)).toISOString(),
      cacheScope: { providerId: "p1", model: "m1" },
      usage: {
        inputTokens: 100,
        providerUsageReported: true,
        outputTokens: 2,
      },
      promptCacheDiagnostics: {
        boundaryPresent: true,
        staticPrefix: { chars: 100, estimatedTokens: 25, hash: "stable-prompt" },
        toolSchemas: { count: 1, hash: "stable-tools", names: ["read_file"] },
      },
      contextDiagnostics: {
        totalChars: 40,
        estimatedTokens: 10,
        hash: `changing-context-${index}`,
        segments: [],
      },
    }))
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      { inputTokens: 100, providerUsageReported: true, outputTokens: 2 },
      undefined,
      [],
      [],
      {
        cacheMemoryAudit: {
          path: "/tmp/cache-memory-audit.jsonl",
          entries,
        },
      },
    )

    expect(text).toContain("Cache shape:")
    expect(text).toContain("static prompt/tool shape stable across 2 audited runs")
    expect(text).toContain("provider endpoint cache support/accounting remains the unverified layer")
    expect(text).not.toContain("app-side prompt or tool-schema churn")
  })

  it("surfaces cacheable prompt churn even when the endpoint omits accounting", () => {
    const entries = ["prompt-a", "prompt-b"].map((hash, index) => buildCacheMemoryAuditEntry({
      timestamp: new Date(Date.UTC(2026, 6, 22, 0, 0, index)).toISOString(),
      cacheScope: { providerId: "p1", model: "m1" },
      usage: {
        inputTokens: 100,
        providerUsageReported: true,
        outputTokens: 2,
      },
      promptCacheDiagnostics: {
        boundaryPresent: true,
        staticPrefix: { chars: 100, estimatedTokens: 25, hash },
        toolSchemas: { count: 1, hash: "stable-tools", names: ["read_file"] },
      },
    }))
    const text = buildStatusText(
      makeConfig(),
      "/repo",
      100,
      { inputTokens: 100, providerUsageReported: true, outputTokens: 2 },
      undefined,
      [],
      [],
      {
        cacheMemoryAudit: {
          path: "/tmp/cache-memory-audit.jsonl",
          entries,
        },
      },
    )

    expect(text).toContain("2 static prompt/tool shapes across 2 audited runs")
    expect(text).toContain("app-side prompt or tool-schema churn can reduce reuse")
    expect(text).not.toContain("remains the unverified layer")
  })
})

function makeContext(
  hash: string,
  estimatedTokens: number,
  segments: Array<[string, string, number?, Record<string, unknown>?]>,
) {
  return {
    totalChars: estimatedTokens * 4,
    estimatedTokens,
    hash,
    segments: segments.map(([name, segmentHash, segmentTokens, meta]) => ({
      name,
      chars: (segmentTokens ?? 25) * 4,
      estimatedTokens: segmentTokens ?? 25,
      hash: segmentHash,
      ...(meta ? { meta } : {}),
    })),
  }
}

function withConversationCache<T extends ReturnType<typeof makeContext>>(
  context: T,
  messageHashes: string[],
  prefixTokens: number,
  tailTokens: number,
): T & { conversationCache: NonNullable<import("../../zapsdk/agent/events.js").ContextDiagnostics["conversationCache"]> } {
  return {
    ...context,
    conversationCache: {
      prefix: {
        messageCount: messageHashes.length,
        chars: prefixTokens * 4,
        estimatedTokens: prefixTokens,
        hash: `prefix-${messageHashes.join("-")}`,
        messageHashes,
      },
      tail: {
        messageCount: tailTokens > 0 ? 1 : 0,
        chars: tailTokens * 4,
        estimatedTokens: tailTokens,
        hash: `tail-${tailTokens}`,
      },
    },
  }
}

function makePromptCache(
  staticHash: string,
  staticTokens: number,
  dynamicHash?: string,
  dynamicTokens?: number,
  toolSchemas?: {
    count: number
    chars?: number
    estimatedTokens?: number
    hash: string
    names: string[]
  },
  boundaryCount?: number,
) {
  return {
    boundaryPresent: dynamicHash !== undefined,
    ...(boundaryCount !== undefined ? { boundaryCount } : {}),
    staticPrefix: {
      chars: staticTokens * 4,
      estimatedTokens: staticTokens,
      hash: staticHash,
    },
    ...(dynamicHash !== undefined && dynamicTokens !== undefined
      ? {
          dynamicSuffix: {
            chars: dynamicTokens * 4,
            estimatedTokens: dynamicTokens,
            hash: dynamicHash,
          },
        }
      : {}),
    ...(toolSchemas ? { toolSchemas } : {}),
  }
}

function makeConfig(): AppConfig {
  return {
    providers: [
      {
        id: "p1",
        name: "Test",
        baseURL: "https://example.test/v1",
        apiKey: "key",
        contextWindow: 1000,
        models: ["m1"],
      },
    ],
    active: { providerId: "p1", model: "m1" },
    serperKey: "",
    maxTokens: 100,
    maxSteps: 10,
    customSystemPrompt: "",
    compaction: { auto: true, prune: true, reserved: 0 },
    mcpServers: [],
    permissionMode: "default",
  }
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}
