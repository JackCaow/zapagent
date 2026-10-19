/**
 * Prompt module entry point.
 *
 * Use `buildDefaultPrompt(ctx)` for the standard stack. For custom stacks
 * (e.g. a different agent persona), import the registry primitives and
 * assemble your own `PromptSection[]`.
 */
export { type PromptContext } from "./context.js"
export { type PromptSection, assemblePrompt, splitOnBoundary, DYNAMIC_BOUNDARY } from "./registry.js"
export { DEFAULT_SECTIONS } from "./default-sections.js"

import type { PromptContext } from "./context.js"
import { assemblePrompt } from "./registry.js"
import { sectionsForProfile } from "./default-sections.js"

/** Build the default system prompt from PromptContext. */
export function buildDefaultPrompt(ctx: PromptContext): string {
  return assemblePrompt(ctx, sectionsForProfile(ctx.promptProfile))
}
