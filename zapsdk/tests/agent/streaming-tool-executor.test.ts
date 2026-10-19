import { describe, it, expect } from "bun:test"
import { StreamingToolExecutor } from "../../agent/streaming-tool-executor.js"
import { AgentEventEmitter, type AgentEvent } from "../../agent/events.js"
import type { LLMChunk } from "../../core/types.js"

describe("streaming tool execution context", () => {
  it("correlates host session, tool call, and loop step", async () => {
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "call-7", toolName: "read_file" }
      yield { type: "tool_call_delta", toolCallId: "call-7", partialJson: `{"path":"x.md"}` }
      yield { type: "done", usage: { inputTokens: 5, outputTokens: 5 } }
    }
    let receivedContext: unknown
    const mockExecutor = {
      execute: async (_name: string, _args: unknown, _signal: unknown, context: unknown) => {
        receivedContext = context
        return { success: true, output: "ok" }
      },
      isReadOnly: () => false,
    }
    const exec = new StreamingToolExecutor(mockExecutor as any, new AgentEventEmitter(), {
      sessionId: "session-1",
    })

    await exec.consumeStream(stream(), 7)

    expect(receivedContext).toEqual({
      sessionId: "session-1",
      toolCallId: "call-7",
      step: 7,
    })
  })
})

describe("content_final section ordering", () => {
  it("finalizes thinking BEFORE text when text_delta starts, preserving thinking→text order", async () => {
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "thinking_delta", text: "Let me reason about this..." }
      yield { type: "text_delta", text: "The answer is 42." }
      yield { type: "done", usage: { inputTokens: 5, outputTokens: 5 } }
    }

    const emitter = new AgentEventEmitter()
    const events: AgentEvent[] = []
    emitter.on("content_final", (e) => events.push(e))
    const exec = new StreamingToolExecutor({} as any, emitter)
    await exec.consumeStream(stream(), 0, undefined)

    const thinkingIdx = events.findIndex((e) => e.type === "content_final" && e.kind === "thinking")
    const textEvent = events.find((e) => e.type === "content_final" && e.kind === "text")
    expect(thinkingIdx).toBeGreaterThanOrEqual(0)
    // Text isn't finalized by consumeStream on pure-text paths (loop.ts does
    // it after applying cleanOutput). But thinking should still fire early.
    expect(textEvent).toBeUndefined()
  })

  it("finalizes thinking BEFORE tool_call when tool follows directly (no text preamble)", async () => {
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "thinking_delta", text: "I'll call a tool." }
      yield { type: "tool_call_start", toolCallId: "t1", toolName: "read_file" }
      yield { type: "tool_call_delta", toolCallId: "t1", partialJson: `{"path":"x.md"}` }
      yield { type: "done", usage: { inputTokens: 5, outputTokens: 5 } }
    }
    const emitter = new AgentEventEmitter()
    const events: AgentEvent[] = []
    emitter.on("content_final", (e) => events.push(e))
    const mockExecutor = { execute: async () => ({ success: true, output: "ok" }), isReadOnly: () => false }
    const exec = new StreamingToolExecutor(mockExecutor as any, emitter)
    await exec.consumeStream(stream(), 0, undefined)

    const thinkingIdx = events.findIndex((e) => e.type === "content_final" && e.kind === "thinking")
    const toolCallIdx = events.findIndex((e) => e.type === "content_final" && e.kind === "tool_call")
    expect(thinkingIdx).toBeGreaterThanOrEqual(0)
    expect(toolCallIdx).toBeGreaterThan(thinkingIdx)
  })

  it("finalizes text BEFORE emitting tool_call_final so UI renders text above tool row", async () => {
    async function* stream(): AsyncIterable<LLMChunk> {
      // Model: preamble text, then tool call
      yield { type: "text_delta", text: "Let me write the file." }
      yield { type: "tool_call_start", toolCallId: "t1", toolName: "write_file" }
      yield { type: "tool_call_delta", toolCallId: "t1", partialJson: `{"path":"x.md","content":"hi"}` }
      yield { type: "done", usage: { inputTokens: 5, outputTokens: 5 } }
    }

    const emitter = new AgentEventEmitter()
    const events: AgentEvent[] = []
    emitter.on("content_final", (e) => events.push(e))

    // Mock executor that resolves immediately
    const mockExecutor = {
      execute: async () => ({ success: true, output: "ok" }),
      isReadOnly: () => false,
    }
    const exec = new StreamingToolExecutor(mockExecutor as any, emitter)
    const result = await exec.consumeStream(stream(), 0, undefined)

    // Ordering check: text final must come before tool_call final in the
    // emitted event stream.
    const textFinalIdx = events.findIndex((e) => e.type === "content_final" && e.kind === "text")
    const toolCallFinalIdx = events.findIndex((e) => e.type === "content_final" && e.kind === "tool_call")
    expect(textFinalIdx).toBeGreaterThanOrEqual(0)
    expect(toolCallFinalIdx).toBeGreaterThan(textFinalIdx)

    // And consumeStream reports that text was finalized so loop.ts won't double-emit.
    expect(result.textFinalEmitted).toBe(true)
  })

  it("does not emit content_final text when there's no text preamble before the tool", async () => {
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "t1", toolName: "read_file" }
      yield { type: "tool_call_delta", toolCallId: "t1", partialJson: `{"path":"x.md"}` }
      yield { type: "done", usage: { inputTokens: 5, outputTokens: 5 } }
    }
    const emitter = new AgentEventEmitter()
    const events: AgentEvent[] = []
    emitter.on("content_final", (e) => events.push(e))
    const mockExecutor = { execute: async () => ({ success: true, output: "ok" }), isReadOnly: () => false }
    const exec = new StreamingToolExecutor(mockExecutor as any, emitter)
    const result = await exec.consumeStream(stream(), 0, undefined)
    const textFinals = events.filter((e) => e.type === "content_final" && e.kind === "text")
    expect(textFinals).toHaveLength(0)
    expect(result.textFinalEmitted).toBe(false)
  })
})

