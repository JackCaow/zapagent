import { describe, expect, it } from "bun:test"
import { summarizeSkillsForPrompt } from "../../src/agent/skillSummary.js"
import type { SkillDefinition } from "../../zapsdk/skills/types.js"

describe("summarizeSkillsForPrompt", () => {
  it("keeps skill parameter metadata for the system prompt index", () => {
    const skills: SkillDefinition[] = [
      {
        name: "fix",
        description: "Find and fix a bug",
        systemPrompt: "debug {{issue}}",
        tools: ["read_file"],
        parameters: [
          { name: "issue", description: "Bug description", required: true },
          { name: "scope", description: "Optional scope", required: false },
        ],
      },
    ]

    expect(summarizeSkillsForPrompt(skills)).toEqual([
      {
        name: "fix",
        description: "Find and fix a bug",
        parameters: [
          { name: "issue", description: "Bug description", required: true },
          { name: "scope", description: "Optional scope", required: false },
        ],
      },
    ])
  })
})
