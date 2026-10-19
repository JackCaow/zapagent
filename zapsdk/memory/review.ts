import type { MdMemoryRecord } from "./md-store.js"
import {
  mdMemoryAgeDays,
  mdMemoryContentHash,
  resolveMdMemoryTimestamp,
  type MdMemoryType,
} from "./md-types.js"
import { normalizeLogicalNewlines } from "../utils/logical-lines.js"
import { resolveMdMemoryLifecycles, type MdMemoryLifecycleResolution } from "./md-lifecycle.js"

export type MemoryReviewScope = "global" | "project"

export type MemoryReviewIssueKind =
  | "stale"
  | "age_unknown"
  | "duplicate_content"
  | "near_duplicate_content"
  | "scope_conflict"
  | "scope_mismatch"
  | "provenance_mismatch"
  | "low_confidence"
  | "not_yet_valid"
  | "expired"
  | "superseded"
  | "lifecycle_invalid"
  | "supersedes_missing"

export interface MemoryReviewRecord {
  id: string
  scope: MemoryReviewScope
  record: MdMemoryRecord
}

export interface MemoryReviewIssue {
  kind: MemoryReviewIssueKind
  ageDays?: number
  relatedIds?: string[]
  /** Quantized Dice similarity for near-duplicate content. */
  similarity?: number
  expectedContentHash?: string
  actualContentHash?: string
  effectiveAt?: string
  detail?: string
}

export type MemoryReviewSuggestionKind =
  | "merge_duplicate"
  | "merge_near_duplicate"
  | "move_scope"
  | "consolidate_scope_conflict"

export interface MemoryReviewSuggestionSource {
  id: string
  scope: MemoryReviewScope
  name: string
}

export interface MemoryReviewSuggestionTarget {
  scope: MemoryReviewScope
  name: string
  type: MdMemoryType
}

export interface MemoryReviewSuggestion {
  id: string
  kind: MemoryReviewSuggestionKind
  confidence: "high" | "review"
  sources: MemoryReviewSuggestionSource[]
  target: MemoryReviewSuggestionTarget
}

export interface MemoryReviewResult {
  issuesById: Map<string, MemoryReviewIssue[]>
  counts: Record<MemoryReviewIssueKind, number>
  suggestions: MemoryReviewSuggestion[]
  suggestionsById: Map<string, MemoryReviewSuggestion[]>
}

export interface MemoryReviewOptions {
  staleAfterDays?: number
  now?: Date
  /** Stores available to the host. Defaults to both scopes. A single-store
   *  host may keep every memory type in its only available scope. */
  availableScopes?: readonly MemoryReviewScope[]
  /** Conservative normalized-content similarity threshold. Set false to
   *  disable near-duplicate review. Defaults to 0.8. */
  nearDuplicateThreshold?: number | false
}

const DEFAULT_STALE_AFTER_DAYS = 30
const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.8
const NEAR_DUPLICATE_MIN_CHARS = 24
const NEAR_DUPLICATE_MIN_SHINGLES = 16
const NEAR_DUPLICATE_MIN_LENGTH_RATIO = 0.7
const NEAR_DUPLICATE_SHINGLE_SIZE = 3
const NEAR_DUPLICATE_NAME_SUFFIXES = new Set([
  "backup", "copy", "current", "draft", "final", "latest", "legacy", "new", "old",
])
const GLOBAL_TYPES = new Set(["user", "feedback"])
const MERGE_SAFE_NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_\-]*$/

