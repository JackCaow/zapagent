import { describe, expect, it } from "bun:test";
import { DYNAMIC_BOUNDARY, stripBoundary } from "../../core/prompt-boundary.js";

describe("prompt boundary helpers", () => {
  it("strips every dynamic boundary marker before provider send", () => {
    const prompt = [
      "stable prefix",
      DYNAMIC_BOUNDARY,
      "dynamic suffix",
      DYNAMIC_BOUNDARY,
      "accidental second suffix",
    ].join("\n\n");

    const stripped = stripBoundary(prompt);

    expect(stripped).toBe("stable prefix\n\ndynamic suffix\n\naccidental second suffix");
    expect(stripped).not.toContain(DYNAMIC_BOUNDARY);
  });

  it("keeps prompts without a boundary unchanged", () => {
    expect(stripBoundary("stable prefix\n\nno marker")).toBe("stable prefix\n\nno marker");
  });
});
