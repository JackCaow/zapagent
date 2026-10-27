import { describe, it, expect } from "bun:test"
import { ConversationManager } from "../../memory/conversation.js"
import { TokenCounter } from "../../context/token-counter.js"
import { buildToolTurn } from "../../core/turn.js"

function structuredSummary(marker = "SUMMARY"): string {
  return [
    "# Primary Request and Intent",
    `- ${marker}`,
    "# All user messages (verbatim)",
    "- user asked to continue",
    "# Current task status",
    "- compacting context",
    "# Files read / modified",
    "- zapsdk/memory/conversation.ts",
    "# Commands run",
    "- bun test",
    "# Key facts discovered",
    "- structured summaries are required",
    "# Decisions made",
    "- reject prose-only summaries",
    "# Errors encountered and their resolution",
    "- none",
    "# Code changes summary",
    "- updated compact handling",
    "# Next steps",
    "- continue",
  ].join("\n")
}

async function conversationWithFailedCompression(): Promise<ConversationManager> {
  const fakeProvider = {
    call: async () => ({ text: "A short prose summary.", toolCalls: [], type: "text" as const }),
  } as any
  const cm = new ConversationManager({ maxMessages: 100, maxTokens: 1_000_000 })
  for (let i = 0; i < 12; i++) {
    cm.add({ role: "user", content: `user message ${i}` })
    cm.add({ role: "assistant", content: `assistant reply ${i}` })
  }
  const failed = await cm.compress(fakeProvider, { force: true, targetTokens: 100 })
  expect(failed).toBeNull()
  expect(cm.lastCompressionFailureReason).toContain("missing required sections")
  return cm
}

describe("ConversationManager limit normalization", () => {
  it("sanitizes invalid constructor token and message limits", () => {
    const cm = new ConversationManager({
      maxMessages: Number.NaN,
      maxTokens: Number.NaN,
      triggerAtTokens: Number.POSITIVE_INFINITY,
      targetTokensAfterCompress: -3,
    })

    expect((cm as any).maxMessages).toBe(100)
    expect((cm as any).maxTokens).toBeUndefined()
    expect((cm as any).triggerAtTokens).toBeUndefined()
    expect((cm as any).targetTokensAfterCompress).toBe(0)

    for (let i = 0; i < 120; i++) {
      cm.add({ role: "user", content: `msg ${i}` })
    }
    expect(cm.getMessages()).toHaveLength(100)
  })

  it("floors fractional limits and clamps negative limits to zero", () => {
    const cm = new ConversationManager({
      maxMessages: 3.9,
      maxTokens: 20.9,
      triggerAtTokens: 10.9,
      targetTokensAfterCompress: 4.9,
    })

    expect((cm as any).maxMessages).toBe(3)
    expect((cm as any).maxTokens).toBe(20)
    expect((cm as any).triggerAtTokens).toBe(10)
    expect((cm as any).targetTokensAfterCompress).toBe(4)

    cm.setMaxTokens(-1)
    cm.setTriggerAtTokens(Number.NaN)
    cm.setTargetTokensAfterCompress(Number.POSITIVE_INFINITY)
    expect((cm as any).maxTokens).toBe(0)
    expect((cm as any).triggerAtTokens).toBeUndefined()
    expect((cm as any).targetTokensAfterCompress).toBeUndefined()
  })

  it("supports token-only history management without a rolling message window", () => {
    const cm = new ConversationManager({
      maxMessages: Number.POSITIVE_INFINITY,
      maxTokens: 1_000_000,
      triggerAtTokens: 800_000,
      autoCompress: true,
    })

    for (let i = 0; i < 140; i++) {
      cm.add({ role: "user", content: `msg ${i}` })
    }

    expect(cm.messageCount).toBe(140)
    expect(cm.getMessages()).toHaveLength(140)
    expect(cm.getAllMessages()[0]?.content).toBe("msg 0")
  })

  it("preserves complete history above the hard token budget for an outer compactor", () => {
    const cm = new ConversationManager({
      maxMessages: Number.POSITIVE_INFINITY,
      maxTokens: 40,
      triggerAtTokens: 20,
      autoCompress: true,
    })

    for (let i = 0; i < 20; i++) {
      cm.add({ role: "user", content: `message ${i} ${"x".repeat(32)}` })
    }

    expect(cm.estimatedTokens).toBeGreaterThan(40)
    expect(cm.getAllMessages()).toHaveLength(20)
    expect(cm.getAllMessages()[0]?.content.startsWith("message 0 ")).toBe(true)
    expect(cm.getMessages().length).toBeLessThan(20)
    expect(cm.getMessages().at(-1)?.content.startsWith("message 19 ")).toBe(true)
  })
})