export function reviewMemoryRecords(
  records: readonly MemoryReviewRecord[],
  options: MemoryReviewOptions = {},
): MemoryReviewResult {
  const issuesById = new Map<string, MemoryReviewIssue[]>()
  const counts: Record<MemoryReviewIssueKind, number> = {
    stale: 0,
    age_unknown: 0,
    duplicate_content: 0,
    near_duplicate_content: 0,
    scope_conflict: 0,
    scope_mismatch: 0,
    provenance_mismatch: 0,
    low_confidence: 0,
    not_yet_valid: 0,
    expired: 0,
    superseded: 0,
    lifecycle_invalid: 0,
    supersedes_missing: 0,
  }
  const staleAfterDays = finiteNonNegativeInteger(options.staleAfterDays, DEFAULT_STALE_AFTER_DAYS)
  const nowMs = validDateMs(options.now) ?? Date.now()
  const availableScopes = memoryReviewAvailableScopes(options.availableScopes)
  const lifecycleById = resolveScopedMemoryLifecycles(records, new Date(nowMs))

  for (const entry of records) {
    addLifecycleReviewIssues(entry, lifecycleById.get(entry.id), records, issuesById, counts)
    const provenance = entry.record.frontmatter.provenance
    if (provenance) {
      const actualContentHash = mdMemoryContentHash(entry.record.body)
      const expectedContentHash = provenance.updated.contentHash
      if (expectedContentHash !== actualContentHash) {
        addIssue(issuesById, counts, entry.id, {
          kind: "provenance_mismatch",
          expectedContentHash,
          actualContentHash,
        })
      }
    }
    const targetScope = expectedScope(entry.record.frontmatter.type, availableScopes)
    if (entry.scope !== targetScope) {
      addIssue(issuesById, counts, entry.id, { kind: "scope_mismatch" })
    }
    const timestamp = resolveMdMemoryTimestamp(entry.record.frontmatter)
    if (timestamp.kind !== "valid") {
      addIssue(issuesById, counts, entry.id, { kind: "age_unknown" })
      continue
    }
    const ageDays = mdMemoryAgeDays(timestamp.timestamp, nowMs)
    if (ageDays > staleAfterDays) {
      addIssue(issuesById, counts, entry.id, { kind: "stale", ageDays })
    }
  }

  addGroupedIssues(records, issuesById, counts, {
    kind: "duplicate_content",
    key: (entry) => normalizeMemoryContent(entry.record.body),
    eligible: (key) => key.length > 0,
  })
  addGroupedIssues(records, issuesById, counts, {
    kind: "scope_conflict",
    key: (entry) => normalizeMemoryIdentity(entry.record.frontmatter.name),
    eligible: (_key, group) => new Set(group.map((entry) => entry.scope)).size > 1,
  })
  const nearDuplicatePairs = findNearDuplicatePairs(records, issuesById, options)
  addNearDuplicateIssues(nearDuplicatePairs, issuesById, counts)

  for (const issues of issuesById.values()) {
    issues.sort((a, b) => issuePriority(a.kind) - issuePriority(b.kind))
  }
  const suggestions = buildMemoryReviewSuggestions(
    records,
    issuesById,
    availableScopes,
    nearDuplicatePairs,
  )
  const suggestionsById = new Map<string, MemoryReviewSuggestion[]>()
  for (const suggestion of suggestions) {
    for (const source of suggestion.sources) {
      const existing = suggestionsById.get(source.id) ?? []
      existing.push(suggestion)
      suggestionsById.set(source.id, existing)
    }
  }
  return { issuesById, counts, suggestions, suggestionsById }
}

export function normalizeMemoryContent(content: string): string {
  return normalizeLogicalNewlines(content).toLowerCase().replace(/\s+/gu, " ").trim()
}

export function normalizeMemoryIdentity(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim()
}

function addGroupedIssues(
  records: readonly MemoryReviewRecord[],
  issuesById: Map<string, MemoryReviewIssue[]>,
  counts: Record<MemoryReviewIssueKind, number>,
  options: {
    kind: "duplicate_content" | "scope_conflict"
    key: (entry: MemoryReviewRecord) => string
    eligible: (key: string, group: MemoryReviewRecord[]) => boolean
  },
): void {
  const groups = new Map<string, MemoryReviewRecord[]>()
  for (const entry of records) {
    const key = options.key(entry)
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }
  for (const [key, group] of groups) {
    if (group.length < 2 || !options.eligible(key, group)) continue
    const ids = group.map((entry) => entry.id).sort((a, b) => a.localeCompare(b))
    for (const entry of group) {
      addIssue(issuesById, counts, entry.id, {
        kind: options.kind,
        relatedIds: ids.filter((id) => id !== entry.id),
      })
    }
  }
}

