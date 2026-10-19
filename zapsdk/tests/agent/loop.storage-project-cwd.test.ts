import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LoopAgent } from "../../agent/loop.js"
import { ToolRegistry } from "../../tools/registry.js"
import { ToolExecutor } from "../../tools/executor.js"
import { ConversationManager } from "../../memory/conversation.js"
import { resolveProjectDataSegment } from "../../utils/project-paths.js"
import {
  PERSIST_THRESHOLD_CHARS,
  readPersistedOutput,
} from "../../utils/tool-result-storage.js"
import { countCodePoints } from "../../utils/logical-lines.js"
import { ResultCompressor } from "../../context/result-compressor.js"
import type { LLMProvider } from "../../core/llm.js"
import type { LLMResponse } from "../../core/types.js"
import type { AgentEvent } from "../../agent/events.js"
import { operationFailure } from "../../execution/failure.js"

const dummyProvider: LLMProvider = {
  async call(): Promise<LLMResponse> {
    throw new Error("not used in this test")
  },
}

describe("LoopAgent oversized tool output storage", () => {
  let dataDir: string
  let projectCwd: string
  let previousDataDir: string | undefined

  beforeEach(() => {
    previousDataDir = process.env.ZAPCODE_DATA_DIR
    dataDir = mkdtempSync(join(tmpdir(), "zap-loop-storage-"))
    projectCwd = mkdtempSync(join(tmpdir(), "zap-loop-project-"))
    process.env.ZAPCODE_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR
    else process.env.ZAPCODE_DATA_DIR = previousDataDir
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(projectCwd, { recursive: true, force: true })
  })

  it("persists large tool results under the configured project cwd", () => {
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 100 })
    const agent = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      storageSessionId: "session-a",
      storageProjectCwd: projectCwd,
    }) as any

    const big = "a".repeat(PERSIST_THRESHOLD_CHARS + 1)
    const formatted = agent.formatResult(
      { id: "tc-1", name: "read_file", arguments: { path: "large.txt" } },
      { success: true, output: big },
      new Map(),
      new Map(),
    ).formattedOutput as string

    const expectedPath = join(
      dataDir,
      "projects",
      resolveProjectDataSegment(projectCwd),
      "tool-outputs",
      "session-a",
      "tc-1.txt",
    )

    expect(existsSync(expectedPath)).toBe(true)
    expect(readPersistedOutput(expectedPath)).toBe(big)
    expect(formatted).toContain(expectedPath)
    expect(formatted).toContain(`${big.length} chars persisted`)
  })

  it("persists the full output before applying an optional lossy compressor", () => {
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 100 })
    const agent = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      resultCompressor: new ResultCompressor({ maxTokens: 100 }),
      storageSessionId: "session-compressor-order",
      storageProjectCwd: projectCwd,
    }) as any
    const output = `HEAD:${"x".repeat(PERSIST_THRESHOLD_CHARS + 1)}:TAIL`

    const formatted = agent.formatResult(
      { id: "tc-compressor-order", name: "bash", arguments: { command: "verbose" } },
      { success: true, output },
      new Map(),
      new Map(),
    ).formattedOutput as string
    const expectedPath = join(
      dataDir,
      "projects",
      resolveProjectDataSegment(projectCwd),
      "tool-outputs",
      "session-compressor-order",
      "tc-compressor-order.txt",
    )

    expect(readPersistedOutput(expectedPath)).toBe(output)
    expect(formatted).toContain(expectedPath)
    expect(formatted).not.toContain("[truncated ~")
  })

  it("reports persisted tool result sizes by Unicode code point", () => {
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 100 })
    const agent = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      storageSessionId: "session-emoji",
      storageProjectCwd: projectCwd,
    }) as any

    const big = "😀".repeat(PERSIST_THRESHOLD_CHARS)
    const formatted = agent.formatResult(
      { id: "tc-emoji", name: "read_file", arguments: { path: "emoji.txt" } },
      { success: true, output: big },
      new Map(),
      new Map(),
    ).formattedOutput as string

    const expectedPath = join(
      dataDir,
      "projects",
      resolveProjectDataSegment(projectCwd),
      "tool-outputs",
      "session-emoji",
      "tc-emoji.txt",
    )

    expect(existsSync(expectedPath)).toBe(true)
    expect(readPersistedOutput(expectedPath)).toBe(big)
    expect(formatted).toContain(`${PERSIST_THRESHOLD_CHARS} chars persisted`)
    expect(formatted).not.toContain(`${big.length} chars persisted`)
  })

  it("persists a sub-threshold result that would dominate a small context window", () => {
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 100 })
    const agent = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      contextWindow: 32_000,
      storageSessionId: "session-small-context",
      storageProjectCwd: projectCwd,
    }) as any

    const output = "diagnostic output line\n".repeat(1_000)
    expect(countCodePoints(output)).toBeLessThan(PERSIST_THRESHOLD_CHARS)
    const formatted = agent.formatResult(
      { id: "tc-small-context", name: "bash", arguments: { command: "verbose-check" } },
      { success: true, output },
      new Map(),
      new Map(),
    ).formattedOutput as string
    const expectedPath = join(
      dataDir,
      "projects",
      resolveProjectDataSegment(projectCwd),
      "tool-outputs",
      "session-small-context",
      "tc-small-context.txt",
    )

    expect(existsSync(expectedPath)).toBe(true)
    expect(readPersistedOutput(expectedPath)).toBe(output)
    expect(formatted).toContain("chars persisted")
    expect(formatted).toContain("Use read_tool_output")
    expect(formatted).toContain("offset/limit are Unicode character counts")
  })

  it("bounds and reports oversized output when storage fails", () => {
    const blockedRoot = join(dataDir, "not-a-directory")
    writeFileSync(blockedRoot, "blocked")
    process.env.ZAPCODE_DATA_DIR = blockedRoot
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 100 })
    const agent = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      storageSessionId: "session-storage-failure",
      storageProjectCwd: projectCwd,
    }) as any
    const observations: AgentEvent[] = []
    agent.on("observation", (event: AgentEvent) => observations.push(event))
    const output = `HEAD:${"x".repeat(PERSIST_THRESHOLD_CHARS + 1)}:TAIL`

    try {
      const formatted = agent.formatResult(
        { id: "tc-storage-failure", name: "bash", arguments: { command: "verbose" } },
        { success: true, output },
        new Map(),
        new Map(),
      ).formattedOutput as string

      expect(formatted.length).toBeLessThan(output.length / 2)
      expect(formatted).toContain("HEAD:")
      expect(formatted).toContain(":TAIL")
      expect(formatted).toContain('status="unavailable"')
      expect(observations).toHaveLength(1)
      expect(observations[0]).toMatchObject({
        type: "observation",
        kind: "tool_result_storage_failed",
        detail: {
          tool: "bash",
          fullChars: countCodePoints(output),
        },
      })
    } finally {
      process.env.ZAPCODE_DATA_DIR = dataDir
    }
  })

  it("keeps a small result inline when it stays below the context share", () => {
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 100 })
    const agent = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      contextWindow: 32_000,
      storageSessionId: "session-inline",
      storageProjectCwd: projectCwd,
    }) as any
    const output = "short diagnostic output"
    const formatted = agent.formatResult(
      { id: "tc-inline", name: "bash", arguments: { command: "quick-check" } },
      { success: true, output },
      new Map(),
      new Map(),
    ).formattedOutput as string
    const unexpectedPath = join(
      dataDir,
      "projects",
      resolveProjectDataSegment(projectCwd),
      "tool-outputs",
      "session-inline",
      "tc-inline.txt",
    )

    expect(existsSync(unexpectedPath)).toBe(false)
    expect(formatted).toContain(output)
    expect(formatted).not.toContain("persisted-output")
  })

  it("persists oversized failed tool results instead of keeping huge stderr inline", () => {
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 100 })
    const agent = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      storageSessionId: "session-error",
      storageProjectCwd: projectCwd,
    }) as any

    const bigError = "stderr ".repeat(PERSIST_THRESHOLD_CHARS)
    const formatted = agent.formatResult(
      { id: "tc-error", name: "bash", arguments: { command: "failing command" } },
      { success: false, output: "", error: bigError, failure: operationFailure("BACKEND_UNAVAILABLE", "backend") },
      new Map(),
      new Map(),
    ).formattedOutput as string

    const expectedPath = join(
      dataDir,
      "projects",
      resolveProjectDataSegment(projectCwd),
      "tool-outputs",
      "session-error",
      "tc-error.txt",
    )

    expect(existsSync(expectedPath)).toBe(true)
    expect(readPersistedOutput(expectedPath)).toBe(`Error: ${bigError}`)
    expect(formatted).toContain(expectedPath)
    expect(formatted).toContain("chars in-context")
    expect(formatted).toContain(`${countCodePoints(`Error: ${bigError}`)} chars persisted`)
    expect(formatted).toContain('"code":"BACKEND_UNAVAILABLE"')
    expect(formatted).toContain('"source":"backend"')
    expect(formatted.length).toBeLessThan(bigError.length)
  })

  it("does not persist failed tool results only because UTF-16 code units exceed the threshold", () => {
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 100 })
    const agent = new LoopAgent({
      provider: dummyProvider,
      registry,
      executor,
      conversation,
      storageSessionId: "session-error-emoji",
      storageProjectCwd: projectCwd,
    }) as any

    const emojiError = "😀".repeat(PERSIST_THRESHOLD_CHARS - "Error: ".length - 1)
    const formatted = agent.formatResult(
      { id: "tc-error-emoji", name: "bash", arguments: { command: "emoji stderr" } },
      { success: false, output: "", error: emojiError },
      new Map(),
      new Map(),
    ).formattedOutput as string

    const unexpectedPath = join(
      dataDir,
      "projects",
      resolveProjectDataSegment(projectCwd),
      "tool-outputs",
      "session-error-emoji",
      "tc-error-emoji.txt",
    )

    expect(emojiError.length).toBeGreaterThan(PERSIST_THRESHOLD_CHARS)
    expect(existsSync(unexpectedPath)).toBe(false)
    expect(formatted).not.toContain("persisted")
    const landedContent = formatted.slice(formatted.indexOf("\n") + 1)
    expect(formatted).toContain(`${countCodePoints(landedContent)} chars`)
  })
})