describe("tool_call_pending argsPreview", () => {
  it("emits argsPreview with path once the path key appears mid-stream", async () => {
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "t1", toolName: "write_file" }
      yield { type: "tool_call_delta", toolCallId: "t1", partialJson: `{"path":"docs/plan.md","content":"hello` }
      // Never completes — user aborts — we just want to verify the preview fired.
    }
    const emitter = new AgentEventEmitter()
    const pendings: AgentEvent[] = []
    emitter.on("tool_call_pending", (e) => pendings.push(e))
    const exec = new StreamingToolExecutor({} as any, emitter)
    try { await exec.consumeStream(stream(), 0, undefined) } catch {}
    // Expect exactly one pending with path extracted.
    const withPath = pendings.filter(
      (e) => e.type === "tool_call_pending" && (e as any).argsPreview?.path === "docs/plan.md",
    )
    expect(withPath.length).toBe(1)
  })
})

describe("tool_call_pending progress (bytesHint)", () => {
  it("re-emits pending with growing bytesHint every ~2KB of tool-args stream", async () => {
    // Simulate a large `bash` payload whose command string can't be previewed
    // early (the regex needs the closing quote, which never comes until the
    // end of the full body). The bytesHint ticker is the fallback UI signal
    // for these "one huge string" calls — verify it fires every ~2KB.
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "t1", toolName: "bash" }
      yield { type: "tool_call_delta", toolCallId: "t1", partialJson: `{"command":"python -c \\"` }
      // ~6KB more body in 1KB chunks — should cross the 2KB progress threshold ~3x.
      const chunk = "x".repeat(1024)
      for (let i = 0; i < 6; i++) {
        yield { type: "tool_call_delta", toolCallId: "t1", partialJson: chunk }
      }
      // No closing `}` — JSON.parse will fail in tryLaunch, but that's fine;
      // we're verifying the progress ticker, not the launch.
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
    }
    const emitter = new AgentEventEmitter()
    const pendings: AgentEvent[] = []
    emitter.on("tool_call_pending", (e) => pendings.push(e))
    const exec = new StreamingToolExecutor({} as any, emitter)
    try { await exec.consumeStream(stream(), 0, undefined) } catch {}

    const withBytes = pendings
      .filter((e) => e.type === "tool_call_pending" && (e as any).bytesHint !== undefined)
      .map((e) => e as any)
    // ~6KB body → at least 3 ticks across the 2KB threshold.
    expect(withBytes.length).toBeGreaterThanOrEqual(3)
    // Monotonically non-decreasing.
    for (let i = 1; i < withBytes.length; i++) {
      expect(withBytes[i].bytesHint).toBeGreaterThanOrEqual(withBytes[i - 1].bytesHint)
    }
  })

  it("emits both the early preview AND subsequent bytesHint progress for a write_file-like call", async () => {
    // write_file has `path` before `content` — preview fires immediately on
    // first delta, then body growth drives the bytesHint ticker. Verify both.
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "t2", toolName: "write_file" }
      yield { type: "tool_call_delta", toolCallId: "t2", partialJson: `{"path":"x.md","content":"` }
      const chunk = "y".repeat(1024)
      for (let i = 0; i < 5; i++) {
        yield { type: "tool_call_delta", toolCallId: "t2", partialJson: chunk }
      }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
    }
    const emitter = new AgentEventEmitter()
    const pendings: AgentEvent[] = []
    emitter.on("tool_call_pending", (e) => pendings.push(e))
    const exec = new StreamingToolExecutor({} as any, emitter)
    try { await exec.consumeStream(stream(), 0, undefined) } catch {}

    const emits = pendings.filter((e) => e.type === "tool_call_pending").map((e) => e as any)
    // First emit after preview-fire carries path=x.md.
    const withPreview = emits.find((e) => e.argsPreview?.path === "x.md")
    expect(withPreview).toBeTruthy()
    expect(withPreview.bytesHint).toBeGreaterThan(0)
    // Later emits still carry the preview (so UI label doesn't flip back).
    const laterEmits = emits.filter((e) => (e.bytesHint ?? 0) > withPreview.bytesHint)
    expect(laterEmits.length).toBeGreaterThan(0)
    for (const e of laterEmits) {
      expect(e.argsPreview?.path).toBe("x.md")
    }
  })
})