function addIssue(
  issuesById: Map<string, MemoryReviewIssue[]>,
  counts: Record<MemoryReviewIssueKind, number>,
  id: string,
  issue: MemoryReviewIssue,
): void {
  const issues = issuesById.get(id) ?? []
  issues.push(issue)
  issuesById.set(id, issues)
  counts[issue.kind]++
}

function validDateMs(date: Date | undefined): number | undefined {
  if (!date) return undefined
  const timestamp = date.getTime()
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function finiteNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback
}

function issuePriority(kind: MemoryReviewIssueKind): number {
  switch (kind) {
    case "provenance_mismatch": return 0
    case "lifecycle_invalid": return 1
    case "supersedes_missing": return 2
    case "scope_conflict": return 3
    case "scope_mismatch": return 4
    case "superseded": return 5
    case "expired": return 6
    case "not_yet_valid": return 7
    case "low_confidence": return 8
    case "duplicate_content": return 9
    case "near_duplicate_content": return 10
    case "stale": return 11
    case "age_unknown": return 12
  }
}

function resolveScopedMemoryLifecycles(
  records: readonly MemoryReviewRecord[],
  now: Date,
): Map<string, MdMemoryLifecycleResolution> {
  const out = new Map<string, MdMemoryLifecycleResolution>()
  for (const scope of ["global", "project"] as const) {
    const scoped = records.filter((entry) => entry.scope === scope)
    const resolved = resolveMdMemoryLifecycles(scoped.map((entry) => entry.record), now)
    for (const entry of scoped) {
      const resolution = resolved.get(entry.record.filename)
      if (resolution) out.set(entry.id, resolution)
    }
  }
  return out
}

function addLifecycleReviewIssues(
  entry: MemoryReviewRecord,
  resolution: MdMemoryLifecycleResolution | undefined,
  records: readonly MemoryReviewRecord[],
  issuesById: Map<string, MemoryReviewIssue[]>,
  counts: Record<MemoryReviewIssueKind, number>,
): void {
  if (!resolution) return
  const relatedIds = resolution.supersededBy.map((filename) => `${entry.scope}:${filename}`)
  switch (resolution.state) {
    case "active": break
    case "low_confidence":
      addIssue(issuesById, counts, entry.id, { kind: "low_confidence" })
      break
    case "not_yet_valid":
      addIssue(issuesById, counts, entry.id, {
        kind: "not_yet_valid",
        ...(resolution.validFromTimestamp !== undefined
          ? { effectiveAt: new Date(resolution.validFromTimestamp).toISOString() }
          : {}),
      })
      break
    case "expired":
      addIssue(issuesById, counts, entry.id, {
        kind: "expired",
        ...(resolution.expiresAtTimestamp !== undefined
          ? { effectiveAt: new Date(resolution.expiresAtTimestamp).toISOString() }
          : {}),
      })
      break
    case "superseded":
      addIssue(issuesById, counts, entry.id, { kind: "superseded", relatedIds })
      break
    case "invalid":
      addIssue(issuesById, counts, entry.id, {
        kind: "lifecycle_invalid",
        detail: lifecycleProblemDetail(resolution),
      })
      break
  }
  const missing = resolution.problems.filter((problem) =>
    problem.kind === "missing_supersedes_target" || problem.kind === "ambiguous_supersedes_target")
  if (missing.length > 0) {
    addIssue(issuesById, counts, entry.id, {
      kind: "supersedes_missing",
      detail: missing
        .map((problem) => `${problem.kind}:${problem.target ?? "unknown"}`)
        .join(", ")
        .slice(0, 400),
      relatedIds: records
        .filter((candidate) =>
          candidate.scope === entry.scope &&
          missing.some((problem) => problem.target === candidate.record.frontmatter.name))
        .map((candidate) => candidate.id)
        .sort((a, b) => a.localeCompare(b)),
    })
  }
}

