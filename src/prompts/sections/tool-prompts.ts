import type { PromptSection } from "../registry.js"

/**
 * Append per-tool prompt fragments that tools self-describe via
 * ToolDefinition.prompt. The registry aggregates them; this section just
 * inlines the aggregated string so the model sees them alongside its
 * top-level guidance.
 */
export const toolPromptsSection: PromptSection = {
  name: "tool-prompts",
  purpose: "tool-contract",
  compute: (ctx) => {
    const raw = ctx.toolPromptsRaw?.trim()
    if (!raw) return null
    return raw
  },
}
