import { describe, it, expect } from "bun:test"
import { z } from "zod"
import { AgentBudget } from "../../agent/budget.js"
import { subagentTool, truncateSubagentToolOutputs, validateReadOnlyBash } from "../../builtin-tools/subagent.js"
import type { LLMProvider } from "../../core/llm.js"
import type { LLMResponse } from "../../core/types.js"
import { ToolExecutor } from "../../tools/executor.js"
import { ToolRegistry } from "../../tools/registry.js"
import type { AgentEvent } from "../../agent/events.js"
import { DefaultExecutionBroker } from "../../execution/broker.js"
import type { OsSandbox } from "../../execution/types.js"

// Dummy provider — not invoked in these factory-only tests.
const dummyProvider: LLMProvider = {
  async call(): Promise<LLMResponse> { throw new Error("not used") },
}

describe("subagent tool: cache-stable prompt", () => {
  it("omits the budget notice when no budget is provided", () => {
    const tool = subagentTool({ provider: dummyProvider, registry: null as any })
    const prompt = tool.definition.prompt ?? ""
    expect(prompt).not.toContain("Budget notice")
    expect(prompt).not.toContain("spawns left this turn")
  })

  it("keeps the prompt stable when plenty of spawns remain", () => {
    const budget = new AgentBudget({ maxSpawns: 8 })
    const tool = subagentTool({ provider: dummyProvider, registry: null as any, budget })
    const prompt = tool.definition.prompt ?? ""
    expect(prompt).not.toContain("Budget notice")
  })

  it("keeps the prompt stable at remaining = 3", () => {
    const budget = new AgentBudget({ maxSpawns: 10 })
    for (let i = 0; i < 7; i++) budget.reserveSpawn() // 7/10 used, 3 remaining
    const tool = subagentTool({ provider: dummyProvider, registry: null as any, budget })
    const prompt = tool.definition.prompt ?? ""
    expect(prompt).not.toContain("Budget notice")
  })

  it("keeps the prompt stable at low remaining budgets", () => {
    const baseline = subagentTool({ provider: dummyProvider, registry: null as any }).definition.prompt
    const budget = new AgentBudget({ maxSpawns: 10 })
    for (let i = 0; i < 8; i++) budget.reserveSpawn() // 8/10 used, 2 remaining
    const tool = subagentTool({ provider: dummyProvider, registry: null as any, budget })
    const prompt = tool.definition.prompt ?? ""
    expect(prompt).toBe(baseline)
    expect(prompt).not.toContain("Budget notice")
  })

  it("keeps the prompt stable at exhausted budgets", () => {
    const baseline = subagentTool({ provider: dummyProvider, registry: null as any }).definition.prompt
    const budget = new AgentBudget({ maxSpawns: 3 })
    budget.reserveSpawn()
    budget.reserveSpawn()
    budget.reserveSpawn() // 3/3 used, 0 remaining
    const tool = subagentTool({ provider: dummyProvider, registry: null as any, budget })
    const prompt = tool.definition.prompt ?? ""
    expect(prompt).toBe(baseline)
    expect(prompt).not.toContain("Budget notice")
  })

  it("retains anti-fabrication guidance without dynamic budget text", () => {
    const budget = new AgentBudget({ maxSpawns: 1 })
    const tool = subagentTool({ provider: dummyProvider, registry: null as any, budget })
    const prompt = tool.definition.prompt ?? ""
    expect(prompt).toMatch(/Do NOT fabricate later rounds/i)
    expect(prompt).not.toContain("Budget notice")
  })

  it("retains the anti-fabrication guidance in the always-on iteration semantics section", () => {
    const tool = subagentTool({ provider: dummyProvider, registry: null as any })
    const prompt = tool.definition.prompt ?? ""
    expect(prompt).toMatch(/Do NOT fabricate later rounds/i)
  })
})

describe("subagent tool: scheduling safety", () => {
  it("parallelizes only explicitly read-only agent types", () => {
    const registry = new ToolRegistry()
    registry.register(subagentTool({ provider: dummyProvider, registry }))
    const executor = new ToolExecutor(registry)

    expect(executor.isReadOnly("agent", { agent_type: "explore" })).toBe(true)
    expect(executor.isReadOnly("agent", { agent_type: "plan" })).toBe(true)
    expect(executor.isReadOnly("agent", { agent_type: "general" })).toBe(false)
    expect(executor.isReadOnly("agent", {})).toBe(false)
  })
})