describe("no-args tools (empty buffer at end of stream)", () => {
  it("launches a tool whose stream emitted only tool_call_start (no input_json_delta)", async () => {
    // Repro for the "/rewind PlanMode() loops forever" bug. Both Anthropic
    // and OpenAI-compatible providers can finish a tool_use block without
    // ever sending an `input_json_delta` / non-empty `arguments` field —
    // happens whenever the tool's schema is `z.object({})` (e.g.
    // enter_plan_mode) so there's nothing to stream. Before the fix the
    // executor synthesized "stream truncated" and the model retried in a
    // tight loop. After: empty buffer at end-of-stream means `{}`, the
    // tool runs once, the loop moves on.
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "t1", toolName: "enter_plan_mode" }
      // No tool_call_delta — provider never sent args for the no-input tool.
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
    }
    const emitter = new AgentEventEmitter()
    const finals: AgentEvent[] = []
    emitter.on("content_final", (e) => finals.push(e))
    let executeCalledWith: { name: string; args: any } | null = null
    const mockExecutor = {
      execute: async (name: string, args: any) => {
        executeCalledWith = { name, args }
        return { success: true, output: "ok" }
      },
      isReadOnly: () => false,
    }
    const exec = new StreamingToolExecutor(mockExecutor as any, emitter)
    await exec.consumeStream(stream(), 0, undefined)

    // The handler ran with `{}` args.
    expect(executeCalledWith).not.toBeNull()
    expect(executeCalledWith!.name).toBe("enter_plan_mode")
    expect(executeCalledWith!.args).toEqual({})
    // And the executor emitted a successful tool_result — NOT the
    // "stream truncated" synthesis.
    const toolResult = finals.find((e) => e.type === "content_final" && e.kind === "tool_result" && e.id === "t1")
    expect(toolResult).toBeTruthy()
    expect((toolResult as any).result.success).toBe(true)
  })
})

