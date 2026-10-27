import type { RequestCacheObservation } from "../../zapsdk/context/request-cache.js"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { computeCacheUsageStats } from "../../zapsdk/agent/cache-metrics.js"
import type { AgentEvent, ContextDiagnostics } from "../../zapsdk/agent/events.js"
import type { TokenUsage } from "../../zapsdk/core/types.js"
import { getAppDataDir, IS_WINDOWS } from "../../zapsdk/utils/platform.js"
import { resolveProjectDataSegment } from "../../zapsdk/utils/project-paths.js"
import { countCodePoints, sliceHeadCodePoints } from "../utils/logicalLines.js"
import { sanitizePromptCacheScope, type PromptCacheScope } from "./cacheScope.js"
import { sanitizeContextDiagnostics, sanitizePromptCacheDiagnostics } from "./diagnosticSanitizers.js"
import type { PromptCacheDiagnostics } from "./promptDiagnostics.js"
import {
  MemoryUtilityTracker,
  sanitizeMemoryUtilityAttribution,
  type MemoryUtilityAttribution,
  type MemoryUtilityCandidate,
  type MemoryUtilityFingerprint,
} from "./memoryUtility.js"

export const CACHE_MEMORY_AUDIT_FILENAME = "cache-memory-audit.jsonl"
export const MAX_CACHE_MEMORY_AUDIT_BYTES = 1024 * 1024
export const DEFAULT_CACHE_MEMORY_AUDIT_READ_LIMIT = 40

const AUDIT_VERSION = 1 as const
const MAX_AUDIT_TEXT_CHARS = 256

export interface CacheMemoryAuditUsage {
  inputTokens: number
  providerUsageReported?: boolean
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  totalPromptInputTokens: number
  cacheHitRatio?: number | null
  cacheReuseRatio?: number | null
  cacheWriteRatio?: number | null
  outputTokens: number
}

export interface CacheMemoryAuditCompaction {
  autoAttempts: number
  autoSucceeded: number
  autoFailed: number
  reactiveCompactions: number
  pruneAttempts?: number
  pruneSucceeded?: number
  prunedTokens?: number
  prunedMessages?: number
}

export interface CacheMemoryAuditTelemetry {
  usageSamples: number
  cacheAccountingSamples: number
  contextSamples: number
  contextShapes: number
  conversationPrefixShapes: number
  wireRequests?: number
  wireRewrites?: number
}

export interface CacheMemoryAuditEntry {
  version: typeof AUDIT_VERSION
  timestamp: string
  sessionId?: string
  cacheScope?: PromptCacheScope
  durationMs: number
  steps: number
  stopped?: string
  finishReason?: string
  usage: CacheMemoryAuditUsage
  promptCacheDiagnostics?: PromptCacheDiagnostics
  contextDiagnostics?: ContextDiagnostics
  requestCache?: RequestCacheObservation
  telemetry?: CacheMemoryAuditTelemetry
  compaction: CacheMemoryAuditCompaction
  memoryUtility?: MemoryUtilityAttribution
}

export interface CacheMemoryAuditEntryInput {
  timestamp?: string
  sessionId?: string
  cacheScope?: PromptCacheScope
  durationMs?: number
  steps?: number
  stopped?: string
  finishReason?: string
  usage: Pick<
    TokenUsage,
    | "inputTokens"
    | "providerUsageReported"
    | "cacheReadInputTokens"
    | "cacheCreationInputTokens"
    | "outputTokens"
  >
  promptCacheDiagnostics?: PromptCacheDiagnostics
  contextDiagnostics?: ContextDiagnostics
  requestCache?: RequestCacheObservation
  telemetry?: Partial<CacheMemoryAuditTelemetry>
  compaction?: Partial<CacheMemoryAuditCompaction>
  memoryUtility?: MemoryUtilityAttribution
}

export interface CacheMemoryAuditWriteOptions {
  dataDir?: string
  maxBytes?: number
}

export interface CacheMemoryAuditTrackerOptions {
  sessionId?: string
  cacheScope?: PromptCacheScope
  getPromptCacheDiagnostics?: () => PromptCacheDiagnostics | undefined
  memoryUtility?: {
    candidates: readonly MemoryUtilityCandidate[]
    cwd: string
    baseline?: MemoryUtilityFingerprint
  }
  append: (entry: CacheMemoryAuditEntry) => void
  onError?: (error: Error) => void
  now?: () => number
}

export function cacheMemoryAuditPath(cwd: string, dataDir = getAppDataDir()): string {
  return join(
    dataDir,
    "projects",
    resolveProjectDataSegment(cwd),
    "diagnostics",
    CACHE_MEMORY_AUDIT_FILENAME,
  )
}

