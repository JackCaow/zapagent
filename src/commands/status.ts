/**
 * /status — single-screen snapshot of the current session.
 *
 * Aims to mirror Claude Code / Codex's `/status` panels: one glance tells
 * you which provider/model/effort is active, where the session lives on
 * disk, how much context headroom is left, and which MCP servers are
 * online. Only renders fields zap actually has data for — provider
 * accounts / collaboration mode / per-tier rate limits don't apply to
 * zap's bring-your-own-key model.
 */

import { existsSync, realpathSync, statSync } from "node:fs"
import { dirname, join, parse, relative } from "node:path"
import { homedir } from "node:os"
import { computeCacheUsageStats } from "../../zapsdk/agent/cache-metrics.js"
import type { ContextDiagnostics, ContextSegmentDiagnostics } from "../../zapsdk/agent/events.js"
import type { ToolSchemaDiagnostics } from "../agent/toolDiagnostics.js"
import type { PromptCacheDiagnostics } from "../agent/promptDiagnostics.js"
import type { CacheMemoryAuditEntry } from "../agent/cacheMemoryAudit.js"
import {
  makePromptCacheScope,
  samePromptCacheScope,
  type PromptCacheScope,
} from "../agent/cacheScope.js"
import {
  getActiveProvider,
  getEffort,
  getProviderDisplayName,
  hasApiKey,
  type AppConfig,
} from "../config.js"
import { getCurrentSessionId } from "../session.js"
import { autoMemory, getMCPManager, globalMemoryDir } from "../singletons.js"
import { countCodePoints, sliceHeadCodePoints } from "../utils/logicalLines.js"
import {
  buildContextBudgetSnapshot,
  legacyContextUsage,
  type ContextBudgetSnapshot,
} from "../context-budget.js"

// Read once at module load — package.json doesn't change at runtime, and
// bun's importer handles JSON imports cleanly.
import pkg from "../../package.json" with { type: "json" }
const APP_VERSION = (pkg as { version?: string }).version ?? "?"

const BAR_WIDTH = 16
const STATUS_HISTORY_SAMPLE_LIMIT = 12

/** Render a left-to-right bar that fills with the REMAINING share — i.e.
 *  100% left = full block, 0% left = empty. Matches the convention used
 *  by both Codex's `/status` and Claude Code's TokenWarning. */
function bar(percentLeft: number, width = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(100, percentLeft))
  const filled = Math.round((clamped / 100) * width)
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]"
}

function nonNegativeFinite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0
}

function formatTokens(n: number): string {
  const safe = nonNegativeFinite(n)
  if (safe < 1000) return `${safe}`
  if (safe < 1_000_000) return `${(safe / 1000).toFixed(1)}K`
  return `${(safe / 1_000_000).toFixed(2)}M`
}

export interface StatusUsageDetail {
  inputTokens?: number
  outputTokens?: number
  providerUsageReported?: boolean
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  cacheScope?: PromptCacheScope
  promptCacheDiagnostics?: PromptCacheDiagnostics
}

export type StatusContextDiagnostics = ContextDiagnostics

export interface StatusDiagnostics {
  memoryAttachmentFailure?: {
    stage: "index" | "working_pack"
    memoryDir?: string
    queryPresent?: boolean
    error?: string
  }
  memoryFailure?: {
    operation?: "instructions" | "compact_summary"
    error?: string
  }
  promptSectionFailure?: {
    section?: string
    dynamic?: boolean
    error?: string
  }
  compactFailure?: {
    phase?: "pre_turn" | "in_loop" | "manual"
    error?: string
    consecutiveFailures?: number
    breakerTripped?: boolean
  }
  usagePersistenceFailure?: {
    error?: string
  }
  sessionPersistence?: {
    pendingWrites?: number
    lastFailure?: {
      operation?: string
      message?: string
      path?: string
      pendingEntries?: number
    }
  }
  toolSchema?: ToolSchemaDiagnostics
  promptCache?: PromptCacheDiagnostics
  cacheMemoryAudit?: {
    path: string
    entries: CacheMemoryAuditEntry[]
  }
}

/** Surface the AGENTS.md file that the system prompt actually loads.
 *  The prompt section resolves AGENTS.md from the git root when available,
 *  so /status must do the same; otherwise a session started from a subdir
 *  misleadingly reports "(none detected)" while project rules are active. */
function detectAgentsDoc(cwd: string): string | null {
  const root = resolveProjectRoot(cwd)
  const path = join(root, "AGENTS.md")
  if (!existsSync(path)) return null
  return root === cwd ? "AGENTS.md" : shortRelativePath(cwd, path)
}

