import { z } from "zod"
import type { Tool, ToolResult } from "../zapsdk/tools/types.js"
import { emptyToolEffects } from "../zapsdk/tools/effects.js"
import { CAPABILITY_KINDS, MAX_REQUESTED_CAPABILITIES, REQUEST_CAPABILITIES_TOOL, capabilityPattern, describeCapabilityPatterns, parseCapabilityRequest } from "./capabilities.js"

/** Asks the user up front for what a task will need. The Host decides: the
 * approval prompt saves the requested capability rules for the session or
 * project, and deny/ask rules keep precedence over them. */
export function requestCapabilitiesTool(granted: (args: Record<string, unknown>) => boolean): Tool {
  return {
    definition: {
      name: REQUEST_CAPABILITIES_TOOL,
      description: "Ask the user once, before multi-step work, for the file edits, network hosts or external systems it will need, so later calls run without interrupting them.",
      prompt: "Use only when a task will clearly need several approvals of the same kind (for example edits under src/** plus requests to one API host). " +
        "Request the narrowest scopes that cover the work. File scopes are project-relative globs; net scopes are hosts; external scopes are systems such as mcp:<server>. " +
        "This cannot authorize shell commands or running outside the sandbox. If the user declines, continue with ordinary per-call approval or ask them.",
      parameters: z.object({
        capabilities: z.array(z.object({
          kind: z.enum(CAPABILITY_KINDS as [string, ...string[]]),
          scope: z.string().min(1).max(200),
        })).min(1).max(MAX_REQUESTED_CAPABILITIES),
        reason: z.string().min(1).max(300).describe("What the task is and why it needs these capabilities"),
      }),
      permission: "confirm",
      // Changes Host authorization state, so it is never read-only.
      resolveEffects: () => ({ ...emptyToolEffects(), external: [{ kind: "external", system: "zapcode:permissions", operation: "mutate" }] }),
    },
    handler: async (args): Promise<ToolResult> => {
      const requested = parseCapabilityRequest(args)
      if (typeof requested === "string") return { success: false, output: "", error: requested }
      const described = describeCapabilityPatterns(requested.map(capability => capabilityPattern(capability.kind, capability.scope)))
      return granted(args)
        ? { success: true, output: `Granted: ${described}. Calls within these capabilities run without asking; deny/ask rules still apply and anything else still asks.` }
        : { success: true, output: `Approved without saving: ${described}. Matching calls may still ask.` }
    },
  }
}
