import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { ToolRegistry } from "../../tools/registry.js"
import type { Tool } from "../../tools/types.js"

describe("ToolRegistry ordering", () => {
  it("returns definitions sorted by tool name, not registration order", () => {
    const registry = new ToolRegistry()
    registry.register(fakeTool("zeta"))
    registry.register(fakeTool("alpha"))
    registry.register(fakeTool("middle"))

    expect(registry.definitions().map((d) => d.name)).toEqual([
      "alpha",
      "middle",
      "zeta",
    ])
  })

  it("renders tool prompts in the same stable sorted order", () => {
    const registry = new ToolRegistry()
    registry.register(fakeTool("zeta", "Z guidance"))
    registry.register(fakeTool("alpha", "A guidance"))
    registry.register(fakeTool("middle"))

    expect(registry.toolPrompts()).toBe([
      "# Tool usage guidance",
      "",
      "## alpha",
      "A guidance",
      "",
      "## zeta",
      "Z guidance",
    ].join("\n"))
  })
})

function fakeTool(name: string, prompt?: string): Tool {
  return {
    definition: {
      name,
      description: name,
      prompt,
      parameters: z.object({}),
    },
    handler: async () => ({ success: true, output: "" }),
  }
}

describe("ToolRegistry.resolveName", () => {
  const registryOf = (...names: string[]) => {
    const registry = new ToolRegistry()
    for (const name of names) registry.register(fakeTool(name))
    return registry
  }
  const registry = registryOf("http_fetch", "read_file", "write_file", "edit_file", "multi_edit", "bash", "agent", "search_files", "glob_files")

  it("keeps exact names and repairs separators, case and one-character slips", () => {
    expect(registry.resolveName("http_fetch")).toBe("http_fetch")
    expect(registry.resolveName("HTTP-Fetch")).toBe("http_fetch")
    expect(registry.resolveName("read.file")).toBe("read_file")
    expect(registry.resolveName("http_fфtch")).toBe("http_fetch") // Cyrillic ф
    expect(registry.resolveName("read_files")).toBe("read_file")
    expect(registry.resolveName("search_file")).toBe("search_files")
    expect(registry.resolveName("edit_fil")).toBe("edit_file")
  })

  it("does not guess when the name is far from everything, too short, or matches two tools", () => {
    expect(registry.resolveName("http-equiv")).toBeUndefined()
    expect(registry.resolveName("read_document")).toBeUndefined()
    expect(registry.resolveName("ba")).toBeUndefined()
    expect(registry.resolveName("")).toBeUndefined()
    // Two registered tools are one edit away: ambiguous, so no repair.
    expect(registryOf("tool_aa", "tool_ab").resolveName("tool_ac")).toBeUndefined()
  })
})
