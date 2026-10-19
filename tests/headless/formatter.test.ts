import { afterEach, describe, expect, it } from "bun:test"
import { createFormatter } from "../../src/headless/formatter.js"
import { assessCompletion } from "../../zapsdk/harness/completion.js"
import { operationFailure } from "../../zapsdk/execution/failure.js"

let captured = ""
const originalWrite = process.stdout.write.bind(process.stdout)

function captureStdout(): void {
  captured = ""
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8")
    return true
  }) as typeof process.stdout.write
}

afterEach(() => {
  process.stdout.write = originalWrite as typeof process.stdout.write
  captured = ""
})

describe("headless formatter subagent event handling", () => {
  it("streams scoped child tool evidence without mixing root accounting or colliding IDs", () => {
    captureStdout()
    const formatter = createFormatter("stream-json", false)
    for (const path of [undefined, ["child-a"], ["child-b", "grandchild"]]) {
      formatter.onEvent({ type: "content_final", kind: "tool_call", id: "same-id", step: 1,
        toolName: "http_fetch", arguments: { url: `https://example.test/${path?.join("/") ?? "root"}` }, path })
    }
    for (const path of [["child-b", "grandchild"], undefined, ["child-a"]]) {
      formatter.onEvent({ type: "content_final", kind: "tool_result", id: "same-id", step: 1,
        toolName: "http_fetch", result: { success: true, output: "observed " + (path?.join("/") ?? "root") }, path })
    }
    const lines = captured.trim().split("\n").map(line => JSON.parse(line))
    expect(lines.map(line => line.type)).toEqual(["tool_use", "subagent_tool_use", "subagent_tool_use", "subagent_tool_result", "tool_result", "subagent_tool_result"])
    expect(lines[1].path).toEqual(["child-a"])
    expect(lines[2].path).toEqual(["child-b", "grandchild"])
    expect(lines[3].preview).toBe("observed child-b/grandchild")
    expect(lines[5].preview).toBe("observed child-a")
    formatter.finalize({ ok: true, text: "done", sessionId: "test", turns: 1,
      usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [], stopReason: "end_turn" })
    const final = JSON.parse(captured.trim().split("\n").at(-1)!)
    expect(final.toolCalls).toHaveLength(1)
    expect(final.toolCalls[0].args).toEqual({ url: "https://example.test/root" })
  })

  it("records abandoned thinking with its identity and unknown usage", () => {
    captureStdout()
    const event = { type: "content_abandoned" as const, kind: "thinking" as const, id: "old", step: 1,
      attempt: 1, reason: "CONNECTION_ERROR", usageUnknown: true as const }
    createFormatter("stream-json", false).onEvent(event)
    expect(JSON.parse(captured)).toEqual(event)
  })
  it("streams only the parent agent tool boundary and suppresses nested subagent chatter", () => {
    captureStdout()
    const formatter = createFormatter("stream-json", false)

    formatter.onEvent({
      type: "content_final",
      kind: "tool_call",
      id: "call_agent",
      step: 1,
      toolName: "agent",
      arguments: { task: "inspect cache handling" },
    })
    formatter.onEvent({
      type: "content_delta",
      kind: "text",
      id: "child_text",
      text: "internal child stream",
      path: ["sa_general_x"],
    })
    formatter.onEvent({
      type: "content_final",
      kind: "tool_result",
      id: "call_agent",
      step: 1,
      toolName: "agent",
      result: { success: true, output: "subagent summary" },
    })

    const lines = captured.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    expect(lines.map((line) => line.type)).toEqual(["tool_use", "tool_result"])
    expect(JSON.stringify(lines)).not.toContain("internal child stream")
    expect(lines[0].name).toBe("agent")
    expect(lines[1].preview).toBe("subagent summary")
  })
})

