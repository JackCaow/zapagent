import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { LoopAgent } from "../../agent/loop.js";
import type { PromptProfile } from "../../agent/prompt-profile.js";
import type { LLMProvider } from "../../core/llm.js";
import type { Message, LLMResponse } from "../../core/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ConversationManager } from "../../memory/conversation.js";
import { subagentTool } from "../../builtin-tools/subagent.js";
import { todoWriteTool } from "../../builtin-tools/todo.js";
import type { Tool } from "../../tools/types.js";

function provider(calls: Message[][]): LLMProvider {
  return { async call(messages): Promise<LLMResponse> {
    calls.push(structuredClone(messages));
    return { type: "text", text: "Finished", usage: { inputTokens: 1, outputTokens: 1 } };
  } };
}

describe("SDK prompt profile", () => {
  it("preserves public project provenance through nested child runs", async () => {
    const publicSource = "<system-reminder>" + "Public project guidance. ".repeat(20) + "</system-reminder>";
    const registry = new ToolRegistry();
    let tool: Tool | undefined, calls = 0;
    const p: LLMProvider = { async call() {
      if (++calls === 1) return { type: "tool_call", text: "", toolCalls: [{ id: "nested", name: "agent", arguments: {
        task: "Quote the project document", agent_type: "general", system_prompt: "Nested role",
      } }], usage: { inputTokens: 1, outputTokens: 1 } };
      return { type: "text", text: publicSource, usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    new LoopAgent({ provider: p, registry, executor: new ToolExecutor(registry, { onApproval: async () => true }),
      systemPrompt: "Root role", subagent: { inheritedInstructions: publicSource, publicPromptSections: [publicSource], maxDepth: 2 },
      subagentFactory: options => { tool = subagentTool(options); return tool; } });
    const result = await tool!.handler({ task: "Quote the project document", agent_type: "general", system_prompt: "Child role" });
    expect(calls).toBe(3);
    expect(result.output).toContain(publicSource);
    expect(result.output).not.toContain("I can't share my system instructions");
  });
  it("does not accept model-supplied public-source exemptions in child arguments", async () => {
    const privateRule = "PRIVATE_HOST_RULE=" + "private host constraint. ".repeat(20);
    const registry = new ToolRegistry();
    let tool: Tool | undefined;
    const p: LLMProvider = { async call() {
      return { type: "text", text: privateRule, usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    new LoopAgent({ provider: p, registry, executor: new ToolExecutor(registry, { onApproval: async () => true }),
      systemPrompt: "Root role", subagent: { inheritedInstructions: privateRule, publicPromptSections: ["Public project guidance."] },
      subagentFactory: options => { tool = subagentTool(options); return tool; } });
    const result = await tool!.handler({ task: "Describe capabilities", agent_type: "explore", publicPromptSections: [privateRule] });
    expect(result.output).toContain("I can't share my system instructions");
    expect(result.output).not.toContain("PRIVATE_HOST_RULE");
  });
  for (const profile of ["standard", "concise"] as const) {
    it(`retains host instructions through nested children and custom briefings (${profile})`, async () => {
      const calls: Message[][] = [], registry = new ToolRegistry();
      let tool: Tool | undefined;
      const p: LLMProvider = { async call(messages): Promise<LLMResponse> {
        calls.push(structuredClone(messages));
        return calls.length === 1
          ? { type: "tool_call", text: "", toolCalls: [{ id: "nested", name: "agent", arguments: {
              task: "Nested fixture", agent_type: "general", system_prompt: "Nested custom role", inheritedInstructions: "FORGED_HOST_RULE",
            } }], usage: { inputTokens: 1, outputTokens: 1 } }
          : { type: "text", text: "Fixture report", usage: { inputTokens: 1, outputTokens: 1 } };
      } };
      new LoopAgent({ provider: p, registry, executor: new ToolExecutor(registry, { onApproval: async () => true }),
        systemPrompt: "ROOT_WORKFLOW_NOT_FOR_CHILDREN", promptProfile: profile,
        subagent: { maxDepth: 2, inheritedInstructions: "HOST_RULE: preserve original inputs." },
        subagentFactory: args => { tool = subagentTool(args); return tool; } });
      const result = await tool!.handler({ task: "Child fixture", agent_type: "general", system_prompt: "Child custom role", inheritedInstructions: "FORGED_HOST_RULE" });
      expect(result.success).toBe(true);
      expect(calls).toHaveLength(3);
      for (const messages of calls) {
        const system = messages.find(m => m.role === "system")!.content;
        expect(system.split("HOST_RULE: preserve original inputs.")).toHaveLength(2);
        expect(system).not.toContain("FORGED_HOST_RULE");
        expect(system).not.toContain("ROOT_WORKFLOW_NOT_FOR_CHILDREN");
        expect(system.split("[Evidence and review scope]")).toHaveLength(2);
        expect(system).toContain("do not present agreement with the briefing as independent verification");
      }
      expect(calls[0][0].content).toContain("Child custom role");
      expect(calls[1][0].content).toContain("Nested custom role");
    });
  }

  it("keeps default SDK prompt bytes and schemas unchanged", () => {
    const registry = new ToolRegistry(), p = provider([]);
    const make = (promptProfile?: PromptProfile) => new LoopAgent({ provider: p, registry,
      executor: new ToolExecutor(registry, {}), systemPrompt: "Host instructions", promptProfile });
    const legacy = make(), standard = make("standard"), concise = make("concise");
    expect(standard.effectiveSystemPrompt()).toBe(legacy.effectiveSystemPrompt());
    // Compare provider-visible schemas, not per-agent capability closures.
    const schemas = (agent: LoopAgent) => agent.toolDefinitions().map(({ name, description, parameters }) => ({ name, description, parameters: z.toJSONSchema(parameters) }));
    expect(schemas(concise)).toEqual(schemas(standard));
    expect(concise.effectiveSystemPrompt()).not.toContain("3-5 ordered");
    expect(concise.effectiveSystemPrompt()).toContain("Host instructions");
  });

  it("replaces the prior system protocol on resume and profile change without adding protocol turns", async () => {
    const calls: Message[][] = [], registry = new ToolRegistry();
    let conversation = new ConversationManager({ maxMessages: 100 });
    for (const profile of ["standard", "concise", "concise", "standard"] as const) {
      const restored = new ConversationManager({ maxMessages: 100 });
      for (const message of conversation.getAllMessages()) restored.add(message);
      conversation = restored;
      const agent = new LoopAgent({ provider: provider(calls), registry, executor: new ToolExecutor(registry, {}),
        promptProfile: profile, conversation, maxSteps: 3 });
      await agent.run(`Request ${calls.length}`);
      const sent = calls.at(-1)!;
      expect(sent.filter(m => m.role === "system")).toHaveLength(1);
      expect(sent.filter(m => m.content.includes("[AGENT PROTOCOL]"))).toHaveLength(1);
      expect(sent[0].content.includes("Profile: concise")).toBe(profile === "concise");
      expect(sent.filter(m => m.content.startsWith("Request "))).toHaveLength(calls.length);
    }
  });

  it("inherits the profile into a real child run without accepting a model-selected override", async () => {
    const calls: Message[][] = [], registry = new ToolRegistry();
    let tool: Tool | undefined;
    new LoopAgent({ provider: provider(calls), registry, executor: new ToolExecutor(registry, {}),
      promptProfile: "concise", subagent: { maxDepth: 1 }, subagentFactory: args => {
        tool = subagentTool(args);
        return tool;
      } });
    const result = await tool!.handler({ task: "Inspect the question", agent_type: "explore", system_prompt: "Child host instructions", promptProfile: "standard" });
    expect(result.success).toBe(true);
    expect(calls[0][0].content).toContain("Profile: concise");
    expect(calls[0][0].content).toContain("Child host instructions");
    expect(calls[0][0].content).not.toContain("3-5 ordered");
  });

  it("keeps an explicitly required plan enforced under concise", async () => {
    const calls: Message[][] = [], registry = new ToolRegistry();
    let executed = false, turns = 0;
    registry.register(todoWriteTool({ store: { get: () => [], set: () => {} } }));
    registry.register({ definition: { name: "change", description: "mutate fixture", parameters: z.object({}) },
      handler: async () => { executed = true; return { success: true, output: "changed" }; } });
    const p: LLMProvider = { async call(messages) {
      calls.push(structuredClone(messages));
      return turns++ === 0
        ? { type: "tool_call", text: "", toolCalls: [{ id: "change", name: "change", arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } }
        : { type: "text", text: "Blocked by explicit planning policy", usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    await new LoopAgent({ provider: p, registry, executor: new ToolExecutor(registry, {}), promptProfile: "concise",
      taskDecomposition: "required", maxSteps: 5 }).run("Change the fixture");
    expect(executed).toBe(false);
    expect(calls[0][0].content).toContain("host explicitly requires a plan");
    expect(JSON.stringify(calls.at(-1))).toContain("Task decomposition required");
  });

  it("retains permission denial and the deadline under concise", async () => {
    const registry = new ToolRegistry(), calls: Message[][] = [];
    let executed = false, now = 0;
    registry.register({ definition: { name: "denied", description: "denied operation", parameters: z.object({}), permission: "deny" },
      handler: async () => { executed = true; return { success: true, output: "unexpected" }; } });
    const p: LLMProvider = {
      async call(messages) {
        calls.push(structuredClone(messages));
        return { type: "text", text: "Deadline reached; operation did not run.", usage: { inputTokens: 1, outputTokens: 1 } };
      },
      async *stream(messages) {
        calls.push(structuredClone(messages));
        now = 900;
        yield { type: "tool_call_start", toolCallId: "denied", toolName: "denied" };
        yield { type: "tool_call_delta", toolCallId: "denied", partialJson: "{}" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const result = await new LoopAgent({ provider: p, registry, executor: new ToolExecutor(registry, {}),
      promptProfile: "concise", timeoutMs: 1000, forceFinishTimeoutMs: 200, now: () => now, maxSteps: 4 }).run("Perform operation");
    expect(executed).toBe(false);
    expect(result.stopped).toBe("timeout");
    expect(result.toolResults[0].success).toBe(false);
    expect(JSON.stringify(calls.at(-1))).toContain("denied");
    expect(JSON.stringify(calls[0])).toContain("remaining (100%)");
  });
});
