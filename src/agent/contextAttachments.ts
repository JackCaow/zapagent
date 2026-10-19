import type { LoopAgentResult, Todo } from "../../zapsdk/index.js"
import { renderTodoAttachment } from "../prompts/sections/todos.js"
import { buildMdIndex, buildMdPack } from "../../zapsdk/memory/md-pack.js"
import type { MdPackRecordDiagnostic } from "../../zapsdk/memory/md-pack.js"
import { openMdStore } from "../../zapsdk/memory/md-store.js"
import type { MdMemoryRecord, MdMemoryStore } from "../../zapsdk/memory/md-store.js"
import type { MdMemoryType } from "../../zapsdk/memory/md-types.js"
import { activeMdMemoryRecords } from "../../zapsdk/memory/md-lifecycle.js"
import type { AutoMemory } from "../../zapsdk/memory/auto-memory.js"
import {
  normalizeMemorySemanticScores,
  type MemorySemanticDocument,
  type MemorySemanticRetriever,
  type MemorySemanticScope,
} from "../../zapsdk/memory/semantic.js"
import { TokenCounter } from "../../zapsdk/context/token-counter.js"
import type { ContextDiagnostics } from "../../zapsdk/agent/events.js"
import { createHash } from "node:crypto"
import { countCodePoints, sliceHeadCodePoints, sliceTailCodePoints, splitLogicalLines } from "../utils/logicalLines.js"
import {
  buildMemoryUtilityCandidates,
  fingerprintMemoryUtilityText,
  type MemoryUtilityCandidate,
  type MemoryUtilityFingerprint,
} from "./memoryUtility.js"

/** Per-turn user-context attachment computed once at the start of each run.
 *  `memoryAttachment` is the MEMORY.md index; `workingPackAttachment` is the
 *  rendered Markdown working pack under a 2k-token budget. The working pack
 *  is query-ranked, filtered, capped, and de-duped so low-signal memories do
 *  not bloat the transient context. Both are stable for one run() call. */
export interface PerTurnAttachments {
  repoMapAttachment?: string | null
  repoMapIncluded?: string[]
  repoMapRevision?: number
  repoMapTokenBudget?: number
  repoMapTruncated?: boolean
  memoryAttachment: string | null
  memoryIndexIncluded: string[]
  memoryIndexSkipped: Record<string, number>
  memoryIndexRecall?: MemoryRecallDiagnostics
  memoryIndexTokenBudget?: number
  memoryQueryHash?: string
  memoryQueryKind?: "direct" | "low_signal"
  memoryQueryFallback?: boolean
  workingPackAttachment: string | null
  workingPackIncluded: string[]
  workingPackExcerpted?: string[]
  workingPackSkipped: Record<string, number>
  workingPackRecall?: MemoryRecallDiagnostics
  workingPackTokenBudget?: number
  globalMemoryAttachment?: string | null
  globalMemoryIndexIncluded?: string[]
  globalMemoryIndexSkipped?: Record<string, number>
  globalMemoryIndexRecall?: MemoryRecallDiagnostics
  globalMemoryIndexTokenBudget?: number
  globalWorkingPackAttachment?: string | null
  globalWorkingPackIncluded?: string[]
  globalWorkingPackExcerpted?: string[]
  globalWorkingPackSkipped?: Record<string, number>
  globalWorkingPackRecall?: MemoryRecallDiagnostics
  globalWorkingPackTokenBudget?: number
  /** Host-only hashed profiles for online utility attribution. Never rendered
   *  into provider context or persisted directly. */
  memoryUtilityCandidates?: MemoryUtilityCandidate[]
  memoryUtilityBaseline?: MemoryUtilityFingerprint
}

export interface MemoryRecallDiagnostics {
  selected: MemoryRecallRecordDiagnostic[]
  topSkipped: MemoryRecallRecordDiagnostic[]
}

export interface MemoryRecallRecordDiagnostic {
  filename: string
  score: number
  relevanceScore: number
  lexicalScore?: number
  semanticScore?: number
  recencyBoost: number
  confidence?: "high" | "medium" | "low"
  lifecycleState?: string
  pinned?: boolean
  excerpted?: boolean
  skippedReason?: string
}

export interface PerTurnAttachmentOptions {
  memoryQuery?: string
  memoryStore?: MdMemoryStore
  /** Optional cross-project personal memory store. Only user/feedback records
   *  are attached from this store so project facts cannot bleed across repos. */
  globalMemoryStore?: MdMemoryStore
  globalMemoryDir?: string
  /** Optional semantic scorer. It sees memory bodies and is called at most
   *  once per available scope for a meaningful query. Failures fall back to
   *  the existing lexical scorer. */
  semanticRetriever?: MemorySemanticRetriever
  /** Per-scope semantic scoring deadline. Defaults to 2 seconds. */
  semanticTimeoutMs?: number
  diagnosticsLogger?: MemoryAttachmentDiagnosticsLogger
  /** Active model context window. Small windows scale memory attachments down. */
  contextWindow?: number
  /** One stable instant for lifecycle evaluation across every recall stage. */
  now?: Date
}

export interface MemoryAttachmentDiagnosticsLogger {
  warn(event: string, fields?: Record<string, unknown>): void
}

export interface MemoryAttachmentFailureDiagnostic {
  stage: "index" | "working_pack"
  memoryDir: string
  queryPresent: boolean
  error: string
}

export interface MemoryQueryHistoryLog {
  type: string
  text: string
  restore?: boolean
  restoreText?: string
}

export interface MemoryQueryHistoryMessage {
  role: string
  content: string
}

export interface MemoryAttachmentBudgets {
  indexTokenBudget: number
  workingPackTokenBudget: number
  fallbackWorkingPackTokenBudget: number
}