describe("subagent tool: AgentRun lifecycle", () => {
  it("correlates lifecycle state with the host-authored tool-call id", async () => {
    const events: AgentEvent[] = []
    const provider: LLMProvider = {
      async call(): Promise<LLMResponse> {
        return {
          type: "text",
          text: "done",
          usage: { inputTokens: 2, outputTokens: 1 },
        }
      },
    }
    const tool = subagentTool({
      provider,
      registry: new ToolRegistry(),
      onEvent: (event) => { events.push(event) },
    })

    const result = await tool.handler(
      { task: "Inspect the scheduler", agent_type: "explore" },
      undefined,
      { toolCallId: "call-agent-42", step: 3 },
    )

    expect(result.success).toBe(true)
    const states = events
      .filter((event) => event.type === "agent_run_state")
      .map((event) => event.run)
    expect(states.map((state) => state.status)).toEqual([
      "starting",
      "running",
      "completed",
    ])
    expect(states.map((state) => state.sequence)).toEqual([1, 2, 3])
    expect(states.every((state) => state.toolCallId === "call-agent-42")).toBe(true)
    expect(new Set(states.map((state) => state.runId)).size).toBe(1)
  })

  it("reports a budget refusal as blocked instead of queued", async () => {
    const events: AgentEvent[] = []
    const budget = new AgentBudget({ maxSpawns: 1 })
    budget.reserveSpawn()
    const tool = subagentTool({
      provider: dummyProvider,
      registry: new ToolRegistry(),
      budget,
      onEvent: (event) => { events.push(event) },
    })

    const result = await tool.handler(
      { task: "Cannot start", agent_type: "general" },
      undefined,
      { toolCallId: "call-blocked" },
    )

    expect(result.success).toBe(false)
    expect(events
      .filter((event) => event.type === "agent_run_state")
      .map((event) => event.run.status)).toEqual(["starting", "blocked"])
  })
})

describe("subagent salvage truncation", () => {
  it("does not truncate when code units exceed the cap but code points fit", () => {
    expect(truncateSubagentToolOutputs("😀😀", 2)).toBe("😀😀")
  })

  it("reports truncated tool output totals by Unicode code point", () => {
    expect(truncateSubagentToolOutputs("a😀b😀c", 4))
      .toBe("a😀b😀\n…[truncated — 5 total chars]")
  })

  it("does not split non-BMP characters at the salvage boundary", () => {
    const truncated = truncateSubagentToolOutputs("ab😀cd", 3)

    expect(truncated).toBe("ab😀\n…[truncated — 5 total chars]")
    expect(hasUnpairedSurrogate(truncated)).toBe(false)
  })
})

describe("read-only bash validator defense in depth", () => {
  it("rejects indirect writers and mutating git subcommands", () => {
    expect(validateReadOnlyBash("env touch /tmp/probe")).not.toBeNull()
    expect(validateReadOnlyBash("ls\nrm file")).not.toBeNull()
    expect(validateReadOnlyBash("ls & touch file")).not.toBeNull()
    expect(validateReadOnlyBash("git worktree remove path")).not.toBeNull()
    expect(validateReadOnlyBash("sort -o /tmp/out input.txt")).not.toBeNull()
    expect(validateReadOnlyBash("git branch probe")).not.toBeNull()
    expect(validateReadOnlyBash("git config user.name probe")).not.toBeNull()
    expect(validateReadOnlyBash("git diff --output=/tmp/diff")).not.toBeNull()
    expect(validateReadOnlyBash("yq -i '.x=1' config.yml")).not.toBeNull()
  })

  it("keeps basic inspection commands available to trusted callers", () => {
    expect(validateReadOnlyBash("git status")).toBeNull()
    expect(validateReadOnlyBash("git worktree list --porcelain")).toBeNull()
    expect(validateReadOnlyBash("git merge-base --is-ancestor HEAD HEAD")).toBeNull()
    expect(validateReadOnlyBash("find . -maxdepth 1 -type d | wc -l")).toBeNull()
    expect(validateReadOnlyBash("cat README.md | head -20")).toBeNull()
  })
})