describe("tool call index routing", () => {
  it("routes interleaved deltas by provider content block index even when indexes are sparse", async () => {
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "text_delta", text: "Checking both files." }
      yield { type: "tool_call_start", toolCallId: "read_a", toolName: "read_file", toolCallIndex: 1 }
      yield { type: "tool_call_start", toolCallId: "read_b", toolName: "read_file", toolCallIndex: 2 }
      yield { type: "tool_call_delta", toolCallId: "", toolCallIndex: 2, partialJson: `{"path":"b` }
      yield { type: "tool_call_delta", toolCallId: "", toolCallIndex: 1, partialJson: `{"path":"a` }
      yield { type: "tool_call_delta", toolCallId: "", toolCallIndex: 2, partialJson: `.ts"}` }
      yield { type: "tool_call_delta", toolCallId: "", toolCallIndex: 1, partialJson: `.ts"}` }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
    }

    const calls: Array<{ name: string; args: any }> = []
    const mockExecutor = {
      execute: async (name: string, args: any) => {
        calls.push({ name, args })
        return { success: true, output: String(args.path) }
      },
      isReadOnly: () => true,
    }
    const emitter = new AgentEventEmitter()
    const exec = new StreamingToolExecutor(mockExecutor as any, emitter)

    const result = await exec.consumeStream(stream(), 0, undefined)

    expect(result.toolCalls).toEqual([
      { id: "read_a", name: "read_file", arguments: { path: "a.ts" } },
      { id: "read_b", name: "read_file", arguments: { path: "b.ts" } },
    ])
    expect(calls).toEqual([
      { name: "read_file", args: { path: "b.ts" } },
      { name: "read_file", args: { path: "a.ts" } },
    ])
  })
})