describe("headless formatter tool result previews", () => {
  it("retains sources beyond a child preview without changing the preview or model output", () => {
    captureStdout()
    const output = "ordinary documentation ".repeat(40) + "https://user:password@example.test/other/trace?token=private#fragment"
    createFormatter("stream-json", false).onEvent({ type: "content_final", kind: "tool_result", path: ["child", "grandchild"],
      id: "source", step: 1, toolName: "web_search", result: { success: true, output } })
    const line = JSON.parse(captured.trim())
    expect(line.type).toBe("subagent_tool_result")
    expect(line.path).toEqual(["child", "grandchild"])
    expect(line.preview).not.toContain("example.test")
    expect(line.sourceUrls.urls).toEqual(["https://example.test/other/trace"])
    expect(line.sourceUrls.complete).toBe(true)
    expect(JSON.stringify(line.sourceUrls)).not.toContain("password")
    expect(JSON.stringify(line.sourceUrls)).not.toContain("private")
  })

  it("preserves structured failure attribution rather than inferring sandbox denial from text", () => {
    captureStdout()
    const failure = operationFailure("EXECUTION_FAILED", "unknown", "execution:tool_1")
    createFormatter("stream-json", false).onEvent({ type: "content_final", kind: "tool_result",
      id: "tool_1", step: 1, toolName: "bash",
      result: { success: false, output: "", error: "sandbox denied", failure } })
    const [line] = captured.trim().split("\n").map(entry => JSON.parse(entry))
    expect(line.failure).toEqual(failure)
    expect(line.error).toBe("sandbox denied")
    expect(line.ok).toBe(false)
  })
  it("does not truncate when only UTF-16 code units exceed the preview cap", () => {
    captureStdout()
    const formatter = createFormatter("stream-json", false)
    const output = "😀".repeat(120)

    formatter.onEvent({
      type: "content_final",
      kind: "tool_result",
      id: "tool_1",
      step: 1,
      toolName: "bash",
      result: { success: true, output },
    })

    const [line] = captured.trim().split("\n").filter(Boolean).map((entry) => JSON.parse(entry))
    expect(line.preview).toBe(output)
  })

  it("does not split non-BMP characters when truncating tool result previews", () => {
    captureStdout()
    const formatter = createFormatter("stream-json", false)

    formatter.onEvent({
      type: "content_final",
      kind: "tool_result",
      id: "tool_1",
      step: 1,
      toolName: "bash",
      result: { success: true, output: "😀".repeat(250) },
    })

    const [line] = captured.trim().split("\n").filter(Boolean).map((entry) => JSON.parse(entry))
    expect(line.preview).toBe(`${"😀".repeat(199)}…`)
    expect(hasUnpairedSurrogate(line.preview)).toBe(false)
  })
})

describe("headless formatter context diagnostics", () => {
  it("streams root run_step context diagnostics without memory contents", () => {
    captureStdout()
    const formatter = createFormatter("stream-json", false)

    formatter.onEvent({
      type: "run_step",
      step: 2,
      messageCount: 5,
      context: {
        totalChars: 400,
        estimatedTokens: 100,
        hash: "ctxhash",
        segments: [
          {
            name: "memory_index",
            chars: 200,
            estimatedTokens: 50,
            hash: "memhash",
            meta: { included: ["a.md"] },
          },
        ],
      },
    })

    const [line] = captured.trim().split("\n").filter(Boolean).map((entry) => JSON.parse(entry))
    expect(line.type).toBe("context")
    expect(line.step).toBe(2)
    expect(line.messageCount).toBe(5)
    expect(line.context.hash).toBe("ctxhash")
    expect(line.context.segments[0].hash).toBe("memhash")
    expect(JSON.stringify(line)).not.toContain("Persistent memory")
  })

  it("does not stream nested subagent context diagnostics", () => {
    captureStdout()
    const formatter = createFormatter("stream-json", false)

    formatter.onEvent({
      type: "run_step",
      step: 1,
      messageCount: 2,
      path: ["sa_1"],
      context: {
        totalChars: 400,
        estimatedTokens: 100,
        hash: "childctx",
        segments: [],
      },
    })

    expect(captured).toBe("")
  })
})

describe("headless formatter usage output", () => {
  it("does not invent cache usage fields when summary usage has none", () => {
    captureStdout()
    const formatter = createFormatter("json", false)

    formatter.finalize({
      ok: false,
      text: "",
      sessionId: "s1",
      turns: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      toolCalls: [],
      stopReason: "error",
      error: "boom",
    })

    const result = JSON.parse(captured)
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect("cacheReadInputTokens" in result.usage).toBe(false)
    expect("cacheCreationInputTokens" in result.usage).toBe(false)
  })
})

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}


describe("headless completion assessment", () => {
  it("exposes delivery evidence independently from process success", () => {
    captureStdout()
    const formatter = createFormatter("json", false)
    const completion = assessCompletion({ text: "done", steps: 1, toolResults: [],
      totalUsage: { inputTokens: 1, outputTokens: 1 } }, { requirements: [{ kind: "artifact", path: "/workspace/output" }] })
    formatter.finalize({ ok: true, text: "done", sessionId: "s", turns: 1,
      usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [], stopReason: "end_turn", completion })
    const output = JSON.parse(captured)
    expect(output.ok).toBe(true)
    expect(output.completion.status).toBe("incomplete")
    expect(output.completion.modelClaimedSuccess).toBe(true)
    expect(output.completion.evidenceState).toBe("missing")
  })
})


describe("headless command observations", () => {
  it("retains the real exit code when the tool accepts grep no-match", () => {
    captureStdout()
    const formatter = createFormatter("stream-json", false)
    formatter.onEvent({ type: "content_final", kind: "tool_result", id: "grep", step: 1, toolName: "bash",
      result: { success: true, output: "no matches", runtime: { command: { commandRef: "grep-receipt", exitCode: 1, timedOut: false, aborted: false } } } })
    const output = JSON.parse(captured.trim())
    expect(output.ok).toBe(true)
    expect(output.command.exitCode).toBe(1)
    expect(output.verification).toBeUndefined()
  })
})