export function buildCacheMemoryAuditEntry(input: CacheMemoryAuditEntryInput): CacheMemoryAuditEntry {
  const cache = computeCacheUsageStats(input.usage)
  const cacheReadReported = typeof input.usage.cacheReadInputTokens === "number"
  const cacheCreationReported = typeof input.usage.cacheCreationInputTokens === "number"
  const cacheScope = sanitizePromptCacheScope(input.cacheScope)
  const promptCacheDiagnostics = sanitizePromptCacheDiagnostics(input.promptCacheDiagnostics)
  const contextDiagnostics = sanitizeContextDiagnostics(input.contextDiagnostics)
  const timestamp = validTimestamp(input.timestamp) ?? new Date().toISOString()
  const usage: CacheMemoryAuditUsage = {
    inputTokens: cache.freshInputTokens,
    ...(typeof input.usage.providerUsageReported === "boolean"
      ? { providerUsageReported: input.usage.providerUsageReported }
      : {}),
    ...(cacheReadReported ? { cacheReadInputTokens: cache.cacheReadInputTokens } : {}),
    ...(cacheCreationReported ? { cacheCreationInputTokens: cache.cacheCreationInputTokens } : {}),
    totalPromptInputTokens: cache.totalPromptInputTokens,
    ...(cacheReadReported || cacheCreationReported
      ? {
          cacheHitRatio: cache.cacheHitRatio,
          cacheReuseRatio: cache.cacheReuseRatio,
          cacheWriteRatio: cache.cacheWriteRatio,
        }
      : {}),
    outputTokens: nonNegativeFinite(input.usage.outputTokens),
  }
  const sessionId = boundedText(input.sessionId)
  const stopped = boundedText(input.stopped)
  const finishReason = boundedText(input.finishReason)
  const memoryUtility = sanitizeMemoryUtilityAttribution(input.memoryUtility)
  return {
    version: AUDIT_VERSION,
    timestamp,
    ...(sessionId ? { sessionId } : {}),
    ...(cacheScope ? { cacheScope } : {}),
    durationMs: nonNegativeInteger(input.durationMs),
    steps: nonNegativeInteger(input.steps),
    ...(stopped ? { stopped } : {}),
    ...(finishReason ? { finishReason } : {}),
    usage,
    ...(promptCacheDiagnostics ? { promptCacheDiagnostics } : {}),
    ...(contextDiagnostics ? { contextDiagnostics } : {}),
    ...(input.telemetry ? { telemetry: sanitizeTelemetry(input.telemetry) } : {}),
    ...(sanitizeRequestCache(input.requestCache) ? { requestCache: sanitizeRequestCache(input.requestCache) } : {}),
    compaction: sanitizeCompaction(input.compaction),
    ...(memoryUtility ? { memoryUtility } : {}),
  }
}

export function appendCacheMemoryAudit(
  cwd: string,
  input: CacheMemoryAuditEntry,
  options: CacheMemoryAuditWriteOptions = {},
): string {
  const entry = sanitizeCacheMemoryAuditEntry(input)
  if (!entry) throw new Error("invalid cache/memory audit entry")
  const path = cacheMemoryAuditPath(cwd, options.dataDir)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodBestEffort(dir, 0o700)
  const line = `${JSON.stringify(entry)}\n`
  const lineBytes = Buffer.byteLength(line)
  const maxBytes = positiveInteger(options.maxBytes, MAX_CACHE_MEMORY_AUDIT_BYTES)
  if (lineBytes > maxBytes) {
    throw new Error(`cache/memory audit entry exceeds ${maxBytes} byte limit`)
  }
  compactAuditFileBeforeAppend(path, lineBytes, maxBytes)
  appendFileSync(path, line, { encoding: "utf-8", mode: 0o600 })
  chmodBestEffort(path, 0o600)
  return path
}

export function readRecentCacheMemoryAudit(
  cwd: string,
  limit = DEFAULT_CACHE_MEMORY_AUDIT_READ_LIMIT,
  dataDir = getAppDataDir(),
): CacheMemoryAuditEntry[] {
  const path = cacheMemoryAuditPath(cwd, dataDir)
  try {
    return parseCacheMemoryAuditJsonl(readFileSync(path, "utf-8"), limit)
  } catch {
    return []
  }
}