describe("tool execution ordering", () => {
  it("delays writes behind earlier read-only tools in the same stream", async () => {
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "r1", toolName: "read_file" }
      yield { type: "tool_call_delta", toolCallId: "r1", partialJson: `{"path":"x.md"}` }
      yield { type: "tool_call_start", toolCallId: "w1", toolName: "write_file" }
      yield { type: "tool_call_delta", toolCallId: "w1", partialJson: `{"path":"x.md","content":"new"}` }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
    }

    const events: string[] = []
    let markReadStarted!: () => void
    let releaseRead!: () => void
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve })
    const readReleased = new Promise<void>((resolve) => { releaseRead = resolve })
    const mockExecutor = {
      execute: async (name: string) => {
        events.push(`${name}:start`)
        if (name === "read_file") {
          markReadStarted()
          await readReleased
          events.push("read_file:finish")
        }
        return { success: true, output: name }
      },
      isReadOnly: (name: string) => name === "read_file",
    }

    const emitter = new AgentEventEmitter()
    let markWriteCallEmitted!: () => void
    const writeCallEmitted = new Promise<void>((resolve) => { markWriteCallEmitted = resolve })
    emitter.on("content_final", (event) => {
      if (event.type === "content_final" && event.kind === "tool_call" && event.id === "w1") {
        markWriteCallEmitted()
      }
    })
    const exec = new StreamingToolExecutor(mockExecutor as any, emitter)
    const consumed = exec.consumeStream(stream(), 0, undefined)

    await readStarted
    await writeCallEmitted
    await Promise.resolve()
    await Promise.resolve()
    const beforeRelease = [...events]

    releaseRead()
    await consumed
    expect(beforeRelease).toEqual(["read_file:start"])
    expect(events).toEqual(["read_file:start", "read_file:finish", "write_file:start"])
  })

  it("runs sibling read-only tools concurrently", async () => {
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "r1", toolName: "read_file" }
      yield { type: "tool_call_delta", toolCallId: "r1", partialJson: `{"path":"a.md"}` }
      yield { type: "tool_call_start", toolCallId: "r2", toolName: "read_file" }
      yield { type: "tool_call_delta", toolCallId: "r2", partialJson: `{"path":"b.md"}` }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
    }

    const started: string[] = []
    let releaseReads!: () => void
    let markBothStarted!: () => void
    const readsReleased = new Promise<void>((resolve) => { releaseReads = resolve })
    const bothStarted = new Promise<void>((resolve) => { markBothStarted = resolve })
    const mockExecutor = {
      execute: async (_name: string, args: Record<string, unknown>) => {
        started.push(String(args.path))
        if (started.length === 2) markBothStarted()
        await readsReleased
        return { success: true, output: String(args.path) }
      },
      isReadOnly: () => true,
    }

    const emitter = new AgentEventEmitter()
    const exec = new StreamingToolExecutor(mockExecutor as any, emitter)
    const consumed = exec.consumeStream(stream(), 0, undefined)

    let timeout: ReturnType<typeof setTimeout> | undefined
    const startedConcurrently = await Promise.race([
      bothStarted.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 500)
      }),
    ])
    if (timeout) clearTimeout(timeout)
    const startedBeforeRelease = [...started]
    releaseReads()
    await consumed
    expect(startedConcurrently).toBe(true)
    expect(startedBeforeRelease).toEqual(["a.md", "b.md"])
  })

  it("passes completed arguments to per-call read-only scheduling", async () => {
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "a1", toolName: "agent" }
      yield { type: "tool_call_delta", toolCallId: "a1", partialJson: `{"task":"fees","agent_type":"explore"}` }
      yield { type: "tool_call_start", toolCallId: "a2", toolName: "agent" }
      yield { type: "tool_call_delta", toolCallId: "a2", partialJson: `{"task":"policy","agent_type":"plan"}` }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
    }

    const started: string[] = []
    const classified: Record<string, unknown>[] = []
    let releaseAgents!: () => void
    let markBothStarted!: () => void
    const agentsReleased = new Promise<void>((resolve) => { releaseAgents = resolve })
    const bothStarted = new Promise<void>((resolve) => { markBothStarted = resolve })
    const mockExecutor = {
      execute: async (_name: string, args: Record<string, unknown>) => {
        started.push(String(args.task))
        if (started.length === 2) markBothStarted()
        await agentsReleased
        return { success: true, output: String(args.task) }
      },
      isReadOnly: (_name: string, args: Record<string, unknown>) => {
        classified.push(args)
        return args.agent_type === "explore" || args.agent_type === "plan"
      },
    }

    const exec = new StreamingToolExecutor(mockExecutor as any, new AgentEventEmitter())
    const consumed = exec.consumeStream(stream(), 0, undefined)

    let timeout: ReturnType<typeof setTimeout> | undefined
    const startedConcurrently = await Promise.race([
      bothStarted.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 500)
      }),
    ])
    if (timeout) clearTimeout(timeout)
    const startedBeforeRelease = [...started]
    releaseAgents()
    await consumed

    expect(startedConcurrently).toBe(true)
    expect(startedBeforeRelease).toEqual(["fees", "policy"])
    expect(classified).toEqual([
      { task: "fees", agent_type: "explore" },
      { task: "policy", agent_type: "plan" },
    ])
  })

  it("delays read-only tools behind earlier writes in the same stream", async () => {
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "w1", toolName: "write_file" }
      yield { type: "tool_call_delta", toolCallId: "w1", partialJson: `{"path":"x.md","content":"new"}` }
      yield { type: "tool_call_start", toolCallId: "r1", toolName: "read_file" }
      yield { type: "tool_call_delta", toolCallId: "r1", partialJson: `{"path":"x.md"}` }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
    }

    const events: string[] = []
    let markWriteStarted!: () => void
    let releaseWrite!: () => void
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve })
    const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve })
    const mockExecutor = {
      execute: async (name: string) => {
        events.push(`${name}:start`)
        if (name === "write_file") {
          markWriteStarted()
          await writeReleased
          events.push("write_file:finish")
        }
        return { success: true, output: name }
      },
      isReadOnly: (name: string) => name === "read_file",
    }

    const emitter = new AgentEventEmitter()
    const exec = new StreamingToolExecutor(mockExecutor as any, emitter)
    const consumed = exec.consumeStream(stream(), 0, undefined)

    await writeStarted
    await Promise.resolve()
    await Promise.resolve()
    const beforeRelease = [...events]

    releaseWrite()
    await consumed
    expect(beforeRelease).toEqual(["write_file:start"])
    expect(events).toEqual(["write_file:start", "write_file:finish", "read_file:start"])
  })
})

