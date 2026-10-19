import type { PromptSection } from "../registry.js"

/**
 * Lists skills available to the `skill` tool and explains relevance-based
 * selection. Static for the session (skills don't change mid-run), so it
 * rides the cacheable prefix.
 */
export const skillsSection: PromptSection = {
  name: "skills",
  purpose: "discovery",
  compute: (ctx) => {
    const skills = ctx.availableSkills ?? []
    if (skills.length === 0) return null

    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name))

    const list = sorted
      .map((s) => {
        const paramHint = s.parameters?.length
          ? ` — params: ${s.parameters.map((p) => p.required ? p.name : `${p.name}?`).join(", ")}`
          : ""
        return `- \`${s.name}\`: ${s.description || "(no description)"}${paramHint}`
      })
      .join("\n")

    return `# Skills

You have access to specialized skills via the \`skill\` tool. Load a skill when the user explicitly requests it or its guidance materially helps the current task. Choose by its purpose and the work needed, not merely its name or a matching keyword.

Load the skill when the relevant work begins. Skill discovery does not require delaying necessary clarification, planning, or unrelated work. The tool returns instructions; loading them does not perform the work or verify its outcome. Apply them within the user's scope and higher-priority instructions.

**Do not narrate** skill selection. Call the tool; use what it returns.

Available skills:
${list}`
  },
}
