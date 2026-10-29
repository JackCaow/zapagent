import { expect, it } from "bun:test";
import { normalizeAssistantText } from "../../agent/output-text.js";

for (const source of [
  "left<tool_call_x>" + "gap".repeat(120) + "</tool_call_x>right",
  "left<|tool_calls_section_begin|>gap<|tool_calls_section_end|>right",
  "left<arg_key>İ</arg_key><arg_value>值İ</arg_value><tool_call_x>gap</tool_call_x>right",
  "left<arg_key>name</arg_key><arg_value>" + "before".repeat(100) + "<tool_call_x>gap</tool_call_x>after</arg_value>right",
  "left<arg_key>" + "before".repeat(100) + "<tool_call_x>gap</tool_call_x>after</arg_key><arg_value>value</arg_value>right",
  "left<arg_key>A<arg_key>B</arg_key><arg_value>C</arg_value>D</arg_key><arg_value>E</arg_value>right",
  JSON.stringify({ name: "sample", description: "public data ".repeat(100), arguments: { input: "value" } }),
  "left <toolbox>right",
  "left <arg_key>bad<div>literal</div>right",
  "A < B and x < 3",
  "Hello <tool_ca",
]) {
  it(`keeps every streaming prefix stable for ${source.slice(0, 45)}`, () => {
    const final = normalizeAssistantText(source);
    expect(normalizeAssistantText(final)).toBe(final);
    for (let end = 0; end <= source.length; end++) {
      expect(final.startsWith(normalizeAssistantText(source.slice(0, end), false).trimEnd())).toBe(true);
    }
  });
}

it("normalizes removed control pairs before counting visible characters", () => {
  expect(normalizeAssistantText("  left<arg_key>name</arg_key><arg_value>value</arg_value>right  ")).toBe("leftright");
  expect(normalizeAssistantText("  left<arg_key>name</arg_key><arg_value>value</arg_value>right  ", false)).toBe("left");
});