const DEFAULT_MEMORY_INDEX_BUDGET = 768
const DEFAULT_MEMORY_WORKING_PACK_BUDGET = 2048
const DEFAULT_MEMORY_FALLBACK_PACK_BUDGET = 1024
const GLOBAL_MEMORY_BUDGET_SCALE = 0.5
const FULL_MEMORY_CONTEXT_WINDOW = 64_000
const MIN_MEMORY_BUDGET_SCALE = 0.25
const MEMORY_RECALL_DIAGNOSTIC_LIMIT = 4
const DEFAULT_MEMORY_SEMANTIC_TIMEOUT_MS = 2_000
const GLOBAL_MEMORY_TYPES = new Set<MdMemoryType>(["user", "feedback"])
const COMPACT_STATE_FILENAME = "project_compact_state.md"
const COMPACT_TIMELINE_FILENAME = "project_compact_timeline.md"
const ESCAPED_TIMELINE_ENTRY_START = "&lt;!-- zap-compact-snapshot:start --&gt;"
const ESCAPED_TIMELINE_ENTRY_END = "&lt;!-- zap-compact-snapshot:end --&gt;"
const MEMORY_QUERY_HEAD_CHARS = 2048
const MEMORY_QUERY_TAIL_CHARS = 2048
const MEMORY_QUERY_MAX_CHARS = MEMORY_QUERY_HEAD_CHARS + MEMORY_QUERY_TAIL_CHARS
const MEMORY_QUERY_LONG_LINE_CHARS = 500
const MEMORY_QUERY_LONG_TOKEN_ANCHOR_CHARS = 160
const MEMORY_QUERY_MULTILINE_BODY_LINES = 24
const MEMORY_QUERY_MULTILINE_ANCHOR_LIMIT = 8
const LONG_MEMORY_QUERY_TOKEN_RE = /\S{501,}/gu
const CJK_ANCHOR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const GENERATED_CONTEXT_BLOCK_RE = /<(file_content|mcp_resource)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/g
const RUNTIME_CONTEXT_BLOCK_RE = /<(task-notification|system-context|active_plan|system-reminder|codex_internal_context|environment_context|memory)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/g
const POST_COMPACT_RESTORED_FILES_BLOCK_RE = /\[Context was just compacted\. Re-injecting recently-read files so you don't have to re-read them:\][\s\S]*?(?:\[End of restored files\]|$)/g
const CONTEXT_COMPACTED_SUMMARY_BLOCK_RE = /(^|\n)\s*\[Context compacted[^\]\n]*earlier messages summarized\][\s\S]*$/u
const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g
const PASTED_PLACEHOLDER_RE = /\[Pasted #[1-9]\d* · \d+ lines · \d+ chars\]/g
const UNAVAILABLE_PASTED_HISTORY_RE = /\[Pasted #\d+ unavailable in history; paste again to resend full text\]/g
const DATA_URI_MEMORY_QUERY_RE = /\bdata:[^\s,;]+(?:;[^\s,;]+)*;base64,[A-Za-z0-9+/=]{32,}/giu
const BASE64_BLOB_MEMORY_QUERY_RE = /(^|[\s"'`=:,;\[\]{}()<>])([A-Za-z0-9+/]{120,}={0,2})(?=$|[\s"'`=:,;\[\]{}()<>])/gu
const LONG_TOKEN_PLACEHOLDER = "[long token omitted from memory query]"
const PASTED_TEXT_PLACEHOLDER = "[pasted text omitted from memory query]"
const MULTILINE_TEXT_PLACEHOLDER = "[multiline text omitted from memory query]"
const DATA_URI_PLACEHOLDER = "[data URI omitted from memory query]"
const BASE64_BLOB_PLACEHOLDER = "[base64 blob omitted from memory query]"
const LOW_SIGNAL_CONTINUATION_QUERY = "zap_low_signal_continue"
export const MEMORY_QUERY_HISTORY_LIMIT = 12
const LOW_SIGNAL_CONTINUATION_PHRASES = new Set([
  "go on",
  "keep going",
  "proceed",
  "start",
  "start now",
  "continue",
  "continue please",
  "continue working",
  "接着",
  "接着来",
  "开始",
  "开始吧",
  "继续",
  "继续吧",
  "继续推进",
  "继续工作",
  "还有后续的么",
  "还有后续的吗",
  "后续呢",
])

export function deriveMemoryAttachmentBudgets(contextWindow?: number): MemoryAttachmentBudgets {
  const validWindow = typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ? Math.floor(contextWindow)
    : undefined
  const scale = validWindow === undefined
    ? 1
    : Math.min(1, Math.max(MIN_MEMORY_BUDGET_SCALE, validWindow / FULL_MEMORY_CONTEXT_WINDOW))
  return {
    indexTokenBudget: Math.max(1, Math.floor(DEFAULT_MEMORY_INDEX_BUDGET * scale)),
    workingPackTokenBudget: Math.max(1, Math.floor(DEFAULT_MEMORY_WORKING_PACK_BUDGET * scale)),
    fallbackWorkingPackTokenBudget: Math.max(1, Math.floor(DEFAULT_MEMORY_FALLBACK_PACK_BUDGET * scale)),
  }
}

function scaleMemoryAttachmentBudgets(
  budgets: MemoryAttachmentBudgets,
  scale: number,
): MemoryAttachmentBudgets {
  return {
    indexTokenBudget: Math.max(1, Math.floor(budgets.indexTokenBudget * scale)),
    workingPackTokenBudget: Math.max(1, Math.floor(budgets.workingPackTokenBudget * scale)),
    fallbackWorkingPackTokenBudget: Math.max(1, Math.floor(budgets.fallbackWorkingPackTokenBudget * scale)),
  }
}

export async function buildPerTurnAttachments(
  autoMemory: AutoMemory,
  options: PerTurnAttachmentOptions = {},
): Promise<PerTurnAttachments> {
  const query = normalizeMemoryQuery(options.memoryQuery)
  const hasQuery = !!query?.trim()
  const continuationQuery = isContinuationMemoryQuery(query)
  const projectPinnedFilter = (record: MdMemoryRecord) =>
    !isGeneratedCompactMemory(record.filename) || continuationQuery
  const projectMinQueryTermMatches = (record: MdMemoryRecord) =>
    isGeneratedCompactMemory(record.filename) && hasQuery && !continuationQuery
      ? 2
      : undefined
  const queryHash = hasQuery ? shortHash(query ?? "") : undefined
  const queryMeta = classifyMemoryQuery(query)
  const budgets = deriveMemoryAttachmentBudgets(options.contextWindow)
  const recallNow = validRecallDate(options.now)
  let memoryAttachment: string | null = null
  let memoryIndexIncluded: string[] = []
  let memoryIndexSkipped: Record<string, number> = {}
  let memoryIndexRecall: MemoryRecallDiagnostics | undefined
  let workingPackAttachment: string | null = null
  let workingPackIncluded: string[] = []
  let workingPackExcerpted: string[] = []
  let workingPackSkipped: Record<string, number> = {}
  let workingPackRecall: MemoryRecallDiagnostics | undefined
  let workingPackTokenBudget = budgets.workingPackTokenBudget
  let globalMemoryAttachment: string | null = null
  let globalMemoryIndexIncluded: string[] = []
  let globalMemoryIndexSkipped: Record<string, number> = {}
  let globalMemoryIndexRecall: MemoryRecallDiagnostics | undefined
  let globalWorkingPackAttachment: string | null = null
  let globalWorkingPackIncluded: string[] = []
  let globalWorkingPackExcerpted: string[] = []
  let globalWorkingPackSkipped: Record<string, number> = {}
  let globalWorkingPackRecall: MemoryRecallDiagnostics | undefined
  let globalWorkingPackTokenBudget = scaleMemoryAttachmentBudgets(budgets, GLOBAL_MEMORY_BUDGET_SCALE).workingPackTokenBudget
  let store: MdMemoryStore
  try {
    if (options.memoryStore) {
      store = createPerTurnMemoryStoreSnapshot(options.memoryStore)
    } else {
      await autoMemory.ensure()
      store = createPerTurnMemoryStoreSnapshot(openMdStore(autoMemory.memoryDir))
    }
  } catch (err) {
    if (isProgrammerError(err)) throw err
    logMemoryAttachmentFailure(options, autoMemory.memoryDir, "index", err, hasQuery)
    return {
      memoryAttachment,
      memoryIndexIncluded,
      memoryIndexSkipped,
      workingPackAttachment,
      workingPackIncluded,
      workingPackSkipped,
    }
  }
  const globalIndexDuplicateKeys = new Set<string>()
  const globalWorkingPackDuplicateKeys = new Set<string>()
  const globalStore = options.globalMemoryStore
    ? filterMemoryStoreByTypes(
        createPerTurnMemoryStoreSnapshot(options.globalMemoryStore),
        GLOBAL_MEMORY_TYPES,
      )
    : undefined
  const [projectSemanticScores, globalSemanticScores] = await Promise.all([
    resolveMemorySemanticScores(options, "project", store, query, queryHash, recallNow),
    globalStore
      ? resolveMemorySemanticScores(options, "global", globalStore, query, queryHash, recallNow)
      : Promise.resolve(undefined),
  ])
  if (options.globalMemoryStore && globalStore) {
    const globalMemoryDir = options.globalMemoryDir ?? options.globalMemoryStore.dir
    const globalBudgets = scaleMemoryAttachmentBudgets(budgets, GLOBAL_MEMORY_BUDGET_SCALE)
    try {
      let index = buildMdIndex(globalStore, {
        tokenBudget: globalBudgets.indexTokenBudget,
        query,
        semanticScores: globalSemanticScores,
        minScore: hasQuery ? 1 : undefined,
        minScoreRatioFromBest: hasQuery ? 0.25 : undefined,
        maxRecords: 12,
        recencyHalfLifeDays: 30,
        now: recallNow,
        dedupe: true,
      })
      if (continuationQuery && index.included.length === 0 && index.skipped.some((s) => s.reason === "min_score")) {
        index = buildMdIndex(globalStore, {
          tokenBudget: globalBudgets.indexTokenBudget,
          query,
          semanticScores: globalSemanticScores,
          maxRecords: 3,
          recencyHalfLifeDays: 30,
          now: recallNow,
          dedupe: true,
        })
      }
      globalMemoryAttachment = index.included.length > 0
        ? renderMemoryIndexAttachment(globalMemoryDir, index.text, "Global personal memory")
        : null
      globalMemoryIndexIncluded = index.included
      addSelectedMemoryDedupeKeys(globalStore, index.diagnostics, globalIndexDuplicateKeys, hasQuery)
      globalMemoryIndexSkipped = summarizeSkipped(index.skipped.map((s) => s.reason))
      globalMemoryIndexRecall = buildMemoryRecallDiagnostics(index.diagnostics)
    } catch (err) {
      if (isProgrammerError(err)) throw err
      logMemoryAttachmentFailure(options, globalMemoryDir, "index", err, hasQuery)
    }
    try {
      let pack = buildMdPack(globalStore, {
        tokenBudget: globalBudgets.workingPackTokenBudget,
        query,
        semanticScores: globalSemanticScores,
        minScore: hasQuery ? 1 : undefined,
        minScoreRatioFromBest: hasQuery ? 0.25 : undefined,
        maxRecords: 4,
        recencyHalfLifeDays: 30,
        now: recallNow,
        dedupe: true,
        excerptOversizedRecords: true,
      })
      if (continuationQuery && pack.included.length === 0 && pack.skipped.some((s) => s.reason === "min_score")) {
        globalWorkingPackTokenBudget = globalBudgets.fallbackWorkingPackTokenBudget
        pack = buildMdPack(globalStore, {
          tokenBudget: globalBudgets.fallbackWorkingPackTokenBudget,
          query,
          semanticScores: globalSemanticScores,
          maxRecords: 2,
          recencyHalfLifeDays: 30,
          now: recallNow,
          dedupe: true,
          excerptOversizedRecords: true,
        })
      }
      globalWorkingPackAttachment = pack.included.length > 0 ? pack.text : null
      globalWorkingPackIncluded = pack.included
      addSelectedMemoryDedupeKeys(globalStore, pack.diagnostics, globalWorkingPackDuplicateKeys, hasQuery)
      globalWorkingPackExcerpted = pack.diagnostics
        .filter((record) => record.included && record.excerpted)
        .map((record) => record.filename)
      globalWorkingPackSkipped = summarizeSkipped(pack.skipped.map((s) => s.reason))
      globalWorkingPackRecall = buildMemoryRecallDiagnostics(pack.diagnostics)
    } catch (err) {
      if (isProgrammerError(err)) throw err
      logMemoryAttachmentFailure(options, globalMemoryDir, "working_pack", err, hasQuery)
    }
  }
  try {
    const indexStore = filterProjectStoreExcludingGlobalPersonalDuplicates(store, globalIndexDuplicateKeys)
    let index = buildMdIndex(indexStore, {
      tokenBudget: budgets.indexTokenBudget,
      query,
      semanticScores: projectSemanticScores,
      minScore: hasQuery ? 1 : undefined,
      minScoreRatioFromBest: hasQuery ? 0.25 : undefined,
      maxRecords: 24,
      recencyHalfLifeDays: 30,
      now: recallNow,
      dedupe: true,
      pinnedFilter: projectPinnedFilter,
      minQueryTermMatchesForRecord: projectMinQueryTermMatches,
    })
    if (continuationQuery && index.included.length === 0 && index.skipped.some((s) => s.reason === "min_score")) {
      index = buildMdIndex(indexStore, {
        tokenBudget: budgets.indexTokenBudget,
        query,
        semanticScores: projectSemanticScores,
        maxRecords: 3,
        recencyHalfLifeDays: 30,
        now: recallNow,
        dedupe: true,
        pinnedFilter: projectPinnedFilter,
        minQueryTermMatchesForRecord: projectMinQueryTermMatches,
      })
    }
    memoryAttachment = index.included.length > 0
      ? renderMemoryIndexAttachment(autoMemory.memoryDir, index.text)
      : null
    memoryIndexIncluded = index.included
    memoryIndexSkipped = summarizeSkipped(index.skipped.map((s) => s.reason))
    memoryIndexRecall = buildMemoryRecallDiagnostics(index.diagnostics)
  } catch (err) {
    if (isProgrammerError(err)) throw err
    logMemoryAttachmentFailure(options, autoMemory.memoryDir, "index", err, hasQuery)
  }

  try {
    const packStore = filterProjectStoreExcludingGlobalPersonalDuplicates(store, globalWorkingPackDuplicateKeys)
    let pack = buildMdPack(packStore, {
      tokenBudget: budgets.workingPackTokenBudget,
      query,
      semanticScores: projectSemanticScores,
      minScore: hasQuery ? 1 : undefined,
      minScoreRatioFromBest: hasQuery ? 0.25 : undefined,
      maxRecords: 8,
      recencyHalfLifeDays: 30,
      now: recallNow,
      dedupe: true,
      excerptOversizedRecords: true,
      pinnedFilter: projectPinnedFilter,
      minQueryTermMatchesForRecord: projectMinQueryTermMatches,
    })
    if (continuationQuery && pack.included.length === 0 && pack.skipped.some((s) => s.reason === "min_score")) {
      workingPackTokenBudget = budgets.fallbackWorkingPackTokenBudget
      pack = buildMdPack(packStore, {
        tokenBudget: budgets.fallbackWorkingPackTokenBudget,
        query,
        semanticScores: projectSemanticScores,
        maxRecords: 3,
        recencyHalfLifeDays: 30,
        now: recallNow,
        dedupe: true,
        excerptOversizedRecords: true,
        pinnedFilter: projectPinnedFilter,
        minQueryTermMatchesForRecord: projectMinQueryTermMatches,
      })
    }
    workingPackAttachment = pack.included.length > 0
      ? omitDuplicateCompactTimelineSnapshot(pack.text, pack.included)
      : null
    workingPackIncluded = pack.included
    workingPackExcerpted = pack.diagnostics
      .filter((record) => record.included && record.excerpted)
      .map((record) => record.filename)
    workingPackSkipped = summarizeSkipped(pack.skipped.map((s) => s.reason))
    workingPackRecall = buildMemoryRecallDiagnostics(pack.diagnostics)
  } catch (err) {
    if (isProgrammerError(err)) throw err
    logMemoryAttachmentFailure(options, autoMemory.memoryDir, "working_pack", err, hasQuery)
  }
  const hasAnyMemoryAttachment =
    !!memoryAttachment ||
    !!workingPackAttachment ||
    !!globalMemoryAttachment ||
    !!globalWorkingPackAttachment
  let memoryUtilityCandidates: MemoryUtilityCandidate[] = []
  try {
    memoryUtilityCandidates = [
      ...(globalStore
        ? buildMemoryUtilityCandidates({
            scope: "global",
            memoryDir: options.globalMemoryDir ?? options.globalMemoryStore?.dir ?? globalStore.dir,
            records: globalStore.list(),
            included: globalWorkingPackIncluded,
            excerpted: globalWorkingPackExcerpted,
          })
        : []),
      ...buildMemoryUtilityCandidates({
        scope: "project",
        memoryDir: autoMemory.memoryDir,
        records: store.list(),
        included: workingPackIncluded,
        excerpted: workingPackExcerpted,
      }),
    ]
  } catch {
    // Attribution is observational and must never turn memory recall into a
    // hard dependency after the attachment path has already failed open.
  }
  return {
    memoryAttachment,
    memoryIndexIncluded,
    memoryIndexSkipped,
    ...(memoryIndexRecall && hasAnyMemoryAttachment ? { memoryIndexRecall } : {}),
    ...(memoryAttachment ? { memoryIndexTokenBudget: budgets.indexTokenBudget } : {}),
    ...(queryHash && hasAnyMemoryAttachment ? { memoryQueryHash: queryHash } : {}),
    ...(queryMeta && hasAnyMemoryAttachment ? { memoryQueryKind: queryMeta.kind } : {}),
    ...(queryMeta?.fallback && hasAnyMemoryAttachment ? { memoryQueryFallback: true } : {}),
    workingPackAttachment,
    workingPackIncluded,
    ...(workingPackExcerpted.length > 0 ? { workingPackExcerpted } : {}),
    workingPackSkipped,
    ...(workingPackRecall && hasAnyMemoryAttachment ? { workingPackRecall } : {}),
    ...(workingPackAttachment ? { workingPackTokenBudget } : {}),
    ...(options.globalMemoryStore ? {
      globalMemoryAttachment,
      globalMemoryIndexIncluded,
      globalMemoryIndexSkipped,
      ...(globalMemoryIndexRecall ? { globalMemoryIndexRecall } : {}),
      ...(globalMemoryAttachment ? { globalMemoryIndexTokenBudget: scaleMemoryAttachmentBudgets(budgets, GLOBAL_MEMORY_BUDGET_SCALE).indexTokenBudget } : {}),
      globalWorkingPackAttachment,
      globalWorkingPackIncluded,
      ...(globalWorkingPackExcerpted.length > 0 ? { globalWorkingPackExcerpted } : {}),
      globalWorkingPackSkipped,
      ...(globalWorkingPackRecall ? { globalWorkingPackRecall } : {}),
      ...(globalWorkingPackAttachment ? { globalWorkingPackTokenBudget } : {}),
    } : {}),
    ...(memoryUtilityCandidates.length > 0
      ? {
          memoryUtilityCandidates,
          memoryUtilityBaseline: fingerprintMemoryUtilityText(query ?? ""),
        }
      : {}),
  }
}

function buildMemoryRecallDiagnostics(
  diagnostics: readonly MdPackRecordDiagnostic[],
): MemoryRecallDiagnostics | undefined {
  const selected = diagnostics
    .filter((record) => record.included)
    .slice(0, MEMORY_RECALL_DIAGNOSTIC_LIMIT)
    .map(memoryRecallRecordDiagnostic)
  const topSkipped = diagnostics
    .filter((record) => !record.included)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore
      return a.filename.localeCompare(b.filename)
    })
    .slice(0, MEMORY_RECALL_DIAGNOSTIC_LIMIT)
    .map(memoryRecallRecordDiagnostic)
  return selected.length > 0 || topSkipped.length > 0
    ? { selected, topSkipped }
    : undefined
}

function memoryRecallRecordDiagnostic(record: MdPackRecordDiagnostic): MemoryRecallRecordDiagnostic {
  return {
    filename: record.filename,
    score: finiteDiagnosticNumber(record.score),
    relevanceScore: finiteDiagnosticNumber(record.relevanceScore),
    ...(typeof record.semanticScore === "number" && record.semanticScore > 0
      ? {
          lexicalScore: finiteDiagnosticNumber(record.lexicalScore ?? 0),
          semanticScore: finiteDiagnosticNumber(record.semanticScore),
        }
      : {}),
    recencyBoost: finiteDiagnosticNumber(record.recencyBoost),
    ...(record.confidence !== "high" ? { confidence: record.confidence } : {}),
    ...(record.lifecycleState !== "active" ? { lifecycleState: record.lifecycleState } : {}),
    ...(record.pinned ? { pinned: true } : {}),
    ...(record.excerpted ? { excerpted: true } : {}),
    ...(record.skippedReason ? { skippedReason: record.skippedReason } : {}),
  }
}

function finiteDiagnosticNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value * 1000) / 1000) : 0
}