describe("ConversationManager.mutateInPlace", () => {
  it("exposes a full message view for maintenance when getMessages is truncated", () => {
    const cm = new ConversationManager({
      maxMessages: 3,
      maxTokens: 1_000_000,
      triggerAtTokens: 1,
      autoCompress: true,
    })

    for (let i = 0; i < 10; i++) {
      cm.add({ role: "user", content: `msg ${i}` })
    }

    expect(cm.getMessages().map((m) => m.content)).toEqual(["msg 7", "msg 8", "msg 9"])
    expect(cm.getAllMessages().map((m) => m.content)).toEqual([
      "msg 0",
      "msg 1",
      "msg 2",
      "msg 3",
      "msg 4",
      "msg 5",
      "msg 6",
      "msg 7",
      "msg 8",
      "msg 9",
    ])
  })

  it("preserves backing store even when getMessages returns a truncated view", () => {
    // autoCompress + tiny triggerAtTokens keeps add() in its early-return branch,
    // so the count-based truncate at the bottom of add() is skipped and the
    // backing store can grow past maxMessages — the exact state where the old
    // microcompact path (getMessages + replaceMessages) would silently wipe
    // messages outside the truncated view.
    const cm = new ConversationManager({
      maxMessages: 3,
      maxTokens: 1_000_000,
      triggerAtTokens: 1,
      autoCompress: true,
    })

    for (let i = 0; i < 10; i++) {
      cm.add({ role: "user", content: `msg ${i}` })
    }

    expect(cm.messageCount).toBe(10)
    expect(cm.getMessages().length).toBe(3)

    cm.mutateInPlace((msgs) => {
      msgs[0] = { ...msgs[0], content: "modified" }
    })

    expect(cm.messageCount).toBe(10)
  })

  it("propagates the mutator's return value and recalculates tokens", () => {
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.add({ role: "user", content: "short" })
    const before = cm.estimatedTokens

    const changed = cm.mutateInPlace((msgs) => {
      msgs[0] = { ...msgs[0], content: "a much longer replacement body that should bump token count" }
      return 1
    })

    expect(changed).toBe(1)
    expect(cm.estimatedTokens).toBeGreaterThan(before)
  })
})

describe("ConversationManager estimatedTokens", () => {
  it("counts image content blocks even when maxTokens is not configured", () => {
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.add({
      role: "user",
      content: "see attached image",
      contentBlocks: [
        { type: "text", text: "see attached image" },
        {
          type: "image",
          filePath: "/tmp/screenshot.png",
          mediaType: "image/png",
          source: "clipboard",
          base64: "iVBORw0KGgo=",
        },
      ],
    })

    const expected = new TokenCounter().countMessages(cm.getAllMessages())

    expect(cm.estimatedTokens).toBe(expected)
    expect(cm.estimatedTokens).toBeGreaterThan(700)
  })

  it("counts tool call names and arguments even when maxTokens is not configured", () => {
    const cm = new ConversationManager({ maxMessages: 100 })
    cm.commitTurn(
      buildToolTurn({
        text: "writing",
        completed: [
          {
            id: "t1",
            name: "write_file",
            arguments: {
              path: "large.md",
              content: "x".repeat(2000),
            },
            result: { success: true, output: "ok" },
          },
        ],
      }),
    )

    const expected = new TokenCounter().countMessages(cm.getAllMessages())

    expect(cm.estimatedTokens).toBe(expected)
    expect(cm.estimatedTokens).toBeGreaterThan(500)
  })
})