describe("incomplete tool_use synthesis", () => {
  it("does not execute a streamed tool call whose JSON args are not an object", async () => {
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "t1", toolName: "write_file" }
      yield { type: "tool_call_delta", toolCallId: "t1", partialJson: `[]` }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
    }
    const emitter = new AgentEventEmitter()
    const finals: AgentEvent[] = []
    emitter.on("content_final", (e) => finals.push(e))
    let executeCalled = false
    const mockExecutor = {
      execute: async () => {
        executeCalled = true
        return { success: true, output: "ok" }
      },
      isReadOnly: () => false,
    }
    const exec = new StreamingToolExecutor(mockExecutor as any, emitter)
    const result = await exec.consumeStream(stream(), 0, undefined)

    expect(executeCalled).toBe(false)
    expect(result.toolCalls).toEqual([
      { id: "t1", name: "write_file", arguments: {} },
    ])
    const toolResult = finals.find((e) => e.type === "content_final" && e.kind === "tool_result" && e.id === "t1")
    expect(toolResult).toBeTruthy()
    expect((toolResult as any).result.success).toBe(false)
    expect((toolResult as any).result.error).toBe("Tool arguments JSON must be an object.")
  })

  it("emits content_final tool_result with success:false when tryLaunch never fires (malformed/truncated JSON)", async () => {
    // Repro for the "write_file/multi_edit stuck on `·` forever" bug: model
    // emitted tool_use_start (UI registered the pending row) but the args
    // JSON never closed cleanly. Without an explicit failure result event,
    // the SDK side synthesizes IncompleteCall for conversation history but
    // the UI sits at `·` until runAgent's finally — possibly many turns away.
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "t1", toolName: "multi_edit" }
      // Open the JSON object but never close it — JSON.parse will throw.
      yield { type: "tool_call_delta", toolCallId: "t1", partialJson: `{"path":"x.dart","edits":[{"old":"a"` }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
    }
    const emitter = new AgentEventEmitter()
    const finals: AgentEvent[] = []
    emitter.on("content_final", (e) => finals.push(e))
    // executor.execute should NEVER be called for an incomplete tool — the
    // fallback emit synthesizes the failure locally without re-running it.
    let executeCalled = false
    const mockExecutor = {
      execute: async () => { executeCalled = true; return { success: true, output: "ok" } },
      isReadOnly: () => false,
    }
    const exec = new StreamingToolExecutor(mockExecutor as any, emitter)
    await exec.consumeStream(stream(), 0, undefined)

    expect(executeCalled).toBe(false)
    const toolResult = finals.find((e) => e.type === "content_final" && e.kind === "tool_result" && e.id === "t1")
    expect(toolResult).toBeTruthy()
    expect((toolResult as any).result.success).toBe(false)
    expect((toolResult as any).result.error).toMatch(/stream truncated/)
  })
})

// stream-idle watchdog moved to core/stream-idle.ts and is applied INSIDE
// each adapter's stream() (around the SDK iterator), not at this executor
// level — see issue #10 and zapsdk/tests/provider/stream-idle.test.ts for
// utility-level + provider-level coverage.