function resolveProjectRoot(cwd: string): string {
  let current = cwd
  const { root } = parse(cwd)
  for (;;) {
    if (hasGitMarker(current)) return current
    if (current === root) return cwd
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

function hasGitMarker(path: string): boolean {
  try {
    const stat = statSync(join(path, ".git"))
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}

function shortRelativePath(cwd: string, path: string): string {
  const from = realPathBestEffort(cwd)
  const to = realPathBestEffort(path)
  const r = relative(from, to)
  if (!r) return "AGENTS.md"
  return r.startsWith(".") ? r : `./${r}`
}

function realPathBestEffort(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Collapse an absolute path to `~/...` form when under the home dir. */
function shortPath(p: string): string {
  const home = homedir()
  if (p === home) return "~"
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length)
  return p
}

export function buildStatusText(
  config: AppConfig,
  cwd: string,
  tokenUsage: number,
  usage?: StatusUsageDetail,
  context?: StatusContextDiagnostics,
  contextHistory: StatusContextDiagnostics[] = [],
  usageHistory: StatusUsageDetail[] = [],
  diagnostics: StatusDiagnostics = {},
  contextPending = false,
  suppliedContextBudget?: ContextBudgetSnapshot,
): string {
  const provider = getActiveProvider(config)
  const providerLabel = provider ? getProviderDisplayName(config) : "(none)"
  const model = config.active.model || "(no model selected)"
  const effort = provider ? getEffort(config, provider.id) : null
  const contextBudget = suppliedContextBudget ?? buildContextBudgetSnapshot(
    config,
    legacyContextUsage(tokenUsage, contextPending),
  )
  const ctxWindow = contextBudget.limits.contextWindow
  // App supplies the shared context snapshot. The legacy numeric argument is
  // retained for non-UI callers and tests that have not migrated yet.
  const usedTokens = nonNegativeFinite(contextBudget.usage.currentPromptTokens ?? 0)
  const percentLeft = ctxWindow > 0
    ? Math.max(0, Math.round(((ctxWindow - usedTokens) / ctxWindow) * 100))
    : 0
  const agentsDoc = detectAgentsDoc(cwd)
  const sessionId = getCurrentSessionId()
  const keyStatus = hasApiKey(config) ? "configured" : "missing — run /connect"

  const mgr = getMCPManager()
  const mcpSummary = mgr ? summariseMCP(mgr.snapshots()) : "(unavailable)"
  const effectiveContextHistory = appendCurrentContextHistory(contextHistory, context)
  const currentCacheScope = makePromptCacheScope(config.active.providerId, config.active.model)
  const unscopedUsageHistory = appendCurrentUsageHistory(usageHistory, usage)
  const effectiveUsageHistory = selectUsageForCacheScope(unscopedUsageHistory, currentCacheScope)
  const scopedUsage = usage && usageMatchesCacheScope(usage, currentCacheScope) ? usage : undefined
  const cacheScopeMismatch = !!usage?.cacheScope &&
    !samePromptCacheScope(usage.cacheScope, currentCacheScope)

  const lines: string[] = []
  lines.push(`⚡ zapAgent v${APP_VERSION}`)
  lines.push("")
  lines.push(`Provider:        ${providerLabel}`)
  lines.push(`Model:           ${model}`)
  lines.push(`Effort:          ${effort ?? "(default)"}`)
  lines.push(`Directory:       ${shortPath(cwd)}`)
  lines.push(`Permissions:     ${config.permissionMode}`)
  lines.push(`AGENTS.md:       ${agentsDoc ?? "(none detected)"}`)
  lines.push(`Session:         ${sessionId}`)
  lines.push(`API key:         ${keyStatus}`)
  lines.push("")
  if (ctxWindow > 0) {
    if (contextPending) {
      lines.push(
        `Context window:  pending (? / ${formatTokens(ctxWindow)}; ` +
          `local estimate ${formatTokens(usedTokens)})`,
      )
    } else {
      lines.push(
        `Context window:  ${bar(percentLeft)} ${percentLeft}% left ` +
          `(${formatTokens(usedTokens)} / ${formatTokens(ctxWindow)})`,
      )
    }
  } else {
    lines.push(contextPending
      ? `Context window:  pending (provider doesn't report a window size; local estimate ${formatTokens(usedTokens)})`
      : `Context window:  (provider doesn't report a window size)`)
  }
  const currentPrefix = contextBudget.usage.approximate ? "~" : ""
  lines.push(`Current prompt:  ${currentPrefix}${formatTokens(usedTokens)}`)
  if (contextBudget.usage.lastMeasuredPromptTokens !== null) {
    lines.push(`Last API prompt: ${formatTokens(contextBudget.usage.lastMeasuredPromptTokens)}`)
  }
  lines.push(`Effective input: ${formatTokens(contextBudget.limits.effectiveInputLimit)}`)
  lines.push(`Auto-compact at: ${formatTokens(contextBudget.limits.compactAt)}`)
  if (contextBudget.remaining.untilCompact !== null) {
    lines.push(`Until compact:   ${formatTokens(contextBudget.remaining.untilCompact)}`)
  }
  lines.push(`Usage source:    ${contextBudget.usage.source}`)
  lines.push(`Limit source:    ${contextBudget.limits.source}`)
  if (cacheScopeMismatch) {
    lines.push("Prompt cache:    no sample for current provider/model; run a turn after switching")
  }
  if (scopedUsage) {
    if (scopedUsage.providerUsageReported === false) {
      lines.push("Prompt cache:    usage not reported by provider")
    }
    const cacheReported = hasUsableCacheAccounting(scopedUsage)
    const cacheAccountingCoverage = summarizeCacheAccountingCoverage(effectiveUsageHistory)
    const cache = computeCacheUsageStats({
      inputTokens: scopedUsage.inputTokens ?? 0,
      cacheReadInputTokens: scopedUsage.cacheReadInputTokens,
      cacheCreationInputTokens: scopedUsage.cacheCreationInputTokens,
    })
    const fresh = cache.freshInputTokens
    if (scopedUsage.providerUsageReported === false) {
      // Nothing else to render: token fields are adapter placeholders, not API truth.
    } else if (cacheReported) {
      const cacheRead = cache.cacheReadInputTokens
      const cacheWrite = cache.cacheCreationInputTokens
      const reuseHit = formatPercent(cache.cacheReuseRatio)
      const effectiveHit = formatPercent(cache.cacheHitRatio)
      const writeRatio = formatPercent(cache.cacheWriteRatio)
      lines.push(
        `Prompt cache:    ${reuseHit} reuse hit ` +
          `(${effectiveHit} effective, ${writeRatio} write; fresh ${formatTokens(fresh)}, read ${formatTokens(cacheRead)}, write ${formatTokens(cacheWrite)})`,
      )
      if (
        cacheAccountingCoverage &&
        cacheAccountingCoverage.reported < cacheAccountingCoverage.total
      ) {
        lines.push(
          `Cache reports:   ${cacheAccountingCoverage.reported}/${cacheAccountingCoverage.total} recent calls exposed cache accounting`,
        )
      }
      lines.push(`Cache diagnosis: ${diagnosePromptCache(cache)}`)
      const trend = summarizePromptCacheTrend(effectiveUsageHistory)
      if (trend) lines.push(`Cache trend:     ${trend}`)
      const cause = summarizeCacheCause(
        cache,
        effectiveContextHistory,
        diagnostics.toolSchema,
        diagnostics.promptCache,
        effectiveUsageHistory,
      )
      if (cause) lines.push(`Cache cause:     ${cause}`)
    } else {
      const coverage = formatMissingCacheAccountingCoverage(cacheAccountingCoverage)
      lines.push(
        `Prompt cache:    provider endpoint did not report cache accounting${coverage} ` +
          `(fresh ${formatTokens(fresh)})`,
      )
      lines.push(
        "Cache diagnosis: cache accounting unavailable; cannot verify hit rate from provider usage. " +
          "Check model/provider prompt-cache support, endpoint settings, or whether cache reporting is disabled",
      )
      const shapeDiagnosis = diagnoseUnaccountedCacheShape(
        diagnostics.cacheMemoryAudit,
        currentCacheScope,
      )
      if (shapeDiagnosis) lines.push(`Cache shape:     ${shapeDiagnosis}`)
    }
    if (scopedUsage.providerUsageReported !== false && typeof scopedUsage.outputTokens === "number") {
      lines.push(`Output tokens:   ${formatTokens(nonNegativeFinite(scopedUsage.outputTokens))}`)
    }
  }
  const hasTransientContext = !!context && (
    context.totalChars > 0 || context.estimatedTokens > 0 || context.segments.length > 0
  )
  if (context && hasTransientContext) {
    lines.push(
      `Context attach:  ${formatTokens(context.estimatedTokens)} tokens · ` +
        `${formatTokens(context.totalChars)} chars · hash ${context.hash}`,
    )
    for (const segment of context.segments.slice(0, 4)) {
      lines.push(
        `  ${segment.name}: ${formatTokens(segment.estimatedTokens)} tok · ` +
          `${formatTokens(segment.chars)} chars · ${segment.hash}${formatSegmentMeta(segment.meta)}`,
      )
    }
    if (context.segments.length > 4) {
      lines.push(`  ... ${context.segments.length - 4} more context segments`)
    }
  }
  const churn = hasTransientContext ? summarizeContextChurn(effectiveContextHistory) : null
  if (churn) lines.push(`Context churn:   ${churn}`)
  if (context?.conversationCache) {
    lines.push(formatConversationCacheDiagnostics(context.conversationCache))
    const prefixTrend = summarizeConversationPrefixTrend(effectiveContextHistory)
    if (prefixTrend) lines.push(`Prefix trend:    ${prefixTrend}`)
  }
  if (diagnostics.promptCache) {
    lines.push(formatPromptCacheDiagnostics(diagnostics.promptCache))
  }
  const effectiveToolSchema = diagnostics.promptCache?.toolSchemas ?? diagnostics.toolSchema
  if (effectiveToolSchema) {
    lines.push(formatToolSchemaDiagnostics(effectiveToolSchema))
  }
  if (diagnostics.memoryAttachmentFailure) {
    lines.push(`Memory attach:   ${formatMemoryAttachmentFailure(diagnostics.memoryAttachmentFailure)}`)
  }
  if (diagnostics.memoryFailure) {
    lines.push(`Memory:          ${formatMemoryFailure(diagnostics.memoryFailure)}`)
  }
  if (diagnostics.promptSectionFailure) {
    lines.push(`Prompt section:  ${formatPromptSectionFailure(diagnostics.promptSectionFailure)}`)
  }
  if (diagnostics.compactFailure) {
    lines.push(`Compact:         ${formatCompactFailure(diagnostics.compactFailure)}`)
  }
  if (diagnostics.usagePersistenceFailure) {
    lines.push(`Usage history:   ${formatUsagePersistenceFailure(diagnostics.usagePersistenceFailure)}`)
  }
  if (diagnostics.sessionPersistence) {
    const line = formatSessionPersistence(diagnostics.sessionPersistence)
    if (line) lines.push(`Persistence:     ${line}`)
  }
  if (diagnostics.cacheMemoryAudit) {
    lines.push(`Cache audit:     ${formatCacheMemoryAudit(diagnostics.cacheMemoryAudit, currentCacheScope)}`)
    const memoryUtility = formatMemoryUtilityAudit(diagnostics.cacheMemoryAudit, currentCacheScope)
    if (memoryUtility) lines.push(`Memory utility:  ${memoryUtility}`)
  }
  lines.push(`Auto-compact:    ${config.compaction.auto ? "on" : "off"}`)
  lines.push(`Prune:           ${config.compaction.prune ? "on · pressure-gated old outputs" : "off"} (overflow recovery is independent)`)
  const latestMaintenance = diagnostics.cacheMemoryAudit?.entries.slice().reverse().find(entry =>
    !currentCacheScope || samePromptCacheScope(entry.cacheScope, currentCacheScope))
  if (latestMaintenance?.compaction.pruneSucceeded) {
    lines.push(`Last prune:      ${latestMaintenance.compaction.prunedMessages ?? 0} outputs · ~${formatTokens(latestMaintenance.compaction.prunedTokens ?? 0)} tokens removed locally`)
  }
  if (latestMaintenance?.requestCache) {
    const shape = latestMaintenance.requestCache
    lines.push(`Wire prefix:     ${shape.change}${shape.reason ? ` (${shape.reason})` : ""} · ${shape.commonPrefixMessages} shared messages${shape.sampled ? " · sampled" : ""}; provider hit rate is separate`)
  }
  lines.push(`Memory dir:      ${shortPath(autoMemory.memoryDir)}`)
  lines.push(`Global memory:   ${shortPath(globalMemoryDir)}`)
  lines.push("")
  lines.push(`MCP servers:     ${mcpSummary}`)
  return lines.join("\n")
}

function appendCurrentContextHistory(
  history: StatusContextDiagnostics[],
  current: StatusContextDiagnostics | undefined,
): StatusContextDiagnostics[] {
  if (!current) return history
  const latest = history.at(-1)
  if (latest && contextDiagnosticsKey(latest) === contextDiagnosticsKey(current)) return history
  return [...history, current].slice(-STATUS_HISTORY_SAMPLE_LIMIT)
}

function contextDiagnosticsKey(context: StatusContextDiagnostics): string {
  return [
    context.hash,
    context.estimatedTokens,
    ...context.segments.map(contextSegmentDiagnosticsKey),
    context.conversationCache?.prefix.hash ?? "",
    context.conversationCache?.tail.hash ?? "",
  ].join(":")
}

function contextSegmentDiagnosticsKey(segment: ContextSegmentDiagnostics): string {
  return [
    segment.name,
    segment.hash,
    segment.estimatedTokens,
    segment.meta ? stableDiagnosticJson(segment.meta) : "",
  ].join(":")
}

function stableDiagnosticJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableDiagnosticJson).join(",")}]`
  const record = value as Record<string, unknown>
  return "{" + Object.keys(record)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${JSON.stringify(key)}:${stableDiagnosticJson(record[key])}`)
    .join(",") + "}"
}

function appendCurrentUsageHistory(
  history: StatusUsageDetail[],
  current: StatusUsageDetail | undefined,
): StatusUsageDetail[] {
  if (!current) return history
  const latest = history.at(-1)
  if (latest && statusUsageKey(latest) === statusUsageKey(current)) return history
  return [...history, current].slice(-STATUS_HISTORY_SAMPLE_LIMIT)
}

