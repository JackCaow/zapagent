import { MD_MEMORY_TYPES, mdMemoryAgeDays, resolveMdMemoryTimestamp, type MdMemoryType } from "./md-types"
import type { MdMemoryStore, MdMemoryRecord } from "./md-store"
import {
  memoryConfidenceWeight,
  resolveMdMemoryLifecycles,
  type MdMemoryLifecycleResolution,
  type MdMemoryLifecycleState,
} from "./md-lifecycle"
import { TokenCounter } from "../context/token-counter"
import { countCodePoints, normalizeLogicalNewlines, sliceHeadCodePoints, sliceTailCodePoints, splitLogicalLines } from "../utils/logical-lines"

export interface MdPack {
  text: string
  included: string[]   // filenames included
  skipped: MdPackSkipped[]
  diagnostics: MdPackRecordDiagnostic[]
}

export interface MdIndex {
  text: string
  included: string[]
  skipped: MdPackSkipped[]
  diagnostics: MdPackRecordDiagnostic[]
}

export type MdPackSkipReason =
  | "budget"
  | "duplicate"
  | "max_records"
  | "min_score"
  | "low_confidence"
  | "not_yet_valid"
  | "expired"
  | "superseded"
  | "invalid_lifecycle"

export interface MdPackSkipped {
  filename: string
  reason: MdPackSkipReason
  score: number
}

export interface MdPackRecordDiagnostic {
  filename: string
  score: number
  relevanceScore: number
  lexicalScore?: number
  semanticScore?: number
  recencyBoost: number
  confidence: "high" | "medium" | "low"
  confidenceWeight: number
  lifecycleState: MdMemoryLifecycleState
  pinned: boolean
  estimatedTokens: number
  included: boolean
  excerpted?: boolean
  skippedReason?: MdPackSkipReason
}

export interface MdPackOptions {
  tokenBudget: number
  /** Current user task / prompt. When present, relevant records are packed first. */
  query?: string
  /** Optional normalized [0, 1] similarity scores keyed by exact filename. */
  semanticScores?: ReadonlyMap<string, number>
  /** Contribution of a perfect semantic match to relevance. Defaults to 12. */
  semanticWeight?: number
  /** Minimum relevance score. Pinned memories bypass this. Undefined preserves legacy all-record packing. */
  minScore?: number
  /** Drop weak non-pinned matches below this share of the best relevance score. */
  minScoreRatioFromBest?: number
  /** Maximum number of records to include. Undefined means no count cap. */
  maxRecords?: number
  /** Tags that force a memory to be eligible and rank high. Defaults to pinned/pin. */
  pinnedTags?: string[]
  /** Optional contextual gate for tag-pinned records. Returning false removes
   *  the pin bonus/bypass but leaves the record eligible through normal
   *  lexical or semantic relevance. */
  pinnedFilter?: (record: MdMemoryRecord) => boolean
  /** Optional per-record lexical coverage floor. Useful for broad aggregate
   *  records that should not be selected from a single incidental query term. */
  minQueryTermMatchesForRecord?: (record: MdMemoryRecord) => number | undefined
  /** Add a small ranking boost for recently updated memories. Undefined disables recency ranking. */
  recencyHalfLifeDays?: number
  /** Skip duplicate records. Non-empty bodies dedupe by body; blank bodies fall back to visible metadata. */
  dedupe?: boolean
  /** Test seam for deterministic recency ranking. */
  now?: Date
  /** Mark working-pack records older than this many UTC days as stale. Defaults to 30. */
  staleAfterDays?: number
  /** Include a bounded excerpt instead of dropping a selected record that is too large. */
  excerptOversizedRecords?: boolean
}