function classifyMemoryQuery(
  query: string | undefined,
): { kind: "direct" | "low_signal"; fallback?: true } | undefined {
  if (!query) return undefined
  if (query === LOW_SIGNAL_CONTINUATION_QUERY) return { kind: "low_signal" }
  if (query.startsWith(`${LOW_SIGNAL_CONTINUATION_QUERY}\n`)) {
    return { kind: "low_signal", fallback: true }
  }
  return { kind: "direct" }
}

export function normalizeMemoryQuery(query: string | undefined): string | undefined {
  const stripped = normalizeMemoryQueryLayout(stripLowSignalMemoryQueryBlocks(query))
  if (!stripped) return undefined
  if (isLowSignalContinuationQuery(stripped)) return LOW_SIGNAL_CONTINUATION_QUERY
  if (countCodePoints(stripped) <= MEMORY_QUERY_MAX_CHARS) return stripped
  return [
    sliceHeadCodePoints(stripped, MEMORY_QUERY_HEAD_CHARS),
    "[memory query truncated]",
    sliceTailCodePoints(stripped, MEMORY_QUERY_TAIL_CHARS),
  ].join("\n")
}

function stripLowSignalMemoryQueryBlocks(query: string | undefined): string {
  if (!query) return ""
  return omitLongMemoryQueryMultilineBody(
    omitLongMemoryQueryLines(
      omitLongMemoryQueryTokens(
        omitArtifactMemoryQueryTokens(query
          .replace(GENERATED_CONTEXT_BLOCK_RE, " ")
          .replace(RUNTIME_CONTEXT_BLOCK_RE, " ")
          .replace(CONTEXT_COMPACTED_SUMMARY_BLOCK_RE, "$1")
          .replace(POST_COMPACT_RESTORED_FILES_BLOCK_RE, " ")
          .replace(FENCED_CODE_BLOCK_RE, "\n[code block omitted from memory query]\n")
          .replace(PASTED_PLACEHOLDER_RE, PASTED_TEXT_PLACEHOLDER)
          .replace(UNAVAILABLE_PASTED_HISTORY_RE, PASTED_TEXT_PLACEHOLDER)),
      ),
    ),
  )
}

