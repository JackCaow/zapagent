import { describe, it, expect } from "bun:test"
import { z } from "zod"
import { LoopAgent } from "../../agent/loop.js"
import { ToolRegistry } from "../../tools/registry.js"
import { ToolExecutor } from "../../tools/executor.js"
import { ConversationManager } from "../../memory/conversation.js"
import { todoWriteTool, type Todo, type TodoStore } from "../../builtin-tools/todo.js"
import type { LLMProvider } from "../../core/llm.js"
import type { LLMChunk, LLMResponse } from "../../core/types.js"
import { OperationFailureSchema } from "../../execution/contracts.js"
import { stepSignature } from "../../agent/tool-execution-guards.js"

// Provider that streams `count` identical tool calls (same tool, same primary
// arg) then a no-tool text turn so the loop can terminate naturally. Used to
// drive the repeat-guard tests without hitting maxSteps.
function makeRepeatingProvider(toolName: string, args: Record<string, unknown>, count: number, finalText: string): LLMProvider {
  let id = 0
  let turn = 0
  return {
    async call(): Promise<LLMResponse> {
      // forceFinish (post-REPEAT_LIMIT) calls call() with tools=[] expecting
      // a plain-text synthesis. Always return the synthesis so any test that
      // exercises the non-friendly path can assert the synthesized text.
      return {
        type: "text" as const,
        text: finalText,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      }
    },
    async *stream(): AsyncIterable<LLMChunk> {
      const callId = `t${++id}`
      if (turn >= count) {
        // Bail out cleanly so the run terminates without forceFinish if the
        // repeat guard never fired (e.g. the whitelist case).
        yield { type: "text_delta", text: finalText }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
        return
      }
      turn++
      yield { type: "tool_call_start", toolCallId: callId, toolName }
      yield { type: "tool_call_delta", toolCallId: callId, partialJson: JSON.stringify(args) }
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" }
    },
  }
}

function makeFakeTool(name: string, schema: z.ZodType) {
  return {
    definition: { name, description: "fake", parameters: schema },
    handler: async () => ({ success: true, output: "ok" }),
  }
}

