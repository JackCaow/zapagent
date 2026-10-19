import { z } from "zod";
import type { Tool } from "../tools/types.js";
import type { SkillDefinition } from "../skills/types.js";
import { applySkillTemplate } from "../skills/template.js";

export interface SkillToolOptions {
  /** Lookup for a skill by name. Returns null when the name is unknown.
   *  The app layer wires this to its SkillRegistry so the tool stays
   *  stateless and reflects whatever skills the user has installed
   *  (system / ~/.agents/skills / project .agents/skills). */
  getSkill: (name: string) => SkillDefinition | null;
  /** Snapshot of available skill names for the "unknown skill" error. */
  listNames: () => string[];
  /** Refresh host-owned discovery when a requested name was installed after startup. */
  refresh?: () => void;
}

/**
 * `skill` — load a named skill's instructions into the conversation.
 *
 * CCB-parity mechanic: the model calls this to pull in domain-specific
 * guidance (brainstorming, writing-plans, systematic-debugging, etc.) when
 * it detects a matching task. The tool output is the skill's full body;
 * the model reads it and follows the instructions in the same run.
 *
 * Not a subagent spawn. Not a system-prompt replacement. Just a one-shot
 * injection of expert guidance as a tool_result.
 */
export function skillTool(options: SkillToolOptions): Tool {
  const { getSkill, listNames } = options;

  return {
    definition: {
      name: "skill",
      description:
        "Load a named skill to receive specialized instructions for the task. " +
        "Use a skill when the user explicitly requests it or its guidance materially helps the current task. " +
        "Choose by purpose, not a name or keyword match, and load it when the relevant work begins. " +
        "The tool returns instructions; loading them does not perform the work. " +
        "Apply them within the user's scope and higher-priority instructions.",
      parameters: z.object({
        name: z.string().min(1).describe(
          "Exact skill name from the 'Skills' section of your system prompt.",
        ),
        params: z.record(z.string(), z.string()).optional().describe(
          "Template parameters to substitute {{name}} placeholders in the skill body. " +
          "Required params for each skill are listed in the system prompt's Skills section.",
        ),
      }),
      permission: "auto",
      readOnly: true,
    },
    handler: async (args) => {
      const name = (args.name as string).trim();
      let skill = getSkill(name);
      if (!skill && options.refresh) {
        options.refresh();
        skill = getSkill(name);
      }
      if (!skill) {
        const available = listNames().sort();
        return {
          success: false,
          output: "",
          error: `Unknown skill: "${name}". Available: ${available.join(", ")}`,
        };
      }
      const params = (args.params as Record<string, string> | undefined) ?? {};
      const { body, missingRequired } = applySkillTemplate(skill, params);
      if (missingRequired.length > 0) {
        const plural = missingRequired.length > 1 ? "s" : "";
        const example = missingRequired.map((p) => `"${p}": "..."`).join(", ");
        return {
          success: false,
          output: "",
          error:
            `Skill "${name}" requires param${plural}: ${missingRequired.join(", ")}. ` +
            `Re-call with: skill({name: "${name}", params: {${example}}}).`,
        };
      }
      return {
        success: true,
        output: skill.sourcePath ? `Skill source: ${skill.sourcePath}\nResolve relative resources against this file’s directory. Loading instructions does not grant file or process access.\n\n${body}` : body,
      };
    },
  };
}