function lifecycleProblemDetail(resolution: MdMemoryLifecycleResolution): string {
  return (resolution.problems
    .map((problem) => problem.target ? `${problem.kind}:${problem.target}` : problem.kind)
    .join(", ") || "invalid lifecycle metadata").slice(0, 400)
}

interface NearDuplicatePair {
  left: MemoryReviewRecord
  right: MemoryReviewRecord
  similarity: number
}

interface NearDuplicateProfile {
  entry: MemoryReviewRecord
  charCount: number
  shingles: Set<string>
  identity: string
  identityTokens: Set<string>
  baseIdentity: string
}

function findNearDuplicatePairs(
  records: readonly MemoryReviewRecord[],
  issuesById: ReadonlyMap<string, MemoryReviewIssue[]>,
  options: MemoryReviewOptions,
): NearDuplicatePair[] {
  if (options.nearDuplicateThreshold === false) return []
  const threshold = finiteUnitInterval(
    options.nearDuplicateThreshold,
    DEFAULT_NEAR_DUPLICATE_THRESHOLD,
  )
  const profiles: NearDuplicateProfile[] = []
  for (const entry of records) {
    if (issuesById.get(entry.id)?.some((issue) => issue.kind === "duplicate_content")) continue
    const chars = nearDuplicateCharacters(entry.record.body)
    if (chars.length < NEAR_DUPLICATE_MIN_CHARS) continue
    const shingles = characterShingles(chars, NEAR_DUPLICATE_SHINGLE_SIZE)
    if (shingles.size < NEAR_DUPLICATE_MIN_SHINGLES) continue
    const identityParts = nearDuplicateIdentityParts(entry.record.frontmatter.name)
    profiles.push({
      entry,
      charCount: chars.length,
      shingles,
      identity: normalizeMemoryIdentity(entry.record.frontmatter.name),
      identityTokens: new Set(identityParts.tokens),
      baseIdentity: identityParts.base.join("\0"),
    })
  }

  const pairs: NearDuplicatePair[] = []
  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex++) {
    const left = profiles[leftIndex]
    for (let rightIndex = leftIndex + 1; rightIndex < profiles.length; rightIndex++) {
      const right = profiles[rightIndex]
      if (left.entry.record.frontmatter.type !== right.entry.record.frontmatter.type) continue
      if (!nearDuplicateIdentitiesRelated(left, right)) continue
      const lengthRatio = Math.min(left.charCount, right.charCount) /
        Math.max(left.charCount, right.charCount)
      if (lengthRatio < NEAR_DUPLICATE_MIN_LENGTH_RATIO) continue
      const similarity = diceSimilarity(left.shingles, right.shingles)
      if (similarity < threshold) continue
      pairs.push({
        left: left.entry,
        right: right.entry,
        similarity: Math.round(similarity * 1_000) / 1_000,
      })
    }
  }
  return pairs.sort((a, b) =>
    a.left.id.localeCompare(b.left.id) || a.right.id.localeCompare(b.right.id))
}

function addNearDuplicateIssues(
  pairs: readonly NearDuplicatePair[],
  issuesById: Map<string, MemoryReviewIssue[]>,
  counts: Record<MemoryReviewIssueKind, number>,
): void {
  const related = new Map<string, { ids: Set<string>; similarity: number }>()
  for (const pair of pairs) {
    addNearDuplicateRelated(related, pair.left.id, pair.right.id, pair.similarity)
    addNearDuplicateRelated(related, pair.right.id, pair.left.id, pair.similarity)
  }
  for (const [id, value] of related) {
    addIssue(issuesById, counts, id, {
      kind: "near_duplicate_content",
      relatedIds: [...value.ids].sort((a, b) => a.localeCompare(b)),
      similarity: value.similarity,
    })
  }
}