export function parseCacheMemoryAuditJsonl(
  raw: string,
  limit = DEFAULT_CACHE_MEMORY_AUDIT_READ_LIMIT,
): CacheMemoryAuditEntry[] {
  const max = positiveInteger(limit, DEFAULT_CACHE_MEMORY_AUDIT_READ_LIMIT)
  const out: CacheMemoryAuditEntry[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = sanitizeCacheMemoryAuditEntry(JSON.parse(line))
      if (!entry) continue
      out.push(entry)
      if (out.length > max) out.shift()
    } catch {}
  }
  return out
}

export class CacheMemoryAuditTracker {
  private readonly options: CacheMemoryAuditTrackerOptions
  private startedAtMs: number | undefined
  private latestContextDiagnostics: ContextDiagnostics | undefined
  private usageSamples = 0
  private cacheAccountingSamples = 0
  private contextSamples = 0
  private contextShapes = new Set<string>()
  private conversationPrefixShapes = new Set<string>()
  private written = false
  private requestCache?: RequestCacheObservation
  private wireRequests = 0
  private wireRewrites = 0
  private compaction: CacheMemoryAuditCompaction = emptyCompaction()
  private readonly memoryUtility: MemoryUtilityTracker | undefined

  constructor(options: CacheMemoryAuditTrackerOptions) {
    this.options = options
    this.memoryUtility = options.memoryUtility
      ? new MemoryUtilityTracker(
          options.memoryUtility.candidates,
          options.memoryUtility.cwd,
          options.memoryUtility.baseline,
        )
      : undefined
  }

  readonly handle = (event: AgentEvent): void => {
    if (event.path && event.path.length > 0) return
    this.memoryUtility?.handle(event)
    if (event.type === "run_started") {
      this.startedAtMs = this.now()
      this.latestContextDiagnostics = undefined
      this.usageSamples = 0
      this.cacheAccountingSamples = 0
      this.contextSamples = 0
      this.contextShapes.clear()
      this.conversationPrefixShapes.clear()
      this.written = false
      this.compaction = emptyCompaction()
      this.requestCache = undefined
      this.wireRequests = 0
      this.wireRewrites = 0
      return
    }
    if (event.type === "run_step") {
      this.latestContextDiagnostics = sanitizeContextDiagnostics(event.context)
      if (this.latestContextDiagnostics) {
        this.contextSamples++
        this.contextShapes.add(this.latestContextDiagnostics.hash)
        const prefixHash = this.latestContextDiagnostics.conversationCache?.prefix.hash
        if (prefixHash) this.conversationPrefixShapes.add(prefixHash)
      }
      return
    }
    if (event.type === "run_usage") {
      this.usageSamples++
      if (
        typeof event.cacheReadInputTokens === "number" ||
        typeof event.cacheCreationInputTokens === "number"
      ) {
        this.cacheAccountingSamples++
      }
      return
    }
    if (event.type === "observation") {
      if (event.kind === "request_cache_shape") {
        const shape = sanitizeRequestCache(event.detail)
        if (shape) {
          this.requestCache = shape; this.wireRequests++
          if (["rewrite", "scope_change", "shape_change"].includes(shape.change)) this.wireRewrites++
        }
      }
      this.recordCompaction(event)
      return
    }
    if (event.type !== "run_ended" || this.written) return
    this.written = true
    const now = this.now()
    let promptCacheDiagnostics: PromptCacheDiagnostics | undefined
    try {
      promptCacheDiagnostics = this.options.getPromptCacheDiagnostics?.()
    } catch (error) {
      this.reportError(error)
    }
    const entry = buildCacheMemoryAuditEntry({
      timestamp: new Date(now).toISOString(),
      sessionId: this.options.sessionId,
      cacheScope: this.options.cacheScope,
      durationMs: this.startedAtMs === undefined ? 0 : Math.max(0, now - this.startedAtMs),
      steps: event.steps,
      stopped: event.stopped,
      finishReason: event.finishReason,
      usage: event.usage,
      promptCacheDiagnostics,
      contextDiagnostics: this.latestContextDiagnostics,
      requestCache: this.requestCache,
      telemetry: {
        usageSamples: this.usageSamples,
        cacheAccountingSamples: this.cacheAccountingSamples,
        contextSamples: this.contextSamples,
        contextShapes: this.contextShapes.size,
        conversationPrefixShapes: this.conversationPrefixShapes.size,
        ...(this.wireRequests ? { wireRequests: this.wireRequests, wireRewrites: this.wireRewrites } : {}),
      },
      compaction: this.compaction,
      memoryUtility: this.memoryUtility?.summarize(),
    })
    try {
      this.options.append(entry)
    } catch (error) {
      this.reportError(error)
    }
  }

