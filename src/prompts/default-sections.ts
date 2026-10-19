import { conciseBehaviorSection, concisePlanSection, conciseToolsSection } from "./sections/concise.js"
import type { PromptProfile } from "../../zapsdk/agent/prompt-profile.js"
import type { PromptSection } from "./registry.js"
import { identitySection } from "./sections/identity.js"
import { systemSection } from "./sections/system.js"
import { tasksSection } from "./sections/tasks.js"
import { actionsSection } from "./sections/actions.js"
import { toolsSection } from "./sections/tools.js"
import { fileReadingSection } from "./sections/file-reading.js"
import { outputEfficiencySection } from "./sections/output-efficiency.js"
import { toneSection } from "./sections/tone.js"
import { safetySection } from "./sections/safety.js"
import { envSection } from "./sections/env.js"
import { toolPromptsSection } from "./sections/tool-prompts.js"
import { agentsMdSection } from "./sections/agents-md.js"
import { notesSection } from "./sections/notes.js"
import { skillsSection } from "./sections/skills.js"
import { planDisciplineSection } from "./sections/plan-discipline.js"

/**
 * Default section order. The registry emits a static/dynamic boundary after
 * the last static section and before the first dynamic one, so provider
 * prompt cache can keep the prefix warm across turns.
 *
 * Static sections (cacheable — same text every turn in a project/session):
 *   identity → system → tasks → actions → tools → output-efficiency →
 *   tone → safety → tool-prompts → notes → agents-md
 *
 * Dynamic sections (recompute per turn / session):
 *   env
 *
 * `env` is intentionally the only default dynamic section because its
 * Today/CWD/branch fields are the highest-frequency mutators. AGENTS.md is
 * project-specific, but stable enough to cache; if maintainers edit it, the
 * changed bytes simply create a new provider cache entry.
 *
 * Memory index and the todo-reminder both live OUTSIDE this list — they're
 * injected as per-turn user-context attachments wrapped in `<system-reminder>`
 * tags (see useAgentRunner). Inline placement matches CCB and is more salient
 * than a system-prompt tail section, which models tend to attend less to
 * after many tool turns.
 */
export const DEFAULT_SECTIONS: PromptSection[] = [
  identitySection,
  systemSection,
  tasksSection,
  actionsSection,
  toolsSection,
  fileReadingSection,
  outputEfficiencySection,
  toneSection,
  safetySection,
  toolPromptsSection,
  skillsSection,
  planDisciplineSection,
  notesSection,
  agentsMdSection,
  // ── dynamic boundary happens here implicitly ──
  envSection,
]

/** Only owned behavior guidance is replaced. Authority, discovery and project text stay intact. */
export function sectionsForProfile(profile: PromptProfile = "standard"): PromptSection[] {
  if (profile === "standard") return DEFAULT_SECTIONS
  return [
    ...DEFAULT_SECTIONS.filter(section => section.purpose !== "behavior"),
    conciseBehaviorSection,
    conciseToolsSection,
    concisePlanSection,
  ]
}