const DEFAULT_PINNED_TAGS = ["pinned", "pin"]
const PINNED_SCORE_BONUS = 10_000
const DEFAULT_SEMANTIC_WEIGHT = 12
const DEFAULT_STALE_AFTER_DAYS = 30
const MAX_INDEX_LABEL_CHARS = 120
const MAX_INDEX_DESCRIPTION_CHARS = 240
const MAX_INDEX_TAGS_CHARS = 200
const tokenCounter = new TokenCounter()
const TOKEN_ALIASES: Record<string, string[]> = {
  cache: ["缓存"],
  cached: ["缓存"],
  caching: ["缓存"],
  hit: ["命中"],
  hits: ["命中"],
  rate: ["命中率"],
  ratio: ["命中率"],
  memory: ["记忆"],
  memories: ["记忆"],
  recall: ["召回"],
  recalls: ["召回"],
  recalled: ["召回"],
  compact: ["压缩"],
  compaction: ["压缩"],
  compress: ["压缩"],
  summary: ["摘要"],
  summarize: ["摘要"],
  context: ["上下文"],
  global: ["全局"],
  personal: ["个人"],
  project: ["项目"],
  workspace: ["项目", "工作区"],
  repository: ["项目", "仓库"],
  repo: ["项目", "仓库"],
  scope: ["作用域", "范围"],
  scoped: ["作用域", "范围"],
  duplicate: ["重复", "去重"],
  duplicates: ["重复", "去重"],
  duplicated: ["重复", "去重"],
  dedupe: ["去重", "重复"],
  deduped: ["去重", "重复"],
  deduplicate: ["去重", "重复"],
  deduplication: ["去重", "重复"],
  attachment: ["附件"],
  attachments: ["附件"],
  pack: ["工作包"],
  packs: ["工作包"],
  persistent: ["持久", "长期"],
  persist: ["持久", "长期"],
  persisted: ["持久", "长期"],
  durable: ["持久", "长期"],
  longterm: ["长期"],
  "long-term": ["长期"],
  design: ["设计"],
  designed: ["设计"],
  designing: ["设计"],
  architecture: ["架构"],
  architectural: ["架构"],
  layer: ["记忆层"],
  layers: ["记忆层"],
  mechanism: ["机制"],
  mechanisms: ["机制"],
  pipeline: ["链路", "流程"],
  pipelines: ["链路", "流程"],
  workflow: ["流程"],
  workflows: ["流程"],
  prompt: ["提示"],
  diagnostic: ["诊断"],
  diagnostics: ["诊断"],
  query: ["查询"],
  queries: ["查询"],
  rank: ["排序"],
  ranking: ["排序"],
  stable: ["稳定"],
  stability: ["稳定"],
  unstable: ["不稳定"],
  history: ["历史"],
  provider: ["供应商"],
  model: ["模型"],
  tool: ["工具"],
  tools: ["工具"],
  terminal: ["终端"],
  output: ["输出"],
  concise: ["简洁"],
  verification: ["验证"],
  verify: ["验证"],
  command: ["命令"],
  commands: ["命令"],
  billing: ["账单"],
  invoice: ["发票"],
  invoices: ["发票"],
  payment: ["支付"],
  payments: ["支付"],
  event: ["事件"],
  events: ["事件"],
  reconcile: ["对账"],
  reconciled: ["对账"],
  reconciliation: ["对账"],
  complete: ["完整"],
  completed: ["完整"],
  completeness: ["完整性"],
  full: ["完整"],
  integrity: ["完整性"],
  preserve: ["保留"],
  preserved: ["保留"],
  preservation: ["保留"],
  copy: ["复制"],
  copied: ["复制"],
  display: ["显示"],
  displayed: ["显示"],
  input: ["输入"],
  incomplete: ["不完整"],
  long: ["长文本", "长文"],
  message: ["消息"],
  messages: ["消息"],
  paste: ["粘贴", "复制"],
  pasted: ["粘贴", "复制"],
  restore: ["恢复"],
  restored: ["恢复"],
  send: ["发送"],
  sent: ["发送"],
  text: ["文本"],
  ui: ["界面", "显示"],
  缓存: ["cache"],
  命中: ["hit"],
  命中率: ["hit", "rate"],
  记忆: ["memory"],
  召回: ["recall"],
  压缩: ["compact"],
  摘要: ["summary"],
  上下文: ["context"],
  全局: ["global"],
  个人: ["personal"],
  项目: ["project"],
  工作区: ["workspace"],
  仓库: ["repository", "repo"],
  作用域: ["scope"],
  范围: ["scope"],
  重复: ["duplicate", "dedupe"],
  去重: ["dedupe", "deduplication", "duplicate"],
  附件: ["attachment"],
  工作包: ["pack"],
  持久: ["persistent", "persisted", "durable"],
  长期: ["persistent", "long-term", "durable"],
  设计: ["design"],
  架构: ["architecture"],
  记忆层: ["memory", "layer"],
  机制: ["mechanism"],
  链路: ["pipeline"],
  流程: ["pipeline", "workflow"],
  提示: ["prompt"],
  诊断: ["diagnostic"],
  查询: ["query"],
  排序: ["rank", "ranking"],
  稳定: ["stable", "stability"],
  不稳定: ["unstable"],
  历史: ["history"],
  供应商: ["provider"],
  模型: ["model"],
  工具: ["tool"],
  终端: ["terminal"],
  输出: ["output"],
  简洁: ["concise"],
  验证: ["verify", "verification"],
  命令: ["command"],
  账单: ["billing"],
  发票: ["invoice"],
  支付: ["payment"],
  事件: ["event"],
  对账: ["reconcile", "reconciliation"],
  完整: ["complete", "full"],
  完整性: ["completeness", "integrity"],
  保留: ["preserve"],
  不完整: ["incomplete"],
  发送: ["send"],
  复制: ["copy", "paste"],
  恢复: ["restore"],
  文本: ["text"],
  显示: ["display", "ui"],
  消息: ["message"],
  界面: ["ui"],
  粘贴: ["paste"],
  输入: ["input"],
  长文: ["long", "text"],
  长文本: ["long", "text"],
}

