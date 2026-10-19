import {
  MD_MEMORY_CONFIDENCE_LEVELS,
  MD_MEMORY_PROVENANCE_ORIGINS,
  isMdMemoryType,
  type MdFrontmatter,
  type MdMemoryLifecycle,
  type MdMemoryProvenance,
  type MdMemoryProvenanceEvent,
  type MdMemoryProvenanceOrigin,
} from "./md-types"

export interface ParsedMdFile {
  frontmatter: MdFrontmatter
  body: string
}

const DELIM = "---"

/** Parse a markdown file with YAML-ish frontmatter. Strict subset:
 *  - File MUST start with a `---` delimiter line
 *  - Closing `---` on its own line ends the frontmatter
 *  - Each frontmatter line is `key: value`; values can be JSON-quoted strings
 *  - Required keys: name (str), description (str), type (MdMemoryType)
 *  - Returns null on any deviation. */
export function parseMdFile(src: string): ParsedMdFile | null {
  if (typeof src !== "string") return null
  src = src.replace(/\r\n?/g, "\n")
  if (!src.startsWith(DELIM + "\n")) return null
  const bodyBase = DELIM.length + 1
  const close = /\n---(?:\n|$)/.exec(src.slice(bodyBase))
  if (!close) return null
  const endIdx = bodyBase + close.index
  const fmText = src.slice(bodyBase, endIdx)
  const bodyStart = endIdx + close[0].length
  const body = src.slice(bodyStart).replace(/^\n+/, "")

  const obj: Record<string, string> = {}
  for (const line of fmText.split("\n")) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/.exec(line)
    if (!m) continue
    let val = m[2].trim()
    // Allow JSON-quoted strings to escape colons / hashes / leading whitespace.
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      try { val = JSON.parse(val) as string } catch { /* keep raw */ }
    }
    obj[m[1]] = val
  }
  if (!obj.name || !obj.description || !isMdMemoryType(obj.type)) return null

  const frontmatter: MdFrontmatter = {
    name: obj.name,
    description: obj.description,
    type: obj.type,
  }
  const tags = parseTags(obj.tags)
  if (tags.length > 0) frontmatter.tags = tags
  if (obj.source) frontmatter.source = obj.source
  if (obj.lifecycle) {
    const lifecycle = parseLifecycle(obj.lifecycle)
    if (lifecycle) frontmatter.lifecycle = lifecycle
    else {
      frontmatter.lifecycleInvalid = true
      frontmatter.lifecycleRaw = obj.lifecycle
    }
  }
  const provenance = parseProvenance(obj.provenance)
  if (provenance) frontmatter.provenance = provenance
  if (obj.createdAt) frontmatter.createdAt = obj.createdAt
  if (obj.updatedAt) frontmatter.updatedAt = obj.updatedAt

  return { frontmatter, body }
}

/** Serialize frontmatter + body back to markdown text. Quotes scalar fields
 *  when they contain characters that would confuse the line-based parser. */
export function serializeMdFile(fm: MdFrontmatter, body: string): string {
  const lines = [
    DELIM,
    `name: ${fm.name}`,
    `description: ${formatScalar(fm.description)}`,
    `type: ${fm.type}`,
  ]
  if (fm.tags?.length) lines.push(`tags: ${JSON.stringify(fm.tags)}`)
  if (fm.source) lines.push(`source: ${formatScalar(fm.source)}`)
  if (fm.lifecycle) lines.push(`lifecycle: ${serializeLifecycle(fm.lifecycle)}`)
  else if (fm.lifecycleInvalid && fm.lifecycleRaw) lines.push(`lifecycle: ${formatScalar(fm.lifecycleRaw)}`)
  if (fm.provenance) lines.push(`provenance: ${serializeProvenance(fm.provenance)}`)
  if (fm.createdAt) lines.push(`createdAt: ${fm.createdAt}`)
  if (fm.updatedAt) lines.push(`updatedAt: ${fm.updatedAt}`)
  lines.push(DELIM, "", body)
  return lines.join("\n")
}