function normalizeMemoryQueryLayout(query: string): string {
  return splitLogicalLines(query)
    .map((line) => line.replace(/[ \t\f\v]+/gu, " ").trim())
    .filter(Boolean)
    .join("\n")
}

function omitArtifactMemoryQueryTokens(query: string): string {
  return query
    .replace(DATA_URI_MEMORY_QUERY_RE, DATA_URI_PLACEHOLDER)
    .replace(BASE64_BLOB_MEMORY_QUERY_RE, (match, prefix: string, token: string) =>
      isLikelyBase64Blob(token) ? `${prefix}${BASE64_BLOB_PLACEHOLDER}` : match)
}

function isLikelyBase64Blob(token: string): boolean {
  if (token.length < 120 || token.length % 4 !== 0) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(token)) return false
  return /[+/=]/u.test(token)
}

function omitLongMemoryQueryTokens(query: string): string {
  return query.replace(LONG_MEMORY_QUERY_TOKEN_RE, foldLongMemoryQueryToken)
}

function foldLongMemoryQueryToken(token: string): string {
  const anchor = longMemoryQueryTokenAnchor(token)
  return anchor ? `${anchor} ${LONG_TOKEN_PLACEHOLDER}` : LONG_TOKEN_PLACEHOLDER
}

function longMemoryQueryTokenAnchor(token: string): string | null {
  const chars = Array.from(token)
  const limit = Math.min(chars.length, MEMORY_QUERY_LONG_TOKEN_ANCHOR_CHARS)
  for (let i = 0; i < limit; i++) {
    const ch = chars[i]
    if (ch !== ":" && ch !== "：") continue
    const anchor = chars.slice(0, i + 1).join("").trim()
    if (!CJK_ANCHOR_RE.test(anchor)) return null
    return countCodePoints(anchor) > 1 ? anchor : null
  }
  return null
}