function statusUsageKey(usage: StatusUsageDetail): string {
  return [
    usage.inputTokens ?? "",
    usage.outputTokens ?? "",
    typeof usage.providerUsageReported === "boolean" ? usage.providerUsageReported : "",
    usage.cacheReadInputTokens ?? "",
    usage.cacheCreationInputTokens ?? "",
    usage.cacheScope ? `${usage.cacheScope.providerId}\0${usage.cacheScope.model}` : "",
    usage.promptCacheDiagnostics ? promptCacheDiagnosticsKey(usage.promptCacheDiagnostics) : "",
  ].join(":")
}

function selectUsageForCacheScope(
  history: StatusUsageDetail[],
  currentScope: PromptCacheScope | undefined,
): StatusUsageDetail[] {
  if (!currentScope) return history.filter((usage) => !usage.cacheScope)
  const matching = history.filter((usage) => samePromptCacheScope(usage.cacheScope, currentScope))
  if (matching.length > 0) return matching
  return history.filter((usage) => !usage.cacheScope)
}

function usageMatchesCacheScope(
  usage: StatusUsageDetail,
  currentScope: PromptCacheScope | undefined,
): boolean {
  return !usage.cacheScope || samePromptCacheScope(usage.cacheScope, currentScope)
}

function formatMemoryAttachmentFailure(failure: NonNullable<StatusDiagnostics["memoryAttachmentFailure"]>): string {
  const stage = failure.stage === "working_pack" ? "working pack" : "index"
  const query = failure.queryPresent ? " for current query" : ""
  const error = oneLine(failure.error ?? "unknown error")
  return `failed building ${stage}${query}: ${truncate(error, 120)}`
}

function formatMemoryFailure(failure: NonNullable<StatusDiagnostics["memoryFailure"]>): string {
  const operation = failure.operation === "compact_summary"
    ? "compact summary persistence"
    : "instructions"
  const error = oneLine(failure.error ?? "unknown error")
  return `${operation} failed: ${truncate(error, 120)}`
}

function formatPromptSectionFailure(failure: NonNullable<StatusDiagnostics["promptSectionFailure"]>): string {
  const section = oneLine(failure.section ?? "(unknown)")
  const scope = failure.dynamic ? "dynamic" : "static"
  const error = oneLine(failure.error ?? "unknown error")
  return `${scope} section ${section} failed: ${truncate(error, 120)}`
}

function formatCompactFailure(failure: NonNullable<StatusDiagnostics["compactFailure"]>): string {
  const phase =
    failure.phase === "in_loop" ? "in-loop auto-compact"
    : failure.phase === "manual" ? "manual /compact"
    : "pre-turn auto-compact"
  const attempts = typeof failure.consecutiveFailures === "number" && failure.consecutiveFailures > 0
    ? ` after ${Math.floor(failure.consecutiveFailures)} failed attempt${Math.floor(failure.consecutiveFailures) === 1 ? "" : "s"}`
    : ""
  const breaker = failure.breakerTripped ? "; circuit breaker tripped" : ""
  const error = oneLine(failure.error ?? "unknown error")
  return `${phase} failed${attempts}${breaker}: ${truncate(error, 120)}`
}

function formatUsagePersistenceFailure(failure: NonNullable<StatusDiagnostics["usagePersistenceFailure"]>): string {
  const error = oneLine(failure.error ?? "unknown error")
  return `failed saving latest token/cache usage: ${truncate(error, 120)}`
}

function formatCacheMemoryAudit(
  audit: NonNullable<StatusDiagnostics["cacheMemoryAudit"]>,
  currentScope: PromptCacheScope | undefined,
): string {
  const scoped = currentScope
    ? audit.entries.filter((entry) => samePromptCacheScope(entry.cacheScope, currentScope))
    : audit.entries.filter((entry) => !entry.cacheScope)
  if (scoped.length === 0) {
    return `no runs for current provider/model · ${shortPath(audit.path)}`
  }
  const accounted = scoped.filter((entry) =>
    entry.usage.providerUsageReported !== false &&
    (typeof entry.usage.cacheReadInputTokens === "number" ||
      typeof entry.usage.cacheCreationInputTokens === "number"),
  )
  const promptShapes = new Set(scoped.flatMap((entry) => {
    const prompt = entry.promptCacheDiagnostics
    if (!prompt) return []
    return [`${prompt.staticPrefix.hash}:${prompt.toolSchemas?.hash ?? ""}`]
  })).size
  const contextShapes = new Set(scoped.flatMap((entry) =>
    entry.contextDiagnostics ? [entry.contextDiagnostics.hash] : [],
  )).size
  const telemetryEntries = scoped.filter((entry) => entry.telemetry)
  const usageSamples = telemetryEntries.reduce(
    (sum, entry) => sum + (entry.telemetry?.usageSamples ?? 0),
    0,
  )
  const cacheAccountingSamples = telemetryEntries.reduce(
    (sum, entry) => sum + (entry.telemetry?.cacheAccountingSamples ?? 0),
    0,
  )
  const contextSamples = telemetryEntries.reduce(
    (sum, entry) => sum + (entry.telemetry?.contextSamples ?? 0),
    0,
  )
  const maxContextShapes = telemetryEntries.reduce(
    (max, entry) => Math.max(max, entry.telemetry?.contextShapes ?? 0),
    0,
  )
  const maxConversationPrefixShapes = telemetryEntries.reduce(
    (max, entry) => Math.max(max, entry.telemetry?.conversationPrefixShapes ?? 0),
    0,
  )
  const coverageText = usageSamples > 0
    ? ` · cache reports ${cacheAccountingSamples}/${usageSamples} usage samples`
    : ""
  const inRunShapeText = contextSamples > 0
    ? ` · max in-run shapes context ${maxContextShapes}, prefix ${maxConversationPrefixShapes}`
    : ""
  const shapeText = `prompt shapes ${promptShapes} · context shapes ${contextShapes}${inRunShapeText}`
  if (accounted.length === 0) {
    return `${scoped.length} runs · cache accounting unavailable${coverageText} · ${shapeText} · ${shortPath(audit.path)}`
  }
  const reusablePrompt = accounted.reduce(
    (sum, entry) => sum + entry.usage.inputTokens + (entry.usage.cacheReadInputTokens ?? 0),
    0,
  )
  const cacheRead = accounted.reduce((sum, entry) => sum + (entry.usage.cacheReadInputTokens ?? 0), 0)
  const reuse = reusablePrompt > 0 ? cacheRead / reusablePrompt : 0
  return `${scoped.length} runs · reuse ${formatPercent(reuse)}${coverageText} · ${shapeText} · ${shortPath(audit.path)}`
}

function formatMemoryUtilityAudit(
  audit: NonNullable<StatusDiagnostics["cacheMemoryAudit"]>,
  currentScope: PromptCacheScope | undefined,
): string | null {
  const scoped = currentScope
    ? audit.entries.filter((entry) => samePromptCacheScope(entry.cacheScope, currentScope))
    : audit.entries.filter((entry) => !entry.cacheScope)
  const instrumented = scoped.filter((entry) => entry.memoryUtility)
  if (instrumented.length === 0) return null
  const selectedRuns = instrumented.filter((entry) => (entry.memoryUtility?.selected ?? 0) > 0).length
  const selected = sumMemoryUtility(instrumented, "selected")
  if (selected === 0) {
    return `${instrumented.length} instrumented runs · no working-pack memories selected`
  }
  const used = sumMemoryUtility(instrumented, "used")
  const read = sumMemoryUtility(instrumented, "read")
  const avoided = sumMemoryUtility(instrumented, "avoidedReRead")
  const revised = sumMemoryUtility(instrumented, "revised")
  const contradicted = sumMemoryUtility(instrumented, "contradicted")
  return `${instrumented.length} instrumented runs · selected ${selected} across ${selectedRuns} runs · ` +
    `used ${used}/${selected} (${formatPercent(used / selected)}) · explicit reads ${read} · ` +
    `avoided re-reads ${avoided} · revised ${revised} · contradicted ${contradicted}`
}

function sumMemoryUtility(
  entries: readonly CacheMemoryAuditEntry[],
  key: "selected" | "read" | "used" | "revised" | "contradicted" | "avoidedReRead",
): number {
  return entries.reduce((sum, entry) => sum + (entry.memoryUtility?.[key] ?? 0), 0)
}

function diagnoseUnaccountedCacheShape(
  audit: StatusDiagnostics["cacheMemoryAudit"],
  currentScope: PromptCacheScope | undefined,
): string | null {
  if (!audit || !currentScope) return null
  const diagnosed = audit.entries.filter((entry) =>
    samePromptCacheScope(entry.cacheScope, currentScope) &&
    entry.promptCacheDiagnostics,
  )
  if (diagnosed.length < 2) return null

  const cacheableShapes = new Set(diagnosed.map((entry) => {
    const prompt = entry.promptCacheDiagnostics!
    return `${prompt.staticPrefix.hash}:${prompt.toolSchemas?.hash ?? ""}`
  }))
  if (cacheableShapes.size === 1) {
    return `static prompt/tool shape stable across ${diagnosed.length} audited runs; ` +
      "provider endpoint cache support/accounting remains the unverified layer"
  }
  return `${cacheableShapes.size} static prompt/tool shapes across ${diagnosed.length} audited runs; ` +
    "app-side prompt or tool-schema churn can reduce reuse"
}

