import { describe, expect, it } from "bun:test"
import { applySkillTemplate } from "../../skills/template.js"
import { skillTool } from "../../builtin-tools/skill.js"
import type { SkillDefinition } from "../../skills/types.js"

const skill: SkillDefinition = {
  name: "fix", description: "Fix bugs", systemPrompt: "Debug {{issue}}; repeat {{issue}}.", tools: [],
  parameters: [{ name: "issue", description: "Bug report", required: true }],
}

describe("literal skill parameters", () => {
  for (const value of ["shell PID $$", "replacement $&", "prefix $`", "suffix $'", "ordinary text"]) {
    it(`preserves supplied value: ${value}`, async () => {
      const expected = `Debug ${value}; repeat ${value}.`
      expect(applySkillTemplate(skill, { issue: value })).toEqual({ body: expected, missingRequired: [] })
      const tool = skillTool({ getSkill: () => skill, listNames: () => [skill.name] })
      expect(await tool.handler({ name: skill.name, params: { issue: value } }))
        .toEqual({ success: true, output: expected })
      expect(skill.systemPrompt).toBe("Debug {{issue}}; repeat {{issue}}.")
    })
    it(`preserves declared default: ${value}`, async () => {
      const withDefault: SkillDefinition = {
        ...skill, parameters: [{ name: "issue", description: "Bug report", required: true, default: value }],
      }
      const expected = `Debug ${value}; repeat ${value}.`
      expect(applySkillTemplate(withDefault)).toEqual({ body: expected, missingRequired: [] })
      const tool = skillTool({ getSkill: () => withDefault, listNames: () => [skill.name] })
      expect(await tool.handler({ name: skill.name })).toEqual({ success: true, output: expected })
      expect(applySkillTemplate(withDefault, { issue: "override" }).body).toBe("Debug override; repeat override.")
    })
  }

  it("still rejects an absent required parameter", async () => {
    expect(applySkillTemplate(skill).missingRequired).toEqual(["issue"])
    const tool = skillTool({ getSkill: () => skill, listNames: () => [skill.name] })
    const result = await tool.handler({ name: skill.name })
    expect(result.success).toBe(false)
    expect(result.error).toContain("requires param: issue")
  })

  it("preserves an explicitly supplied empty value over a default", () => {
    const withDefault: SkillDefinition = {
      ...skill, parameters: [{ name: "issue", description: "Bug report", required: true, default: "fallback" }],
    }
    expect(applySkillTemplate(withDefault, { issue: "" })).toEqual({ body: "Debug ; repeat .", missingRequired: [] })
  })
})