function omitLongMemoryQueryLines(query: string): string {
  const lines = splitLogicalLines(query)
  if (lines.length <= 1) return query
  return lines
    .map((line) => countCodePoints(line) > MEMORY_QUERY_LONG_LINE_CHARS
      ? "[long line omitted from memory query]"
      : line)
    .join("\n")
}

function omitLongMemoryQueryMultilineBody(query: string): string {
  const lines = splitLogicalLines(query)
  if (lines.length <= MEMORY_QUERY_MULTILINE_BODY_LINES) return query
  const anchors = lines
    .slice(1, -1)
    .filter(isStructuredMemoryQueryAnchor)
    .slice(0, MEMORY_QUERY_MULTILINE_ANCHOR_LIMIT)
  return [
    lines[0],
    ...anchors,
    MULTILINE_TEXT_PLACEHOLDER,
    lines[lines.length - 1],
  ].join("\n")
}

function isStructuredMemoryQueryAnchor(line: string): boolean {
  const trimmed = line.trim()
  const charCount = countCodePoints(trimmed)
  if (charCount === 0 || charCount > 180) return false
  return /^#{1,6}\s+\S/u.test(trimmed) ||
    /^[-*]\s+\S/u.test(trimmed) ||
    /^\d+[.)]\s+\S/u.test(trimmed) ||
    /^[\p{L}\p{N}_ -]{1,80}[:：]\s+\S/u.test(trimmed)
}

export function buildMemoryQueryHistoryFromLogs(
  logs: readonly MemoryQueryHistoryLog[],
  limit = MEMORY_QUERY_HISTORY_LIMIT,
): string[] {
  const max = Math.max(0, Math.floor(limit))
  if (max === 0) return []
  const history: string[] = []
  for (let i = logs.length - 1; i >= 0 && history.length < max; i--) {
    const log = logs[i]
    if (log.type !== "user") continue
    if (log.restore === false) continue
    const historyText = memoryQueryHistoryText(log.text)
    if (!historyText) continue
    history.unshift(historyText)
  }
  return history
}

export function buildMemoryQueryHistoryFromMessages(
  messages: readonly MemoryQueryHistoryMessage[],
  limit = MEMORY_QUERY_HISTORY_LIMIT,
): string[] {
  const max = Math.max(0, Math.floor(limit))
  if (max === 0) return []
  const history: string[] = []
  for (let i = messages.length - 1; i >= 0 && history.length < max; i--) {
    const message = messages[i]
    if (message.role !== "user") continue
    const historyText = memoryQueryHistoryText(message.content)
    if (!historyText) continue
    history.unshift(historyText)
  }
  return history
}

export function memoryQueryHistoryText(text: string | undefined): string | null {
  const normalized = normalizeMemoryQuery(text)
  if (!normalized || isLowSignalContinuationFallbackQuery(normalized)) return null
  return normalized
}

export function shouldRecordMemoryQueryHistoryText(text: string | undefined): boolean {
  return memoryQueryHistoryText(text) !== null
}

/** Build the memory-recall query for a run.
 *
 * A bare "继续" / "continue" carries almost no lexical signal. Using only a
 * fixed continuation sentinel keeps cache/context shape stable, but it also
 * means task-specific memories are missed unless they are pinned. Fold in the
 * most recent meaningful user request from the persisted conversation so
 * repeated continuation turns keep recalling the same relevant memory set.
 */
export function buildMemoryQueryForRun(
  task: string,
  recentUserMessages: readonly string[] = [],
): string | undefined {
  const normalizedTask = normalizeMemoryQuery(task)
  if (normalizedTask !== LOW_SIGNAL_CONTINUATION_QUERY) return normalizedTask
  for (let i = recentUserMessages.length - 1; i >= 0; i--) {
    const previous = normalizeMemoryQuery(recentUserMessages[i])
    if (!previous || isLowSignalContinuationFallbackQuery(previous)) continue
    return `${LOW_SIGNAL_CONTINUATION_QUERY}\n${previous}`
  }
  return normalizedTask
}

function isLowSignalContinuationQuery(query: string): boolean {
  const normalized = query
    .toLowerCase()
    .replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~。，“”‘’！？，、；：（）【】《》「」『』]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
  return LOW_SIGNAL_CONTINUATION_PHRASES.has(normalized)
}

function isContinuationMemoryQuery(query: string | undefined): boolean {
  return query === LOW_SIGNAL_CONTINUATION_QUERY ||
    query?.startsWith(`${LOW_SIGNAL_CONTINUATION_QUERY}\n`) === true
}

function isGeneratedCompactMemory(filename: string): boolean {
  return filename === COMPACT_STATE_FILENAME || filename === COMPACT_TIMELINE_FILENAME
}

function isLowSignalContinuationFallbackQuery(query: string): boolean {
  if (query === LOW_SIGNAL_CONTINUATION_QUERY) return true
  const meaningful = query
    .replaceAll(PASTED_TEXT_PLACEHOLDER, " ")
    .replaceAll(DATA_URI_PLACEHOLDER, " ")
    .replaceAll(BASE64_BLOB_PLACEHOLDER, " ")
    .replace(/\[code block omitted from memory query\]/g, " ")
    .replace(/\[long token omitted from memory query\]/g, " ")
    .replace(/\[long line omitted from memory query\]/g, " ")
    .replace(/\[multiline text omitted from memory query\]/g, " ")
    .replace(/\[memory query truncated\]/g, " ")
    .replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~。，“”‘’！？，、；：（）【】《》「」『』]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
  return !meaningful || isLowSignalContinuationQuery(meaningful)
}

