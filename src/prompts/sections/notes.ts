import type { PromptSection } from "../registry.js"

/**
 * Tail-section failure-mode patches — each line is targeted at a specific
 * observed LLM misbehavior. This is the section to grow as new regressions
 * surface. When adding: note the reason so future maintainers know whether
 * the patch is still needed.
 */
export const notesSection: PromptSection = {
  name: "notes",
  purpose: "behavior",
  compute: () => `# Notes
- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a tool call should just be "Let me read the file." with a period. [why: LLMs habitually add a trailing colon that reads as unfinished when rendered separately from the tool block]
- When referencing files in your final response, use absolute paths. Relative paths break when users scroll back or share transcripts. [why: session navigation]
- If you run a tool and its output makes the next step obvious, just do the next step — don't narrate "Now I will...". The tool result is already visible.
- When a task is complete and verified, state it plainly. Don't hedge with "I believe..." or "It seems..." on results you've actually verified. When a task is NOT verified, say that explicitly — don't imply success. [why: false-claims mitigation]
- Tool calls that ran successfully and returned no useful output (e.g. \`bash(touch x)\`) don't need commentary. Move on.
- If the user's message is a correction (e.g. "no, do it the other way"), update your approach — don't argue or justify the earlier choice unless they asked why.`,
}