describe("ConversationManager provider view truncation", () => {
  it("truncates getMessages by token budget even when the message count is below maxMessages", () => {
    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 150 })

    for (let i = 0; i < 6; i++) {
      cm.add({ role: "user", content: `message ${i} ${"x".repeat(180)}` })
    }

    const providerView = cm.getMessages()
    const fullView = cm.getAllMessages()
    const providerTokens = new TokenCounter().countMessages(providerView)

    expect(fullView).toHaveLength(6)
    expect(providerView.length).toBeLessThan(fullView.length)
    expect(providerView.at(-1)?.content).toBe(fullView.at(-1)?.content)
    expect(providerTokens).toBeLessThanOrEqual(150)
  })

  it("keeps the latest complete turn when a single turn exceeds the token budget", () => {
    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 20 })
    cm.add({ role: "user", content: "older small message" })
    cm.add({ role: "user", content: `latest ${"x".repeat(200)}` })

    const providerView = cm.getMessages()

    expect(providerView).toHaveLength(1)
    expect(providerView[0].content).toContain("latest")
  })

  it("does not hoist non-leading system turns when returning a truncated provider view", () => {
    const cm = new ConversationManager({ maxMessages: 2 })
    cm.add({ role: "system", content: "base system prompt" })
    cm.add({ role: "user", content: "old user request" })
    cm.add({ role: "system", content: "late system note should stay historical" })
    cm.add({ role: "user", content: "latest user request" })

    const providerView = cm.getMessages()

    expect(providerView.map((m) => `${m.role}:${m.content}`)).toEqual([
      "system:base system prompt",
      "user:latest user request",
    ])
  })
})

describe("truncateAfter", () => {
  it("keeps messages[0..index) and drops the rest", () => {
    const mgr = new ConversationManager({ maxMessages: 100 });
    mgr.add({ role: "user", content: "m0" } as any);
    mgr.add({ role: "assistant", content: "m1" } as any);
    mgr.add({ role: "user", content: "m2" } as any);
    mgr.add({ role: "assistant", content: "m3" } as any);

    mgr.truncateAfter(2);
    const msgs = mgr.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe("m0");
    expect(msgs[1].content).toBe("m1");
  });

  it("is a no-op when index exceeds message count", () => {
    const mgr = new ConversationManager({ maxMessages: 100 });
    mgr.add({ role: "user", content: "m0" } as any);
    mgr.truncateAfter(50);
    expect(mgr.getMessages()).toHaveLength(1);
  });

  it("clears all messages when index is 0", () => {
    const mgr = new ConversationManager({ maxMessages: 100 });
    mgr.add({ role: "user", content: "m0" } as any);
    mgr.add({ role: "assistant", content: "m1" } as any);
    mgr.truncateAfter(0);
    expect(mgr.getMessages()).toHaveLength(0);
  });
});

