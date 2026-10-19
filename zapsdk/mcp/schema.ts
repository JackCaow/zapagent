// MCP tool parameter handling.
//
// We deliberately do NOT convert MCP JSON Schemas to Zod. JSON Schema has
// features (oneOf/anyOf/allOf/$ref/integer/nullable/format/pattern) that
// don't round-trip into Zod without a heavyweight converter, and any
// information lost there silently corrupts what the LLM sees.
//
// Instead the bridged framework Tool gets:
//   - `parameters`: a permissive passthrough Zod that accepts any object
//     so the executor's safeParse path stays uniform.
//   - `rawSchema`: the original JSON Schema, forwarded verbatim to the LLM
//     by the provider layer (see ToolDefinition.rawSchema).
//
// Argument validation is left to the MCP server itself. If the LLM produces
// invalid args, the server returns a JSON-RPC error which we surface as a
// ToolResult error — same as any other tool failure.

import { z } from "zod";

let cached: z.ZodType | null = null;

/** Singleton passthrough schema reused across every bridged MCP tool. */
export function passthroughObjectSchema(): z.ZodType {
  if (!cached) {
    cached = z.object({}).passthrough();
  }
  return cached;
}

/**
 * Defensive normalisation of an MCP tool's inputSchema. Most servers send
 * a `{ type: "object", properties: {…} }` object. A few omit `type`; some
 * send `null`. The LLM-side providers tolerate empty schemas, but ensuring
 * `type: object` here prevents weird behaviour with strict provider validators.
 */
export function normalizeInputSchema(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") {
    return { type: "object", properties: {} };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.type !== "object") {
    return { ...obj, type: "object" };
  }
  return obj;
}