describe("StreamingToolExecutor abort preservation", () => {
  it("attaches launched tool calls and settled abort results to the error", async () => {
    const controller = new AbortController()
    let markToolStarted!: () => void
    const toolStarted = new Promise<void>((resolve) => { markToolStarted = resolve })

    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "t1", toolName: "write_file" }
      yield {
        type: "tool_call_delta",
        toolCallId: "t1",
        partialJson: `{"path":"x.md","content":"new"}`,
      }
      await toolStarted
      controller.abort()
      yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } }
    }

    const emitter = new AgentEventEmitter()
    const finals: AgentEvent[] = []
    emitter.on("content_final", (event) => finals.push(event))
    const mockExecutor = {
      isReadOnly: () => false,
      execute: async (_name: string, _args: Record<string, unknown>, signal?: AbortSignal) => {
        markToolStarted()
        if (!signal?.aborted) {
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
        }
        return { success: false, output: "", error: "aborted" }
      },
    }
    const exec = new StreamingToolExecutor(mockExecutor as any, emitter)

    let caught: any
    try {
      await exec.consumeStream(stream(), 1, controller.signal)
    } catch (error) {
      caught = error
    }

    expect(caught?.message).toBe("aborted")
    expect(caught?.partial.toolCalls).toEqual([{
      id: "t1",
      name: "write_file",
      arguments: { path: "x.md", content: "new" },
    }])
    expect(caught?.partial.results.get("t1")).toEqual({
      success: false,
      output: "",
      error: "aborted",
    })
    const resultEvents = finals.filter(
      (event) => event.type === "content_final" && event.kind === "tool_result" && event.id === "t1",
    )
    expect(resultEvents).toHaveLength(1)
  })

  it("preserves but does not execute an incomplete tool call when aborted", async () => {
    const controller = new AbortController()
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })

    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "tool_call_start", toolCallId: "t1", toolName: "read_file" }
      yield { type: "tool_call_delta", toolCallId: "t1", partialJson: `{"path":"a.md"}` }
      yield { type: "tool_call_start", toolCallId: "t2", toolName: "write_file" }
      yield { type: "tool_call_delta", toolCallId: "t2", partialJson: `{"path":"b.md","content":"` }
      await firstStarted
      controller.abort()
    }

    const executed: string[] = []
    const mockExecutor = {
      isReadOnly: (name: string) => name === "read_file",
      execute: async (name: string, _args: Record<string, unknown>, signal?: AbortSignal) => {
        executed.push(name)
        markFirstStarted()
        if (!signal?.aborted) {
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
        }
        return { success: false, output: "", error: "aborted" }
      },
    }
    const exec = new StreamingToolExecutor(mockExecutor as any, new AgentEventEmitter())

    let caught: any
    try {
      await exec.consumeStream(stream(), 1, controller.signal)
    } catch (error) {
      caught = error
    }

    expect(executed).toEqual(["read_file"])
    expect(caught?.partial.toolCalls.map((call: { id: string }) => call.id)).toEqual(["t1", "t2"])
    expect([...caught?.partial.results.keys()]).toEqual(["t1"])
  })

  it("throws aborted but attaches partial thinking to the error", async () => {
    const controller = new AbortController()

    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "thinking_delta", text: "I'll use python-pptx" }
      yield { type: "thinking_delta", text: " to create a PowerPoint file." }
      // User presses Ctrl+C here, mid-thought, before any tool call.
      controller.abort()
      // One more chunk after abort — loop body's aborted-check must break out.
      yield { type: "thinking_delta", text: " Let me first check if the library is available." }
    }

    const emitter = new AgentEventEmitter()
    const finals: AgentEvent[] = []
    emitter.on("content_final", (e) => finals.push(e))

    const exec = new StreamingToolExecutor({} as any, emitter)

    let caught: Error | null = null
    try {
      await exec.consumeStream(stream(), 1, controller.signal)
    } catch (e) {
      caught = e as Error
    }

    expect(caught?.message).toBe("aborted")

    // Content_final for thinking must still be emitted so UI shows what the
    // model was thinking before interruption.
    const finalThinking = finals.find(
      (e) => e.type === "content_final" && e.kind === "thinking",
    ) as any
    expect(finalThinking).toBeTruthy()
    expect(finalThinking.text).toContain("python-pptx")

    // After fix: the abort Error carries partial state so LoopAgent can
    // persist it into conversation history. Before fix: .partial is undefined
    // and the next user turn loses all context of what was interrupted.
    const partial = (caught as any)?.partial
    expect(partial).toBeTruthy()
    expect(partial.thinking).toContain("python-pptx")
  })

  it("does not attach partial on normal (non-abort) stream completion", async () => {
    async function* stream(): AsyncIterable<LLMChunk> {
      yield { type: "thinking_delta", text: "thinking" }
      yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } }
    }

    const emitter = new AgentEventEmitter()
    const exec = new StreamingToolExecutor({} as any, emitter)

    const result = await exec.consumeStream(stream(), 1, undefined)
    expect(result.thinking).toBe("thinking")
  })
})
