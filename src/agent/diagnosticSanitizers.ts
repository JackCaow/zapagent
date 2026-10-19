import type { ContextDiagnostics } from "../../zapsdk/agent/events.js"
import { countCodePoints } from "../../zapsdk/utils/logical-lines.js"
import type { PromptCacheDiagnostics } from "./promptDiagnostics.js"

const MAX_DIAGNOSTIC_SEGMENTS = 16
const MAX_DIAGNOSTIC_LIST_ITEMS = 24
const MAX_DIAGNOSTIC_TEXT_LENGTH = 160
const MAX_CONVERSATION_MESSAGE_HASHES = 128

export function sanitizeContextDiagnostics(value: unknown): ContextDiagnostics | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.hash !== "string") return undefined
  if (!Array.isArray(value.segments)) return undefined

  const segments = value.segments
    .map((segment) => {
      if (!isRecord(segment)) return null
      if (typeof segment.name !== "string" || typeof segment.hash !== "string") return null
      const out: ContextDiagnostics["segments"][number] = {
        name: sanitizeText(segment.name),
        chars: nonNegativeFinite(segment.chars),
        estimatedTokens: nonNegativeFinite(segment.estimatedTokens),
        hash: sanitizeText(segment.hash),
      }
      const meta = sanitizeContextSegmentMeta(segment.meta)
      if (meta) out.meta = meta
      return out
    })
    .filter((segment): segment is ContextDiagnostics["segments"][number] => segment !== null)
    .slice(0, MAX_DIAGNOSTIC_SEGMENTS)
  const conversationCache = sanitizeConversationCacheDiagnostics(value.conversationCache)

  return {
    totalChars: nonNegativeFinite(value.totalChars),
    estimatedTokens: nonNegativeFinite(value.estimatedTokens),
    hash: sanitizeText(value.hash),
    segments,
    ...(conversationCache ? { conversationCache } : {}),
  }
}

function sanitizeConversationCacheDiagnostics(
  value: unknown,
): ContextDiagnostics["conversationCache"] | undefined {
  if (!isRecord(value)) return undefined
  const prefix = sanitizeConversationCacheSlice(value.prefix)
  const tail = sanitizeConversationCacheSlice(value.tail)
  if (!prefix || !tail || !isRecord(value.prefix)) return undefined
  const messageHashes = Array.isArray(value.prefix.messageHashes)
    ? value.prefix.messageHashes
      .filter((hash): hash is string => typeof hash === "string" && hash.trim().length > 0)
      .slice(0, MAX_CONVERSATION_MESSAGE_HASHES)
      .map(sanitizeText)
    : []
  return {
    prefix: { ...prefix, messageHashes },
    tail,
  }
}

function sanitizeConversationCacheSlice(
  value: unknown,
): NonNullable<ContextDiagnostics["conversationCache"]>["tail"] | undefined {
  if (!isRecord(value) || typeof value.hash !== "string") return undefined
  return {
    messageCount: nonNegativeInteger(value.messageCount),
    chars: nonNegativeFinite(value.chars),
    estimatedTokens: nonNegativeFinite(value.estimatedTokens),
    hash: sanitizeText(value.hash),
  }
}

export function sanitizePromptCacheDiagnostics(value: unknown): PromptCacheDiagnostics | undefined {
  if (!isRecord(value)) return undefined
  const staticPrefix = sanitizePromptSegmentDiagnostics(value.staticPrefix)
  if (!staticPrefix) return undefined
  const dynamicSuffix = sanitizePromptSegmentDiagnostics(value.dynamicSuffix)
  const toolSchemas = sanitizePromptToolSchemaDiagnostics(value.toolSchemas)
  return {
    staticPrefix,
    ...(value.profile === "standard" || value.profile === "concise" ? { profile: value.profile } : {}),
    ...(Array.isArray(value.sections) ? { sections: value.sections.flatMap(section => {
      if (!isRecord(section) || typeof section.name !== "string") return []
      const segment = sanitizePromptSegmentDiagnostics(section)
      const purpose = ["protocol", "identity", "behavior", "authority", "tool-contract", "discovery", "project", "environment", "user", "unspecified"].includes(String(section.purpose))
        ? section.purpose as NonNullable<PromptCacheDiagnostics["sections"]>[number]["purpose"] : "unspecified" as const
      return segment ? [{ ...segment, name: sanitizeText(section.name), purpose, dynamic: section.dynamic === true }] : []
    }).slice(0, 32) } : {}),
    ...(dynamicSuffix ? { dynamicSuffix } : {}),
    ...(toolSchemas ? { toolSchemas } : {}),
    boundaryPresent: value.boundaryPresent === true,
    ...(typeof value.boundaryCount === "number"
      ? { boundaryCount: Math.floor(nonNegativeFinite(value.boundaryCount)) }
      : {}),
  }
}

