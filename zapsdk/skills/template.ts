import type { SkillDefinition } from "./types.js";

export interface AppliedTemplate {
  body: string;
  /** Required parameters that remained unresolved (no value provided, no default). */
  missingRequired: string[];
}

/**
 * Apply param substitution + declared defaults to a skill's systemPrompt.
 *
 * Provided params win over declared defaults. Required params with no value
 * and no default surface as `missingRequired` — caller decides whether to
 * throw (SkillRunner) or return a tool error (skill tool).
 *
 * Single source of truth shared by both invocation paths so they can't drift.
 */
export function applySkillTemplate(
  skill: SkillDefinition,
  params: Record<string, string> = {},
): AppliedTemplate {
  let body = skill.systemPrompt;
  const provided = new Set(Object.keys(params));

  for (const [k, v] of Object.entries(params)) {
    body = body.replaceAll(`{{${k}}}`, v);
  }

  for (const p of skill.parameters ?? []) {
    if (!provided.has(p.name) && p.default !== undefined) {
      body = body.replaceAll(`{{${p.name}}}`, p.default);
    }
  }

  const missingRequired: string[] = [];
  for (const p of skill.parameters ?? []) {
    if (p.required && body.includes(`{{${p.name}}}`)) {
      missingRequired.push(p.name);
    }
  }

  return { body, missingRequired };
}
