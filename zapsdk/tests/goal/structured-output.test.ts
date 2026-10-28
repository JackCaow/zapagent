import { describe, expect, it } from "bun:test";
import { GoalStructuredOutputError, goalPlanSchema, goalVerdictSchema, parseGoalObject, readGoalStructuredResult } from "../../goal/structured-output.js";

describe("Goal structured phase results", () => {
  const verdict = { status: "passed", detail: 'Checked {braces}, quotes " and Unicode 验收' };
  for (const wrap of [(s: string) => s, (s: string) => `\`\`\`json\n${s}\n\`\`\``, (s: string) => `Read-only inspection complete.\n\`\`\`json\n${s}\n\`\`\`\nNo files changed.`, (s: string) => `Audit completed:\n${s}`]) {
    it("validates an unambiguous object even with surrounding prose", () => {
      expect(parseGoalObject(wrap(JSON.stringify(verdict)), goalVerdictSchema)).toEqual(verdict);
    });
  }
  for (const text of ['{"status":"failed","status":"passed","detail":"ok"}', '{"status":"passed"}', '[{"status":"passed","detail":"ok"}]', '{"status":"passed","detail":"ok","extra":true}', '{"status":"passed","detail":"ok"}\n{"status":"failed","detail":"no"}', '{"status":"passed","detail":"ok"}\n{', 'Nothing to return', '{"status":"complete","detail":"ok"}']) {
    it(`rejects missing, invalid or ambiguous verdicts: ${text.slice(0, 45)}`, () => {
      expect(() => parseGoalObject(text, goalVerdictSchema)).toThrow(GoalStructuredOutputError);
    });
  }
  it("validates the complete DAG before permitting development work", () => {
    expect(parseGoalObject('{"tasks":[{"id":"a","description":"Report","acceptance":"Cited"}]}', goalPlanSchema).tasks).toHaveLength(1);
    for (const tasks of [[], [{ id: "a", description: "x", acceptance: "y", dependencies: ["a"] }], [{ id: "a", description: "x", acceptance: "y", dependencies: ["missing"] }]]) {
      expect(() => parseGoalObject(JSON.stringify({ tasks }), goalPlanSchema)).toThrow(GoalStructuredOutputError);
    }
  });
  it("corrects format at most twice and never retries execution, permission or sealing failures", async () => {
    let calls = 0;
    const result = await readGoalStructuredResult(async correction => {
      calls++;
      if (calls === 1) { expect(correction).toBe(""); return "Malformed result"; }
      expect(correction).toContain("Do not perform development work");
      return JSON.stringify(verdict);
    }, goalVerdictSchema);
    expect(result).toEqual(verdict); expect(calls).toBe(2);
    calls = 0;
    await expect(readGoalStructuredResult(async () => { calls++; return "Invalid"; }, goalVerdictSchema)).rejects.toThrow("GOAL_STRUCTURED_OUTPUT_INVALID");
    expect(calls).toBe(3);
    calls = 0;
    await expect(readGoalStructuredResult(async () => { calls++; throw new Error("GOAL_SEAL_UNCONFIRMED"); }, goalVerdictSchema)).rejects.toThrow("GOAL_SEAL_UNCONFIRMED");
    expect(calls).toBe(1);
  });
});