function sanitizePromptSegmentDiagnostics(value: unknown): PromptCacheDiagnostics["staticPrefix"] | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.hash !== "string") return undefined
  return {
    chars: nonNegativeFinite(value.chars),
    estimatedTokens: nonNegativeFinite(value.estimatedTokens),
    hash: sanitizeText(value.hash),
  }
}

function sanitizePromptToolSchemaDiagnostics(value: unknown): PromptCacheDiagnostics["toolSchemas"] | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.hash !== "string") return undefined
  const names = Array.isArray(value.names)
    ? value.names
      .filter((entry): entry is string => typeof entry === "string")
      .slice(0, MAX_DIAGNOSTIC_LIST_ITEMS)
      .map(sanitizeText)
    : []
  return {
    count: nonNegativeInteger(value.count),
    ...(typeof value.chars === "number" ? { chars: nonNegativeFinite(value.chars) } : {}),
    ...(typeof value.estimatedTokens === "number" ? { estimatedTokens: nonNegativeFinite(value.estimatedTokens) } : {}),
    hash: sanitizeText(value.hash),
    names,
  }
}

function sanitizeContextSegmentMeta(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, unknown> = {}
  const included = sanitizeStringList(value.included)
  if (included.length > 0) out.included = included
  const excerpted = sanitizeStringList(value.excerpted)
  if (excerpted.length > 0) out.excerpted = excerpted
  const skipped = sanitizeSkipped(value.skipped)
  if (skipped) out.skipped = skipped
  const selected = sanitizeRecallDiagnostics(value.selected)
  if (selected.length > 0) out.selected = selected
  const topSkipped = sanitizeRecallDiagnostics(value.topSkipped)
  if (topSkipped.length > 0) out.topSkipped = topSkipped
  if (typeof value.queryHash === "string" && value.queryHash.trim().length > 0) {
    out.queryHash = sanitizeText(value.queryHash)
  }
  if (value.queryKind === "direct" || value.queryKind === "low_signal") {
    out.queryKind = value.queryKind
  }
  if (value.queryFallback === true) out.queryFallback = true
  if (typeof value.budgetTokens === "number") out.budgetTokens = nonNegativeFinite(value.budgetTokens)
  if (typeof value.todoCount === "number") out.todoCount = nonNegativeFinite(value.todoCount)
  if (typeof value.inProgressCount === "number") out.inProgressCount = nonNegativeFinite(value.inProgressCount)
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, MAX_DIAGNOSTIC_LIST_ITEMS)
    .map(sanitizeText)
}

function sanitizeRecallDiagnostics(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  const out: Record<string, unknown>[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    if (typeof item.filename !== "string" || item.filename.trim().length === 0) continue
    const record: Record<string, unknown> = {
      filename: sanitizeText(item.filename),
      score: nonNegativeFinite(item.score),
      relevanceScore: nonNegativeFinite(item.relevanceScore),
      recencyBoost: nonNegativeFinite(item.recencyBoost),
    }
    if (typeof item.lexicalScore === "number") {
      record.lexicalScore = nonNegativeFinite(item.lexicalScore)
    }
    if (typeof item.semanticScore === "number") {
      record.semanticScore = Math.min(1, nonNegativeFinite(item.semanticScore))
    }
    if (item.confidence === "high" || item.confidence === "medium" || item.confidence === "low") {
      record.confidence = item.confidence
    }
    if (
      item.lifecycleState === "active" ||
      item.lifecycleState === "low_confidence" ||
      item.lifecycleState === "not_yet_valid" ||
      item.lifecycleState === "expired" ||
      item.lifecycleState === "superseded" ||
      item.lifecycleState === "invalid"
    ) {
      record.lifecycleState = item.lifecycleState
    }
    if (item.pinned === true) record.pinned = true
    if (item.excerpted === true) record.excerpted = true
    if (typeof item.skippedReason === "string" && item.skippedReason.trim().length > 0) {
      record.skippedReason = sanitizeText(item.skippedReason)
    }
    out.push(record)
    if (out.length >= MAX_DIAGNOSTIC_LIST_ITEMS) break
  }
  return out
}

function sanitizeSkipped(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, number> = {}
  for (const [key, count] of Object.entries(value).slice(0, MAX_DIAGNOSTIC_LIST_ITEMS).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof count !== "number") continue
    out[sanitizeText(key)] = nonNegativeFinite(count)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeText(value: string): string {
  return countCodePoints(value) > MAX_DIAGNOSTIC_TEXT_LENGTH
    ? Array.from(value).slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH).join("")
    : value
}

function nonNegativeFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0
}

function nonNegativeInteger(value: unknown): number {
  return Math.floor(nonNegativeFinite(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