export interface ContextPrefixDeps {
  attachments: PerTurnAttachments
  /** Live todos ref — read fresh on every call so mid-run todo_write updates
   *  reflect in the next LLM call's <active_plan>. */
  getTodos: () => Todo[]
  modelId: string
}

interface ContextSegment {
  name: string
  text: string
  meta?: Record<string, unknown>
}

const tokenCounter = new TokenCounter()

function collectContextSegments(
  deps: ContextPrefixDeps,
  options: { includeTodos?: boolean } = {},
): ContextSegment[] {
  const segments: ContextSegment[] = []
  if (deps.attachments.repoMapAttachment) {
    segments.push({
      name: "repo_map",
      text: deps.attachments.repoMapAttachment,
      meta: {
        included: deps.attachments.repoMapIncluded ?? [],
        revision: deps.attachments.repoMapRevision,
        budgetTokens: deps.attachments.repoMapTokenBudget,
        truncated: deps.attachments.repoMapTruncated ?? false,
      },
    })
  }
  if (deps.attachments.globalMemoryAttachment) {
    segments.push({
      name: "global_memory_index",
      text: deps.attachments.globalMemoryAttachment,
      meta: {
        included: deps.attachments.globalMemoryIndexIncluded ?? [],
        skipped: deps.attachments.globalMemoryIndexSkipped ?? {},
        ...memoryRecallDiagnosticsMeta(deps.attachments.globalMemoryIndexRecall),
        ...(deps.attachments.memoryQueryHash ? { queryHash: deps.attachments.memoryQueryHash } : {}),
        ...(deps.attachments.memoryQueryKind ? { queryKind: deps.attachments.memoryQueryKind } : {}),
        ...(deps.attachments.memoryQueryFallback ? { queryFallback: true } : {}),
        ...(typeof deps.attachments.globalMemoryIndexTokenBudget === "number"
          ? { budgetTokens: deps.attachments.globalMemoryIndexTokenBudget }
          : {}),
      },
    })
  }
  if (deps.attachments.globalWorkingPackAttachment) {
    segments.push({
      name: "global_memory_working_pack",
      text: deps.attachments.globalWorkingPackAttachment,
      meta: {
        included: deps.attachments.globalWorkingPackIncluded ?? [],
        ...(deps.attachments.globalWorkingPackExcerpted?.length
          ? { excerpted: deps.attachments.globalWorkingPackExcerpted }
          : {}),
        skipped: deps.attachments.globalWorkingPackSkipped ?? {},
        ...memoryRecallDiagnosticsMeta(deps.attachments.globalWorkingPackRecall),
        ...(deps.attachments.memoryQueryHash ? { queryHash: deps.attachments.memoryQueryHash } : {}),
        ...(deps.attachments.memoryQueryKind ? { queryKind: deps.attachments.memoryQueryKind } : {}),
        ...(deps.attachments.memoryQueryFallback ? { queryFallback: true } : {}),
        ...(typeof deps.attachments.globalWorkingPackTokenBudget === "number"
          ? { budgetTokens: deps.attachments.globalWorkingPackTokenBudget }
          : {}),
      },
    })
  }
  if (deps.attachments.memoryAttachment) {
    segments.push({
      name: "memory_index",
      text: deps.attachments.memoryAttachment,
      meta: {
        included: deps.attachments.memoryIndexIncluded,
        skipped: deps.attachments.memoryIndexSkipped,
        ...memoryRecallDiagnosticsMeta(deps.attachments.memoryIndexRecall),
        ...(deps.attachments.memoryQueryHash ? { queryHash: deps.attachments.memoryQueryHash } : {}),
        ...(deps.attachments.memoryQueryKind ? { queryKind: deps.attachments.memoryQueryKind } : {}),
        ...(deps.attachments.memoryQueryFallback ? { queryFallback: true } : {}),
        ...(typeof deps.attachments.memoryIndexTokenBudget === "number"
          ? { budgetTokens: deps.attachments.memoryIndexTokenBudget }
          : {}),
      },
    })
  }
  if (deps.attachments.workingPackAttachment) {
    segments.push({
      name: "memory_working_pack",
      text: deps.attachments.workingPackAttachment,
      meta: {
        included: deps.attachments.workingPackIncluded,
        ...(deps.attachments.workingPackExcerpted?.length
          ? { excerpted: deps.attachments.workingPackExcerpted }
          : {}),
        skipped: deps.attachments.workingPackSkipped,
        ...memoryRecallDiagnosticsMeta(deps.attachments.workingPackRecall),
        ...(deps.attachments.memoryQueryHash ? { queryHash: deps.attachments.memoryQueryHash } : {}),
        ...(deps.attachments.memoryQueryKind ? { queryKind: deps.attachments.memoryQueryKind } : {}),
        ...(deps.attachments.memoryQueryFallback ? { queryFallback: true } : {}),
        ...(typeof deps.attachments.workingPackTokenBudget === "number"
          ? { budgetTokens: deps.attachments.workingPackTokenBudget }
          : {}),
      },
    })
  }
  if (options.includeTodos !== false) segments.push(...collectTodoSegments(deps))
  return segments
}

function collectTodoSegments(deps: ContextPrefixDeps): ContextSegment[] {
  const todos = deps.getTodos()
  const todoBlock = renderTodoAttachment(todos, { model: deps.modelId })
  if (!todoBlock) return []
  return [{
    name: "active_plan",
    text: todoBlock,
    meta: {
      todoCount: todos.length,
      inProgressCount: todos.filter((t) => t.status === "in_progress").length,
    },
  }]
}

function memoryRecallDiagnosticsMeta(
  diagnostics: MemoryRecallDiagnostics | undefined,
): Record<string, unknown> {
  if (!diagnostics) return {}
  return {
    ...(diagnostics.selected.length > 0 ? { selected: diagnostics.selected } : {}),
    ...(diagnostics.topSkipped.length > 0 ? { topSkipped: diagnostics.topSkipped } : {}),
  }
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12)
}

