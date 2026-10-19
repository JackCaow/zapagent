/**
 * Runtime context threaded into every PromptSection.
 *
 * Keep this small and pure — sections should read from it, not fetch from
 * the filesystem or the network. Anything the sections need computes here
 * once per prompt build.
 */
import type { PromptProfile } from "../../zapsdk/agent/prompt-profile.js"
import type { PromptPurpose } from "./registry.js"
import type { ExecutionEnvironmentFacts } from "../../zapsdk/execution/types.js"
import type { ExecutionCapacityFacts } from "../../zapsdk/execution/capacity.js"

export interface PromptContext {
  promptProfile?: PromptProfile
  /** Diagnostics receive assembled text in memory; hosts persist only lengths/hashes. */
  onSection?: (name: string, purpose: PromptPurpose, dynamic: boolean, text: string) => void
  /** Snapshot from the selected execution backend, not runtime discovery. */
  executionFacts?: ExecutionEnvironmentFacts
  executionCapacity?: ExecutionCapacityFacts
  /** Working directory the agent runs in. */
  cwd: string

  /** Names of all tools currently registered in the ToolRegistry. Sections
   *  adapt their wording to what actually exists — e.g. the "prefer read_file
   *  over cat" bullet is elided when read_file isn't enabled. */
  enabledTools: Set<string>

  /** Pre-built per-tool prompts (from the ToolDefinition.prompt fields, already
   *  concatenated by the registry). Appended by the tool-prompts section. */
  toolPromptsRaw?: string

  /** Active model id, used for self-awareness statements in the env section. */
  model?: string

  /** Custom system prompt that replaces the default stack entirely when set. */
  customSystemPrompt?: string

  /** Skills available to the `skill` tool. Populated from loaded SKILL.md
   *  files at session start. Empty/undefined → skills section is elided.
   *  `parameters` flows through so the section can list required/optional
   *  params and the model knows what to pass via the tool's `params` arg. */
  availableSkills?: ReadonlyArray<{
    name: string
    description: string
    parameters?: ReadonlyArray<{ name: string; required?: boolean; description?: string }>
  }>
}

/** Minimal context for standalone sections that do not inspect runtime fields. */
export const EMPTY_PROMPT_CONTEXT: PromptContext = {
  cwd: "",
  enabledTools: new Set<string>(),
}