function needsQuoting(s: string): boolean {
  return /[:#\r\n]/.test(s) || s !== s.trim() || s === ""
}

function formatScalar(s: string): string {
  return needsQuoting(s) ? JSON.stringify(s) : s
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return []
  const trimmed = raw.trim()
  if (!trimmed) return []
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return cleanTags(parsed)
    } catch { /* fall through to comma parsing */ }
  }
  return cleanTags(trimmed.split(","))
}

function cleanTags(values: unknown[]): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== "string") continue
    const tag = normalizeTagText(value)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b))
}

function normalizeTagText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase()
}

function parseLifecycle(raw: string): MdMemoryLifecycle | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (value.version !== 1 || !isMemoryConfidence(value.confidence)) return undefined
    const validFrom = optionalString(value.validFrom)
    const expiresAt = optionalString(value.expiresAt)
    const supersedes = optionalMemoryNames(value.supersedes)
    if (validFrom === null || expiresAt === null || supersedes === null) return undefined
    return {
      version: 1,
      confidence: value.confidence,
      ...(validFrom ? { validFrom } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(supersedes?.length ? { supersedes } : {}),
    }
  } catch {
    return undefined
  }
}

function serializeLifecycle(lifecycle: MdMemoryLifecycle): string {
  return JSON.stringify({
    version: 1,
    confidence: lifecycle.confidence,
    ...(lifecycle.validFrom ? { validFrom: lifecycle.validFrom } : {}),
    ...(lifecycle.expiresAt ? { expiresAt: lifecycle.expiresAt } : {}),
    ...(lifecycle.supersedes?.length ? { supersedes: [...lifecycle.supersedes] } : {}),
  })
}

function isMemoryConfidence(value: unknown): value is MdMemoryLifecycle["confidence"] {
  return typeof value === "string" &&
    (MD_MEMORY_CONFIDENCE_LEVELS as readonly string[]).includes(value)
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === "string" && value.trim() ? value : null
}

function optionalMemoryNames(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  const names: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length > 200 ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_\-]*$/.test(item)
    ) return null
    const identity = item.toLowerCase()
    if (seen.has(identity)) continue
    seen.add(identity)
    names.push(item)
  }
  return names.sort((a, b) => a.localeCompare(b))
}

function parseProvenance(raw: string | undefined): MdMemoryProvenance | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (value.version !== 1) return undefined
    const created = parseProvenanceEvent(value.created)
    const updated = parseProvenanceEvent(value.updated)
    if (!updated) return undefined
    return {
      version: 1,
      ...(created ? { created } : {}),
      updated,
    }
  } catch {
    return undefined
  }
}

function parseProvenanceEvent(value: unknown): MdMemoryProvenanceEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const event = value as Record<string, unknown>
  if (!isProvenanceOrigin(event.origin)) return undefined
  if (typeof event.contentHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(event.contentHash)) return undefined
  if (event.sessionId !== undefined && typeof event.sessionId !== "string") return undefined
  if (event.toolCallId !== undefined && typeof event.toolCallId !== "string") return undefined
  if (event.step !== undefined && (!Number.isInteger(event.step) || (event.step as number) < 0)) return undefined
  return {
    origin: event.origin,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    ...(event.step !== undefined ? { step: event.step as number } : {}),
    contentHash: event.contentHash,
  }
}

function serializeProvenance(provenance: MdMemoryProvenance): string {
  return JSON.stringify({
    version: 1,
    ...(provenance.created ? { created: canonicalProvenanceEvent(provenance.created) } : {}),
    updated: canonicalProvenanceEvent(provenance.updated),
  })
}

function canonicalProvenanceEvent(event: MdMemoryProvenanceEvent): MdMemoryProvenanceEvent {
  return {
    origin: event.origin,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    ...(event.step !== undefined ? { step: event.step } : {}),
    contentHash: event.contentHash,
  }
}

function isProvenanceOrigin(value: unknown): value is MdMemoryProvenanceOrigin {
  return typeof value === "string" && (MD_MEMORY_PROVENANCE_ORIGINS as readonly string[]).includes(value)
}