it("emits a single versioned limited result without a legacy completion or false error", async () => {
  const { classifyExecution, classifyObservedAcceptance } = await import("../../zapsdk/runtime/outcome.js")
  const loopResult = { text: "partial work", steps: 2, toolResults: [], stopped: "budget" as const, totalUsage: { inputTokens: 2, outputTokens: 1 } }
  const outcome = { schema: "zap.outcome" as const, schemaVersion: 1 as const, threadId: "thread", turnId: "turn", runId: "run", attemptId: "run", startedAt: 1, endedAt: 2,
    execution: classifyExecution({ attemptId: "run", result: loopResult }), acceptance: classifyObservedAcceptance("run", loopResult, 2),
    workflow: { attemptId: "run", status: "not_requested" as const, controlRevision: 0, code: "WORKFLOW_NOT_CONFIGURED" } }
  for (const format of ["json", "stream-json"] as const) {
    captureStdout()
    const formatter = createFormatter(format, false, "outcome-v1")
    formatter.init({ sessionId: "thread", provider: "fixture", model: "fixture" })
    formatter.finalize({ ok: false, text: loopResult.text, sessionId: "thread", turns: 2, usage: loopResult.totalUsage, toolCalls: [], stopReason: "budget", outcome })
    const records = format === "json" ? [JSON.parse(captured)] : captured.trim().split("\n").map(line => JSON.parse(line))
    expect(records.filter(record => record.type === "result")).toHaveLength(1)
    const final = records.at(-1)
    expect(final).toMatchObject({ type: "result", schema: "zap.outcome", schemaVersion: 1, ok: false, stopReason: "budget", execution: { status: "limited" } })
    expect(final.completion).toBeUndefined()
    expect(final.error).toBeUndefined()
  }
})

it("prints the execution fault in text mode without requiring a legacy error projection", async () => {
  const { classifyExecution, classifyObservedAcceptance } = await import("../../zapsdk/runtime/outcome.js")
  const result = { text: "", steps: 0, toolResults: [], totalUsage: { inputTokens: 0, outputTokens: 0 } }
  const outcome = { schema: "zap.outcome" as const, schemaVersion: 1 as const, threadId: "t", turnId: "turn", runId: "r", attemptId: "r", startedAt: 1, endedAt: 2,
    execution: classifyExecution({ attemptId: "r", result, error: new Error("provider connection failed") }), acceptance: classifyObservedAcceptance("r", result, 2),
    workflow: { attemptId: "r", status: "not_requested" as const, controlRevision: 0, code: "WORKFLOW_NOT_CONFIGURED" } }
  let stderr = ""
  const original = process.stderr.write
  process.stderr.write = ((text: string) => { stderr += text; return true }) as typeof process.stderr.write
  try {
    createFormatter("text", true, "outcome-v1").finalize({ outcome, ok: false, text: "", sessionId: "t", turns: 0, usage: result.totalUsage, toolCalls: [], stopReason: "error" })
    expect(stderr).toContain("provider connection failed")
  } finally { process.stderr.write = original }
})


it("records provider lifecycle timing in stream-json diagnostics", () => {
  captureStdout()
  createFormatter("stream-json", false).onEvent({ type: "provider_request", step: 2,
    request: { phase: "failed", attempt: 1, maxAttempts: 3, startedAt: 100, at: 125, elapsedMs: 25, reason: "AbortError" } })
  expect(JSON.parse(captured)).toEqual({ type: "observation", kind: "provider_request", detail: {
    step: 2, phase: "failed", attempt: 1, maxAttempts: 3, startedAt: 100, at: 125, elapsedMs: 25, reason: "AbortError",
  } })
})


it("preserves root and child service owner receipts and unknown operations in stream records", () => {
  captureStdout()
  const formatter = createFormatter("stream-json", false)
  const service = { version: 1 as const, backendId: "backend", ownerId: "owner", ownerGeneration: "g1", workspaceId: "w", ownerScope: "environment" as const,
    operationId: "op", serviceId: "service", requestDigest: "a".repeat(64), state: "running" as const, observedAt: 1, expiresAt: 100 }
  const operation = { version: 1 as const, executionId: "execution:op", kind: "start" as const, backendId: "backend", ownerId: "owner", ownerGeneration: "g1", workspaceId: "w", ownerScope: "environment" as const,
    operationId: "op", state: "unknown" as const, observedAt: 1 }
  for (const path of [undefined, ["child"]]) formatter.onEvent({ type: "content_final", kind: "tool_result", id: "op", step: 1, path,
    toolName: "service_start", result: { success: true, output: "receipt", runtime: { service, serviceOperation: operation } } })
  const frames = captured.trim().split("\n").map(line => JSON.parse(line))
  expect(frames.map(f => f.type)).toEqual(["tool_result", "subagent_tool_result"])
  for (const frame of frames) { expect(frame.service).toEqual(service); expect(frame.serviceOperation).toEqual(operation) }
})