describe("subagent tool: explore sandbox boundary", () => {
  it("refreshes parent capability disclosure when the source registry changes", () => {
    const registry = new ToolRegistry()
    const tool = subagentTool({
      provider: dummyProvider, registry,
      executorOptions: {
        executionBroker: new DefaultExecutionBroker({
          sandboxMode: "required",
          sandbox: {
            status: () => ({ provider: "macos-seatbelt", available: true }),
            createContext: () => { throw new Error("No process should execute") },
          },
        }),
      },
    })
    expect(tool.definition.description).toContain("Read-only shell access: unavailable.")
    registry.register(stubTool("bash"))
    expect(tool.definition.description).toContain("Read-only shell access: allowlisted inspection commands only.")
    registry.unregister("bash")
    expect(tool.definition.description).toContain("Read-only shell access: unavailable.")
    expect(tool.definition.prompt).toContain("builds, tests or diagnostic scripts")
  })

  for (const agentType of ["explore", "plan"] as const) {
    for (const sandboxAvailable of [false, true]) {
      for (const registeredBash of [false, true]) {
        it(`describes actual ${agentType} shell access (sandbox=${sandboxAvailable}, bash=${registeredBash})`, async () => {
          const registry = new ToolRegistry()
          if (registeredBash) registry.register(stubTool("bash"))
          const expectedBash = sandboxAvailable && registeredBash
          let calls = 0
          const provider: LLMProvider = {
            async call(messages, tools): Promise<LLMResponse> {
              calls++
              const system = messages.filter(message => message.role === "system")
                .map(message => message.content).join("\n")
              expect(tools?.some(tool => tool.name === "bash") ?? false).toBe(expectedBash)
              expect(system).toContain(expectedBash
                ? "Shell access: bash is limited to allowlisted inspection commands."
                : "Shell access: bash is unavailable in this subagent.")
              expect(system).toContain("Compilation, tests, interpreters and custom executables are unavailable in this read-only role.")
              expect(system).not.toContain("5. bash for read-only shell ops")
              expect(system).toContain("Preserve the host boundary.")
              expect(system).toContain("[Evidence and review scope]")
              expect(system).toContain("check assumptions against available callers, tests or other independent evidence")
              return { type: "text", text: "inspected", usage: { inputTokens: 1, outputTokens: 1 } }
            },
          }
          const tool = subagentTool({
            registry, provider, inheritedInstructions: "Preserve the host boundary.",
            executorOptions: {
              executionBroker: new DefaultExecutionBroker({
                sandboxMode: "required",
                sandbox: {
                  status: () => ({ provider: "macos-seatbelt", available: sandboxAvailable }),
                  createContext: () => { throw new Error("No shell should execute") },
                },
              }),
            },
          })
          expect(tool.definition.description).toContain(expectedBash
            ? "Read-only shell access: allowlisted inspection commands only."
            : "Read-only shell access: unavailable.")
          for (const custom of [false, true]) {
            const result = await tool.handler({
              task: "Inspect tool availability.", agent_type: agentType,
              ...(custom ? { system_prompt: "Report capabilities." } : {}),
            })
            expect(result.success).toBe(true)
          }
          expect(calls).toBe(2)
        })
      }
    }
  }

  it("does not expose bash until an OS-enforced read-only sandbox exists", async () => {
    const registry = new ToolRegistry()
    registry.register(stubTool("bash"))
    const provider: LLMProvider = {
      async call(_messages, tools): Promise<LLMResponse> {
        expect(tools?.map((tool) => tool.name)).not.toContain("bash")
        return {
          type: "text",
          text: "safe",
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    const tool = subagentTool({ provider, registry })

    const result = await tool.handler({
      task: "Inspect safely.",
      agent_type: "explore",
      thoroughness: "quick",
    })

    expect(result.success).toBe(true)
    expect(result.output).toBe("safe")
  })

  it("exposes read-only bash when the runtime has an enforced OS provider", async () => {
    const registry = new ToolRegistry()
    registry.register(stubTool("bash"))
    const provider: LLMProvider = {
      async call(_messages, tools): Promise<LLMResponse> {
        expect(tools?.map((tool) => tool.name)).toContain("bash")
        return {
          type: "text",
          text: "sandboxed",
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    const sandbox: OsSandbox = {
      status: () => ({ provider: "macos-seatbelt", available: true }),
      createContext: () => { throw new Error("not invoked") },
    }
    const tool = subagentTool({
      provider,
      registry,
      executorOptions: {
        executionBroker: new DefaultExecutionBroker({ sandbox, sandboxMode: "required" }),
      },
    })

    const result = await tool.handler({
      task: "Inspect safely.",
      agent_type: "explore",
      thoroughness: "quick",
    })

    expect(result.success).toBe(true)
    expect(result.output).toBe("sandboxed")
  })
})

describe("subagent tool: memory maintenance isolation", () => {
  it("keeps memory_save but strips inventory review and destructive merge from general subagents", async () => {
    const registry = new ToolRegistry()
    registry.register(stubTool("memory_save"))
    registry.register(stubTool("memory_review"))
    registry.register(stubTool("memory_merge"))
    const provider: LLMProvider = {
      async call(_messages, tools): Promise<LLMResponse> {
        const names = tools?.map((tool) => tool.name) ?? []
        expect(names).toContain("memory_save")
        expect(names).not.toContain("memory_review")
        expect(names).not.toContain("memory_merge")
        return {
          type: "text",
          text: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    const tool = subagentTool({ provider, registry })

    const result = await tool.handler({
      task: "Inspect memory state.",
      agent_type: "general",
    })

    expect(result.success).toBe(true)
  })
})

function stubTool(name: string) {
  return {
    definition: {
      name,
      description: name,
      parameters: z.object({}),
      permission: "auto" as const,
    },
    async handler() {
      return { success: true, output: "ok" }
    },
  }
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      i++
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}