describe("LoopAgent repeat guard", () => {
  it("does not terminate distinct long commands that share their first 120 characters", async () => {
    const prefix = `python3 - <<'PY'\n# ${"shared setup ".repeat(20)}\n`
    let calls = 0
    const executed: string[] = []
    const provider: LLMProvider = {
      async call() { throw new Error("distinct commands must not force finish") },
      async *stream(): AsyncIterable<LLMChunk> {
        if (calls === 7) {
          yield { type: "text_delta", text: "verified" }
        } else {
          const id = `probe-${calls++}`
          yield { type: "tool_call_start", toolCallId: id, toolName: "bash" }
          yield { type: "tool_call_delta", toolCallId: id,
            partialJson: JSON.stringify({ command: `${prefix}print(${calls})\nPY` }) }
        }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const registry = new ToolRegistry()
    registry.register({ definition: { name: "bash", description: "probe", parameters: z.object({ command: z.string() }) },
      handler: async args => { executed.push(String(args.command)); return { success: true, output: "observed" } } })
    const agent = new LoopAgent({ provider, registry, executor: new ToolExecutor(registry), maxSteps: 12 })
    const completed = await agent.run("Run independent probes")
    expect(executed).toHaveLength(7)
    expect(new Set(executed.map(command => command.slice(0, 120))).size).toBe(1)
    expect(completed.stopped).toBeUndefined()
    expect(completed.text).toBe("verified")
  })

  it("uses complete arguments with stable object keys and ordered arrays for repetition identity", () => {
    const sig = (args: Record<string, unknown>) => stepSignature([{ name: "custom", arguments: args }])
    expect(sig({ path: "same", options: { a: 1, b: 2 } })).toBe(sig({ options: { b: 2, a: 1 }, path: "same" }))
    expect(sig({ path: "same", content: "first" })).not.toBe(sig({ path: "same", content: "second" }))
    expect(sig({ enum: ["a", "b"] })).not.toBe(sig({ enum: ["b", "a"] }))
    expect(sig(JSON.parse('{"__proto__":{"value":1}}'))).not.toBe(sig({}))
  })

  it("requires a small executable plan before constrained runs mutate the workspace", async () => {
    let applyExecutions = 0
    let currentTodos: Todo[] = []
    const todoStore: TodoStore = {
      get: () => currentTodos,
      set: (_key, _old, next) => { currentTodos = next },
    }
    const actions = [
      { name: "inspect", args: { path: "src/main.ts" } },
      { name: "apply", args: { path: "src/main.ts" } },
      {
        name: "todo_write",
        args: {
          todos: [
            {
              content: "Inspect the failing path and run a minimal smoke probe",
              activeForm: "Inspecting the failing path",
              status: "in_progress",
              acceptanceCriteria: "The minimal smoke probe reproduces the failure once.",
              contingency: "If the probe cannot run after two attempts, inspect its missing dependency instead.",
            },
            {
              content: "Implement the smallest fix",
              activeForm: "Implementing the smallest fix",
              status: "pending",
              acceptanceCriteria: "Only the failing source path is changed.",
            },
            {
              content: "Verify the targeted behavior",
              activeForm: "Verifying the targeted behavior",
              status: "pending",
              acceptanceCriteria: "The targeted test passes.",
            },
          ],
        },
      },
      { name: "apply", args: { path: "src/main.ts" } },
    ]
    let turn = 0
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        return { type: "text", text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
      },
      async *stream(): AsyncIterable<LLMChunk> {
        const action = actions[turn++]
        if (!action) {
          yield { type: "text_delta", text: "done" }
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
          return
        }
        yield { type: "tool_call_start", toolCallId: `plan-${turn}`, toolName: action.name }
        yield { type: "tool_call_delta", toolCallId: `plan-${turn}`, partialJson: JSON.stringify(action.args) }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" }
      },
    }
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "inspect", description: "inspect", parameters: z.object({ path: z.string() }), readOnly: true },
      handler: async () => ({ success: true, output: "baseline" }),
    })
    registry.register({
      definition: { name: "apply", description: "apply", parameters: z.object({ path: z.string() }) },
      handler: async () => {
        applyExecutions++
        return { success: true, output: "changed" }
      },
    })
    registry.register(todoWriteTool({ store: todoStore }))
    const conversation = new ConversationManager({ maxMessages: 200 })
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      conversation,
      systemPrompt: "test",
      maxSteps: 8,
      taskDecomposition: "required",
    })

    const result = await agent.run("Fix the implementation and verify it")

    expect(applyExecutions).toBe(1)
    expect(currentTodos).toHaveLength(3)
    const blocked = result.toolResults.find(result => !result.success)!
    expect(OperationFailureSchema.parse(blocked.failure)).toMatchObject({ code: "TASK_PLAN_REQUIRED", source: "harness", retryable: false })
    expect(blocked.runtime?.execution).toBeUndefined()
    expect(conversation.getMessages().some((message) =>
      message.content.includes("Task decomposition required")
    )).toBe(true)
  })

  it("auto planning does not synthesize failures or mandatory todos for a short task", async () => {
    let executions = 0
    let todos: Todo[] = []
    const registry = new ToolRegistry()
    registry.register({ definition: { name: "apply", description: "apply", parameters: z.object({ path: z.string() }) },
      handler: async () => { executions++; return { success: true, output: "changed" } } })
    registry.register(todoWriteTool({ store: { get: () => todos, set: (_key, _old, next) => { todos = next } } }))
    const agent = new LoopAgent({ registry, executor: new ToolExecutor(registry), maxSteps: 6, taskDecomposition: "auto",
      provider: makeRepeatingProvider("apply", { path: "index.html" }, 3, "done") })
    const result = await agent.run("Make a small change and verify")
    expect(executions).toBe(3)
    expect(result.toolResults.every(result => result.success)).toBe(true)
    expect(todos).toEqual([])
  })

  it("suppresses exact repeated reads until a mutation succeeds", async () => {
    let readExecutions = 0
    const provider = makeRepeatingProvider("read_file", { path: "src/a.ts" }, 2, "done")
    const registry = new ToolRegistry()
    registry.register({
      definition: {
        name: "read_file",
        description: "read",
        parameters: z.object({ path: z.string() }),
        readOnly: true,
      },
      handler: async () => {
        readExecutions++
        return { success: true, output: "file contents" }
      },
    })
    const conversation = new ConversationManager({ maxMessages: 200 })
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      conversation,
      systemPrompt: "test",
      maxSteps: 5,
    })

    const result = await agent.run("read once")

    expect(result.text).toBe("done")
    expect(readExecutions).toBe(1)
    expect(conversation.getMessages().some((message) =>
      message.content.includes("Duplicate read_file suppressed")
    )).toBe(true)
  })

  it("suppresses exact repeated searches while the workspace is unchanged", async () => {
    let searchExecutions = 0
    const provider = makeRepeatingProvider("search_files", { query: "AgentRuntime" }, 2, "done")
    const registry = new ToolRegistry()
    registry.register({
      definition: {
        name: "search_files",
        description: "search",
        parameters: z.object({ query: z.string() }),
        readOnly: true,
      },
      handler: async () => {
        searchExecutions++
        return { success: true, output: "src/runtime.ts:1:AgentRuntime" }
      },
    })
    const conversation = new ConversationManager({ maxMessages: 200 })
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      conversation,
      systemPrompt: "test",
      maxSteps: 5,
    })

    const result = await agent.run("search once")

    expect(result.text).toBe("done")
    expect(searchExecutions).toBe(1)
    expect(conversation.getMessages().some((message) =>
      message.content.includes("Duplicate search_files suppressed")
    )).toBe(true)
  })

  it("suppresses a repeated conservative bash inspection command", async () => {
    let bashExecutions = 0
    const provider = makeRepeatingProvider("bash", { command: "git status --short" }, 2, "done")
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "bash", description: "shell", parameters: z.object({ command: z.string() }) },
      handler: async () => {
        bashExecutions++
        return { success: true, output: " M zapsdk/agent/loop.ts" }
      },
    })
    const conversation = new ConversationManager({ maxMessages: 200 })
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      conversation,
      systemPrompt: "test",
      maxSteps: 5,
    })

    await agent.run("inspect once")

    expect(bashExecutions).toBe(1)
    expect(conversation.getMessages().some((message) =>
      message.content.includes("Duplicate bash suppressed")
    )).toBe(true)
  })

  it("executes a corrected compiler command for the same output target", async () => {
    let buildExecutions = 0
    let turn = 0
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        return { type: "text", text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
      },
      async *stream(): AsyncIterable<LLMChunk> {
        const commands = [
          "gcc -o /tmp/app main.o",
          "gcc -o /tmp/app main.o -lm",
        ]
        if (turn >= commands.length) {
          yield { type: "text_delta", text: "done" }
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
          return
        }
        const id = `build-${turn}`
        yield { type: "tool_call_start", toolCallId: id, toolName: "bash" }
        yield { type: "tool_call_delta", toolCallId: id, partialJson: JSON.stringify({ command: commands[turn++] }) }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" }
      },
    }
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "bash", description: "shell", parameters: z.object({ command: z.string() }) },
      handler: async () => {
        buildExecutions++
        return buildExecutions === 1
          ? { success: false, output: "undefined reference to round" }
          : { success: true, output: "linked" }
      },
    })
    const conversation = new ConversationManager({ maxMessages: 200 })
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      conversation,
      systemPrompt: "test",
      maxSteps: 5,
    })

    await agent.run("build the target")

    expect(buildExecutions).toBe(2)
    expect(conversation.getMessages().some((message) =>
      message.content.includes("Repeated build target /tmp/app suppressed")
    )).toBe(false)
  })

  it("allows a failed build target after a successful source edit", async () => {
    let buildExecutions = 0
    let turn = 0
    const actions = [
      { name: "bash", args: { command: "gcc -o /tmp/app main.o" } },
      { name: "edit_file", args: { path: "main.c", old_string: "old", new_string: "fixed" } },
      { name: "bash", args: { command: "gcc -o /tmp/app main.o util.o" } },
    ]
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        return { type: "text", text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
      },
      async *stream(): AsyncIterable<LLMChunk> {
        const action = actions[turn++]
        if (!action) {
          yield { type: "text_delta", text: "done" }
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
          return
        }
        const id = `action-${turn}`
        yield { type: "tool_call_start", toolCallId: id, toolName: action.name }
        yield { type: "tool_call_delta", toolCallId: id, partialJson: JSON.stringify(action.args) }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" }
      },
    }
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "bash", description: "shell", parameters: z.object({ command: z.string() }) },
      handler: async () => {
        buildExecutions++
        return { success: false, output: "undefined reference to missing_symbol" }
      },
    })
    registry.register({
      definition: {
        name: "edit_file",
        description: "edit",
        parameters: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
      },
      handler: async () => ({ success: true, output: "updated main.c" }),
    })
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      systemPrompt: "test",
      maxSteps: 5,
    })

    await agent.run("build the target")

    expect(buildExecutions).toBe(2)
  })

  it("suppresses the fixed read-only sed line-range form", async () => {
    let bashExecutions = 0
    const provider = makeRepeatingProvider("bash", { command: "sed -n '1,40p' src/a.ts" }, 2, "done")
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "bash", description: "shell", parameters: z.object({ command: z.string() }) },
      handler: async () => {
        bashExecutions++
        return { success: true, output: "source" }
      },
    })
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      systemPrompt: "test",
      maxSteps: 5,
    })

    await agent.run("inspect source once")

    expect(bashExecutions).toBe(1)
  })

  it("does not memoize shell-composed or potentially mutating bash commands", async () => {
    let bashExecutions = 0
    const provider = makeRepeatingProvider("bash", { command: "git status && echo done" }, 2, "done")
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "bash", description: "shell", parameters: z.object({ command: z.string() }) },
      handler: async () => {
        bashExecutions++
        return { success: true, output: "done" }
      },
    })
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      systemPrompt: "test",
      maxSteps: 5,
    })

    await agent.run("run composed shell command")

    expect(bashExecutions).toBe(2)
  })

  it("does not treat a cd prefix with shell expansion as read-only", async () => {
    let bashExecutions = 0
    const provider = makeRepeatingProvider(
      "bash",
      { command: "cd \"$(touch should-not-be-classified)\" && git status --short" },
      2,
      "done",
    )
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "bash", description: "shell", parameters: z.object({ command: z.string() }) },
      handler: async () => {
        bashExecutions++
        return { success: true, output: "done" }
      },
    })
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      systemPrompt: "test",
      maxSteps: 5,
    })

    await agent.run("do not memoize shell expansion")

    expect(bashExecutions).toBe(2)
  })

  it("does not treat a potentially writing git subcommand as read-only", async () => {
    let bashExecutions = 0
    const provider = makeRepeatingProvider("bash", { command: "git branch -D stale" }, 2, "done")
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "bash", description: "shell", parameters: z.object({ command: z.string() }) },
      handler: async () => {
        bashExecutions++
        return { success: true, output: "done" }
      },
    })
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      systemPrompt: "test",
      maxSteps: 5,
    })

    await agent.run("do not memoize a branch deletion")

    expect(bashExecutions).toBe(2)
  })

  it("invalidates duplicate suppression after a successful mutation", async () => {
    const sequence = ["read_file", "write_file", "read_file"]
    let turn = 0
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        return { type: "text", text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
      },
      async *stream(): AsyncIterable<LLMChunk> {
        const name = sequence[turn]
        if (!name) {
          yield { type: "text_delta", text: "done" }
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
          return
        }
        const id = `call-${turn}`
        turn++
        yield { type: "tool_call_start", toolCallId: id, toolName: name }
        yield {
          type: "tool_call_delta",
          toolCallId: id,
          partialJson: JSON.stringify(name === "read_file"
            ? { path: "src/a.ts" }
            : { path: "src/a.ts", content: "changed" }),
        }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" }
      },
    }
    let reads = 0
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "read_file", description: "read", parameters: z.object({ path: z.string() }), readOnly: true },
      handler: async () => ({ success: true, output: `version ${++reads}` }),
    })
    registry.register({
      definition: {
        name: "write_file",
        description: "write",
        parameters: z.object({ path: z.string(), content: z.string() }),
        writesPath: (args) => [String(args.path)],
      },
      handler: async () => ({ success: true, output: "written" }),
    })
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      systemPrompt: "test",
      maxSteps: 5,
    })

    await agent.run("read, write, read")

    expect(reads).toBe(2)
  })

  it("fetches the same URL once per run, even across a workspace write, but refetches after a failure", async () => {
    const sequence: Array<[string, Record<string, unknown>]> = [
      ["http_fetch", { url: "https://example.com/a" }],
      ["write_file", { path: "x.txt", content: "c" }],
      ["http_fetch", { url: "https://example.com/a" }],
      ["http_fetch", { url: "https://example.com/b" }],
      ["http_fetch", { url: "https://example.com/b" }],
    ]
    let turn = 0
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> { return { type: "text", text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } } },
      async *stream(): AsyncIterable<LLMChunk> {
        const next = sequence[turn]
        if (!next) { yield { type: "text_delta", text: "done" }; yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }; return }
        const id = `call-${turn++}`
        yield { type: "tool_call_start", toolCallId: id, toolName: next[0] }
        yield { type: "tool_call_delta", toolCallId: id, partialJson: JSON.stringify(next[1]) }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" }
      },
    }
    const fetched: string[] = []
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "http_fetch", description: "fetch", parameters: z.object({ url: z.string() }), readOnly: true },
      // /b fails the first time: a failed fetch must not count as done.
      handler: async (args) => {
        const url = String(args.url); fetched.push(url)
        return url.endsWith("/b") && fetched.filter((u) => u === url).length === 1
          ? { success: false, output: "", error: "timeout" } : { success: true, output: "page" }
      },
    })
    registry.register({
      definition: { name: "write_file", description: "write", parameters: z.object({ path: z.string(), content: z.string() }), writesPath: (a) => [String(a.path)] },
      handler: async () => ({ success: true, output: "written" }),
    })
    const conversation = new ConversationManager({ maxMessages: 200 })
    await new LoopAgent({ provider, registry, executor: new ToolExecutor(registry, {}), conversation, systemPrompt: "test", maxSteps: 8 }).run("go")
    // /a once (the write in between does not reset it, the repeat is suppressed); /b twice (the first attempt failed, so the retry is allowed).
    expect(fetched).toEqual(["https://example.com/a", "https://example.com/b", "https://example.com/b"])
    expect(conversation.getMessages().filter((m) => m.content.includes("Duplicate http_fetch suppressed")).length).toBe(1)
  })

  it("runs a tool the model misspelled by one character", async () => {
    let ran = 0
    const provider = makeRepeatingProvider("http_f\u0444tch", { url: "https://example.com" }, 1, "done")
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "http_fetch", description: "fetch", parameters: z.object({ url: z.string() }), readOnly: true },
      handler: async () => { ran++; return { success: true, output: "page" } },
    })
    const result = await new LoopAgent({ provider, registry, executor: new ToolExecutor(registry, {}), systemPrompt: "test", maxSteps: 4 }).run("go")
    expect(result.text).toBe("done")
    expect(ran).toBe(1)
  })

  it("non-friendly tool repeated past REPEAT_LIMIT triggers forceFinish (no throw, stopped=max_repeat)", async () => {
    // 6 identical bash calls — past REPEAT_LIMIT (5). bash is NOT in the
    // repeat-friendly whitelist, so the guard fires; previously this would
    // throw, now it goes through forceFinish and completes cleanly.
    const provider = makeRepeatingProvider("bash", { command: "echo same" }, 6, "Synthesised summary after stuck loop.")
    const registry = new ToolRegistry()
    registry.register(makeFakeTool("bash", z.object({ command: z.string() })))
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 200 })
    const agent = new LoopAgent({
      provider,
      registry,
      executor,
      conversation,
      systemPrompt: "test",
      maxSteps: 50,
    })

    const result = await agent.run("loop on same bash forever")
    expect(result.stopped).toBe("max_repeat")
    expect(result.text).toContain("Synthesised summary")
    expect(conversation.getMessages().at(-1)).toMatchObject({
      role: "assistant",
      content: "Synthesised summary after stuck loop.",
    })
  })

  it("does not abort a repeated status poll while its observed output advances", async () => {
    let polls = 0
    const provider = makeRepeatingProvider(
      "bash",
      { command: "sleep 1; tail -1 /tmp/build.log; pgrep -f build" },
      7,
      "build completed",
    )
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "bash", description: "shell", parameters: z.object({ command: z.string() }) },
      handler: async () => ({ success: true, output: `compile phase ${++polls}` }),
    })
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      systemPrompt: "test",
      maxSteps: 10,
    })

    const result = await agent.run("wait for the build")

    expect(polls).toBe(7)
    expect(result.stopped).toBeUndefined()
    expect(result.text).toBe("build completed")
  })

  it("still stops an unchanged status poll so a contingency can take over", async () => {
    const provider = makeRepeatingProvider(
      "bash",
      { command: "sleep 1; tail -1 /tmp/build.log; pgrep -f build" },
      8,
      "use the fallback path",
    )
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "bash", description: "shell", parameters: z.object({ command: z.string() }) },
      handler: async () => ({ success: true, output: "still compiling" }),
    })
    const agent = new LoopAgent({
      provider,
      registry,
      executor: new ToolExecutor(registry, {}),
      systemPrompt: "test",
      maxSteps: 12,
    })

    const result = await agent.run("wait for the build")

    expect(result.stopped).toBe("max_repeat")
    expect(result.text).toBe("use the fallback path")
  })

  it("does not force-finish a freshly observed running task with unchanged output", async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "task_status", description: "wait", parameters: z.object({ task_id: z.string() }), readOnly: true },
      handler: async () => ({ success: true, output: "unchanged log", runtime: {
        taskObservation: { tasks: [{ taskId: "owned-task", status: "running" as const }] },
      } }),
    })
    const agent = new LoopAgent({ registry, executor: new ToolExecutor(registry), maxSteps: 12,
      provider: makeRepeatingProvider("task_status", { task_id: "owned-task" }, 8, "task finished") })
    const result = await agent.run("Wait for the running task")
    expect(result.stopped).toBeUndefined()
    expect(result.toolResults).toHaveLength(8)
  })

  it("still bounds live task waiting by the declared step budget", async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: "task_status", description: "wait", parameters: z.object({ task_id: z.string() }), readOnly: true },
      handler: async () => ({ success: true, output: "running", runtime: {
        taskObservation: { tasks: [{ taskId: "owned-task", status: "running" as const }] },
      } }),
    })
    const agent = new LoopAgent({ registry, executor: new ToolExecutor(registry), maxSteps: 7,
      provider: makeRepeatingProvider("task_status", { task_id: "owned-task" }, 20, "budget exhausted") })
    expect((await agent.run("Wait for the task")).stopped).toBe("max_steps")
  })

  it("does not trust running prose, another task's receipt, or an exited task as a live wait", async () => {
    for (const tasks of [undefined, [{ taskId: "other-task", status: "running" as const }], [{ taskId: "owned-task", status: "exited" as const }]]) {
      const registry = new ToolRegistry()
      registry.register({
        definition: { name: "task_status", description: "status", parameters: z.object({ task_id: z.string() }), readOnly: true },
        handler: async () => ({ success: true, output: '{"status":"running"}',
          ...(tasks ? { runtime: { taskObservation: { tasks } } } : {}) }),
      })
      const agent = new LoopAgent({ registry, executor: new ToolExecutor(registry), maxSteps: 12,
        provider: makeRepeatingProvider("task_status", { task_id: "owned-task" }, 8, "stopped repeating") })
      expect((await agent.run("Check the task")).stopped).toBe("max_repeat")
    }
  })

  it("forceFinish reports cache usage in both run_usage events and totalUsage", async () => {
    let id = 0
    let turn = 0
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        return {
          type: "text",
          text: "forced summary with cache",
          toolCalls: [],
          usage: {
            inputTokens: 2,
            cacheReadInputTokens: 80,
            cacheCreationInputTokens: 8,
            outputTokens: 3,
          },
          finishReason: "stop",
        }
      },
      async *stream(): AsyncIterable<LLMChunk> {
        const callId = `t${++id}`
        turn++
        yield { type: "tool_call_start", toolCallId: callId, toolName: "bash" }
        yield { type: "tool_call_delta", toolCallId: callId, partialJson: JSON.stringify({ command: "echo same" }) }
        yield {
          type: "done",
          usage: {
            inputTokens: 1,
            cacheReadInputTokens: 10,
            cacheCreationInputTokens: 1,
            outputTokens: 1,
          },
          finishReason: "tool_calls",
        }
      },
    }
    const registry = new ToolRegistry()
    registry.register(makeFakeTool("bash", z.object({ command: z.string() })))
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 200 })
    const agent = new LoopAgent({
      provider,
      registry,
      executor,
      conversation,
      systemPrompt: "test",
      maxSteps: 50,
    })
    const usageEvents: Array<{
      inputTokens: number
      cacheReadInputTokens?: number
      cacheCreationInputTokens?: number
      outputTokens: number
    }> = []
    agent.on("run_usage", (event) => {
      if (event.type === "run_usage") usageEvents.push(event)
    })

    const result = await agent.run("loop on same bash forever")

    expect(turn).toBeGreaterThanOrEqual(5)
    expect(result.stopped).toBe("max_repeat")
    expect(result.totalUsage.cacheReadInputTokens).toBe(10 * turn + 80)
    expect(result.totalUsage.cacheCreationInputTokens).toBe(1 * turn + 8)
    expect(usageEvents.at(-1)).toMatchObject({
      inputTokens: 2,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 8,
      outputTokens: 3,
    })
    expect(conversation.getMessages().at(-1)).toMatchObject({
      role: "assistant",
      content: "forced summary with cache",
    })
  })

  it("forceFinish sanitizes invalid usage before emitting events and totals", async () => {
    let id = 0
    let turn = 0
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        return {
          type: "text",
          text: "forced summary with sanitized usage",
          toolCalls: [],
          usage: {
            inputTokens: Number.NaN,
            cacheReadInputTokens: -80,
            cacheCreationInputTokens: 8,
            outputTokens: Number.POSITIVE_INFINITY,
            providerUsageReported: true,
          },
          finishReason: "stop",
        }
      },
      async *stream(): AsyncIterable<LLMChunk> {
        const callId = `t${++id}`
        turn++
        yield { type: "tool_call_start", toolCallId: callId, toolName: "bash" }
        yield { type: "tool_call_delta", toolCallId: callId, partialJson: JSON.stringify({ command: "echo same" }) }
        yield {
          type: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "tool_calls",
        }
      },
    }
    const registry = new ToolRegistry()
    registry.register(makeFakeTool("bash", z.object({ command: z.string() })))
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 200 })
    const agent = new LoopAgent({
      provider,
      registry,
      executor,
      conversation,
      systemPrompt: "test",
      maxSteps: 50,
    })
    const usageEvents: Array<{
      inputTokens: number
      cacheReadInputTokens?: number
      cacheCreationInputTokens?: number
      outputTokens: number
      providerUsageReported?: boolean
    }> = []
    agent.on("run_usage", (event) => {
      if (event.type === "run_usage") usageEvents.push(event)
    })

    const result = await agent.run("loop on same bash forever")

    expect(result.stopped).toBe("max_repeat")
    expect(result.totalUsage).toEqual({
      inputTokens: turn,
      outputTokens: turn,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 8,
      providerUsageReported: true,
    })
    expect(usageEvents.at(-1)).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 8,
      providerUsageReported: true,
    })
  })

  it("repeat-friendly tools (edit_file) bypass the guard — no abort even on 8 same-path calls", async () => {
    // edit_file is in REPEAT_FRIENDLY_TOOLS — building up a doc in chunks /
    // iterating edits is normal progress, not "stuck". 8 same-path calls
    // would have hit REPEAT_LIMIT under the old behavior.
    const provider = makeRepeatingProvider("edit_file", { path: "ARCHITECTURE.md" }, 8, "Doc finalized.")
    const registry = new ToolRegistry()
    registry.register(makeFakeTool("edit_file", z.object({ path: z.string() })))
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 200 })
    const agent = new LoopAgent({
      provider,
      registry,
      executor,
      conversation,
      systemPrompt: "test",
      maxSteps: 50,
    })

    const result = await agent.run("write the doc in chunks")
    expect(result.stopped).toBeUndefined() // ran to natural completion
    expect(result.text).toContain("Doc finalized")
  })

  it("does NOT abort when calls target different files", async () => {
    let id = 0
    let turn = 0
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        const path = `file_${turn++}.md`
        return {
          type: "text" as const,
          text: "",
          toolCalls: [{ id: `t${++id}`, name: "edit_file", arguments: { path } }],
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
      async *stream(): AsyncIterable<LLMChunk> {
        const callId = `t${++id}`
        const path = `file_${turn++}.md`
        if (turn > 6) {
          yield { type: "text_delta", text: "all done" }
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
          return
        }
        yield { type: "tool_call_start", toolCallId: callId, toolName: "edit_file" }
        yield { type: "tool_call_delta", toolCallId: callId, partialJson: JSON.stringify({ path }) }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" }
      },
    }
    const registry = new ToolRegistry()
    registry.register(makeFakeTool("edit_file", z.object({ path: z.string() })))
    const executor = new ToolExecutor(registry, {})
    const conversation = new ConversationManager({ maxMessages: 200 })
    const agent = new LoopAgent({
      provider,
      registry,
      executor,
      conversation,
      systemPrompt: "test",
      maxSteps: 50,
    })
    // Should complete without throwing — distinct paths reset the streak.
    await agent.run("touch each file")
  })
})
