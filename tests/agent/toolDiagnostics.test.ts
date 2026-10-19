import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { buildToolSchemaDiagnostics } from "../../src/agent/toolDiagnostics.js"
import { executeCommandTool } from "../../zapsdk/builtin-tools/command.js"
import { delegateAgentTool } from "../../zapsdk/builtin-tools/delegate.js"
import { readFileTool, writeFileTool } from "../../zapsdk/builtin-tools/filesystem.js"
import { memorySaveTool } from "../../zapsdk/builtin-tools/memory.js"
import { subagentTool } from "../../zapsdk/builtin-tools/subagent.js"
import type { MdMemoryStore } from "../../zapsdk/memory/md-store.js"
import { ToolRegistry } from "../../zapsdk/tools/registry.js"
import type { ToolDefinition } from "../../zapsdk/tools/types.js"

describe("buildToolSchemaDiagnostics", () => {
  it("produces a stable hash independent of definition order and object key order", () => {
    const first = buildToolSchemaDiagnostics([
      tool("write_file", { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } }),
      tool("bash", { type: "object", properties: { cmd: { type: "string" } } }),
    ])
    const second = buildToolSchemaDiagnostics([
      tool("bash", { properties: { cmd: { type: "string" } }, type: "object" }),
      tool("write_file", { properties: { content: { type: "string" }, path: { type: "string" } }, type: "object" }),
    ])

    expect(second).toEqual(first)
    expect(first.count).toBe(2)
    expect(first.chars).toBeGreaterThan(0)
    expect(first.estimatedTokens).toBeGreaterThan(0)
    expect(first.names).toEqual(["bash", "write_file"])
    expect(first.hash).toMatch(/^[a-f0-9]{12}$/)
  })

  it("changes the hash when a schema changes", () => {
    const before = buildToolSchemaDiagnostics([
      tool("bash", { type: "object", properties: { cmd: { type: "string" } } }),
    ])
    const after = buildToolSchemaDiagnostics([
      tool("bash", { type: "object", properties: { cmd: { type: "string" }, cwd: { type: "string" } } }),
    ])

    expect(after.hash).not.toBe(before.hash)
    expect(after.chars).toBeGreaterThan(before.chars ?? 0)
    expect(after.estimatedTokens).toBeGreaterThanOrEqual(before.estimatedTokens ?? 0)
    expect(after.names).toEqual(["bash"])
  })

  it("reports serialized schema chars by Unicode character count", () => {
    const diagnostics = buildToolSchemaDiagnostics([
      tool("emoji_tool", {}),
    ])

    expect(diagnostics.chars).toBe('[{"description":"emoji_tool description","input_schema":{},"name":"emoji_tool"}]'.length)

    const withEmoji = buildToolSchemaDiagnostics([
      {
        name: "emoji_tool",
        description: "😀",
        parameters: z.object({}),
        rawSchema: {},
      },
    ])

    const expectedSerialized = '[{"description":"😀","input_schema":{},"name":"emoji_tool"}]'
    expect(expectedSerialized.length).toBeGreaterThan(Array.from(expectedSerialized).length)
    expect(withEmoji.chars).toBe(Array.from(expectedSerialized).length)
  })

  it("keeps the hash stable when raw schema required order changes", () => {
    const first = buildToolSchemaDiagnostics([
      tool("write_file", {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      }),
    ])
    const second = buildToolSchemaDiagnostics([
      tool("write_file", {
        required: ["content", "path"],
        properties: {
          content: { type: "string" },
          path: { type: "string" },
        },
        type: "object",
      }),
    ])

    expect(second).toEqual(first)
  })

  it("keeps the hash stable when raw schema enum and type order changes", () => {
    const first = buildToolSchemaDiagnostics([
      tool("choose_mode", {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["fast", "safe"] },
          maybe: { type: ["string", "null"] },
        },
        required: ["mode"],
      }),
    ])
    const second = buildToolSchemaDiagnostics([
      tool("choose_mode", {
        required: ["mode"],
        properties: {
          maybe: { type: ["null", "string"] },
          mode: { enum: ["safe", "fast"], type: "string" },
        },
        type: "object",
      }),
    ])

    expect(second).toEqual(first)
  })

  it("keeps the hash stable when raw schema combinator order changes", () => {
    const first = buildToolSchemaDiagnostics([
      tool("choose_value", {
        type: "object",
        properties: {
          value: {
            anyOf: [
              { type: "string" },
              { type: "number" },
            ],
          },
        },
      }),
    ])
    const second = buildToolSchemaDiagnostics([
      tool("choose_value", {
        properties: {
          value: {
            anyOf: [
              { type: "number" },
              { type: "string" },
            ],
          },
        },
        type: "object",
      }),
    ])

    expect(second).toEqual(first)
  })

  it("matches JSON serialization semantics for undefined raw schema fields", () => {
    const withUndefined = buildToolSchemaDiagnostics([
      tool("describe_value", {
        type: "object",
        properties: {
          value: {
            type: "string",
            description: undefined,
          },
        },
        examples: ["alpha", undefined],
      }),
    ])
    const jsonEquivalent = buildToolSchemaDiagnostics([
      tool("describe_value", {
        type: "object",
        properties: {
          value: {
            type: "string",
          },
        },
        examples: ["alpha", null],
      }),
    ])

    expect(withUndefined).toEqual(jsonEquivalent)
  })

  it("keeps the largest built-in tool contracts within a fixed prompt budget", () => {
    const definitions = [
      delegateAgentTool({
        providers: [
          { name: "claude", bin: "/bin/claude" },
          { name: "codex", bin: "/bin/codex" },
        ],
      })!.definition,
      memorySaveTool({ store: emptyMemoryStore() }).definition,
      executeCommandTool({ timeoutMs: 60_000, store: {} as never, sandboxTemporaryDirectory: {
        environmentVariables: ["TMPDIR", "TMP", "TEMP"], scope: "command", cleanup: "on-command-exit",
      } }).definition,
      readFileTool().definition,
      writeFileTool().definition,
      subagentTool({
        provider: { call: async () => ({ text: "" }) } as never,
        registry: new ToolRegistry(),
      }).definition,
    ]
    const diagnostics = buildToolSchemaDiagnostics(definitions)
    const guidanceChars = Array.from(
      definitions.map((definition) => definition.prompt ?? "").join("\n"),
    ).length

    expect(diagnostics.names).toEqual([
      "agent",
      "bash",
      "delegate_agent",
      "memory_save",
      "read_file",
      "write_file",
    ])
    // These six previously consumed roughly 8.8k schema chars plus 3.7k
    // guidance chars. Keep modest headroom without allowing usage manuals to
    // drift back into provider tool definitions. The +100 covers bash's
    // dangerouslyDisableSandbox parameter (the sandbox escape hatch); another +100
    // covers bash's timeout_ms parameter.
    // +350 for explicit, independently authorized shell filesystem paths.
    expect(diagnostics.chars).toBeLessThanOrEqual(6_300)
    expect(diagnostics.estimatedTokens).toBeLessThanOrEqual(2_500)
    // +700 for shell status caveats and the local sandbox scratch lifecycle.
    // +300 for cwd scope and external-path authorization/lifetime guidance.
    expect(guidanceChars).toBeLessThanOrEqual(2_400)
  })
})

function tool(name: string, rawSchema: Record<string, unknown>): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    parameters: z.object({}),
    rawSchema,
  }
}

function emptyMemoryStore(): MdMemoryStore {
  return {
    dir: "/tmp/zap-memory-schema-budget",
    list: () => [],
    get: () => undefined,
    save: () => { throw new Error("not used") },
    delete: () => false,
  }
}
