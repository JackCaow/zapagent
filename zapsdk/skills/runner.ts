import type { LLMProvider } from "../core/llm.js";
import { LoopAgent, type LoopAgentResult, type RunOptions } from "../agent/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolExecutor, type ToolExecutorOptions } from "../tools/executor.js";
import type { ConversationManager } from "../memory/conversation.js";
import type { ResultCompressor } from "../context/result-compressor.js";
import { SkillRegistry } from "./registry.js";
import { applySkillTemplate } from "./template.js";
import type { SkillDefinition, SkillInvocation } from "./types.js";

export interface SkillRunnerOptions {
  provider: LLMProvider;
  /** Master tool registry containing all available tools */
  toolRegistry: ToolRegistry;
  executorOptions?: ToolExecutorOptions;
  conversation?: ConversationManager;
  resultCompressor?: ResultCompressor;
}

export class SkillRunner {
  private provider: LLMProvider;
  private masterRegistry: ToolRegistry;
  private executorOptions?: ToolExecutorOptions;
  private conversation?: ConversationManager;
  private resultCompressor?: ResultCompressor;
  private skillRegistry = new SkillRegistry();

  constructor(options: SkillRunnerOptions) {
    this.provider = options.provider;
    this.masterRegistry = options.toolRegistry;
    this.executorOptions = options.executorOptions;
    this.conversation = options.conversation;
    this.resultCompressor = options.resultCompressor;
  }

  /** Register a skill definition */
  registerSkill(skill: SkillDefinition): void {
    this.skillRegistry.register(skill);
  }

  /** List all registered skills */
  listSkills(): SkillDefinition[] {
    return this.skillRegistry.list();
  }

  /** Run a skill by name with the given input and parameters */
  async run(invocation: SkillInvocation, options?: RunOptions): Promise<LoopAgentResult> {
    const skill = this.skillRegistry.get(invocation.skill);
    if (!skill) {
      throw new Error(`Skill "${invocation.skill}" not found. Available: ${this.skillRegistry.names().join(", ")}`);
    }

    const { body: systemPrompt, missingRequired } = applySkillTemplate(
      skill,
      invocation.params,
    );
    if (missingRequired.length > 0) {
      const plural = missingRequired.length > 1 ? "s" : "";
      throw new Error(
        `Required parameter${plural} "${missingRequired.join('", "')}" not provided for skill "${skill.name}"`,
      );
    }

    // Validate and create a filtered tool registry
    if (skill.tools.length > 0) {
      const missing = skill.tools.filter((t) => !this.masterRegistry.has(t));
      if (missing.length > 0) {
        throw new Error(`Skill "${skill.name}" requires tools not in registry: ${missing.join(", ")}`);
      }
    }

    const skillRegistry = skill.tools.length > 0
      ? this.masterRegistry.subset(skill.tools)
      : this.masterRegistry;

    const executor = new ToolExecutor(skillRegistry, this.executorOptions);

    const agent = new LoopAgent({
      provider: this.provider,
      registry: skillRegistry,
      executor,
      systemPrompt,
      maxSteps: skill.maxSteps ?? 10,
      reserveSteps: skill.reserveSteps ?? 2,
      conversation: this.conversation,
      resultCompressor: this.resultCompressor,
    });

    return agent.run(invocation.input, options);
  }
}
