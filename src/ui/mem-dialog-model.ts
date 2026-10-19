import type { MdMemoryRecord, MdMemoryStore } from "../../zapsdk/memory/md-store.js"
import type { MdMemoryType } from "../../zapsdk/memory/md-types.js"
import {
  reviewMemoryRecords,
  type MemoryReviewIssue,
  type MemoryReviewOptions,
  type MemoryReviewSuggestion,
} from "../../zapsdk/memory/review.js"

export type MemDialogScope = "global" | "project"

export interface ScopedMemoryRecord {
  id: string
  scope: MemDialogScope
  store: MdMemoryStore
  record: MdMemoryRecord
  issues: MemoryReviewIssue[]
  suggestions: MemoryReviewSuggestion[]
}

const SCOPE_PRIORITY: Record<MemDialogScope, number> = {
  global: 0,
  project: 1,
}
const TYPE_PRIORITY: Record<MdMemoryType, number> = {
  user: 0,
  feedback: 1,
  project: 2,
  reference: 3,
}

export function listScopedMemoryRecords(options: {
  projectStore: MdMemoryStore
  globalStore: MdMemoryStore
  review?: MemoryReviewOptions
}): ScopedMemoryRecord[] {
  // /mem is an explicit maintenance surface, so show mis-scoped legacy
  // global project/reference records here even though recall correctly filters
  // them out. Hiding them would make scope-conflict errors impossible to fix.
  const globalRecords = options.globalStore.list()
    .map((record) => scopedRecord("global", options.globalStore, record))
  const projectRecords = options.projectStore.list()
    .map((record) => scopedRecord("project", options.projectStore, record))

  const records = [...globalRecords, ...projectRecords]
  const review = reviewMemoryRecords(records, options.review)
  return records
    .map((record) => ({
      ...record,
      issues: review.issuesById.get(record.id) ?? [],
      suggestions: review.suggestionsById.get(record.id) ?? [],
    }))
    .sort(compareScopedMemoryRecords)
}

export function findScopedMemoryRecord(
  records: readonly ScopedMemoryRecord[],
  id: string,
): ScopedMemoryRecord | undefined {
  return records.find((record) => record.id === id)
}

export function deleteScopedMemoryRecord(record: ScopedMemoryRecord): boolean {
  return record.store.delete(record.record.filename)
}

export function formatScopedMemoryMeta(record: ScopedMemoryRecord): string {
  const review = record.issues.length > 0
    ? ` · review: ${record.issues.map((issue) => memoryReviewIssueLabel(issue.kind)).join(", ")}`
    : ""
  const suggestion = record.suggestions[0]
    ? ` · suggested: ${memoryReviewSuggestionLabel(record.suggestions[0])}`
    : ""
  return `[${record.scope}:${record.record.frontmatter.type}] ${record.record.frontmatter.description}${review}${suggestion}`
}

export function formatScopedMemoryTitle(record: ScopedMemoryRecord): string {
  return `${record.record.frontmatter.name}  [${record.scope}:${record.record.frontmatter.type}]`
}

export function formatScopedMemoryReviewNotices(record: ScopedMemoryRecord): string[] {
  return record.issues.map((issue) => {
    const related = issue.relatedIds?.length ? ` Related: ${issue.relatedIds.join(", ")}.` : ""
    switch (issue.kind) {
      case "stale":
        return `Stale: last update was ${issue.ageDays ?? "more than 30"} days ago. Verify it against current state before reuse.`
      case "age_unknown":
        return "Age unknown: this record has no valid createdAt or updatedAt timestamp."
      case "duplicate_content":
        return `Duplicate content: another memory has equivalent normalized content.${related}`
      case "near_duplicate_content":
        return `Near-duplicate content: another same-type memory is ${formatSimilarity(issue.similarity)} similar. Read both bodies before merging.${related}`
      case "scope_conflict":
        return `Scope conflict: the same memory name exists in global and project stores.${related}`
      case "scope_mismatch":
        return record.scope === "global"
          ? "Scope mismatch: project/reference memory is stored globally. Review and move it explicitly."
          : "Scope mismatch: user/feedback memory is stored in this project. Review and move it explicitly."
      case "provenance_mismatch":
        return `Provenance mismatch: body hash ${shortHash(issue.actualContentHash)} no longer matches the latest host record ${shortHash(issue.expectedContentHash)}. Verify the file before reuse.`
      case "low_confidence":
        return "Low-confidence candidate: excluded from automatic recall until it is verified and saved with medium or high confidence."
      case "not_yet_valid":
        return `Not yet valid: automatic recall starts at ${issue.effectiveAt ?? "the declared validFrom time"}.`
      case "expired":
        return `Expired: automatic recall stopped at ${issue.effectiveAt ?? "the declared expiresAt time"}.`
      case "superseded":
        return `Superseded: a newer memory replaces this record, so it remains audit-only.${related}`
      case "lifecycle_invalid":
        return `Invalid lifecycle: this record is excluded from automatic recall. ${issue.detail ?? "Repair its lifecycle metadata."}`
      case "supersedes_missing":
        return `Supersession warning: a declared predecessor is missing or ambiguous. ${issue.detail ?? "Review the supersedes list."}`
    }
  })
}

