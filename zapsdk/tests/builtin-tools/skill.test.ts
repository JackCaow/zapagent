import { describe, expect, it } from "bun:test"
import { skillTool } from "../../builtin-tools/skill.js"
import type { SkillDefinition } from "../../skills/types.js"

const reviewer: SkillDefinition = {
  name: "reviewer",
  description: "Review code",
  systemPrompt: "Review {{target}} carefully.",
  tools: ["read_file"],
  parameters: [{ name: "target", description: "Review target", required: true }],
}

describe("skill tool", () => {
  it("refreshes a missing name once and returns the exact resource origin", async () => {
    const skills = new Map<string, SkillDefinition>()
    let refreshes = 0
    const tool = skillTool({ getSkill: name => skills.get(name) ?? null, listNames: () => [...skills.keys()],
      refresh: () => { refreshes++; skills.set("reviewer", { ...reviewer, sourcePath: "/fixture/installed-folder/SKILL.md" }) },
    })
    const result = await tool.handler({ name: "reviewer", params: { target: "module" } })
    expect(result.success).toBe(true)
    expect(result.output).toContain("/fixture/installed-folder/SKILL.md")
    expect(result.output).toContain("Review module carefully.")
    await tool.handler({ name: "reviewer", params: { target: "module" } })
    expect(refreshes).toBe(1)
  })
  it("declares pure skill lookup and rendering as read-only", () => {
    const tool = skillTool({
      getSkill: (name) => name === reviewer.name ? reviewer : null,
      listNames: () => [reviewer.name],
    })

    expect(tool.definition.name).toBe("skill")
    expect(tool.definition.readOnly).toBe(true)
  })

  it("renders the selected skill without mutating the registry", async () => {
    const skills = new Map([[reviewer.name, reviewer]])
    const tool = skillTool({
      getSkill: (name) => skills.get(name) ?? null,
      listNames: () => [...skills.keys()],
    })

    const result = await tool.handler({
      name: "reviewer",
      params: { target: "the cache layer" },
    })

    expect(result).toEqual({
      success: true,
      output: "Review the cache layer carefully.",
    })
    expect(skills.get("reviewer")).toBe(reviewer)
  })
})