function addNearDuplicateRelated(
  related: Map<string, { ids: Set<string>; similarity: number }>,
  id: string,
  relatedId: string,
  similarity: number,
): void {
  const value = related.get(id) ?? { ids: new Set<string>(), similarity: 0 }
  value.ids.add(relatedId)
  value.similarity = Math.max(value.similarity, similarity)
  related.set(id, value)
}

function nearDuplicateCharacters(content: string): string[] {
  return Array.from(
    normalizeLogicalNewlines(content)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ""),
  )
}

function nearDuplicateIdentityParts(value: string): { tokens: string[]; base: string[] } {
  const tokens = value
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => token.length >= 2) ?? []
  const base = [...tokens]
  while (base.length > 0 && isNearDuplicateNameSuffix(base[base.length - 1])) base.pop()
  return { tokens, base }
}

function isNearDuplicateNameSuffix(token: string): boolean {
  return NEAR_DUPLICATE_NAME_SUFFIXES.has(token) || /^v\d+$/u.test(token)
}

function nearDuplicateIdentitiesRelated(
  left: NearDuplicateProfile,
  right: NearDuplicateProfile,
): boolean {
  if (left.identity === right.identity) return true
  if (
    left.baseIdentity &&
    left.baseIdentity === right.baseIdentity &&
    left.baseIdentity.replaceAll("\0", "").length >= 4
  ) {
    return true
  }
  let shared = 0
  for (const token of left.identityTokens) {
    if (right.identityTokens.has(token) && ++shared >= 2) return true
  }
  return false
}

function characterShingles(chars: readonly string[], size: number): Set<string> {
  const shingles = new Set<string>()
  for (let index = 0; index <= chars.length - size; index++) {
    shingles.add(chars.slice(index, index + size).join(""))
  }
  return shingles
}

function diceSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  let intersection = 0
  for (const shingle of small) {
    if (large.has(shingle)) intersection++
  }
  return (2 * intersection) / (left.size + right.size)
}

function finiteUnitInterval(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback
}