function summarizeSkipped(reasons: string[]): Record<string, number> {
  const counts = new Map<string, number>()
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function isProgrammerError(err: unknown): boolean {
  return err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError
}

async function resolveMemorySemanticScores(
  options: PerTurnAttachmentOptions,
  scope: MemorySemanticScope,
  store: MdMemoryStore,
  query: string | undefined,
  queryHash: string | undefined,
  now: Date,
): Promise<Map<string, number> | undefined> {
  const semanticQuery = semanticQueryText(query)
  if (!options.semanticRetriever || !semanticQuery) return undefined
  let recordCount = 0
  try {
    const snapshot = store.snapshot?.()
    const inventory = snapshot?.records ?? store.list()
    const records = activeMdMemoryRecords(inventory, now)
    if (records.length === 0) return undefined
    recordCount = records.length
    const documents: MemorySemanticDocument[] = records.map((record) => ({
      filename: record.filename,
      name: record.frontmatter.name,
      description: record.frontmatter.description,
      type: record.frontmatter.type,
      tags: [...(record.frontmatter.tags ?? [])],
      ...(record.frontmatter.source ? { source: record.frontmatter.source } : {}),
      body: record.body,
    }))
    const scores = await scoreMemorySemanticsWithTimeout(
      options.semanticRetriever,
      {
        scope,
        query: semanticQuery,
        documents,
        ...(snapshot ? { corpusRevision: activeCorpusRevision(records) } : {}),
      },
      finitePositiveInteger(options.semanticTimeoutMs, DEFAULT_MEMORY_SEMANTIC_TIMEOUT_MS),
    )
    return normalizeMemorySemanticScores(
      scores,
      new Set(documents.map((document) => document.filename)),
    )
  } catch (err) {
    try {
      options.diagnosticsLogger?.warn("memory_semantic_retrieval_failed", {
        scope,
        ...(queryHash ? { queryHash } : {}),
        recordCount,
        errorType: semanticErrorType(err),
      })
    } catch {
      // Diagnostics must not make optional semantic retrieval a hard dependency.
    }
    return undefined
  }
}

function validRecallDate(value: Date | undefined): Date {
  return value && Number.isFinite(value.getTime()) ? new Date(value.getTime()) : new Date()
}

function activeCorpusRevision(records: readonly MdMemoryRecord[]): string {
  const hash = createHash("sha256")
  for (const record of [...records].sort((a, b) => a.filename.localeCompare(b.filename))) {
    hash
      .update(record.filename).update("\0")
      .update(record.frontmatter.name).update("\0")
      .update(record.frontmatter.description).update("\0")
      .update(record.frontmatter.type).update("\0")
      .update((record.frontmatter.tags ?? []).join("\0")).update("\0")
      .update(record.frontmatter.source ?? "").update("\0")
      .update(record.body).update("\n")
  }
  return hash.digest("hex")
}

async function scoreMemorySemanticsWithTimeout(
  retriever: MemorySemanticRetriever,
  request: Omit<Parameters<MemorySemanticRetriever["score"]>[0], "signal">,
  timeoutMs: number,
): Promise<ReadonlyMap<string, number>> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      const error = new Error(`semantic retrieval exceeded ${timeoutMs}ms`)
      error.name = "MemorySemanticTimeoutError"
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      retriever.score({ ...request, signal: controller.signal }),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function semanticQueryText(query: string | undefined): string | undefined {
  if (!query || query === LOW_SIGNAL_CONTINUATION_QUERY) return undefined
  if (query.startsWith(`${LOW_SIGNAL_CONTINUATION_QUERY}\n`)) {
    const fallback = query.slice(LOW_SIGNAL_CONTINUATION_QUERY.length + 1).trim()
    return fallback || undefined
  }
  return query
}

function semanticErrorType(err: unknown): string {
  if (err instanceof Error && err.name.trim()) return err.name.slice(0, 80)
  return typeof err
}

function finitePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback
}

function filterMemoryStoreByTypes(
  store: MdMemoryStore,
  allowedTypes: ReadonlySet<MdMemoryType>,
): MdMemoryStore {
  const isAllowed = (record: MdMemoryRecord | undefined): record is MdMemoryRecord =>
    !!record && allowedTypes.has(record.frontmatter.type)
  return {
    dir: store.dir,
    ...(store.snapshot ? {
      snapshot() {
        const snapshot = store.snapshot!()
        return { ...snapshot, records: snapshot.records.filter(isAllowed) }
      },
    } : {}),
    list(filter) {
      if (filter && !allowedTypes.has(filter)) return []
      return store.list(filter).filter(isAllowed)
    },
    get(filename) {
      const record = store.get(filename)
      return isAllowed(record) ? record : undefined
    },
    save(rec) {
      return store.save(rec)
    },
    delete(filename) {
      return store.delete(filename)
    },
  }
}

/** Lazily capture one stable record view for all recall stages in a run.
 *  The semantic scorer, compact index, working pack, and dedupe lookups would
 *  otherwise each rescan the Markdown directory independently. Besides the
 *  repeated I/O, a concurrent writer could make those stages observe
 *  different inventories within the same provider request. */
function createPerTurnMemoryStoreSnapshot(source: MdMemoryStore): MdMemoryStore {
  let snapshot: {
    records: MdMemoryRecord[]
    byFilename: Map<string, MdMemoryRecord>
    revision?: string
  } | undefined
  const readSnapshot = () => {
    if (snapshot) return snapshot
    const sourceSnapshot = source.snapshot?.()
    const records = sourceSnapshot?.records ?? source.list()
    snapshot = {
      records,
      byFilename: new Map(records.map((record) => [record.filename, record])),
      ...(sourceSnapshot ? { revision: sourceSnapshot.revision } : {}),
    }
    return snapshot
  }
  const invalidate = () => { snapshot = undefined }

  return {
    dir: source.dir,
    ...(source.snapshot ? {
      snapshot() {
        const current = readSnapshot()
        return { records: [...current.records], revision: current.revision! }
      },
    } : {}),
    list(filter) {
      const records = readSnapshot().records
      return filter
        ? records.filter((record) => record.frontmatter.type === filter)
        : [...records]
    },
    get(filename) {
      return readSnapshot().byFilename.get(filename)
    },
    save(record) {
      try {
        return source.save(record)
      } finally {
        invalidate()
      }
    },
    delete(filename) {
      try {
        return source.delete(filename)
      } finally {
        invalidate()
      }
    },
    ...(source.restore ? {
      restore(record: MdMemoryRecord) {
        try {
          return source.restore!(record)
        } finally {
          invalidate()
        }
      },
    } : {}),
  }
}

function filterProjectStoreExcludingGlobalPersonalDuplicates(
  store: MdMemoryStore,
  globalSelectedDedupeKeys: ReadonlySet<string>,
): MdMemoryStore {
  if (globalSelectedDedupeKeys.size === 0) return store
  const keepRecord = (record: MdMemoryRecord | undefined): record is MdMemoryRecord => {
    if (!record) return false
    if (!GLOBAL_MEMORY_TYPES.has(record.frontmatter.type)) return true
    return !globalSelectedDedupeKeys.has(memoryDedupeKey(record))
  }
  return {
    dir: store.dir,
    ...(store.snapshot ? {
      snapshot() {
        const snapshot = store.snapshot!()
        return { ...snapshot, records: snapshot.records.filter(keepRecord) }
      },
    } : {}),
    list(filter) {
      return store.list(filter).filter(keepRecord)
    },
    get(filename) {
      const record = store.get(filename)
      return keepRecord(record) ? record : undefined
    },
    save(rec) {
      return store.save(rec)
    },
    delete(filename) {
      return store.delete(filename)
    },
  }
}

function addSelectedMemoryDedupeKeys(
  store: MdMemoryStore,
  diagnostics: readonly MdPackRecordDiagnostic[],
  out: Set<string>,
  hasQuery: boolean,
): void {
  for (const diagnostic of diagnostics) {
    if (!diagnostic.included) continue
    if (hasQuery && !diagnostic.pinned && diagnostic.relevanceScore <= 0) continue
    const record = store.get(diagnostic.filename)
    if (!record) continue
    out.add(memoryDedupeKey(record))
  }
}

