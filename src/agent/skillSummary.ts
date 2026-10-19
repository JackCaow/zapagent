import type { SkillDefinition } from "../../zapsdk/skills/types.js"
import type { PromptContext } from "../prompts/context.js"

export type PromptSkillSummary = NonNullable<PromptContext["availableSkills"]>[number]

export function summarizeSkillsForPrompt(
  skills: Iterable<SkillDefinition>,
): PromptSkillSummary[] {
  return Array.from(skills, (skill) => ({
    name: skill.name,
    description: skill.description,
    ...(skill.parameters?.length
      ? {
          parameters: skill.parameters.map((param) => ({
            name: param.name,
            required: param.required,
            description: param.description,
          })),
        }
      : {}),
  }))
}