function buildMemoryReviewSuggestions(
  records: readonly MemoryReviewRecord[],
  issuesById: ReadonlyMap<string, MemoryReviewIssue[]>,
  availableScopes: ReadonlySet<MemoryReviewScope>,
  nearDuplicatePairs: readonly NearDuplicatePair[],
): MemoryReviewSuggestion[] {
  const suggestions: MemoryReviewSuggestion[] = []
  const contentGroups = groupMemoryRecords(records, (entry) => normalizeMemoryContent(entry.record.body))
  for (const group of contentGroups.values()) {
    if (group.length < 2 || !normalizeMemoryContent(group[0].record.body)) continue
    if (!mergeSourcesResolvable(group, records)) continue
    const type = sharedMemoryType(group)
    if (!type) continue
    const targetScope = expectedScope(type, availableScopes)
    const targetRecord = canonicalTargetRecord(group, targetScope, issuesById, records)
    if (!targetRecord) continue
    suggestions.push(memoryReviewSuggestion(
      "merge_duplicate",
      "high",
      group,
      targetScope,
      targetRecord.record.frontmatter.name,
      type,
    ))
  }

  for (const pair of nearDuplicatePairs) {
    const group = [pair.left, pair.right]
    if (!mergeSourcesResolvable(group, records)) continue
    const type = sharedMemoryType(group)
    if (!type) continue
    const targetScope = expectedScope(type, availableScopes)
    const targetRecord = canonicalTargetRecord(group, targetScope, issuesById, records)
    if (!targetRecord) continue
    suggestions.push(memoryReviewSuggestion(
      "merge_near_duplicate",
      "review",
      group,
      targetScope,
      targetRecord.record.frontmatter.name,
      type,
    ))
  }

  const identityGroups = groupMemoryRecords(
    records,
    (entry) => normalizeMemoryIdentity(entry.record.frontmatter.name),
  )
  for (const group of identityGroups.values()) {
    if (group.length < 2 || new Set(group.map((entry) => entry.scope)).size < 2) continue
    if (!mergeSourcesResolvable(group, records)) continue
    if (suggestions.some((suggestion) =>
      (suggestion.kind === "merge_duplicate" || suggestion.kind === "merge_near_duplicate") &&
      group.every((entry) =>
        suggestion.sources.some((source) => source.id === entry.id)))) {
      continue
    }
    const type = sharedMemoryType(group)
    if (!type) continue
    const targetScope = expectedScope(type, availableScopes)
    const targetRecord = canonicalTargetRecord(group, targetScope, issuesById, records)
    if (!targetRecord) continue
    suggestions.push(memoryReviewSuggestion(
      "consolidate_scope_conflict",
      "review",
      group,
      targetScope,
      targetRecord.record.frontmatter.name,
      type,
    ))
  }

  const alreadySuggested = new Set(suggestions.flatMap((suggestion) =>
    suggestion.sources.map((source) => source.id)))
  for (const entry of records) {
    if (alreadySuggested.has(entry.id)) continue
    if (!issuesById.get(entry.id)?.some((issue) => issue.kind === "scope_mismatch")) continue
    const targetScope = expectedScope(entry.record.frontmatter.type, availableScopes)
    if (!targetAvailable(entry.record.frontmatter.name, targetScope, [entry], records)) continue
    suggestions.push(memoryReviewSuggestion(
      "move_scope",
      "high",
      [entry],
      targetScope,
      entry.record.frontmatter.name,
      entry.record.frontmatter.type,
    ))
  }

  return suggestions.sort((a, b) =>
    suggestionPriority(a.kind) - suggestionPriority(b.kind) || a.id.localeCompare(b.id))
}

function groupMemoryRecords(
  records: readonly MemoryReviewRecord[],
  keyOf: (entry: MemoryReviewRecord) => string,
): Map<string, MemoryReviewRecord[]> {
  const groups = new Map<string, MemoryReviewRecord[]>()
  for (const entry of records) {
    const key = keyOf(entry)
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }
  return groups
}

function sharedMemoryType(records: readonly MemoryReviewRecord[]): MdMemoryType | undefined {
  const types = new Set(records.map((entry) => entry.record.frontmatter.type))
  return types.size === 1 ? records[0].record.frontmatter.type : undefined
}

function expectedScope(
  type: MdMemoryType,
  availableScopes: ReadonlySet<MemoryReviewScope>,
): MemoryReviewScope {
  const preferred = GLOBAL_TYPES.has(type) ? "global" : "project"
  if (availableScopes.has(preferred)) return preferred
  return availableScopes.has("project") ? "project" : "global"
}

function memoryReviewAvailableScopes(
  scopes: readonly MemoryReviewScope[] | undefined,
): Set<MemoryReviewScope> {
  if (!scopes) return new Set(["global", "project"])
  const available = new Set(scopes)
  return available.size > 0 ? available : new Set(["global", "project"])
}

function canonicalTargetRecord(
  group: readonly MemoryReviewRecord[],
  targetScope: MemoryReviewScope,
  issuesById: ReadonlyMap<string, MemoryReviewIssue[]>,
  allRecords: readonly MemoryReviewRecord[],
): MemoryReviewRecord | undefined {
  return [...group]
    .sort((a, b) => compareCanonicalRecords(a, b, targetScope, issuesById))
    .find((entry) => targetAvailable(
      entry.record.frontmatter.name,
      targetScope,
      group,
      allRecords,
    ))
}