  private recordCompaction(event: Extract<AgentEvent, { type: "observation" }>): void {
    if (event.kind === "prune_start") {
      this.compaction.pruneAttempts = (this.compaction.pruneAttempts ?? 0) + 1
    } else if (event.kind === "prune_done") {
      this.compaction.pruneSucceeded = (this.compaction.pruneSucceeded ?? 0) + 1
      this.compaction.prunedTokens = (this.compaction.prunedTokens ?? 0) + Math.max(0,
        nonNegativeInteger(event.detail?.inputTokens) - nonNegativeInteger(event.detail?.outputTokens))
      this.compaction.prunedMessages = (this.compaction.prunedMessages ?? 0) + nonNegativeInteger(event.detail?.messagesPruned)
    } else if (event.kind === "autocompact_start") {
      this.compaction.autoAttempts++
    } else if (event.kind === "autocompact_done") {
      if (event.detail?.failed === true) this.compaction.autoFailed++
      else this.compaction.autoSucceeded++
    } else if (event.kind === "reactive_compact") {
      this.compaction.reactiveCompactions++
    }
  }

  private now(): number {
    const value = this.options.now?.() ?? Date.now()
    return Number.isFinite(value) ? value : Date.now()
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
    } catch {}
  }
}

function sanitizeCacheMemoryAuditEntry(value: unknown): CacheMemoryAuditEntry | undefined {
  if (!isRecord(value) || value.version !== AUDIT_VERSION || !isRecord(value.usage)) return undefined
  const timestamp = validTimestamp(value.timestamp)
  if (!timestamp) return undefined
  const input: CacheMemoryAuditEntryInput = {
    timestamp,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    cacheScope: sanitizePromptCacheScope(value.cacheScope),
    durationMs: numberOrUndefined(value.durationMs),
    steps: numberOrUndefined(value.steps),
    stopped: typeof value.stopped === "string" ? value.stopped : undefined,
    finishReason: typeof value.finishReason === "string" ? value.finishReason : undefined,
    usage: {
      inputTokens: nonNegativeFinite(value.usage.inputTokens),
      ...(typeof value.usage.providerUsageReported === "boolean"
        ? { providerUsageReported: value.usage.providerUsageReported }
        : {}),
      ...(typeof value.usage.cacheReadInputTokens === "number"
        ? { cacheReadInputTokens: value.usage.cacheReadInputTokens }
        : {}),
      ...(typeof value.usage.cacheCreationInputTokens === "number"
        ? { cacheCreationInputTokens: value.usage.cacheCreationInputTokens }
        : {}),
      outputTokens: nonNegativeFinite(value.usage.outputTokens),
    },
    promptCacheDiagnostics: sanitizePromptCacheDiagnostics(value.promptCacheDiagnostics),
    contextDiagnostics: sanitizeContextDiagnostics(value.contextDiagnostics),
    telemetry: isRecord(value.telemetry)
      ? {
          usageSamples: numberOrUndefined(value.telemetry.usageSamples),
          cacheAccountingSamples: numberOrUndefined(value.telemetry.cacheAccountingSamples),
          contextSamples: numberOrUndefined(value.telemetry.contextSamples),
          contextShapes: numberOrUndefined(value.telemetry.contextShapes),
          conversationPrefixShapes: numberOrUndefined(value.telemetry.conversationPrefixShapes),
          wireRequests: numberOrUndefined(value.telemetry.wireRequests),
          wireRewrites: numberOrUndefined(value.telemetry.wireRewrites),
        }
      : undefined,
    requestCache: sanitizeRequestCache(value.requestCache),
    compaction: isRecord(value.compaction)
      ? {
          autoAttempts: numberOrUndefined(value.compaction.autoAttempts),
          autoSucceeded: numberOrUndefined(value.compaction.autoSucceeded),
          autoFailed: numberOrUndefined(value.compaction.autoFailed),
          reactiveCompactions: numberOrUndefined(value.compaction.reactiveCompactions),
          pruneAttempts: numberOrUndefined(value.compaction.pruneAttempts),
          pruneSucceeded: numberOrUndefined(value.compaction.pruneSucceeded),
          prunedTokens: numberOrUndefined(value.compaction.prunedTokens),
          prunedMessages: numberOrUndefined(value.compaction.prunedMessages),
        }
      : undefined,
    memoryUtility: sanitizeMemoryUtilityAttribution(value.memoryUtility),
  }
  return buildCacheMemoryAuditEntry(input)
}

