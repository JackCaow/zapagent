import type { PromptContext } from "./context.js"
import { assemblePrompt } from "./registry.js"
import { actionsSection } from "./sections/actions.js"
import { agentsMdSection } from "./sections/agents-md.js"
import { safetySection } from "./sections/safety.js"
import { systemSection } from "./sections/system.js"
import { escapeDynamicBoundaryText } from "../../zapsdk/core/prompt-boundary.js"

/** Roles replace behavior guidance, never the host's authority or project scope. */
export const REQUIRED_SECTIONS = [systemSection, actionsSection, safetySection, agentsMdSection]

export function buildInheritedPromptInstructions(cwd: string, explicit: Array<string | undefined>): {
  instructions: string
  publicPromptSections: string[]
} {
  const publicPromptSections: string[] = []
  const ctx: PromptContext = { cwd, enabledTools: new Set(), onSection: (_name, purpose, _dynamic, text, sourceText) => {
    if (purpose === "project") {
      publicPromptSections.push(text)
      if (sourceText && sourceText !== text) publicPromptSections.push(sourceText)
    }
  } }
  const required = assemblePrompt(ctx, REQUIRED_SECTIONS)
  const userInstructions = [...new Set(explicit.map(text => escapeDynamicBoundaryText(text ?? "").trim()).filter(Boolean))]
  return { instructions: [...userInstructions, required].join("\n\n"), publicPromptSections }
}