const TYPE_PRIORITY = new Map<MdMemoryType, number>(
  MD_MEMORY_TYPES.map((type, index) => [type, index]),
)

function priorityOrder(records: MdMemoryRecord[]): MdMemoryRecord[] {
  return [...records].sort(compareFallback)
}

function fmt(r: MdMemoryRecord, opts: MdPackOptions): string {
  return fmtWithBody(r, normalizeLogicalNewlines(r.body).replace(/\n+$/, "") + staleMemoryNote(r, opts))
}

function fmtWithBody(r: MdMemoryRecord, body: string, extraAttrs: string[] = []): string {
  const fm = r.frontmatter
  const attrs = [`name="${escapeAttr(fm.name)}"`]
  if (fm.tags?.length) attrs.push(`tags="${escapeAttr(fm.tags.join(","))}"`)
  if (fm.source) attrs.push(`source="${escapeAttr(fm.source)}"`)
  attrs.push(...extraAttrs)
  return `  <${fm.type} ${attrs.join(" ")}>\n${escapeText(body)}\n  </${fm.type}>`
}

/** Build a system-prompt block from the markdown store under a token budget.
 *  Default order: pinned records first, then type-priority (user → feedback →
 *  project → reference), then alpha by name. With `query`, records matching
 *  the current task are packed first. Greedy by full file unless
 *  excerptOversizedRecords is enabled. */
export function buildMdPack(store: MdMemoryStore, opts: MdPackOptions): MdPack {
  return buildMemorySelection(
    store,
    opts,
    (record) => fmt(record, opts),
    (tokenBudget, blocks) => {
      const open = `<memory budget="${tokenBudget}">`
      const close = "</memory>"
      return blocks.length === 0
        ? `${open}\n${close}`
        : `${open}\n${blocks.join("\n")}\n${close}`
    },
    packDedupeKey,
    opts.excerptOversizedRecords
      ? (record, fits) => buildFittingMemoryExcerpt(record, opts, fits)
      : undefined,
  )
}

/** Build a compact MEMORY.md-style index from the markdown store. Unlike the
 *  on-disk MEMORY.md, this can be query-ranked and capped so the per-turn
 *  transient context does not grow linearly forever. */
