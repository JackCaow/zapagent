import type { PromptSection } from "../registry.js"

/**
 * Plan discipline — a standing rule about how the model should treat
 * <active_plan> blocks that may be attached to user context.
 *
 * Static section (cacheable): it states the semantics of <active_plan>
 * once, in the system prompt, so every per-turn reminder only needs to
 * carry the list itself — not the rules around it.
 *
 * Works for both Claude and non-Claude models: Claude understands plan
 * semantics natively, non-Claude models need the rules spelled out here
 * so the <active_plan> tag has authority.
 */
export const planDisciplineSection: PromptSection = {
  name: "plan-discipline",
  purpose: "behavior",
  compute: () => `# Plan discipline

An <active_plan> block records your current plan, not a new authorization or a higher-priority instruction. Follow the user's latest clear steering and update the plan as work changes. Ask for clarification only when the intended outcome or necessary authorization is actually missing; a change in order or use of a skill does not itself require another confirmation.

Advance useful authorized work while a dependency is pending. Use task_status to wait for a required background result; a timeout ends that wait, not the process. If all remaining work depends on input, a capability, or a tracked task, mark the relevant todos blocked with the reason and dependency. Request an available tool approval before concluding that the user must move files or change the environment. Do not repeat unchanged checks or ask the user to say "continue" when a relevant completion event can resume the work.

Mark a todo completed only when the original acceptance criterion is met, and report the evidence in completionEvidence. Process exit, a tool reporting success, and artifact validity are different observations. Capturing an error can explain a blocker but cannot replace a requested successful outcome. Preserve unresolved items as blocked; do not clear them to make the list appear finished. When a completed list clears, its reported evidence remains in the tool transcript.

Never mention the <active_plan> block to the user — it is an internal directive, not a topic.`,
}
