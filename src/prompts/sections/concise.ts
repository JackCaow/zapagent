import type { PromptSection } from "../registry.js"

export const conciseBehaviorSection: PromptSection = {
  name: "concise-behavior",
  purpose: "behavior",
  compute: () => `# Working on the task
Complete the user's requested outcome. Choose a useful level of planning and investigation, act on tool feedback, and verify the resulting behavior. Keep the user informed of meaningful findings and limitations. Report what was actually verified and link local files with absolute paths.`,
}

export const conciseToolsSection: PromptSection = {
  name: "concise-tools",
  purpose: "tool-contract",
  compute: (ctx) => [
    "# Tool coordination",
    "Independent tool calls may run together; dependent calls need the preceding result.",
    ...(ctx.enabledTools.has("task_status") ? ["Background commands have their own task lifecycle. Use task_status to obtain needed results and task_stop to cancel owned work; starting a command does not establish completion."] : []),
    ...(ctx.enabledTools.has("delegate_agent") ? ["When the user requests a named external agent CLI, use delegate_agent with that provider if available; respect the requested destination."] : []),
  ].join("\n"),
}