function compareCanonicalRecords(
  a: MemoryReviewRecord,
  b: MemoryReviewRecord,
  targetScope: MemoryReviewScope,
  issuesById: ReadonlyMap<string, MemoryReviewIssue[]>,
): number {
  const scopeDelta = Number(b.scope === targetScope) - Number(a.scope === targetScope)
  if (scopeDelta !== 0) return scopeDelta
  const aStale = issuesById.get(a.id)?.some((issue) => issue.kind === "stale") ?? false
  const bStale = issuesById.get(b.id)?.some((issue) => issue.kind === "stale") ?? false
  if (aStale !== bStale) return aStale ? 1 : -1
  const timestampDelta = comparableMemoryTimestamp(b.record) - comparableMemoryTimestamp(a.record)
  if (timestampDelta !== 0) return timestampDelta
  const metadataDelta = memoryMetadataScore(b.record) - memoryMetadataScore(a.record)
  if (metadataDelta !== 0) return metadataDelta
  return a.id.localeCompare(b.id)
}

function comparableMemoryTimestamp(record: MdMemoryRecord): number {
  const resolution = resolveMdMemoryTimestamp(record.frontmatter)
  return resolution.kind === "valid" ? resolution.timestamp : -1
}

function memoryMetadataScore(record: MdMemoryRecord): number {
  return record.frontmatter.description.trim().length +
    (record.frontmatter.tags?.length ?? 0) * 20 +
    (record.frontmatter.source ? 20 : 0)
}

function targetAvailable(
  name: string,
  targetScope: MemoryReviewScope,
  sources: readonly MemoryReviewRecord[],
  allRecords: readonly MemoryReviewRecord[],
): boolean {
  const sourceIds = new Set(sources.map((entry) => entry.id))
  const identity = normalizeMemoryIdentity(name)
  const exactFilename = `${name}.md`
  const foldedFilename = exactFilename.toLowerCase()
  return MERGE_SAFE_NAME_RE.test(name) && !allRecords.some((entry) => {
    const sameIdentity = normalizeMemoryIdentity(entry.record.frontmatter.name) === identity
    if (entry.scope === targetScope && sameIdentity && entry.record.filename !== exactFilename) {
      return true
    }
    if (sourceIds.has(entry.id)) return false
    return sameIdentity || (
      entry.scope === targetScope && entry.record.filename.toLowerCase() === foldedFilename
    )
  })
}

function mergeSourcesResolvable(
  sources: readonly MemoryReviewRecord[],
  allRecords: readonly MemoryReviewRecord[],
): boolean {
  return sources.every((source) => {
    const name = source.record.frontmatter.name
    if (!MERGE_SAFE_NAME_RE.test(name)) return false
    const identity = normalizeMemoryIdentity(name)
    return allRecords.filter((entry) =>
      entry.scope === source.scope &&
      normalizeMemoryIdentity(entry.record.frontmatter.name) === identity).length === 1
  })
}

function memoryReviewSuggestion(
  kind: MemoryReviewSuggestionKind,
  confidence: MemoryReviewSuggestion["confidence"],
  records: readonly MemoryReviewRecord[],
  targetScope: MemoryReviewScope,
  targetName: string,
  targetType: MdMemoryType,
): MemoryReviewSuggestion {
  const sources = [...records]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => ({
      id: entry.id,
      scope: entry.scope,
      name: entry.record.frontmatter.name,
    }))
  const target = { scope: targetScope, name: targetName, type: targetType }
  return {
    id: `${kind}:${sources.map((source) => source.id).join("|")}->${target.scope}:${target.name}`,
    kind,
    confidence,
    sources,
    target,
  }
}

function suggestionPriority(kind: MemoryReviewSuggestionKind): number {
  switch (kind) {
    case "merge_duplicate": return 0
    case "merge_near_duplicate": return 1
    case "move_scope": return 2
    case "consolidate_scope_conflict": return 3
  }
}