function compactAuditFileBeforeAppend(path: string, incomingBytes: number, maxBytes: number): void {
  if (!existsSync(path)) return
  try {
    if (statSync(path).size + incomingBytes <= maxBytes) return
  } catch {
    return
  }
  let entries: CacheMemoryAuditEntry[]
  try {
    entries = parseCacheMemoryAuditJsonl(readFileSync(path, "utf-8"), Number.MAX_SAFE_INTEGER)
  } catch {
    entries = []
  }
  const budget = Math.max(0, maxBytes - incomingBytes)
  const retained: string[] = []
  let retainedBytes = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = `${JSON.stringify(entries[i])}\n`
    const bytes = Buffer.byteLength(line)
    if (retainedBytes + bytes > budget) break
    retained.unshift(line)
    retainedBytes += bytes
  }
  atomicRewrite(path, retained.join(""))
}

function atomicRewrite(path: string, content: string): void {
  const tempPath = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tempPath, content, { encoding: "utf-8", mode: 0o600 })
    chmodBestEffort(tempPath, 0o600)
    renameSync(tempPath, path)
  } finally {
    try { unlinkSync(tempPath) } catch {}
  }
}

function sanitizeRequestCache(value: unknown): RequestCacheObservation | undefined {
  if (!isRecord(value) || !["initial", "unchanged", "append", "rewrite", "scope_change", "shape_change", "unsampled_change"].includes(String(value.change))) return undefined
  const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
  if (!validHash(value.afterHash) || !validHash(value.scopeHash) || !validHash(value.staticHash)) return undefined
  return { change: value.change as RequestCacheObservation["change"],
    ...(["prune", "summary", "recovery"].includes(String(value.reason)) ? { reason: value.reason as RequestCacheObservation["reason"] } : {}),
    commonPrefixMessages: nonNegativeInteger(value.commonPrefixMessages), previousMessages: nonNegativeInteger(value.previousMessages),
    messages: nonNegativeInteger(value.messages), sampled: value.sampled === true,
    ...(validHash(value.beforeHash) ? { beforeHash: value.beforeHash } : {}),
    afterHash: value.afterHash, scopeHash: value.scopeHash, staticHash: value.staticHash }
}

function sanitizeCompaction(value: Partial<CacheMemoryAuditCompaction> | undefined): CacheMemoryAuditCompaction {
  return {
    autoAttempts: nonNegativeInteger(value?.autoAttempts),
    autoSucceeded: nonNegativeInteger(value?.autoSucceeded),
    autoFailed: nonNegativeInteger(value?.autoFailed),
    reactiveCompactions: nonNegativeInteger(value?.reactiveCompactions),
    ...Object.fromEntries(["pruneAttempts", "pruneSucceeded", "prunedTokens", "prunedMessages"]
      .filter(key => value?.[key as keyof CacheMemoryAuditCompaction] !== undefined)
      .map(key => [key, nonNegativeInteger(value?.[key as keyof CacheMemoryAuditCompaction])])),
  }
}

function sanitizeTelemetry(value: Partial<CacheMemoryAuditTelemetry>): CacheMemoryAuditTelemetry {
  const usageSamples = nonNegativeInteger(value.usageSamples)
  const contextSamples = nonNegativeInteger(value.contextSamples)
  return {
    usageSamples,
    ...(value.wireRequests === undefined ? {} : { wireRequests: nonNegativeInteger(value.wireRequests), wireRewrites: nonNegativeInteger(value.wireRewrites) }),
    cacheAccountingSamples: Math.min(
      usageSamples,
      nonNegativeInteger(value.cacheAccountingSamples),
    ),
    contextSamples,
    contextShapes: Math.min(contextSamples, nonNegativeInteger(value.contextShapes)),
    conversationPrefixShapes: Math.min(
      contextSamples,
      nonNegativeInteger(value.conversationPrefixShapes),
    ),
  }
}

function emptyCompaction(): CacheMemoryAuditCompaction {
  return { autoAttempts: 0, autoSucceeded: 0, autoFailed: 0, reactiveCompactions: 0 }
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined
}

function boundedText(value: unknown): string {
  if (typeof value !== "string") return ""
  const text = value.trim()
  return countCodePoints(text) > MAX_AUDIT_TEXT_CHARS
    ? sliceHeadCodePoints(text, MAX_AUDIT_TEXT_CHARS)
    : text
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
  return Math.max(1, Math.floor(value))
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

function nonNegativeFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
}

function nonNegativeInteger(value: unknown): number {
  return Math.floor(nonNegativeFinite(value))
}

function chmodBestEffort(path: string, mode: number): void {
  if (IS_WINDOWS) return
  try { chmodSync(path, mode) } catch {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
