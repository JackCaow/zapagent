import { createHash } from "node:crypto"

export const MD_MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const
export type MdMemoryType = typeof MD_MEMORY_TYPES[number]

export const MD_MEMORY_PROVENANCE_ORIGINS = ["memory_save", "memory_merge", "compact_summary"] as const
export type MdMemoryProvenanceOrigin = typeof MD_MEMORY_PROVENANCE_ORIGINS[number]

export const MD_MEMORY_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const
export type MdMemoryConfidence = typeof MD_MEMORY_CONFIDENCE_LEVELS[number]

export interface MdMemoryLifecycleInput {
  confidence?: MdMemoryConfidence
  validFrom?: string | null
  expiresAt?: string | null
  supersedes?: string[]
}

export interface MdMemoryLifecycle {
  version: 1
  confidence: MdMemoryConfidence
  validFrom?: string
  expiresAt?: string
  supersedes?: string[]
}

export interface MdMemoryProvenanceInput {
  origin: MdMemoryProvenanceOrigin
  sessionId?: string
  toolCallId?: string
  step?: number
}

export interface MdMemoryProvenanceEvent extends MdMemoryProvenanceInput {
  contentHash: string
}

export interface MdMemoryProvenance {
  version: 1
  created?: MdMemoryProvenanceEvent
  updated: MdMemoryProvenanceEvent
}

export function mdMemoryContentHash(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`
}

export interface MdFrontmatter {
  name: string
  description: string
  type: MdMemoryType
  tags?: string[]
  source?: string
  lifecycle?: MdMemoryLifecycle
  /** Parse-only safety marker. Malformed lifecycle metadata must not silently
   *  turn into an active legacy record. It is never serialized. */
  lifecycleInvalid?: true
  /** Original scalar retained so rollback/restore does not silently activate a
   *  malformed manually-authored lifecycle record. */
  lifecycleRaw?: string
  provenance?: MdMemoryProvenance
  createdAt?: string
  updatedAt?: string
}

export type MdMemoryTimestampResolution =
  | { kind: "valid"; timestamp: number }
  | { kind: "missing" }
  | { kind: "invalid" }

/** Resolve the semantic age carried by a memory record. Filesystem mtime is
 *  intentionally outside this helper: callers may use it only as a legacy
 *  fallback when a record has no declared timestamp. */
export function resolveMdMemoryTimestamp(
  frontmatter: Pick<MdFrontmatter, "createdAt" | "updatedAt">,
): MdMemoryTimestampResolution {
  const raw = frontmatter.updatedAt ?? frontmatter.createdAt
  if (!raw) return { kind: "missing" }
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp)
    ? { kind: "valid", timestamp }
    : { kind: "invalid" }
}

/** Whole UTC-day age used by recall, review, and explicit-read warnings. */
export function mdMemoryAgeDays(timestamp: number, nowTimestamp = Date.now()): number {
  return Math.max(0, Math.floor(
    (utcDayStartMs(nowTimestamp) - utcDayStartMs(timestamp)) / 86_400_000,
  ))
}

function utcDayStartMs(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export function isMdMemoryType(v: unknown): v is MdMemoryType {
  return typeof v === "string" && (MD_MEMORY_TYPES as readonly string[]).includes(v)
}