describe("ConversationManager.compress return value", () => {
  it("compresses at the soft trigger even when below the hard maxTokens ceiling", async () => {
    let calls = 0
    const fakeProvider = {
      call: async () => {
        calls++
        return { text: structuredSummary("SOFT TRIGGER SUMMARY"), toolCalls: [], type: "text" as const }
      },
    } as any

    const cm = new ConversationManager({
      maxMessages: 1000,
      maxTokens: 100_000,
      triggerAtTokens: 20,
      targetTokensAfterCompress: 10,
      summarizer: fakeProvider,
      autoCompress: true,
    })

    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `message ${i} ${"x".repeat(80)}` })
    }
    expect(cm.estimatedTokens).toBeGreaterThan(20)
    expect(cm.estimatedTokens).toBeLessThan(100_000)
    const before = cm.messageCount

    const result = await cm.compress(undefined, { targetTokens: 10 })

    expect(calls).toBe(1)
    expect(result?.summary).toContain("SOFT TRIGGER SUMMARY")
    expect(cm.messageCount).toBeLessThan(before)
  })

  it("passes AbortSignal through to the summarizer call", async () => {
    const controller = new AbortController()
    let seenSignal: AbortSignal | undefined
    const fakeProvider = {
      call: async (_messages: unknown, _tools: unknown, opts?: { signal?: AbortSignal }) => {
        seenSignal = opts?.signal
        return { text: structuredSummary("SIGNAL SUMMARY"), toolCalls: [], type: "text" as const }
      },
    } as any

    const cm = new ConversationManager({
      maxMessages: 1000,
      maxTokens: 100_000,
      triggerAtTokens: 20,
      targetTokensAfterCompress: 10,
      summarizer: fakeProvider,
      autoCompress: true,
    })

    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `message ${i} ${"x".repeat(80)}` })
    }

    const result = await cm.compress(undefined, {
      targetTokens: 10,
      signal: controller.signal,
    })

    expect(result?.summary).toContain("SIGNAL SUMMARY")
    expect(seenSignal).toBe(controller.signal)
  })

  it("waitForCompression compacts pending soft-trigger history below the hard maxTokens ceiling", async () => {
    let calls = 0
    const fakeProvider = {
      call: async () => {
        calls++
        return { text: structuredSummary("SOFT SUMMARY"), toolCalls: [], type: "text" as const }
      },
    } as any

    const cm = new ConversationManager({
      maxMessages: 1000,
      maxTokens: 100_000,
      triggerAtTokens: 20,
      targetTokensAfterCompress: 10,
      summarizer: fakeProvider,
      autoCompress: true,
    })

    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `message ${i} ${"x".repeat(80)}` })
    }
    const before = cm.messageCount
    expect(cm.estimatedTokens).toBeGreaterThan(20)

    await cm.waitForCompression()

    expect(calls).toBeGreaterThan(0)
    expect(cm.messageCount).toBeLessThan(before)
    expect(cm.getMessages().some((m) => m.content.includes("SOFT SUMMARY"))).toBe(true)
  })

  it("waitForCompression passes AbortSignal through to repeated compaction attempts", async () => {
    const controller = new AbortController()
    const seenSignals: Array<AbortSignal | undefined> = []
    const fakeProvider = {
      call: async (_messages: unknown, _tools: unknown, opts?: { signal?: AbortSignal }) => {
        seenSignals.push(opts?.signal)
        return { text: structuredSummary("WAIT SIGNAL SUMMARY"), toolCalls: [], type: "text" as const }
      },
    } as any

    const cm = new ConversationManager({
      maxMessages: 1000,
      maxTokens: 100_000,
      triggerAtTokens: 20,
      targetTokensAfterCompress: 10,
      summarizer: fakeProvider,
      autoCompress: true,
    })

    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `message ${i} ${"x".repeat(80)}` })
    }

    await cm.waitForCompression(undefined, { signal: controller.signal })

    expect(seenSignals.length).toBeGreaterThan(0)
    expect(seenSignals.every((signal) => signal === controller.signal)).toBe(true)
  })

  it("keeps soft-trigger compression pending when a summarizer returns no usable summary", async () => {
    let calls = 0
    const fakeProvider = {
      call: async () => {
        calls++
        return {
          text: calls === 1 ? "  \n\t" : structuredSummary("RECOVERED SUMMARY"),
          toolCalls: [],
          type: "text" as const,
        }
      },
    } as any

    const cm = new ConversationManager({
      maxMessages: 1000,
      maxTokens: 100_000,
      triggerAtTokens: 20,
      targetTokensAfterCompress: 10,
      summarizer: fakeProvider,
      autoCompress: true,
    })

    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `message ${i} ${"x".repeat(80)}` })
    }
    const before = cm.messageCount

    await cm.waitForCompression()
    expect(calls).toBe(1)
    expect(cm.messageCount).toBe(before)

    await cm.waitForCompression()
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(cm.messageCount).toBeLessThan(before)
    expect(cm.getMessages().some((m) => m.content.includes("RECOVERED SUMMARY"))).toBe(true)
  })

  it("keeps soft-trigger compression pending when the summarizer throws", async () => {
    let calls = 0
    const fakeProvider = {
      call: async () => {
        calls++
        if (calls === 1) throw new Error("temporary summarizer outage")
        return {
          text: structuredSummary("RECOVERED AFTER THROW"),
          toolCalls: [],
          type: "text" as const,
        }
      },
    } as any

    const cm = new ConversationManager({
      maxMessages: 1000,
      maxTokens: 100_000,
      triggerAtTokens: 20,
      targetTokensAfterCompress: 10,
      summarizer: fakeProvider,
      autoCompress: true,
    })

    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `message ${i} ${"x".repeat(80)}` })
    }
    const before = cm.messageCount

    await expect(cm.waitForCompression()).resolves.toBeUndefined()
    expect(calls).toBe(1)
    expect(cm.messageCount).toBe(before)

    await cm.waitForCompression()
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(cm.messageCount).toBeLessThan(before)
    expect(cm.getMessages().some((m) => m.content.includes("RECOVERED AFTER THROW"))).toBe(true)
  })

  it("returns {summary, before, after} on successful compression", async () => {
    const fakeProvider = {
      call: async () => ({ text: structuredSummary("SUMMARIZED"), toolCalls: [], type: "text" as const }),
    } as any;

    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 1_000_000 });
    for (let i = 0; i < 20; i++) {
      cm.add({ role: "user", content: `long user message number ${i} with some body text` });
      cm.add({ role: "assistant", content: `assistant reply ${i} with text body` });
    }
    const before = cm.messageCount;

    const result = await cm.compress(fakeProvider, { force: true, targetTokens: 10_000 });

    expect(result).not.toBeNull();
    expect(result!.summary).toContain("SUMMARIZED");
    expect(result!.before).toBe(before);
    expect(result!.after).toBeGreaterThan(0);
    expect(result!.after).toBeLessThan(before);
    const compactSummary = cm.getMessages().find((m) => m.content.includes("SUMMARIZED"));
    expect(compactSummary?.role).toBe("user");
    expect(compactSummary?.content).toContain("[Context compacted");
  });

  it("force compression can summarize every non-system turn when no tail turn fits the target", async () => {
    let compactInput = "";
    const fakeProvider = {
      call: async (messages: Array<{ role: string; content: string }>) => {
        compactInput = messages[1]?.content ?? "";
        return { text: structuredSummary("ALL HISTORY COMPACTED"), toolCalls: [], type: "text" as const };
      },
    } as any;

    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 1_000_000 });
    cm.add({ role: "user", content: "small older request" });
    cm.add({ role: "assistant", content: "small older answer" });
    cm.add({ role: "user", content: `latest oversized turn ${"x".repeat(20_000)}` });
    const beforeTokens = cm.estimatedTokens;

    const result = await cm.compress(fakeProvider, { force: true, targetTokens: 10 });

    expect(result).not.toBeNull();
    expect(result!.after).toBe(0);
    expect(compactInput).toContain("latest oversized turn");
    expect(cm.getAllMessages()).toHaveLength(1);
    expect(cm.getAllMessages()[0].content).toContain("ALL HISTORY COMPACTED");
    expect(cm.estimatedTokens).toBeLessThan(beforeTokens);
  });

  it("does not replace history when the summarizer returns an empty summary", async () => {
    const fakeProvider = {
      call: async () => ({ text: "   \n\t", toolCalls: [], type: "text" as const }),
    } as any;

    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 1_000_000 });
    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `user message ${i}` });
      cm.add({ role: "assistant", content: `assistant reply ${i}` });
    }
    const beforeMessages = cm.getMessages().map((m) => `${m.role}:${m.content}`);
    const beforeCount = cm.messageCount;

    const result = await cm.compress(fakeProvider, { force: true, targetTokens: 100 });

    expect(result).toBeNull();
    expect(cm.messageCount).toBe(beforeCount);
    expect(cm.getMessages().map((m) => `${m.role}:${m.content}`)).toEqual(beforeMessages);
    expect(cm.getMessages().some((m) => m.content.includes("[Previous conversation summary]"))).toBe(false);
  });

  it("does not replace history when the summarizer returns an unstructured summary", async () => {
    const fakeProvider = {
      call: async () => ({ text: "A short prose summary without the required anchors.", toolCalls: [], type: "text" as const }),
    } as any;

    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 1_000_000 });
    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `user message ${i}` });
      cm.add({ role: "assistant", content: `assistant reply ${i}` });
    }
    const beforeMessages = cm.getMessages().map((m) => `${m.role}:${m.content}`);

    const result = await cm.compress(fakeProvider, { force: true, targetTokens: 100 });

    expect(result).toBeNull();
    expect(cm.getMessages().map((m) => `${m.role}:${m.content}`)).toEqual(beforeMessages);
    expect(cm.lastCompressionFailureReason).toContain("missing required sections: Primary Request and Intent");
  });

  it("records and clears detailed compression failure diagnostics", async () => {
    let responseText = [
      "# Primary Request and Intent",
      "- goal",
      "# All user messages (verbatim)",
      "# Current task status",
      "- status",
      "# Files read / modified",
      "- file",
      "# Commands run",
      "- command",
      "# Key facts discovered",
      "- fact",
      "# Decisions made",
      "- decision",
      "# Errors encountered and their resolution",
      "- none",
      "# Code changes summary",
      "- change",
      "# Next steps",
      "- continue",
    ].join("\n");
    const fakeProvider = {
      call: async () => ({ text: responseText, toolCalls: [], type: "text" as const }),
    } as any;

    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 1_000_000 });
    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `user message ${i}` });
      cm.add({ role: "assistant", content: `assistant reply ${i}` });
    }

    const failed = await cm.compress(fakeProvider, { force: true, targetTokens: 100 });
    expect(failed).toBeNull();
    expect(cm.lastCompressionFailureReason).toContain(
      "summarizer returned an unusable compact summary (empty required sections: All user messages (verbatim))",
    );
    expect(cm.lastCompressionFailureReason).toContain("repair attempt still invalid");

    responseText = structuredSummary("RECOVERED");
    const recovered = await cm.compress(fakeProvider, { force: true, targetTokens: 100 });

    expect(recovered?.summary).toContain("RECOVERED");
    expect(cm.lastCompressionFailureReason).toBeUndefined();
  });

  it("records summarizer exceptions as compression failure diagnostics before rethrowing", async () => {
    const fakeProvider = {
      call: async () => {
        throw new Error("model overloaded");
      },
    } as any;

    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 1_000_000 });
    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `user message ${i}` });
      cm.add({ role: "assistant", content: `assistant reply ${i}` });
    }

    await expect(cm.compress(fakeProvider, { force: true, targetTokens: 100 }))
      .rejects.toThrow("model overloaded");
    expect(cm.lastCompressionFailureReason).toBe("summarizer failed: model overloaded");
  });

  it("does not commit a compact result when the provider ignores cancellation", async () => {
    const controller = new AbortController();
    const fakeProvider = {
      call: async () => {
        controller.abort(new Error("user cancelled"));
        return { text: structuredSummary("SHOULD NOT COMMIT"), toolCalls: [], type: "text" as const };
      },
    } as any;
    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 1_000_000 });
    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `user message ${i}` });
      cm.add({ role: "assistant", content: `assistant reply ${i}` });
    }
    const before = cm.getAllMessages();

    await expect(cm.compress(fakeProvider, {
      force: true,
      targetTokens: 100,
      signal: controller.signal,
    })).rejects.toThrow("user cancelled");

    expect(cm.getAllMessages()).toEqual(before);
  });

  it("clears stale compression failure diagnostics when the conversation is cleared", async () => {
    const fakeProvider = {
      call: async () => ({ text: "A short prose summary.", toolCalls: [], type: "text" as const }),
    } as any;
    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 1_000_000 });
    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `user message ${i}` });
      cm.add({ role: "assistant", content: `assistant reply ${i}` });
    }

    const failed = await cm.compress(fakeProvider, { force: true, targetTokens: 100 });
    expect(failed).toBeNull();
    expect(cm.lastCompressionFailureReason).toContain("missing required sections");

    cm.clear();

    expect(cm.lastCompressionFailureReason).toBeUndefined();
    expect(cm.messageCount).toBe(0);
  });

  it("clears stale compression failure diagnostics when history is truncated", async () => {
    const fakeProvider = {
      call: async () => ({ text: "A short prose summary.", toolCalls: [], type: "text" as const }),
    } as any;
    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 1_000_000 });
    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `user message ${i}` });
      cm.add({ role: "assistant", content: `assistant reply ${i}` });
    }

    const failed = await cm.compress(fakeProvider, { force: true, targetTokens: 100 });
    expect(failed).toBeNull();
    expect(cm.lastCompressionFailureReason).toContain("missing required sections");

    cm.truncateAfter(2);

    expect(cm.lastCompressionFailureReason).toBeUndefined();
    expect(cm.messageCount).toBe(2);
  });

  it("clears stale compression failure diagnostics after a later message mutation", async () => {
    const cm = await conversationWithFailedCompression();

    cm.add({ role: "user", content: "new request after failed compact" });

    expect(cm.lastCompressionFailureReason).toBeUndefined();
    expect(cm.getMessages().at(-1)?.content).toBe("new request after failed compact");
  });

  it("clears stale compression failure diagnostics after maintenance mutations", async () => {
    const cm = await conversationWithFailedCompression();

    cm.mutateInPlace((messages) => {
      messages[0] = { ...messages[0], content: "rewritten first message" };
    });

    expect(cm.lastCompressionFailureReason).toBeUndefined();
    expect(cm.getMessages()[0]?.content).toBe("rewritten first message");
  });

  it("strips analysis scratchpads before storing compact summaries", async () => {
    const fakeProvider = {
      call: async () => ({
        text: [
          "<analysis>",
          "private chain of thought",
          "</analysis>",
          "",
          structuredSummary("preserve the useful summary"),
        ].join("\n"),
        toolCalls: [],
        type: "text" as const,
      }),
    } as any;

    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 1_000_000 });
    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `user message ${i}` });
      cm.add({ role: "assistant", content: `assistant reply ${i}` });
    }

    const result = await cm.compress(fakeProvider, { force: true, targetTokens: 100 });
    const stored = cm.getMessages().map((m) => m.content).join("\n");

    expect(result?.summary).toContain("# Primary Request and Intent");
    expect(result?.summary).not.toContain("<analysis>");
    expect(result?.summary).not.toContain("private chain of thought");
    expect(stored).toContain("preserve the useful summary");
    expect(stored).not.toContain("<analysis>");
    expect(stored).not.toContain("private chain of thought");
  });

  it("preserves only the leading system prefix instead of hoisting later system turns", async () => {
    let compactInput = "";
    const fakeProvider = {
      call: async (messages: Array<{ role: string; content: string }>) => {
        compactInput = messages[1]?.content ?? "";
        return { text: structuredSummary("PREFIX SUMMARY"), toolCalls: [], type: "text" as const };
      },
    } as any;

    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 1_000_000 });
    cm.add({ role: "system", content: "base system prompt" });
    cm.add({ role: "system", content: "cacheable support instructions" });
    cm.add({ role: "user", content: "old user request" });
    cm.add({ role: "system", content: "late system note should stay historical" });
    cm.add({ role: "assistant", content: "old answer" });
    for (let i = 0; i < 8; i++) {
      cm.add({ role: "user", content: `tail user ${i}` });
      cm.add({ role: "assistant", content: `tail answer ${i}` });
    }

    const result = await cm.compress(fakeProvider, { force: true, targetTokens: 100 });
    const after = cm.getMessages();

    expect(result?.summary).toContain("PREFIX SUMMARY");
    expect(after.slice(0, 2).map((m) => `${m.role}:${m.content}`)).toEqual([
      "system:base system prompt",
      "system:cacheable support instructions",
    ]);
    expect(after[2]?.role).toBe("user");
    expect(after[2]?.content).toContain("[Context compacted");
    expect(after.slice(0, 3).some((m) => m.content === "late system note should stay historical")).toBe(false);
    expect(compactInput).toContain("[system]: late system note should stay historical");
  });

  it("does not replace history when the summarizer returns only analysis", async () => {
    const fakeProvider = {
      call: async () => ({
        text: "<analysis>\nprivate only\n</analysis>",
        toolCalls: [],
        type: "text" as const,
      }),
    } as any;

    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 1_000_000 });
    for (let i = 0; i < 12; i++) {
      cm.add({ role: "user", content: `user message ${i}` });
      cm.add({ role: "assistant", content: `assistant reply ${i}` });
    }
    const beforeMessages = cm.getMessages().map((m) => `${m.role}:${m.content}`);

    const result = await cm.compress(fakeProvider, { force: true, targetTokens: 100 });

    expect(result).toBeNull();
    expect(cm.getMessages().map((m) => `${m.role}:${m.content}`)).toEqual(beforeMessages);
  });

  it("returns null when nothing to compact", async () => {
    const fakeProvider = {
      call: async () => ({ text: "x", toolCalls: [], type: "text" as const }),
    } as any;
    const cm = new ConversationManager({ maxMessages: 100, maxTokens: 1_000_000 });
    cm.add({ role: "user", content: "only one" });
    const result = await cm.compress(fakeProvider, { force: false, targetTokens: 10_000 });
    expect(result).toBeNull();
  });
});