export function formatScopedMemorySuggestionNotices(record: ScopedMemoryRecord): string[] {
  return record.suggestions.map((suggestion) => {
    const sources = suggestion.sources.map((source) => source.id).join(", ")
    const target = `${suggestion.target.scope}:${suggestion.target.name}`
    switch (suggestion.kind) {
      case "merge_duplicate":
        return `Suggested maintenance: inspect duplicate records ${sources} in /mem before deciding which durable record to retain for ${target}. No automatic records are changed.`
      case "merge_near_duplicate":
        return `Suggested maintenance: inspect near-duplicate records ${sources} in /mem before deciding which durable record to retain for ${target}. Bodies differ, so preserve all durable details; no automatic records are changed.`
      case "move_scope":
        return `Suggested maintenance: inspect ${sources} in /mem before deciding whether to replace them with a record in ${target}. No automatic records are changed.`
      case "consolidate_scope_conflict":
        return `Suggested maintenance: inspect and reconcile ${sources} in /mem before deciding which durable record to retain for ${target}. Source bodies differ, so preserve all durable details; no automatic records are changed.`
    }
  })
}

function scopedRecord(
  scope: MemDialogScope,
  store: MdMemoryStore,
  record: MdMemoryRecord,
): ScopedMemoryRecord {
  return {
    id: `${scope}:${record.filename}`,
    scope,
    store,
    record,
    issues: [],
    suggestions: [],
  }
}

function memoryReviewIssueLabel(kind: MemoryReviewIssue["kind"]): string {
  return kind.replaceAll("_", " ")
}

function memoryReviewSuggestionLabel(suggestion: MemoryReviewSuggestion): string {
  switch (suggestion.kind) {
    case "merge_duplicate": return `merge duplicate -> ${suggestion.target.scope}:${suggestion.target.name}`
    case "merge_near_duplicate": return `review near duplicate -> ${suggestion.target.scope}:${suggestion.target.name}`
    case "move_scope": return `move -> ${suggestion.target.scope}:${suggestion.target.name}`
    case "consolidate_scope_conflict": return `consolidate -> ${suggestion.target.scope}:${suggestion.target.name}`
  }
}

function formatSimilarity(similarity: number | undefined): string {
  if (typeof similarity !== "number" || !Number.isFinite(similarity)) return "highly"
  return `${Math.round(Math.min(1, Math.max(0, similarity)) * 100)}%`
}

function shortHash(value: string | undefined): string {
  if (!value) return "unknown"
  const hash = value.startsWith("sha256:") ? value.slice("sha256:".length) : value
  return hash.slice(0, 12)
}

function compareScopedMemoryRecords(a: ScopedMemoryRecord, b: ScopedMemoryRecord): number {
  const scopeDelta = SCOPE_PRIORITY[a.scope] - SCOPE_PRIORITY[b.scope]
  if (scopeDelta !== 0) return scopeDelta
  const typeDelta = TYPE_PRIORITY[a.record.frontmatter.type] - TYPE_PRIORITY[b.record.frontmatter.type]
  if (typeDelta !== 0) return typeDelta
  const nameDelta = a.record.frontmatter.name.localeCompare(b.record.frontmatter.name)
  if (nameDelta !== 0) return nameDelta
  return a.record.filename.localeCompare(b.record.filename)
}
