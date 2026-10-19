export interface SkillDefinition {
  /** Unique skill name */
  name: string;
  /** Human-readable description */
  description: string;
  /** System prompt template — can use {{param}} placeholders */
  systemPrompt: string;
  /** List of tool names this skill requires */
  tools: string[];
  /** Parameter definitions for the skill */
  parameters?: SkillParameter[];
  /** Maximum steps for this skill (default: 10) */
  maxSteps?: number;
  /** Reserved steps for wrap-up (default: 2) */
  reserveSteps?: number;
  /** Absolute path of the directory the skill was loaded from. Optional —
   *  set by `loadSkillsFromDir` so callers (e.g. UI) can group skills by
   *  origin (user-installed vs codex-cache aggregated). */
  loadedFrom?: string;
  /** Exact instruction file; relative assets resolve against its directory. */
  sourcePath?: string;
}

export interface SkillParameter {
  name: string;
  description: string;
  required?: boolean;
  default?: string;
}

export interface SkillInvocation {
  /** Skill name to invoke */
  skill: string;
  /** User input / task description */
  input: string;
  /** Parameter values for template substitution */
  params?: Record<string, string>;
}
