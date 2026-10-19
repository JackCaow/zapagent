import { z } from "zod";
import type { Tool } from "../tools/types.js";
import { emptyToolEffects } from "../tools/effects.js";
import { createPersistedOutputReader } from "../utils/tool-result-storage.js";
import { countCodePoints, sliceHeadCodePoints } from "../utils/logical-lines.js";

/** Reads runtime artifacts through a host-owned session capability. This does
 * not grant workspace tools access to the application's private data tree. */
export function toolOutputTool(sessionId: string, projectCwd: string): Tool {
  const read = createPersistedOutputReader(sessionId, projectCwd);
  return {
    definition: {
      name: "read_tool_output",
      description: "Read or search this agent's persisted tool output using the path in a persisted-output marker. Offset and limit count Unicode characters, not lines. Search finds the next literal match at or after offset.",
      parameters: z.object({
        path: z.string(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(8_000).default(2_000),
        search: z.string().min(1).max(1_000).optional(),
      }),
      permission: "confirm",
      executionLocation: "host",
      readOnly: true,
      resolveEffects: (args) => ({
        ...emptyToolEffects(),
        external: [{ kind: "external", system: "tool-output-store", operation: "read", resource: `${sessionId}:${String(args.path)}` }],
      }),
    },
    handler: async (args) => {
      try {
        const content = read(args.path as string);
        const total = countCodePoints(content);
        let offset = Math.min(args.offset as number, total);
        let start = sliceHeadCodePoints(content, offset).length;
        if (typeof args.search === "string") {
          const match = content.indexOf(args.search, start);
          if (match < 0) return { success: true, output: JSON.stringify({ found: false, total_chars: total, next_offset: null }) };
          start = match;
          offset = countCodePoints(content.slice(0, start));
        }
        const page = sliceHeadCodePoints(content.slice(start), args.limit as number);
        const next = offset + countCodePoints(page);
        return { success: true, output: JSON.stringify({
          offset, total_chars: total, next_offset: next < total ? next : null, content: page,
          ...(args.search ? { found: true, next_search_offset: offset + 1 } : {}),
        }) };
      } catch (error) {
        return { success: false, output: "", error: `Cannot read persisted output: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}
