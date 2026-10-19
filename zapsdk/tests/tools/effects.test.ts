import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  effectsToResourceClaims,
  isEffectivelyReadOnly,
  unknownToolEffects,
} from "../../tools/effects.js";
import { resolveDefinitionEffects } from "../../tools/compatibility.js";

describe("tool effects compatibility", () => {
  it("treats unknown legacy tools as mutating", () => {
    const effects = resolveDefinitionEffects({
      name: "legacy",
      description: "legacy",
      parameters: z.object({}),
    }, {});

    expect(effects.confidence).toBe("unknown");
    expect(isEffectivelyReadOnly(effects)).toBe(false);
    expect(effectsToResourceClaims(effects)).toEqual([
      { key: "global:unknown", mode: "exclusive" },
    ]);
  });

  it("uses declared per-call effects instead of a static read-only guess", () => {
    const definition = {
      name: "http",
      description: "http",
      parameters: z.object({ method: z.string() }),
      resolveEffects: (args: Record<string, unknown>) => ({
        filesystem: [],
        network: [{
          kind: "network" as const,
          operation: args.method === "GET" ? "connect" as const : "mutate" as const,
          destinations: ["https://example.com"],
        }],
        process: [],
        external: [],
        workspace: { mode: "none" as const },
        confidence: "declared" as const,
      }),
    };

    expect(isEffectivelyReadOnly(resolveDefinitionEffects(definition, { method: "GET" }))).toBe(true);
    expect(isEffectivelyReadOnly(resolveDefinitionEffects(definition, { method: "POST" }))).toBe(false);
  });

  it("creates exclusive claims for filesystem writes", () => {
    const effects = {
      ...unknownToolEffects(),
      confidence: "declared" as const,
      filesystem: [{
        kind: "filesystem" as const,
        operation: "modify" as const,
        paths: ["/repo/a.ts"],
      }],
      workspace: { mode: "root-integration" as const },
    };

    const claims = effectsToResourceClaims(effects).map((claim) => `${claim.mode}:${claim.key}`);
    expect(claims).toContain("exclusive:fs:/repo/a.ts");
    expect(claims).toContain("exclusive:workspace:root");
  });
});