function memoryDedupeKey(record: MdMemoryRecord): string {
  const body = normalizeMemoryDedupeText(record.body)
  if (body) return `body:${body}`
  const fm = record.frontmatter
  return [
    "meta",
    normalizeMemoryDedupeText(fm.type),
    normalizeMemoryDedupeText(fm.name),
    normalizeMemoryDedupeText(fm.description),
    normalizeMemoryDedupeText((fm.tags ?? []).slice().sort().join(" ")),
    normalizeMemoryDedupeText(fm.source ?? ""),
  ].join("\0")
}

function normalizeMemoryDedupeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
}

function logMemoryAttachmentFailure(
  options: PerTurnAttachmentOptions,
  memoryDir: string,
  stage: "index" | "working_pack",
  err: unknown,
  queryPresent: boolean,
): void {
  const message = err instanceof Error ? err.message : String(err)
  if (options.diagnosticsLogger) {
    try {
      const fields: MemoryAttachmentFailureDiagnostic = {
        stage,
        memoryDir,
        queryPresent,
        error: message,
      }
      options.diagnosticsLogger.warn("memory_attachment_failed", { ...fields })
      return
    } catch {
      // Fall through to console as a last-resort diagnostic path.
    }
  }
  console.warn(`[memory] ${stage} attachment skipped:`, message)
}

function renderMemoryIndexAttachment(
  memoryDir: string,
  indexText: string,
  title = "Persistent memory",
): string {
  return [
    "<system-context>",
    `${title} (compact index from ${escapeContextText(`${memoryDir}/MEMORY.md`)}).`,
    `Read listed topic files under ${escapeContextText(memoryDir)} with read_file when relevant. Do not quote this index verbatim in replies.`,
    "",
    escapeContextText(indexText.trim()),
    "</system-context>",
  ].join("\n")
}

function omitDuplicateCompactTimelineSnapshot(text: string, included: string[]): string {
  if (
    !included.includes(COMPACT_STATE_FILENAME) ||
    !included.includes(COMPACT_TIMELINE_FILENAME)
  ) {
    return text
  }
  const timelineStart = text.indexOf(`name="project_compact_timeline"`)
  if (timelineStart < 0) return text
  const entryStart = text.indexOf(ESCAPED_TIMELINE_ENTRY_START, timelineStart)
  if (entryStart < 0) return text
  const entryEnd = text.indexOf(ESCAPED_TIMELINE_ENTRY_END, entryStart)
  if (entryEnd < 0) return text
  const afterEntry = entryEnd + ESCAPED_TIMELINE_ENTRY_END.length
  const before = text.slice(0, entryStart).replace(/\n+$/u, "\n")
  const after = text.slice(afterEntry).replace(/^\n+/u, "\n")
  return `${before}[Latest compact timeline snapshot omitted because ${COMPACT_STATE_FILENAME} is attached in this working pack.]${after}`
}

function escapeContextText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/** Builder for the stable LoopAgent.RunOptions.contextPrefix snapshot. The
 *  loop evaluates the returned callback once at run start. */
export function makeContextPrefixBuilder(deps: ContextPrefixDeps): () => string | undefined {
  return () => {
    const parts = collectContextSegments(deps).map((s) => s.text)
    return parts.length > 0 ? parts.join("\n\n") : undefined
  }
}

/** Diagnostics for transient context. Hashes let us spot churn without
 * logging memory contents verbatim. */
export function makeContextDiagnosticsBuilder(deps: ContextPrefixDeps): () => ContextDiagnostics | undefined {
  return () => {
    const segments = collectContextSegments(deps)
    if (segments.length === 0) return undefined
    const fullText = segments.map((s) => s.text).join("\n\n")
    return buildDiagnosticsFromSegments(segments, fullText)
  }
}

export function makeContextBuilders(deps: ContextPrefixDeps): {
  contextPrefix: () => string | undefined
  contextDelta: () => string | undefined
  contextDiagnostics: () => ContextDiagnostics | undefined
} {
  let baselineTodoText: string | undefined
  let stableSegments: ContextSegment[] | undefined
  let lastSnapshot: { text: string | undefined; diagnostics: ContextDiagnostics | undefined } | undefined
  const snapshot = (segments: ContextSegment[]) => {
    if (segments.length === 0) {
      return { text: undefined, diagnostics: undefined }
    }
    const text = segments.map((s) => s.text).join("\n\n")
    return {
      text,
      diagnostics: buildDiagnosticsFromSegments(segments, text),
    }
  }
  return {
    contextPrefix: () => {
      stableSegments = collectContextSegments(deps)
      baselineTodoText = stableSegments.find((segment) => segment.name === "active_plan")?.text
      lastSnapshot = snapshot(stableSegments)
      return lastSnapshot.text
    },
    contextDelta: () => {
      const todoSegments = collectTodoSegments(deps)
      const currentTodoText = todoSegments[0]?.text
      const clearedTodoSegment: ContextSegment = {
        name: "active_plan_delta",
        text: '<active_plan update="cleared">\nNo active todos remain.\n</active_plan>',
        meta: { todoCount: 0, inProgressCount: 0, cleared: true },
      }
      const deltaSegments = currentTodoText === baselineTodoText
        ? []
        : todoSegments.length > 0
          ? todoSegments
          : baselineTodoText
            ? [clearedTodoSegment]
            : []
      lastSnapshot = snapshot([...(stableSegments ?? []), ...deltaSegments])
      return deltaSegments.map((segment) => segment.text).join("\n\n") || undefined
    },
    contextDiagnostics: () => {
      if (!lastSnapshot) lastSnapshot = snapshot(collectContextSegments(deps))
      const diagnostics = lastSnapshot.diagnostics
      lastSnapshot = undefined
      return diagnostics
    },
  }
}

function buildDiagnosticsFromSegments(segments: ContextSegment[], fullText: string): ContextDiagnostics {
  return {
    totalChars: countCodePoints(fullText),
    estimatedTokens: tokenCounter.countText(fullText),
    hash: shortHash(fullText),
    segments: segments.map((s) => ({
      name: s.name,
      chars: countCodePoints(s.text),
      estimatedTokens: tokenCounter.countText(s.text),
      hash: shortHash(s.text),
      ...(s.meta ? { meta: s.meta } : {}),
    })),
  }
}

/** Review observed work against the original request before natural finish.
 *  LoopAgent bounds this to one reminder and permits an honest incomplete
 *  response. Todo completion does not suppress review of settled tool work. */
export function makeTurnEndGuard(getTodos: () => Todo[]): (result?: Pick<LoopAgentResult, "toolResults">) => string | null {
  return (result) => {
    const active = getTodos().find((t) => t.status === "in_progress")
    if (!active && !result?.toolResults.length) return null
    return (
      "<system-reminder>\n" +
      (active ? `Todo "${escapeContextText(active.content)}" remains in_progress.\n` : "") +
      "Review the original user request and latest authorized steering against the actual " +
      "observations from this run. Do not substitute your own plan or a weaker success criterion. " +
      "If evidence contradicts a requirement and a useful authorized check or repair remains " +
      "possible within the budget, take that step. Otherwise report verified results and " +
      "unresolved limitations honestly. Todo completion and command exit zero do not establish " +
      "functional correctness. You may finish with an honest incomplete or unverified result; " +
      "do not invent checks or repeat an external side effect just to obtain evidence.\n" +
      "</system-reminder>"
    )
  }
}