export function buildMdIndex(store: MdMemoryStore, opts: MdPackOptions): MdIndex {
  return buildMemorySelection(
    store,
    opts,
    fmtIndexLine,
    (_tokenBudget, blocks) => blocks.join("\n") + (blocks.length ? "\n" : ""),
    indexDedupeKey,
  )
}

function buildMemorySelection<T extends MdPack | MdIndex>(
  store: MdMemoryStore,
  opts: MdPackOptions,
  renderRecord: (record: MdMemoryRecord) => string,
  renderText: (tokenBudget: number, blocks: string[]) => string,
  dedupeKey: (record: MdMemoryRecord) => string,
  renderBudgetFallback?: (record: MdMemoryRecord, fits: (block: string) => boolean) => string | null,
): T {
  const records = store.list()
  const lifecycles = resolveMdMemoryLifecycles(records, opts.now)
  const ordered = rankRecords(records, opts, lifecycles)
  const blocks: string[] = []
  const included: string[] = []
  const skipped: MdPackSkipped[] = []
  const diagnostics: MdPackRecordDiagnostic[] = []
  const seenBodies = new Set<string>()
  const relativeScoreFloor = minScoreRatioFloor(ordered, opts)
  for (const candidate of ordered) {
    const r = candidate.record
    const lifecycleSkipReason = memoryLifecycleSkipReason(candidate.lifecycleState)
    let block = lifecycleSkipReason ? "" : renderRecord(r)
    let skippedReason: MdPackSkipReason | undefined = lifecycleSkipReason
    let excerpted = false
    const fits = (candidateBlock: string) =>
      tokenCounter.countText(renderText(opts.tokenBudget, [...blocks, candidateBlock])) <= opts.tokenBudget
    const minQueryTermMatches = lifecycleSkipReason
      ? undefined
      : normalizeMinQueryTermMatches(opts.minQueryTermMatchesForRecord?.(r))
    if (!skippedReason && (
      minQueryTermMatches !== undefined &&
      !candidate.pinned &&
      candidate.matchedQueryTerms < minQueryTermMatches
    )) {
      skippedReason = "min_score"
    } else if (
      !skippedReason &&
      opts.minScore !== undefined &&
      !candidate.pinned &&
      candidate.relevanceScore < opts.minScore
    ) {
      skippedReason = "min_score"
    } else if (
      !skippedReason &&
      relativeScoreFloor !== undefined &&
      !candidate.pinned &&
      candidate.relevanceScore < relativeScoreFloor
    ) {
      skippedReason = "min_score"
    } else if (!skippedReason && opts.dedupe && seenBodies.has(dedupeKey(r))) {
      skippedReason = "duplicate"
    } else if (!skippedReason && opts.maxRecords !== undefined && included.length >= opts.maxRecords) {
      skippedReason = "max_records"
    } else if (!skippedReason && !fits(block)) {
      const fallback = renderBudgetFallback?.(r, fits)
      if (fallback) {
        block = fallback
        excerpted = true
      } else {
        skippedReason = "budget"
      }
    }
    const diag: MdPackRecordDiagnostic = {
      filename: r.filename,
      score: candidate.score,
      relevanceScore: candidate.relevanceScore,
      lexicalScore: candidate.lexicalScore,
      semanticScore: candidate.semanticScore,
      recencyBoost: candidate.recencyBoost,
      confidence: candidate.confidence,
      confidenceWeight: candidate.confidenceWeight,
      lifecycleState: candidate.lifecycleState,
      pinned: candidate.pinned,
      estimatedTokens: tokenCounter.countText(block),
      included: skippedReason === undefined,
      ...(excerpted ? { excerpted: true } : {}),
      ...(skippedReason ? { skippedReason } : {}),
    }
    diagnostics.push(diag)
    if (skippedReason) {
      skipped.push({ filename: r.filename, reason: skippedReason, score: candidate.score })
      continue
    }
    blocks.push(block)
    included.push(r.filename)
    if (opts.dedupe) seenBodies.add(dedupeKey(r))
  }
  const text = renderText(opts.tokenBudget, blocks)
  return { text, included, skipped, diagnostics } as T
}

function normalizeMinQueryTermMatches(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined
}

