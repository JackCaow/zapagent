import { expect, it } from "bun:test";
import { LoopAgent } from "../../agent/loop.js";
import { AgentBudget } from "../../agent/budget.js";
import { subagentTool } from "../../builtin-tools/subagent.js";
import { ToolRegistry } from "../../tools/registry.js";

for (const exhausted of [false, true]) {
  it(`salvages an empty child report without starting another provider request (exhausted=${exhausted})`, async () => {
    const budget = new AgentBudget({ maxSteps: exhausted ? 0 : 10 });
    let providerCalls = 0;
    // Exercise the adapter's fallback contract independently of LoopAgent's
    // normal nonempty final text. No global module mock survives this test.
    const originalRun = LoopAgent.prototype.run;
    LoopAgent.prototype.run = async () => ({
      text: "", steps: 1, totalUsage: { inputTokens: 4, outputTokens: 2 },
      toolResults: [{ success: true, output: "Observed file contents, with bounded trailing detail" }],
    });
    try {
      const tool = subagentTool({
        provider: { async call() { providerCalls++; return { type: "text", text: "unmetered", usage: { inputTokens: 8, outputTokens: 3 } }; } },
        registry: new ToolRegistry(), budget, maxSalvageChars: 22,
      });
      const result = await tool.handler({ task: "inspect", agent_type: "plan" });
      expect(result.success).toBe(true);
      expect(result.output).toContain("Observed file contents");
      expect(result.output).not.toContain("bounded trailing detail");
      expect(result.meta).toMatchObject({ salvage: "raw", usage: { inputTokens: 4, outputTokens: 2 } });
      expect(providerCalls).toBe(0);
      expect(budget.stepsUsed).toBe(0);
    } finally { LoopAgent.prototype.run = originalRun; }
  });
}