function formatSessionPersistence(status: NonNullable<StatusDiagnostics["sessionPersistence"]>): string | null {
  const pending = nonNegativeFinite(status.pendingWrites)
  const failure = status.lastFailure
  if (!failure && pending === 0) return null

  const pendingText = pending > 0
    ? `${Math.floor(pending)} pending session write${Math.floor(pending) === 1 ? "" : "s"}`
    : "no pending writes"
  if (!failure) return pendingText

  const operation = oneLine(failure.operation ?? "unknown")
  const message = oneLine(failure.message ?? "unknown error")
  const path = failure.path ? ` at ${shortPath(failure.path)}` : ""
  const failurePending = typeof failure.pendingEntries === "number"
    ? `; ${Math.floor(nonNegativeFinite(failure.pendingEntries))} entries buffered at failure`
    : ""
  return `${pendingText}; ${operation} failed${path}: ${truncate(message, 100)}${failurePending}`
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function truncate(value: string, maxChars: number): string {
  if (countCodePoints(value) <= maxChars) return value
  return `${sliceHeadCodePoints(value, Math.max(0, maxChars - 1))}…`
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`
}

function diagnosePromptCache(cache: ReturnType<typeof computeCacheUsageStats>): string {
  const reuse = cache.cacheReuseRatio
  const write = cache.cacheWriteRatio
  if (reuse === null) {
    return "cache data incomplete"
  }
  if (write !== null && write >= 0.25) {
    return "warming or prompt churn; high cache-write share means the provider is creating new cache blocks"
  }
  if (reuse >= 0.9) {
    return "healthy; reusable prompt prefix is hitting cache"
  }
  if (reuse >= 0.6) {
    return "partial; some prefix is stable but dynamic context or tool/schema changes may be fragmenting it"
  }
  return "low; stable prefix is not being reused, inspect dynamic system prompt, memory/todo attachments, and tool definitions"
}

function summarizeCacheCause(
  cache: ReturnType<typeof computeCacheUsageStats>,
  contextHistory: StatusContextDiagnostics[],
  toolSchema?: ToolSchemaDiagnostics,
  promptCache?: PromptCacheDiagnostics,
  usageHistory: StatusUsageDetail[] = [],
): string | null {
  const reuse = cache.cacheReuseRatio
  if (reuse === null || reuse >= 0.9) return null

  const effectiveToolSchema = promptCache?.toolSchemas ?? toolSchema
  const write = cache.cacheWriteRatio
  const boundaryCause = promptCacheBoundaryCause(promptCache)
  const boundaryHint = boundaryCause ? `; ${boundaryCause}` : ""
  const promptChurn = summarizePromptShapeCause(usageHistory, promptCache)
  const conversationChurn = summarizeConversationPrefixCause(contextHistory)
  if (conversationChurn) {
    const promptHint = promptChurn ? `; ${promptChurn}` : ""
    return `${conversationChurn}${promptHint}${boundaryHint}`
  }
  const recent = contextHistory.filter(Boolean).slice(-2)
  let metadataOnlyContextHint = ""
  const contextChange = latestContextTextChange(contextHistory)
  if (contextChange) {
    const { latest, textChangedSegments, metadataOnlySegments, samplesAgo } = contextChange
    metadataOnlyContextHint = summarizeMetadataOnlyContextHint(metadataOnlySegments)
    const changed = textChangedSegments.map(formatChangedContextSegment)
    if (changed.length > 0) {
      const contextHint = summarizeContextChangeHint(textChangedSegments)
      const writeHint = write !== null && write >= 0.25
        ? "; high cache writes indicate new cache blocks are being created"
        : ""
      const promptHint = promptChurn ? `; ${promptChurn}` : ""
      const hint = contextHint ? `; ${contextHint}` : ""
      const shareHint = summarizeCacheablePrefixShareHint(promptCache, latest, effectiveToolSchema, cache)
      const recencyHint = samplesAgo > 0
        ? `; latest context is stable, but this changed ${samplesAgo} ${samplesAgo === 1 ? "sample" : "samples"} ago`
        : ""
      return `recent transient context changed: ${changed.slice(0, 4).join(", ")}${changed.length > 4 ? ", ..." : ""}${hint}${metadataOnlyContextHint}${recencyHint}${shareHint}${writeHint}${promptHint}${boundaryHint}`
    }
  } else if (recent.length >= 2) {
    const changedSegments = changedContextSegments(recent[0], recent[1])
    const metadataOnlySegments = changedSegments.filter((segment) => !hasContextTextChange(segment))
    metadataOnlyContextHint = summarizeMetadataOnlyContextHint(metadataOnlySegments)
  }

  if (promptChurn) return `${promptChurn}${metadataOnlyContextHint}${boundaryHint}`
  if (boundaryCause) return `${boundaryCause}${metadataOnlyContextHint}`

  if (write !== null && write >= 0.25) {
    return `high cache writes; cache may still be warming or prompt bytes are creating new cache blocks${metadataOnlyContextHint}${boundaryHint}`
  }

  const latest = contextHistory.filter(Boolean).slice(-1)[0]
  if (latest && latest.estimatedTokens > 0) {
    if (recent.length >= 2 && recent[0]?.hash === recent[1]?.hash) {
      const toolHint = effectiveToolSchema ? ` (tool schema hash ${effectiveToolSchema.hash})` : ""
      const promptHint = promptCache
        ? ` (prompt static hash ${promptCache.staticPrefix.hash}` +
          (promptCache.dynamicSuffix ? `, dynamic hash ${promptCache.dynamicSuffix.hash}` : "") +
          ")"
        : ""
      const shareHint = summarizeCacheablePrefixShareHint(promptCache, latest, effectiveToolSchema, cache)
      return `transient context text stable at ${formatTokens(latest.estimatedTokens)} tokens${metadataOnlyContextHint}${shareHint}; inspect cacheable system prompt${promptHint}, tool definitions${toolHint}, provider cache settings, or model support${boundaryHint}`
    }
    const shareHint = summarizeCacheablePrefixShareHint(promptCache, latest, effectiveToolSchema, cache)
    return `transient context is ${formatTokens(latest.estimatedTokens)} tokens; appended memory/todo context can lower total cache share${metadataOnlyContextHint}${shareHint}${boundaryHint}`
  }

  const promptHint = promptCache ? ` (prompt static hash ${promptCache.staticPrefix.hash})` : ""
  return `no transient context churn recorded; inspect system prompt${promptHint}, tool definitions, provider cache settings, or model support${metadataOnlyContextHint}${boundaryHint}`
}

function latestContextTextChange(
  contextHistory: StatusContextDiagnostics[],
): {
  latest: StatusContextDiagnostics
  textChangedSegments: ChangedContextSegment[]
  metadataOnlySegments: ChangedContextSegment[]
  samplesAgo: number
} | null {
  const recent = contextHistory.filter(Boolean).slice(-STATUS_HISTORY_SAMPLE_LIMIT)
  for (let i = recent.length - 1; i > 0; i--) {
    const changedSegments = changedContextSegments(recent[i - 1], recent[i])
    const textChangedSegments = changedSegments.filter(hasContextTextChange)
    if (textChangedSegments.length === 0) continue
    return {
      latest: recent[i],
      textChangedSegments,
      metadataOnlySegments: changedSegments.filter((segment) => !hasContextTextChange(segment)),
      samplesAgo: recent.length - 1 - i,
    }
  }
  return null
}

function summarizeCacheablePrefixShareHint(
  promptCache: PromptCacheDiagnostics | undefined,
  context: StatusContextDiagnostics | undefined,
  toolSchema?: ToolSchemaDiagnostics,
  cache?: ReturnType<typeof computeCacheUsageStats>,
): string {
  if (!promptCache || !context) return ""
  const staticTokens = nonNegativeFinite(promptCache.staticPrefix.estimatedTokens)
  const runtimeEnvironmentAlreadyInContext = context.segments.some(
    (segment) => segment.name === "runtime_environment",
  )
  const dynamicTokens = runtimeEnvironmentAlreadyInContext
    ? 0
    : nonNegativeFinite(promptCache.dynamicSuffix?.estimatedTokens)
  const toolTokens = nonNegativeFinite((promptCache.toolSchemas ?? toolSchema)?.estimatedTokens)
  const conversationPrefixTokens = nonNegativeFinite(
    context.conversationCache?.prefix.estimatedTokens,
  )
  const conversationTailTokens = nonNegativeFinite(
    context.conversationCache?.tail.estimatedTokens,
  )
  const contextTokens = nonNegativeFinite(context.estimatedTokens)
  const cacheableTokens = staticTokens + toolTokens + conversationPrefixTokens
  const dynamicContextTokens = dynamicTokens + contextTokens + conversationTailTokens
  const knownPromptTokens = cacheableTokens + dynamicContextTokens
  if (cacheableTokens <= 0 || knownPromptTokens <= 0) return ""
  const providerReusablePromptTokens = cache
    ? cache.freshInputTokens + cache.cacheReadInputTokens
    : 0
  const unaccountedReusableTokens = providerReusablePromptTokens > knownPromptTokens
    ? providerReusablePromptTokens - knownPromptTokens
    : 0
  const hasUnaccountedPromptTail = isSignificantUnaccountedPromptTail(
    unaccountedReusableTokens,
    providerReusablePromptTokens,
  )
  const denominatorTokens = hasUnaccountedPromptTail
    ? providerReusablePromptTokens
    : knownPromptTokens
  if (denominatorTokens <= 0) return ""
  const share = cacheableTokens / denominatorTokens
  if (share >= 0.9) return ""
  const cacheableParts = [
    `static ${formatTokens(staticTokens)}`,
    ...(toolTokens > 0 ? [`tools ${formatTokens(toolTokens)}`] : []),
    ...(conversationPrefixTokens > 0
      ? [`conversation ${formatTokens(conversationPrefixTokens)}`]
      : []),
  ]
  const label = conversationPrefixTokens > 0
    ? "cacheable static+tool+conversation prefix"
    : toolTokens > 0 ? "cacheable static+tool prefix" : "cacheable static prefix"
  const cacheablePart = cacheableParts.join(" + ")
  const denominatorLabel = hasUnaccountedPromptTail
    ? "provider-observed reusable prompt tokens"
    : "known prompt/context tokens"
  const unaccountedPart = hasUnaccountedPromptTail
    ? `; unaccounted provider tail ${formatTokens(unaccountedReusableTokens)}`
    : ""
  const capSubject = hasUnaccountedPromptTail
    ? "non-cacheable dynamic memory/todo context plus current user/conversation tail"
    : "non-cacheable dynamic memory/todo context"
  const unaccountedHint = hasUnaccountedPromptTail
    ? `; provider reported ${formatTokens(unaccountedReusableTokens)} additional prompt tokens outside ` +
      `static/tools/conversation/dynamic context diagnostics, ` +
      (context.conversationCache
        ? "likely provider-only serialization or token-estimation drift"
        : "likely current user input or uncached conversation tail")
    : ""
  const observedReuse = cache?.cacheReuseRatio
  const observedShareLabel = hasUnaccountedPromptTail
    ? "estimated cacheable share"
    : "known cacheable share"
  const observedGap = observedReuse !== null &&
    observedReuse !== undefined &&
    observedReuse + 0.05 < share
    ? `; observed reuse ${formatPercent(observedReuse)} is below that ${observedShareLabel}, so dynamic context alone does not explain the miss`
    : ""
  return `; ${label} is about ${formatPercent(share)} of ${denominatorLabel} ` +
    `(${cacheablePart} of ${formatTokens(denominatorTokens)}; ` +
    `dynamic/context ${formatTokens(dynamicContextTokens)}${unaccountedPart}), so ` +
    `${capSubject} can cap observed hit rate below 90%${unaccountedHint}${observedGap}`
}

function isSignificantUnaccountedPromptTail(
  unaccountedReusableTokens: number,
  providerReusablePromptTokens: number,
): boolean {
  if (unaccountedReusableTokens <= 0 || providerReusablePromptTokens <= 0) return false
  return unaccountedReusableTokens >= 512 &&
    unaccountedReusableTokens / providerReusablePromptTokens >= 0.05
}

function promptCacheBoundaryCause(promptCache: PromptCacheDiagnostics | undefined): string | null {
  if (!promptCache) return null
  const count = promptBoundaryCount(promptCache)
  if (count === 0) {
    return `prompt cache boundary missing; dynamic environment may be part of the cacheable prompt (static hash ${promptCache.staticPrefix.hash})`
  }
  if (count > 1) {
    return `multiple prompt cache boundaries (${count}); only the first split is cacheable, so later boundary markers can hide prompt churn`
  }
  return null
}

function summarizePromptShapeCause(
  usageHistory: StatusUsageDetail[],
  current?: PromptCacheDiagnostics,
): string | null {
  const recent = appendCurrentPromptCacheHistory(
    usageHistory.flatMap((usage) => usage.promptCacheDiagnostics ? [usage.promptCacheDiagnostics] : []),
    current,
  ).slice(-STATUS_HISTORY_SAMPLE_LIMIT)
  if (recent.length < 2) return null

  for (let i = recent.length - 1; i > 0; i--) {
    const previous = recent[i - 1]
    const latest = recent[i]
    const changes = changedPromptSegments(previous, latest)
    if (changes.length === 0) continue
    const samplesAgo = recent.length - 1 - i
    const recencyHint = samplesAgo > 0
      ? `; latest prompt shape is stable, but this changed ${samplesAgo} ${samplesAgo === 1 ? "sample" : "samples"} ago`
      : ""
    if (!hasCacheablePromptShapeChange(previous, latest)) {
      return `recent dynamic suffix changed: ${changes.join("; ")}${recencyHint}; ` +
        "cacheable static prefix/tool schemas stayed stable, so inspect transient context, " +
        "provider cache warm-up/settings, or model support"
    }
    return `recent prompt shape changed: ${changes.join("; ")}${recencyHint}; provider cache sees different prompt bytes`
  }
  return null
}

function appendCurrentPromptCacheHistory(
  history: PromptCacheDiagnostics[],
  current?: PromptCacheDiagnostics,
): PromptCacheDiagnostics[] {
  if (!current) return history
  const latest = history.at(-1)
  if (latest && promptCacheDiagnosticsKey(latest) === promptCacheDiagnosticsKey(current)) return history
  return [...history, current]
}

function promptCacheDiagnosticsKey(prompt: PromptCacheDiagnostics): string {
  return [
    prompt.boundaryPresent ? "boundary" : "no-boundary",
    String(promptBoundaryCount(prompt)),
    prompt.staticPrefix.hash,
    prompt.dynamicSuffix?.hash ?? "",
    prompt.toolSchemas?.hash ?? "",
  ].join(":")
}

function hasCacheablePromptShapeChange(previous: PromptCacheDiagnostics, latest: PromptCacheDiagnostics): boolean {
  return previous.boundaryPresent !== latest.boundaryPresent ||
    promptBoundaryCount(previous) !== promptBoundaryCount(latest) ||
    previous.staticPrefix.hash !== latest.staticPrefix.hash ||
    previous.toolSchemas?.hash !== latest.toolSchemas?.hash
}

function changedPromptSegments(previous: PromptCacheDiagnostics, latest: PromptCacheDiagnostics): string[] {
  const changes: string[] = []
  if (previous.boundaryPresent !== latest.boundaryPresent) {
    changes.push(`boundary ${previous.boundaryPresent ? "present" : "missing"} -> ${latest.boundaryPresent ? "present" : "missing"}`)
  }
  if (promptBoundaryCount(previous) !== promptBoundaryCount(latest)) {
    changes.push(`boundary count ${promptBoundaryCount(previous)} -> ${promptBoundaryCount(latest)}`)
  }
  if (previous.staticPrefix.hash !== latest.staticPrefix.hash) {
    changes.push(`static prefix changed (${formatPromptSegmentDelta(previous.staticPrefix, latest.staticPrefix)})`)
  }
  const previousDynamic = previous.dynamicSuffix
  const latestDynamic = latest.dynamicSuffix
  if (previousDynamic?.hash !== latestDynamic?.hash) {
    if (previousDynamic && latestDynamic) {
      changes.push(`dynamic suffix changed (${formatPromptSegmentDelta(previousDynamic, latestDynamic)})`)
    } else if (latestDynamic) {
      changes.push(`dynamic suffix added (now ${formatTokens(latestDynamic.estimatedTokens)} tok)`)
    } else if (previousDynamic) {
      changes.push(`dynamic suffix removed (was ${formatTokens(previousDynamic.estimatedTokens)} tok)`)
    }
  }
  const previousTools = previous.toolSchemas
  const latestTools = latest.toolSchemas
  if (previousTools?.hash !== latestTools?.hash) {
    if (previousTools && latestTools) {
      const delta = latestTools.count - previousTools.count
      const deltaText = delta === 0
        ? ""
        : `, ${delta > 0 ? "+" : "-"}${Math.abs(delta)} ${Math.abs(delta) === 1 ? "tool" : "tools"}`
      const nameDelta = formatToolNameDelta(previousTools.names, latestTools.names)
      const nameDeltaText = nameDelta ? `; ${nameDelta}` : ""
      changes.push(
        `tool schemas changed (${previousTools.count} -> ${latestTools.count} tools${deltaText}; ` +
        `${previousTools.hash} -> ${latestTools.hash}${nameDeltaText})`,
      )
    } else if (latestTools) {
      changes.push(`tool schemas added (${latestTools.count} tools, hash ${latestTools.hash})`)
    } else if (previousTools) {
      changes.push(`tool schemas removed (was ${previousTools.count} tools, hash ${previousTools.hash})`)
    }
  }
  return changes
}

function formatToolNameDelta(previous: string[], latest: string[]): string | null {
  const previousSet = new Set(previous)
  const latestSet = new Set(latest)
  const added = latest.filter((name) => !previousSet.has(name))
  const removed = previous.filter((name) => !latestSet.has(name))
  const parts: string[] = []
  if (added.length > 0) parts.push(`added${formatShortList(added)}`)
  if (removed.length > 0) parts.push(`removed${formatShortList(removed)}`)
  if (parts.length > 0) return parts.join(", ")
  return "same tool names; schema content changed"
}

function formatPromptSegmentDelta(previous: { estimatedTokens: number }, latest: { estimatedTokens: number }): string {
  const delta = latest.estimatedTokens - previous.estimatedTokens
  const deltaText = formatSignedTokenDelta(delta)
  const base = `${formatTokens(previous.estimatedTokens)} -> ${formatTokens(latest.estimatedTokens)} tok`
  return deltaText ? `${base}, ${deltaText}` : base
}

function formatPromptCacheDiagnostics(prompt: PromptCacheDiagnostics): string {
  const staticPart = `static ${formatTokens(prompt.staticPrefix.estimatedTokens)} tok · ` +
    `${formatTokens(prompt.staticPrefix.chars)} chars · ${prompt.staticPrefix.hash}`
  const dynamicPart = prompt.dynamicSuffix
    ? `; dynamic ${formatTokens(prompt.dynamicSuffix.estimatedTokens)} tok · ` +
      `${formatTokens(prompt.dynamicSuffix.chars)} chars · ${prompt.dynamicSuffix.hash}`
    : "; dynamic none"
  const toolsPart = prompt.toolSchemas
    ? `; tools ${formatTokens(prompt.toolSchemas.count)}${formatToolSchemaSize(prompt.toolSchemas)} · ${prompt.toolSchemas.hash}${formatShortList(prompt.toolSchemas.names)}`
    : ""
  const count = promptBoundaryCount(prompt)
  const boundary = count === 0
    ? "; no boundary"
    : count > 1
      ? `; ${count} boundaries`
      : ""
  return `Prompt shape:    ${staticPart}${dynamicPart}${toolsPart}${boundary}`
}

type ConversationCacheDiagnostics = NonNullable<StatusContextDiagnostics["conversationCache"]>

function formatConversationCacheDiagnostics(cache: ConversationCacheDiagnostics): string {
  return `Conversation:    prefix ${formatTokens(cache.prefix.estimatedTokens)} tok / ` +
    `${formatTokens(cache.prefix.messageCount)} msg · ${cache.prefix.hash}; ` +
    `fresh tail ${formatTokens(cache.tail.estimatedTokens)} tok / ` +
    `${formatTokens(cache.tail.messageCount)} msg · ${cache.tail.hash}`
}

type ConversationPrefixTransition = {
  state: "stable" | "extended" | "contracted" | "rewritten"
  previousCount: number
  latestCount: number
  commonMessages: number
}

function summarizeConversationPrefixTrend(history: StatusContextDiagnostics[]): string | null {
  const snapshots = conversationCacheSnapshots(history)
  if (snapshots.length < 2) return null
  const disruption = latestConversationPrefixDisruption(snapshots)
  if (disruption) {
    const { transition, samplesAgo } = disruption
    const recency = samplesAgo === 0
      ? "latest transition"
      : `${samplesAgo} ${samplesAgo === 1 ? "sample" : "samples"} ago`
    if (transition.state === "contracted") {
      return `contracted ${transition.previousCount} -> ${transition.latestCount} messages · ${recency}`
    }
    return `rewritten from message ${transition.commonMessages + 1} · ` +
      `${transition.previousCount} -> ${transition.latestCount} messages · ${recency}`
  }
  const latest = snapshots.at(-1)!
  const changed = snapshots.slice(1).some((snapshot, index) =>
    compareConversationPrefixes(snapshots[index], snapshot).state === "extended")
  return `${changed ? "append-only" : "stable"} across last ${snapshots.length} snapshots · ` +
    `${formatTokens(latest.prefix.messageCount)} prefix messages`
}

function summarizeConversationPrefixCause(history: StatusContextDiagnostics[]): string | null {
  const snapshots = conversationCacheSnapshots(history)
  const disruption = latestConversationPrefixDisruption(snapshots)
  if (!disruption) return null
  const { transition, samplesAgo } = disruption
  const recency = samplesAgo > 0
    ? `; latest prefix is stable, but this happened ${samplesAgo} ${samplesAgo === 1 ? "sample" : "samples"} ago`
    : ""
  if (transition.state === "contracted") {
    return `conversation cache prefix contracted from ${transition.previousCount} to ` +
      `${transition.latestCount} messages; compaction or provider-view truncation removed reusable history${recency}`
  }
  return `conversation cache prefix was rewritten from message ${transition.commonMessages + 1} ` +
    `(${transition.previousCount} -> ${transition.latestCount} messages); ` +
    `previously-cacheable history bytes changed${recency}`
}

function conversationCacheSnapshots(
  history: StatusContextDiagnostics[],
): ConversationCacheDiagnostics[] {
  return history
    .flatMap((context) => context.conversationCache ? [context.conversationCache] : [])
    .filter(hasCompleteConversationMessageHashes)
    .slice(-STATUS_HISTORY_SAMPLE_LIMIT)
}

function hasCompleteConversationMessageHashes(cache: ConversationCacheDiagnostics): boolean {
  return cache.prefix.messageHashes.length === cache.prefix.messageCount
}

function latestConversationPrefixDisruption(
  snapshots: ConversationCacheDiagnostics[],
): { transition: ConversationPrefixTransition; samplesAgo: number } | null {
  for (let i = snapshots.length - 1; i > 0; i--) {
    const transition = compareConversationPrefixes(snapshots[i - 1], snapshots[i])
    if (transition.state === "stable" || transition.state === "extended") continue
    return {
      transition,
      samplesAgo: snapshots.length - 1 - i,
    }
  }
  return null
}

function compareConversationPrefixes(
  previous: ConversationCacheDiagnostics,
  latest: ConversationCacheDiagnostics,
): ConversationPrefixTransition {
  const before = previous.prefix.messageHashes
  const after = latest.prefix.messageHashes
  const sharedLimit = Math.min(before.length, after.length)
  let commonMessages = 0
  while (commonMessages < sharedLimit && before[commonMessages] === after[commonMessages]) {
    commonMessages++
  }
  let state: ConversationPrefixTransition["state"]
  if (commonMessages < sharedLimit) state = "rewritten"
  else if (before.length === after.length) state = "stable"
  else if (before.length < after.length) state = "extended"
  else state = "contracted"
  return {
    state,
    previousCount: before.length,
    latestCount: after.length,
    commonMessages,
  }
}

function promptBoundaryCount(prompt: PromptCacheDiagnostics): number {
  if (typeof prompt.boundaryCount === "number" && Number.isFinite(prompt.boundaryCount)) {
    return Math.max(0, Math.floor(prompt.boundaryCount))
  }
  return prompt.boundaryPresent ? 1 : 0
}

function formatToolSchemaDiagnostics(toolSchema: ToolSchemaDiagnostics): string {
  return `Tool schemas:    ${formatTokens(toolSchema.count)} tools${formatToolSchemaSize(toolSchema)} · hash ${toolSchema.hash}${formatShortList(toolSchema.names)}`
}

function formatToolSchemaSize(toolSchema: ToolSchemaDiagnostics): string {
  const estimatedTokens = nonNegativeFinite(toolSchema.estimatedTokens)
  const chars = nonNegativeFinite(toolSchema.chars)
  if (estimatedTokens <= 0 && chars <= 0) return ""
  return ` · ${formatTokens(estimatedTokens)} tok · ${formatTokens(chars)} chars`
}

function summarizePromptCacheTrend(history: StatusUsageDetail[]): string | null {
  const samples = history
    .filter(isPromptCacheTrendSample)
    .slice(-STATUS_HISTORY_SAMPLE_LIMIT)
  if (samples.length < 2) return null

  let totalFresh = 0
  let totalRead = 0
  let totalWrite = 0
  let targetHits = 0
  let writeCalls = 0
  for (const usage of samples) {
    const cache = computeCacheUsageStats({
      inputTokens: usage.inputTokens ?? 0,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
    })
    totalFresh += cache.freshInputTokens
    totalRead += cache.cacheReadInputTokens
    totalWrite += cache.cacheCreationInputTokens
    if (cache.cacheReuseRatio !== null && cache.cacheReuseRatio >= 0.9) {
      targetHits++
    }
    if (cache.cacheCreationInputTokens > 0) {
      writeCalls++
    }
  }
  const aggregate = computeCacheUsageStats({
    inputTokens: totalFresh,
    cacheReadInputTokens: totalRead,
    cacheCreationInputTokens: totalWrite,
  })
  return `${formatPercent(aggregate.cacheReuseRatio)} avg reuse over ${samples.length} calls ` +
    `(${formatPercent(aggregate.cacheHitRatio)} effective, ${formatPercent(aggregate.cacheWriteRatio)} write; ` +
    `${targetHits}/${samples.length} at ≥90%; ${writeCalls}/${samples.length} wrote cache; fresh ${formatTokens(totalFresh)}, ` +
    `read ${formatTokens(totalRead)}, write ${formatTokens(totalWrite)})`
}

function isPromptCacheTrendSample(usage: StatusUsageDetail): boolean {
  if (usage.providerUsageReported === false || !hasUsableCacheAccounting(usage)) return false
  const cache = computeCacheUsageStats({
    inputTokens: usage.inputTokens ?? 0,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
  })
  return cache.totalPromptInputTokens > 0
}

interface CacheAccountingCoverage {
  reported: number
  total: number
}

function summarizeCacheAccountingCoverage(
  history: StatusUsageDetail[],
): CacheAccountingCoverage | null {
  const samples = history
    .filter(isProviderUsageSample)
    .slice(-STATUS_HISTORY_SAMPLE_LIMIT)
  if (samples.length === 0) return null
  return {
    reported: samples.filter(hasUsableCacheAccounting).length,
    total: samples.length,
  }
}

function isProviderUsageSample(usage: StatusUsageDetail): boolean {
  if (usage.providerUsageReported === false) return false
  if (usage.providerUsageReported === true) return true
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadInputTokens,
    usage.cacheCreationInputTokens,
  ].some((value) => typeof value === "number" && Number.isFinite(value))
}

function formatMissingCacheAccountingCoverage(
  coverage: CacheAccountingCoverage | null,
): string {
  if (!coverage || coverage.total <= 1) return ""
  if (coverage.reported === 0) return ` across ${coverage.total} recent calls`
  return ` on the latest call (reported on ${coverage.reported}/${coverage.total} recent calls)`
}

function hasUsableCacheAccounting(usage: StatusUsageDetail): boolean {
  return isUsableCacheToken(usage.cacheReadInputTokens) ||
    isUsableCacheToken(usage.cacheCreationInputTokens)
}

function isUsableCacheToken(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function summarizeContextChurn(history: StatusContextDiagnostics[]): string | null {
  const recent = history.filter(Boolean).slice(-STATUS_HISTORY_SAMPLE_LIMIT)
  if (recent.length < 2) return null

  const uniqueHashes = new Set(recent.map((ctx) => ctx.hash)).size
  const latest = recent[recent.length - 1]
  const previous = recent[recent.length - 2]
  const changedSegments = changedContextSegmentLabels(previous, latest)
  const trend = latest.estimatedTokens - previous.estimatedTokens
  const tokenDelta = trend === 0
    ? "token delta 0"
    : `token delta ${trend > 0 ? "+" : "-"}${formatTokens(Math.abs(trend))}`
  const recentChangeText = changedSegments.length === 0
    ? summarizeMostRecentContextSegmentChange(recent)
    : ""

  if (uniqueHashes === 1 && changedSegments.length === 0) {
    return `stable across last ${recent.length} snapshots · ${tokenDelta}${recentChangeText}`
  }
  const segmentText = changedSegments.length > 0
    ? ` · ${changedSegments.slice(0, 4).join(", ")}${changedSegments.length > 4 ? ", ..." : ""}`
    : recentChangeText
  const hashText = uniqueHashes === 1
    ? `1 unique text hash in last ${recent.length} snapshots`
    : `${uniqueHashes} unique hashes in last ${recent.length} snapshots`
  return `${hashText} · ${tokenDelta}${segmentText}`
}

function summarizeMostRecentContextSegmentChange(
  recent: StatusContextDiagnostics[],
): string {
  for (let i = recent.length - 1; i > 0; i--) {
    const changedSegments = changedContextSegmentLabels(recent[i - 1], recent[i])
    if (changedSegments.length === 0) continue
    const samplesAgo = recent.length - 1 - i
    const sampleLabel = samplesAgo === 1 ? "1 sample ago" : `${samplesAgo} samples ago`
    return ` · latest changed ${sampleLabel}: ${changedSegments.slice(0, 4).join(", ")}${changedSegments.length > 4 ? ", ..." : ""}`
  }
  return ""
}

function changedContextSegmentLabels(
  previous: StatusContextDiagnostics,
  latest: StatusContextDiagnostics,
): string[] {
  return changedContextSegments(previous, latest).map(formatChangedContextSegment)
}

interface ChangedContextSegment {
  name: string
  state: "added" | "removed" | "changed"
  previous?: ContextSegmentDiagnostics
  latest?: ContextSegmentDiagnostics
  tokenDelta: number
  textChanged: boolean
}

function changedContextSegments(
  previous: StatusContextDiagnostics,
  latest: StatusContextDiagnostics,
): ChangedContextSegment[] {
  const prev = new Map(previous.segments.map((s) => [s.name, s]))
  const next = new Map(latest.segments.map((s) => [s.name, s]))
  const names = new Set([
    ...previous.segments.map((s) => s.name),
    ...latest.segments.map((s) => s.name),
  ])
  const changed: ChangedContextSegment[] = []
  for (const name of names) {
    const before = prev.get(name)
    const after = next.get(name)
    if (
      before &&
      after &&
      contextSegmentDiagnosticsKey(before) === contextSegmentDiagnosticsKey(after)
    ) {
      continue
    }
    const previousTokens = before?.estimatedTokens ?? 0
    const latestTokens = after?.estimatedTokens ?? 0
    const tokenDelta = latestTokens - previousTokens
    if (before === undefined) {
      changed.push({ name, state: "added", latest: after, tokenDelta, textChanged: true })
    } else if (after === undefined) {
      changed.push({ name, state: "removed", previous: before, tokenDelta, textChanged: true })
    } else {
      changed.push({
        name,
        state: "changed",
        previous: before,
        latest: after,
        tokenDelta,
        textChanged: contextSegmentTextDiagnosticsKey(before) !== contextSegmentTextDiagnosticsKey(after),
      })
    }
  }
  return changed.sort((a, b) => {
    const byTokenImpact = changedContextSegmentImpact(b) - changedContextSegmentImpact(a)
    if (byTokenImpact !== 0) return byTokenImpact
    return a.name.localeCompare(b.name)
  })
}

function contextSegmentTextDiagnosticsKey(segment: ContextSegmentDiagnostics): string {
  return [
    segment.name,
    segment.hash,
    segment.chars,
    segment.estimatedTokens,
  ].join(":")
}

function hasContextTextChange(segment: ChangedContextSegment): boolean {
  return segment.textChanged
}

function summarizeMetadataOnlyContextHint(changedSegments: ChangedContextSegment[]): string {
  const changed = changedSegments.map(formatChangedContextSegment)
  return changed.length > 0
    ? `; diagnostic metadata changed without prompt-byte changes: ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", ..." : ""}`
    : ""
}

function summarizeContextChangeHint(changedSegments: ChangedContextSegment[]): string | null {
  if (changedSegments.some(isMemoryQueryHashChange)) {
    return "memory recall query changed; check recent long-paste/continue input"
  }
  if (changedSegments.some(isMemorySelectionChange)) {
    return "memory selection changed; inspect memory query, MEMORY.md updates, or pinned memories"
  }
  return null
}

function isMemorySegment(segment: ChangedContextSegment): boolean {
  return segment.name === "memory_index" ||
    segment.name === "memory_working_pack" ||
    segment.name === "global_memory_index" ||
    segment.name === "global_memory_working_pack"
}

function isMemoryQueryHashChange(segment: ChangedContextSegment): boolean {
  if (segment.state !== "changed") return false
  if (!isMemorySegment(segment)) return false
  const previous = metaString(segment.previous?.meta, "queryHash")
  const latest = metaString(segment.latest?.meta, "queryHash")
  return previous !== undefined &&
    latest !== undefined &&
    previous !== latest
}

function isMemorySelectionChange(segment: ChangedContextSegment): boolean {
  if (!isMemorySegment(segment)) return false
  const previousIncluded = metaStringList(segment.previous?.meta, "included")
  const latestIncluded = metaStringList(segment.latest?.meta, "included")
  const previousExcerpted = metaStringList(segment.previous?.meta, "excerpted")
  const latestExcerpted = metaStringList(segment.latest?.meta, "excerpted")
  const previousSkipped = metaSkipped(segment.previous?.meta)
  const latestSkipped = metaSkipped(segment.latest?.meta)
  return stringListKey(previousIncluded) !== stringListKey(latestIncluded) ||
    stringListKey(previousExcerpted) !== stringListKey(latestExcerpted) ||
    (previousSkipped ?? "") !== (latestSkipped ?? "")
}

function stringListKey(values: string[] | undefined): string {
  return values?.join("\0") ?? ""
}

function changedContextSegmentImpact(segment: ChangedContextSegment): number {
  return Math.max(
    Math.abs(segment.tokenDelta),
    segment.previous?.estimatedTokens ?? 0,
    segment.latest?.estimatedTokens ?? 0,
  )
}

function formatChangedContextSegment(segment: ChangedContextSegment): string {
  const parts = [`${segment.state} ${segment.name}`]
  const delta = formatSignedTokenDelta(segment.tokenDelta)
  const current = segment.latest
    ? `now ${formatTokens(segment.latest.estimatedTokens)} tok`
    : segment.previous
      ? `was ${formatTokens(segment.previous.estimatedTokens)} tok`
      : null
  const metaDelta = formatContextMetaDelta(segment)
  const hashDelta = !delta && !metaDelta ? formatContextHashDelta(segment) : null
  if (delta || current) {
    parts.push(`(${[delta, current, metaDelta, hashDelta].filter(Boolean).join(", ")})`)
  }
  return parts.join(" ")
}

function formatSignedTokenDelta(delta: number): string | null {
  if (delta === 0) return null
  return `${delta > 0 ? "+" : "-"}${formatTokens(Math.abs(delta))} tok`
}

function formatContextHashDelta(segment: ChangedContextSegment): string | null {
  if (segment.state !== "changed") return null
  const previous = segment.previous?.hash
  const latest = segment.latest?.hash
  if (!previous || !latest || previous === latest) return null
  return `hash ${previous} -> ${latest}`
}

function formatContextMetaDelta(segment: ChangedContextSegment): string | null {
  const previousMeta = segment.previous?.meta
  const latestMeta = segment.latest?.meta
  const parts = [
    formatStringListMetaDelta(
      "included",
      metaStringList(previousMeta, "included"),
      metaStringList(latestMeta, "included"),
      segment.state,
    ),
    formatStringListMetaDelta(
      "excerpted",
      metaStringList(previousMeta, "excerpted"),
      metaStringList(latestMeta, "excerpted"),
      segment.state,
    ),
    formatSkippedMetaDelta(
      metaSkipped(previousMeta),
      metaSkipped(latestMeta),
      segment.state,
    ),
    formatStringMetaDelta(
      "query",
      metaString(previousMeta, "queryHash"),
      metaString(latestMeta, "queryHash"),
      segment.state,
    ),
    formatStringMetaDelta(
      "query_kind",
      memoryQueryKindLabel(previousMeta),
      memoryQueryKindLabel(latestMeta),
      segment.state,
    ),
    formatStringListMetaDelta(
      "selected",
      metaRecallList(previousMeta, "selected"),
      metaRecallList(latestMeta, "selected"),
      segment.state,
    ),
    formatStringListMetaDelta(
      "top_skipped",
      metaRecallList(previousMeta, "topSkipped"),
      metaRecallList(latestMeta, "topSkipped"),
      segment.state,
    ),
    formatNumberMetaDelta(
      "budget",
      metaNumber(previousMeta, "budgetTokens"),
      metaNumber(latestMeta, "budgetTokens"),
      segment.state,
    ),
    formatNumberMetaDelta(
      "todos",
      metaNumber(previousMeta, "todoCount"),
      metaNumber(latestMeta, "todoCount"),
      segment.state,
    ),
    formatNumberMetaDelta(
      "in_progress",
      metaNumber(previousMeta, "inProgressCount"),
      metaNumber(latestMeta, "inProgressCount"),
      segment.state,
    ),
  ].filter((value): value is string => !!value)
  return parts.length > 0 ? parts.join("; ") : null
}

function metaStringList(meta: Record<string, unknown> | undefined, key: string): string[] | undefined {
  if (!meta) return undefined
  const value = meta[key]
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string")
}

function metaRecallList(meta: Record<string, unknown> | undefined, key: string): string[] | undefined {
  if (!meta) return undefined
  const formatted = recallEntries(meta[key])
  return formatted.length > 0 ? formatted : undefined
}

function metaNumber(meta: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!meta) return undefined
  const value = meta[key]
  return typeof value === "number" && Number.isFinite(value) ? nonNegativeFinite(value) : undefined
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!meta) return undefined
  const value = meta[key]
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function metaBoolean(meta: Record<string, unknown> | undefined, key: string): boolean | undefined {
  if (!meta) return undefined
  return typeof meta[key] === "boolean" ? meta[key] : undefined
}

function metaSkipped(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta || !isRecord(meta.skipped)) return undefined
  return formatSkippedReasons(meta.skipped) || undefined
}

function memoryQueryKindLabel(meta: Record<string, unknown> | undefined): string | undefined {
  const kind = metaString(meta, "queryKind")
  if (kind !== "direct" && kind !== "low_signal") return undefined
  return metaBoolean(meta, "queryFallback") === true ? `${kind}+fallback` : kind
}

function formatStringListMetaDelta(
  label: string,
  previous: string[] | undefined,
  latest: string[] | undefined,
  state: ChangedContextSegment["state"],
): string | null {
  if (!previous?.length && !latest?.length) return null
  const previousKey = previous?.join("\0") ?? ""
  const latestKey = latest?.join("\0") ?? ""
  if (state === "changed" && previousKey === latestKey) return null
  if (state === "added") return latest?.length ? `${label}${formatShortList(latest)}` : null
  if (state === "removed") return previous?.length ? `${label} was${formatShortList(previous)}` : null
  if (!previous?.length) return latest?.length ? `${label}${formatShortList(latest)}` : null
  if (!latest?.length) return `${label} cleared`
  return `${label}${formatShortList(previous)} ->${formatShortList(latest)}`
}

function formatStringMetaDelta(
  label: string,
  previous: string | undefined,
  latest: string | undefined,
  state: ChangedContextSegment["state"],
): string | null {
  if (!previous && !latest) return null
  if (state === "changed" && previous === latest) return null
  if (state === "added") return latest ? `${label} ${latest}` : null
  if (state === "removed") return previous ? `${label} was ${previous}` : null
  if (!previous) return latest ? `${label} ${latest}` : null
  if (!latest) return `${label} cleared`
  return `${label} ${previous} -> ${latest}`
}

function formatSkippedMetaDelta(
  previous: string | undefined,
  latest: string | undefined,
  state: ChangedContextSegment["state"],
): string | null {
  if (!previous && !latest) return null
  if (state === "changed" && previous === latest) return null
  if (state === "added") return latest ? `skipped ${latest}` : null
  if (state === "removed") return previous ? `skipped was ${previous}` : null
  if (!previous) return latest ? `skipped ${latest}` : null
  if (!latest) return "skipped cleared"
  return `skipped ${previous} -> ${latest}`
}

function formatNumberMetaDelta(
  label: string,
  previous: number | undefined,
  latest: number | undefined,
  state: ChangedContextSegment["state"],
): string | null {
  if (previous === undefined && latest === undefined) return null
  if (state === "changed" && previous === latest) return null
  if (state === "added") return latest !== undefined ? `${label} ${formatTokens(latest)}` : null
  if (state === "removed") return previous !== undefined ? `${label} was ${formatTokens(previous)}` : null
  if (previous === undefined) return latest !== undefined ? `${label} ${formatTokens(latest)}` : null
  if (latest === undefined) return `${label} cleared`
  return `${label} ${formatTokens(previous)} -> ${formatTokens(latest)}`
}

function formatSegmentMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta) return ""
  const parts: string[] = []
  if (Array.isArray(meta.included)) {
    const included = meta.included.filter((value): value is string => typeof value === "string")
    parts.push(`included ${included.length}${formatShortList(included)}`)
  }
  if (Array.isArray(meta.excerpted)) {
    const excerpted = meta.excerpted.filter((value): value is string => typeof value === "string")
    if (excerpted.length > 0) parts.push(`excerpted ${excerpted.length}${formatShortList(excerpted)}`)
  }
  if (isRecord(meta.skipped)) {
    const skipped = formatSkippedReasons(meta.skipped)
    if (skipped) parts.push(`skipped ${skipped}`)
  }
  const selected = formatRecallList(meta.selected)
  if (selected) parts.push(`selected ${selected}`)
  const topSkipped = formatRecallList(meta.topSkipped)
  if (topSkipped) parts.push(`top_skipped ${topSkipped}`)
  if (typeof meta.queryHash === "string" && meta.queryHash.trim().length > 0) {
    const queryKind = memoryQueryKindLabel(meta)
    parts.push(`query ${meta.queryHash}${queryKind ? ` (${queryKind})` : ""}`)
  } else {
    const queryKind = memoryQueryKindLabel(meta)
    if (queryKind) parts.push(`query ${queryKind}`)
  }
  if (typeof meta.budgetTokens === "number") parts.push(`budget ${formatTokens(nonNegativeFinite(meta.budgetTokens))} tok`)
  if (typeof meta.todoCount === "number") parts.push(`todos ${nonNegativeFinite(meta.todoCount)}`)
  if (typeof meta.inProgressCount === "number") parts.push(`in_progress ${nonNegativeFinite(meta.inProgressCount)}`)
  if (parts.length === 0) return ""
  return ` · ${parts.join(", ")}`
}

function formatRecallList(value: unknown, maxItems = 3): string | null {
  const entries = recallEntries(value)
  if (entries.length === 0) return null
  const shown = entries.slice(0, maxItems)
  const suffix = entries.length > maxItems ? `, +${entries.length - maxItems} more` : ""
  return `[${shown.join(", ")}${suffix}]`
}

function recallEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map(formatRecallEntry)
    .filter((entry): entry is string => !!entry)
}

function formatRecallEntry(record: Record<string, unknown>): string | null {
  const filename = typeof record.filename === "string" ? truncate(oneLine(record.filename), 40) : ""
  if (!filename) return null
  const reason = typeof record.skippedReason === "string" && record.skippedReason.trim()
    ? ` ${truncate(oneLine(record.skippedReason), 20)}`
    : ""
  const score = typeof record.score === "number" && Number.isFinite(record.score)
    ? ` s${formatRecallScore(record.score)}`
    : ""
  const relevance = typeof record.relevanceScore === "number" && Number.isFinite(record.relevanceScore)
    ? ` r${formatRecallScore(record.relevanceScore)}`
    : ""
  const semanticScore = typeof record.semanticScore === "number" && Number.isFinite(record.semanticScore)
    ? record.semanticScore
    : undefined
  const hasSemantic = semanticScore !== undefined
  const lexical = hasSemantic && typeof record.lexicalScore === "number" && Number.isFinite(record.lexicalScore)
    ? ` l${formatRecallScore(record.lexicalScore)}`
    : ""
  const semantic = hasSemantic
    ? ` sem${formatRecallScore(semanticScore)}`
    : ""
  const flags = [
    record.pinned === true ? "pin" : "",
    record.excerpted === true ? "excerpt" : "",
  ].filter(Boolean)
  return `${filename}${reason}${score}${relevance}${lexical}${semantic}${flags.length ? ` ${flags.join("+")}` : ""}`
}

function formatRecallScore(value: number): string {
  const safe = nonNegativeFinite(value)
  if (Number.isInteger(safe)) return String(safe)
  const fixed = safe >= 10 ? safe.toFixed(1) : safe.toFixed(2)
  return fixed.replace(/\.?0+$/u, "")
}

function formatShortList(values: string[], maxItems = 3): string {
  if (values.length === 0) return ""
  const shown = values.slice(0, maxItems).map((value) => truncate(oneLine(value), 40))
  const suffix = values.length > maxItems ? `, +${values.length - maxItems} more` : ""
  return ` [${shown.join(", ")}${suffix}]`
}

function formatSkippedReasons(skipped: Record<string, unknown>): string {
  const parts = Object.entries(skipped)
    .filter(([, count]) => typeof count === "number" && count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${oneLine(reason)} ${nonNegativeFinite(count as number)}`)
  return parts.join(", ")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function summariseMCP(snaps: { status: string }[]): string {
  if (snaps.length === 0) return "(none configured)"
  const counts: Record<string, number> = {}
  for (const s of snaps) counts[s.status] = (counts[s.status] ?? 0) + 1
  const order = ["ready", "connecting", "degraded", "needs_auth", "error"]
  const parts: string[] = []
  for (const k of order) {
    if (counts[k]) parts.push(`${counts[k]} ${k}`)
  }
  // Catch any status keys that aren't in our priority order.
  for (const k of Object.keys(counts)) {
    if (!order.includes(k)) parts.push(`${counts[k]} ${k}`)
  }
  return parts.join(" · ") + ` (${snaps.length} total)`
}