function minScoreRatioFloor(
  ordered: RankedMemoryRecord[],
  opts: MdPackOptions,
): number | undefined {
  const ratio = typeof opts.minScoreRatioFromBest === "number" && Number.isFinite(opts.minScoreRatioFromBest)
    ? Math.max(0, Math.min(1, opts.minScoreRatioFromBest))
    : 0
  if (ratio <= 0) return undefined
  const best = ordered.reduce((max, candidate) =>
    candidate.pinned || candidate.lifecycleState !== "active"
      ? max
      : Math.max(max, candidate.relevanceScore), 0)
  return best > 0 ? best * ratio : undefined
}

function buildFittingMemoryExcerpt(
  record: MdMemoryRecord,
  opts: MdPackOptions,
  fits: (block: string) => boolean,
): string | null {
  const note = `[Memory excerpted because the full record is too large for this working pack. Read ${record.filename} with read_file for the full content.]`
  const staleNote = staleMemoryNote(record, opts)
  const content = selectMemoryExcerptContent(
    normalizeLogicalNewlines(record.body).replace(/\n+$/, ""),
    tokenize(opts.query ?? "", true),
  )
  const makeBlock = (bodyLimit: number) => {
    const body = [
      note,
      content ? "" : null,
      content ? truncateMiddle(content, bodyLimit) : null,
    ].filter((part): part is string => part !== null).join("\n") + staleNote
    return fmtWithBody(record, body, [`excerpt="true"`])
  }

  const noteOnly = makeBlock(0)
  if (!fits(noteOnly)) return null

  let best = noteOnly
  let low = 0
  let high = countCodePoints(content)
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = makeBlock(mid)
    if (fits(candidate)) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

function selectMemoryExcerptContent(body: string, terms: string[]): string {
  const trimmed = body.trim()
  if (!trimmed || terms.length === 0) return trimmed

  const lines = splitLogicalLines(trimmed)
  const selected = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    if (!lineMatchesTerms(lines[i], terms)) continue
    const heading = nearestHeadingBefore(lines, i)
    if (heading !== undefined) selected.add(heading)
    for (let j = i; j <= Math.min(lines.length - 1, i + 3); j++) {
      selected.add(j)
    }
  }
  if (selected.size === 0) return trimmed

  const out: string[] = []
  let previous = -1
  for (const index of [...selected].sort((a, b) => a - b)) {
    if (previous >= 0 && index > previous + 1) {
      out.push("[... unrelated memory lines omitted ...]")
    }
    out.push(lines[index])
    previous = index
  }
  return out.join("\n").trim()
}

