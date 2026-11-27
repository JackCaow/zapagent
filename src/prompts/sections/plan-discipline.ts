import type { PromptSection } from "../registry.js"

export const planDisciplineSection: PromptSection = {
  name: "plan-discipline",
  purpose: "behavior",
  compute: (ctx) => `# Plan discipline

Follow the user's latest clear steering and update your approach as work changes. Ask for clarification only when the intended outcome or necessary authorization is actually missing; a change in order or use of a skill does not itself require another confirmation.

For an implementation request, organize the work yourself and proceed through changes and verification. If the user asks for analysis without changes, stay within that scope. State reasonable assumptions where useful and keep questions focused on decisions that affect the result.

Advance useful authorized work while a dependency is pending. ${ctx.enabledTools.has("task_status") ? "Use task_status to wait for a required background result; a timeout ends that wait, not the process. " : ""}Request an available tool approval before concluding that the user must move files or change the environment. Do not repeat unchanged checks or ask the user to say "continue" when a relevant completion event can resume the work.

Process exit, a tool reporting success, and artifact validity are different observations. Capturing an error can explain a blocker but cannot replace a requested successful outcome.`,
}
