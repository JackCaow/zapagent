import { createHash } from "node:crypto"
import { TokenCounter } from "../../zapsdk/context/token-counter.js"
import { canonicalizeJsonSchema, zodToJsonSchema } from "../../zapsdk/tools/schema.js"
import type { ToolDefinition } from "../../zapsdk/tools/types.js"
import { countCodePoints } from "../../zapsdk/utils/logical-lines.js"

export interface ToolSchemaDiagnostics {
  count: number
  chars?: number
  estimatedTokens?: number
  hash: string
  names: string[]
}

const tokenCounter = new TokenCounter()

export function buildToolSchemaDiagnostics(definitions: ToolDefinition[]): ToolSchemaDiagnostics {
  const tools = [...definitions]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: canonicalizeJsonSchema(tool.rawSchema ?? zodToJsonSchema(tool.parameters)),
    }))
  const serialized = stableJsonStringify(tools)
  return {
    count: tools.length,
    chars: countCodePoints(serialized),
    estimatedTokens: tokenCounter.countText(serialized),
    hash: createHash("sha256").update(serialized).digest("hex").slice(0, 12),
    names: tools.map((tool) => tool.name),
  }
}

function stableJsonStringify(value: unknown): string {
  return stableStringify(value, false) ?? "null"
}

function stableStringify(value: unknown, inArray: boolean): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return inArray ? "null" : undefined
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry, true) ?? "null").join(",")}]`
  }
  const record = value as Record<string, unknown>
  const entries: string[] = []
  for (const key of Object.keys(record).sort()) {
    const encoded = stableStringify(record[key], false)
    if (encoded === undefined) continue
    entries.push(`${JSON.stringify(key)}:${encoded}`)
  }
  return `{${entries.join(",")}}`
}