function nearestHeadingBefore(lines: string[], index: number): number | undefined {
  for (let i = index; i >= Math.max(0, index - 8); i--) {
    if (/^#{1,6}\s+\S/u.test(lines[i])) return i
  }
  return undefined
}

function lineMatchesTerms(line: string, terms: string[]): boolean {
  const tokens = tokenize(line, false)
  return terms.some((term) => tokenMatches(tokens, term))
}

function truncateMiddle(text: string, maxChars: number): string {
  if (countCodePoints(text) <= maxChars) return text
  if (maxChars <= 0) return ""
  if (maxChars < 120) return `${sliceHeadCodePoints(text, maxChars).trimEnd()}\n[excerpt truncated]`
  const marker = "\n[excerpt truncated]\n"
  const available = Math.max(0, maxChars - countCodePoints(marker))
  const head = Math.ceil(available * 0.65)
  const tail = available - head
  return `${sliceHeadCodePoints(text, head).trimEnd()}${marker}${sliceTailCodePoints(text, tail).trimStart()}`
}

interface RankedMemoryRecord {
  record: MdMemoryRecord
  score: number
  relevanceScore: number
  lexicalScore: number
  matchedQueryTerms: number
  semanticScore: number
  recencyBoost: number
  confidence: "high" | "medium" | "low"
  confidenceWeight: number
  lifecycleState: MdMemoryLifecycleState
  pinned: boolean
}

function rankRecords(
  records: MdMemoryRecord[],
  opts: MdPackOptions,
  lifecycles: ReadonlyMap<string, MdMemoryLifecycleResolution>,
): RankedMemoryRecord[] {
  const terms = tokenize(opts.query ?? "", true)
  const hasSemanticScores = (opts.semanticScores?.size ?? 0) > 0
  const pinnedTags = opts.pinnedTags ?? DEFAULT_PINNED_TAGS
  const hasPinnedRecords = records.some((record) =>
    lifecycles.get(record.filename)?.state === "active" && isPinned(record, pinnedTags))
  if (
    terms.length === 0 &&
    !hasSemanticScores &&
    !opts.recencyHalfLifeDays &&
    !hasPinnedRecords
  ) {
    return priorityOrder(records).map(record => {
      const lifecycle = lifecycles.get(record.filename) ?? defaultLifecycleResolution()
      return {
        record,
        score: 0,
        relevanceScore: 0,
        lexicalScore: 0,
        matchedQueryTerms: 0,
        semanticScore: 0,
        recencyBoost: 0,
        confidence: lifecycle.confidence,
        confidenceWeight: memoryConfidenceWeight(lifecycle.confidence),
        lifecycleState: lifecycle.state,
        pinned: false,
      }
    })
  }
  return [...records]
    .map(record => {
      const lifecycle = lifecycles.get(record.filename) ?? defaultLifecycleResolution()
      const active = lifecycle.state === "active"
      const lexical = active && terms.length > 0
        ? lexicalRelevance(record, terms)
        : { score: 0, matchedTerms: 0 }
      const lexicalScore = lexical.score
      const semanticScore = active ? memorySemanticScore(record, opts.semanticScores) : 0
      const semanticWeight = finiteNonNegative(opts.semanticWeight, DEFAULT_SEMANTIC_WEIGHT)
      const confidenceWeight = memoryConfidenceWeight(lifecycle.confidence)
      const relevance = quantizedScore((lexicalScore + semanticScore * semanticWeight) * confidenceWeight)
      const pinned = active && isPinned(record, pinnedTags) && (opts.pinnedFilter?.(record) ?? true)
      const recencyBoost = active ? recencyScore(record, opts) : 0
      return {
        record,
        relevanceScore: relevance,
        lexicalScore,
        matchedQueryTerms: lexical.matchedTerms,
        semanticScore,
        recencyBoost,
        confidence: lifecycle.confidence,
        confidenceWeight,
        lifecycleState: lifecycle.state,
        pinned,
        score: relevance + recencyBoost + (pinned ? PINNED_SCORE_BONUS : 0),
      }
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if ((terms.length > 0 || hasSemanticScores) && b.relevanceScore !== a.relevanceScore) {
        return b.relevanceScore - a.relevanceScore
      }
      if (b.score !== a.score) return b.score - a.score
      return compareFallback(a.record, b.record)
    })
}

function memoryLifecycleSkipReason(state: MdMemoryLifecycleState): MdPackSkipReason | undefined {
  switch (state) {
    case "active": return undefined
    case "low_confidence": return "low_confidence"
    case "not_yet_valid": return "not_yet_valid"
    case "expired": return "expired"
    case "superseded": return "superseded"
    case "invalid": return "invalid_lifecycle"
  }
}

function defaultLifecycleResolution(): MdMemoryLifecycleResolution {
  return {
    state: "active",
    confidence: "high",
    supersededBy: [],
    problems: [],
  }
}

function quantizedScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function memorySemanticScore(
  record: MdMemoryRecord,
  scores: ReadonlyMap<string, number> | undefined,
): number {
  const score = scores?.get(record.filename)
  return typeof score === "number" && Number.isFinite(score)
    ? Math.min(1, Math.max(0, score))
    : 0
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback
}

function compareFallback(a: MdMemoryRecord, b: MdMemoryRecord): number {
  const typeDelta =
    (TYPE_PRIORITY.get(a.frontmatter.type) ?? 999) -
    (TYPE_PRIORITY.get(b.frontmatter.type) ?? 999)
  if (typeDelta !== 0) return typeDelta
  const nameDelta = a.frontmatter.name.localeCompare(b.frontmatter.name)
  if (nameDelta !== 0) return nameDelta
  return a.filename.localeCompare(b.filename)
}

function lexicalRelevance(
  record: MdMemoryRecord,
  terms: string[],
): { score: number; matchedTerms: number } {
  const fm = record.frontmatter
  const weightedFields: Array<[string, number]> = [
    [fm.name, 10],
    [filenameSearchText(record), 6],
    [fm.description, 8],
    [(fm.tags ?? []).join(" "), 8],
    [fm.source ?? "", 4],
    [record.body, 3],
  ]

  let score = 0
  const matchedTerms = new Set<string>()
  for (const [text, weight] of weightedFields) {
    if (!text) continue
    const fieldTokens = tokenize(text, false)
    for (const term of terms) {
      if (!tokenMatches(fieldTokens, term)) continue
      score += weight
      matchedTerms.add(term)
    }
  }
  return { score, matchedTerms: matchedTerms.size }
}

function filenameSearchText(record: MdMemoryRecord): string {
  const filenameStem = record.filename.replace(/\.md$/iu, "")
  return normalizeDedupeText(filenameStem) === normalizeDedupeText(record.frontmatter.name)
    ? ""
    : filenameStem
}

function fmtIndexLine(r: MdMemoryRecord): string {
  const fm = r.frontmatter
  const meta: string[] = [fm.type]
  if (fm.tags?.length) {
    meta.push(`tags:${escapeMarkdownInline(compactIndexInline(fm.tags.join(","), MAX_INDEX_TAGS_CHARS))}`)
  }
  const description = compactIndexInline(fm.description, MAX_INDEX_DESCRIPTION_CHARS)
  return `- [${indexLabel(fm.name, r.filename)}](${escapeMarkdownDestination(r.filename)}) — ${escapeMarkdownInline(description)} (${meta.join("; ")})`
}

function tokenMatches(tokens: string[], term: string): boolean {
  for (const token of tokens) {
    if (token === term) return true
    const shorter = Math.min(token.length, term.length)
    const longer = Math.max(token.length, term.length)
    if (shorter >= 4 && shorter / longer >= 0.7 && (token.includes(term) || term.includes(token))) {
      return true
    }
  }
  return false
}

function isPinned(record: MdMemoryRecord, pinnedTags = DEFAULT_PINNED_TAGS): boolean {
  const tags = record.frontmatter.tags ?? []
  if (tags.length === 0) return false
  const pins = new Set(pinnedTags.map(t => t.trim().toLowerCase()).filter(Boolean))
  return tags.some(t => pins.has(t.trim().toLowerCase()))
}

function recencyScore(record: MdMemoryRecord, opts: MdPackOptions): number {
  if (!opts.recencyHalfLifeDays || opts.recencyHalfLifeDays <= 0) return 0
  const resolution = resolveMdMemoryTimestamp(record.frontmatter)
  if (resolution.kind !== "valid") return 0
  // Quantize to UTC days so repeated turns in the same day don't get subtly
  // different scores/hashes from a continuously-decaying Date.now().
  const ageDays = mdMemoryAgeDays(resolution.timestamp, opts.now?.getTime() ?? Date.now())
  return 2 * Math.pow(0.5, ageDays / opts.recencyHalfLifeDays)
}

function staleMemoryNote(record: MdMemoryRecord, opts: MdPackOptions): string {
  const staleAfterDays = typeof opts.staleAfterDays === "number" && Number.isFinite(opts.staleAfterDays)
    ? Math.max(0, Math.floor(opts.staleAfterDays))
    : DEFAULT_STALE_AFTER_DAYS
  const resolution = resolveMdMemoryTimestamp(record.frontmatter)
  if (resolution.kind === "missing") return ""
  if (resolution.kind === "invalid") {
    return "\n\n[Memory timestamp metadata is invalid — age unknown; verify against current state]"
  }
  const ageDays = mdMemoryAgeDays(resolution.timestamp, opts.now?.getTime() ?? Date.now())
  if (ageDays <= staleAfterDays) return ""
  return `\n\n[Memory updated ${staleAgeLabel(ageDays, staleAfterDays)} — may be outdated; verify against current state]`
}

function staleAgeLabel(ageDays: number, staleAfterDays: number): string {
  if (ageDays < 90) return `more than ${staleAfterDays} days ago`
  if (ageDays < 180) return "more than 90 days ago"
  if (ageDays < 365) return "more than 180 days ago"
  return "more than 1 year ago"
}

function packDedupeKey(record: MdMemoryRecord): string {
  const bodyKey = bodyDedupeKey(record)
  if (bodyKey) return `body:${bodyKey}`
  const fm = record.frontmatter
  return [
    "pack",
    normalizeDedupeText(fm.type),
    normalizeDedupeText(fm.name),
    normalizeDedupeText((fm.tags ?? []).join(" ")),
    normalizeDedupeText(fm.source ?? ""),
  ].join("\0")
}

function bodyDedupeKey(record: MdMemoryRecord): string {
  return normalizeDedupeText(record.body)
}

function indexDedupeKey(record: MdMemoryRecord): string {
  const bodyKey = bodyDedupeKey(record)
  if (bodyKey) return `body:${bodyKey}`
  const fm = record.frontmatter
  return [
    "index",
    normalizeDedupeText(fm.type),
    normalizeDedupeText(fm.name),
    normalizeDedupeText(record.filename),
    normalizeDedupeText(fm.description),
    normalizeDedupeText((fm.tags ?? []).join(" ")),
    normalizeDedupeText(fm.source ?? ""),
  ].join("\0")
}

function normalizeDedupeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

function tokenize(text: string, expandAliases: boolean): string[] {
  const matches = text.match(/[\p{L}\p{N}_-]+/gu) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  const add = (rawToken: string) => {
    const token = rawToken.toLowerCase()
    if (token.length <= 1 || seen.has(token)) return
    seen.add(token)
    out.push(token)
    if (!expandAliases) return
    for (const alias of TOKEN_ALIASES[token] ?? []) {
      if (alias.length <= 1 || seen.has(alias)) continue
      seen.add(alias)
      out.push(alias)
    }
  }
  for (const match of matches) {
    for (const token of identifierTokenVariants(match)) add(token)
    for (const run of cjkRuns(match)) {
      add(run)
      for (const gram of cjkNgrams(run, 2)) add(gram)
      for (const gram of cjkNgrams(run, 3)) add(gram)
    }
  }
  return out
}

function identifierTokenVariants(token: string): string[] {
  const out: string[] = [token]
  for (const part of token.split(/[_-]+/u)) {
    if (!part) continue
    out.push(part)
    out.push(...splitCamelIdentifier(part))
  }
  return out
}

function splitCamelIdentifier(token: string): string[] {
  return token
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/u)
    .filter(Boolean)
}

function cjkRuns(text: string): string[] {
  return text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? []
}

function cjkNgrams(text: string, size: number): string[] {
  const chars = Array.from(text)
  if (chars.length < size) return []
  const out: string[] = []
  for (let i = 0; i <= chars.length - size; i++) {
    out.push(chars.slice(i, i + size).join(""))
  }
  return out
}

function escapeAttr(value: string): string {
  return escapeText(oneLine(value))
    .replace(/"/g, "&quot;")
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function compactIndexInline(value: string, maxChars: number): string {
  const text = oneLine(value)
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, Math.max(0, maxChars - 3)).join("").trimEnd()}...`
}

function indexLabel(name: string, filename: string): string {
  const label = compactIndexInline(name, MAX_INDEX_LABEL_CHARS)
    .replace(/[\[\]]/g, "")
    .replace(/([\\()])/g, "\\$1")
    .trim()
  return label || escapeMarkdownInline(oneLine(filename.replace(/\.md$/i, "")))
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\[\]()])/g, "\\$1")
}

function escapeMarkdownDestination(value: string): string {
  return oneLine(value)
    .replace(/ /g, "%20")
    .replace(/([\\()])/g, "\\$1")
}

export const __test = { truncateMiddle }
