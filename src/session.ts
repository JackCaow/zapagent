import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path"
import {
  mkdirSync, writeFileSync, readFileSync, appendFileSync,
  existsSync, readdirSync, unlinkSync, openSync, readSync,
  closeSync, statSync, lstatSync, chmodSync,
} from "node:fs"
import {
  open as openAsync,
  lstat as lstatAsync,
  readFile as readFileAsync,
  readdir as readdirAsync,
  stat as statAsync,
} from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { getAppDataDir } from "../zapsdk/utils/platform.js"
import { legacyProjectDataSegment, resolveProjectDataSegment } from "../zapsdk/utils/project-paths.js"
import type { ImageContent, Message } from "../zapsdk/index.js"
import type { ContextDiagnostics } from "../zapsdk/agent/events.js"
import type { PromptCacheDiagnostics } from "./agent/promptDiagnostics.js"
import { sanitizePromptCacheScope, type PromptCacheScope } from "./agent/cacheScope.js"
import { sanitizeContextDiagnostics, sanitizePromptCacheDiagnostics } from "./agent/diagnosticSanitizers.js"
import { type Turn, type CompletedCall, type IncompleteCall, buildToolTurn, turnsToMessages } from "../zapsdk/core/turn.js"
import type { ToolCallInfo } from "./ui/types.js"
import { writeFileAtomic } from "./utils/secure-write.js"
import { renderUnavailablePastedPlaceholder } from "./utils/pastedPlaceholder.js"
import { persistPasteSidecar, readPasteSidecar } from "./utils/pasteSidecar.js"
import { VERSION } from "./version.js"
import { deletePersistedToolOutputs } from "../zapsdk/utils/tool-result-storage.js"
import { isValidSessionId } from "./utils/session-id.js"
// SessionInfo type lived in dialog-session-list.tsx (deleted in Ink migration).
// Inline its shape here so session.ts doesn't depend on the dialog UI.
export interface SessionInfo {
  id: string
  name: string
  date: string
  messageCount: number
  preview: string
}

export type SessionLoadErrorCode =
  | "invalid_id"
  | "not_found"
  | "permission_denied"
  | "unreadable"
  | "empty"
  | "corrupt"

export class SessionLoadError extends Error {
  constructor(
    public readonly code: SessionLoadErrorCode,
    public readonly sessionId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "SessionLoadError"
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionImageRef {
  filePath: string
  source: string
  mediaType: string
}

export interface SessionLog {
  type: string
  text: string
  tool?: ToolCallInfo
  images?: SessionImageRef[]
  /** false means this log is display-only and must not be replayed into
   *  restored model context. */
  restore?: boolean
  /** Optional model-facing text used for restore when `text` is a compact
   *  display form (for example a long-paste placeholder). */
  restoreText?: string
  /** Subagent nesting chain. Absent for root events. Propagated end-to-end
   *  (JSONL → parse → UI) so reloaded sessions fold the same way as live ones. */
  agentPath?: string[]
}

/** Whether replaying this display log through SessionWriter consumes one
 *  persisted journal position. Shared with restore UI mapping so checkpoint
 *  journal offsets are never mistaken for transcript-array offsets. */
export function sessionLogConsumesJournalIndex(type: string): boolean {
  return type === "user"
    || type === "task-notification"
    || type === "agent"
    || type === "tool"
    || type === "result"
    || type === "thinking"
    || type === "system"
    || type === "error"
}

export interface SessionDiagnostics {
  warn?: (event: string, fields?: Record<string, unknown>) => void
  error?: (event: string, fields?: Record<string, unknown>) => void
}

let sessionDiagnostics: SessionDiagnostics | null = null

export interface SessionPersistenceFailure {
  operation: string
  message: string
  path?: string
  pendingEntries?: number
}

export interface SessionPersistenceStatus {
  pendingWrites: number
  lastFailure?: SessionPersistenceFailure
}

let lastSessionPersistenceFailure: SessionPersistenceFailure | undefined

export function setSessionDiagnostics(next: SessionDiagnostics | null): SessionDiagnostics | null {
  const previous = sessionDiagnostics
  sessionDiagnostics = next
  return previous
}

function reportSessionPersistenceFailure(
  operation: string,
  error: unknown,
  fields: Record<string, unknown> = {},
): void {
  lastSessionPersistenceFailure = {
    operation,
    message: error instanceof Error ? error.message : String(error),
    ...(typeof fields.path === "string" ? { path: fields.path } : {}),
    ...(typeof fields.pendingEntries === "number" && Number.isFinite(fields.pendingEntries)
      ? { pendingEntries: Math.max(0, Math.floor(fields.pendingEntries)) }
      : {}),
  }
  try {
    sessionDiagnostics?.warn?.("session_persistence_failed", {
      operation,
      message: lastSessionPersistenceFailure.message,
      ...fields,
    })
  } catch {}
}

function clearSessionPersistenceFailure(): void {
  lastSessionPersistenceFailure = undefined
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const cwd = process.cwd()
export const cwdShort = `${basename(dirname(cwd))}/${basename(cwd)}`
export const appDataDir = getAppDataDir()
function ensurePrivateDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true })
    if (process.platform !== "win32") chmodSync(path, 0o700)
  } catch {}
}

ensurePrivateDir(appDataDir)
export const configPath = join(appDataDir, "config.json")
export const lastOutputPath = join(appDataDir, "last-output.md")

export const sessionPath = join(appDataDir, "session.json") // kept for reference only
const RESTORE_TEXT_INLINE_MAX_BYTES = 64 * 1024
const PASTED_DISPLAY_PLACEHOLDER_RE = /\[Pasted #([1-9]\d*) · \d+ lines · \d+ chars\]/g
const UNAVAILABLE_RESTORE_TEXT_NOTICE =
  "[Full user input unavailable in session history; paste again to resend full text]"

/** Per-project session directory. New sessions use the shared project identity
 *  helper (git remote/root when available, legacy cwd flattening otherwise) so
 *  sessions and long-term memory agree on project scope. Readers still include
 *  the legacy cwd directory so existing sessions remain visible after upgrade. */
function resolveProjectSessionDirs(dataDir: string, projectCwd: string): string[] {
  const active = join(dataDir, "projects", resolveProjectDataSegment(projectCwd))
  const legacy = join(dataDir, "projects", legacyProjectDataSegment(projectCwd))
  return active === legacy ? [active] : [active, legacy]
}

const [projectSessionsDir, legacyProjectSessionsDir = projectSessionsDir] = resolveProjectSessionDirs(appDataDir, cwd)
ensurePrivateDir(join(appDataDir, "projects"))
ensurePrivateDir(projectSessionsDir)

function projectSessionDirs(): string[] {
  return projectSessionsDir === legacyProjectSessionsDir
    ? [projectSessionsDir]
    : [projectSessionsDir, legacyProjectSessionsDir]
}

function attachRestoreTextMetadata(entry: Record<string, unknown>, restoreText: string): void {
  if (Buffer.byteLength(restoreText, "utf-8") <= RESTORE_TEXT_INLINE_MAX_BYTES) {
    entry["zapRestoreText"] = restoreText
    return
  }
  const ref = persistRestoreTextSidecar(restoreText)
  if (ref) {
    entry["zapRestoreTextRef"] = ref
    entry["zapRestoreTextBytes"] = Buffer.byteLength(restoreText, "utf-8")
    return
  }
  // Durability beats compactness when sidecar write fails.
  entry["zapRestoreText"] = restoreText
}

function persistRestoreTextSidecar(restoreText: string): string | null {
  return persistPasteSidecar(appDataDir, restoreText)
}

function readRestoreTextSidecar(ref: string): string | undefined {
  return readPasteSidecar(appDataDir, ref)?.content
}

interface RestoreTextResolution {
  text?: string
  unavailable: boolean
}

function resolveRestoreTextFromEntry(entry: Record<string, unknown>): RestoreTextResolution {
  if (typeof entry.zapRestoreText === "string") {
    return { text: entry.zapRestoreText, unavailable: false }
  }
  if (typeof entry.zapRestoreTextRef !== "string") return { unavailable: false }
  const text = readRestoreTextSidecar(entry.zapRestoreTextRef)
  return text === undefined
    ? { unavailable: true }
    : { text, unavailable: false }
}

function markUnavailableRestoreText(displayText: string): string {
  let replaced = false
  const marked = displayText.replace(PASTED_DISPLAY_PLACEHOLDER_RE, (_placeholder, id) => {
    replaced = true
    return renderUnavailablePastedPlaceholder(id)
  })
  if (replaced) return marked
  return displayText
    ? `${displayText}\n\n${UNAVAILABLE_RESTORE_TEXT_NOTICE}`
    : UNAVAILABLE_RESTORE_TEXT_NOTICE
}

/** ZapCode built-in skills dir */
export const globalSkillsDir = join(appDataDir, "skills")
ensurePrivateDir(globalSkillsDir)

const gitBranch = detectGitBranch(cwd) ?? "main"

function detectGitBranch(projectCwd: string): string | null {
  const root = findGitRoot(projectCwd)
  if (!root) return null
  const gitDir = resolveGitDir(root)
  const head = readTextFile(join(gitDir, "HEAD")).trim()
  const ref = head.match(/^ref:\s+refs\/heads\/(.+)$/)
  if (ref?.[1]) return ref[1]
  return head ? head.slice(0, 12) : null
}

function findGitRoot(projectCwd: string): string | null {
  let current = projectCwd
  const { root } = parse(projectCwd)
  for (;;) {
    if (hasGitMarker(current)) return current
    if (current === root) return null
    const parent = dirname(current)
    if (parent === current) return null
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

function resolveGitDir(root: string): string {
  const marker = join(root, ".git")
  try {
    if (statSync(marker).isDirectory()) return marker
    const raw = readTextFile(marker).trim()
    const match = raw.match(/^gitdir:\s*(.+)$/i)
    if (match?.[1]) return isAbsolute(match[1]) ? match[1] : resolve(root, match[1])
  } catch {}
  return marker
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return ""
  }
}

export function saveLastOutput(text: string) {
  try { saveLastOutputFile(lastOutputPath, text) }
  catch (err) { reportSessionPersistenceFailure("save_last_output", err, { path: lastOutputPath }) }
}

function saveLastOutputFile(path: string, text: string): void {
  writeFileAtomic(path, text, { mode: 0o600 })
}

// ─── CCB-Compatible JSONL Writer ─────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 100

/** Common fields on every CCB entry */
function baseEntry(parentUuid: string | null, uuid: string, sessionId: string) {
  return {
    parentUuid,
    isSidechain: false,
    uuid,
    timestamp: new Date().toISOString(),
    userType: "external" as const,
    cwd,
    sessionId,
    version: VERSION,
    gitBranch,
  }
}

interface SessionWriterOptions {
  filePath?: string
  sessionId?: string
  registerExitHandler?: boolean
}

class SessionWriter {
  private buffer: string[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private filePath: string
  private sessionId: string
  private lastUuid: string | null = null
  private logCount = 0
  private materialized = false
  private exitHandler: () => void
  private firstUserMsg: string | null = null
  // Tracks the latest-written uuid per journal index. On appendReplace we
  // reference the prior uuid via `replacesUuid` so parseSessionJsonl can drop
  // stale tool-call snapshots (e.g. tool_call_pending → argsPreview → final)
  // and render only the final state. Append-only storage preserved; replace
  // semantics restored at read time.
  private uuidByIndex: string[] = []

  constructor(options: SessionWriterOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID()
    this.filePath = options.filePath ?? join(projectSessionsDir, `${this.sessionId}.jsonl`)
    this.exitHandler = () => this.flushSync()
    if (options.registerExitHandler !== false) process.on("exit", this.exitHandler)
  }

  private materialize(operation: string): boolean {
    if (this.materialized) return true
    try {
      writeFileSync(this.filePath, "", { mode: 0o600 })
      chmodSync(this.filePath, 0o600)
      this.materialized = true
      return true
    } catch (err) {
      reportSessionPersistenceFailure(`${operation}.materialize`, err, {
        path: this.filePath,
        pendingEntries: this.buffer.length,
      })
      return false
    }
  }

  appendLog(
    logType: string,
    text: string,
    tool?: ToolCallInfo,
    images?: SessionImageRef[],
    agentPath?: string[],
    options?: { restore?: boolean; restoreText?: string },
  ): boolean {
    const uuid = this.writeEntry(logType, text, tool, images, agentPath, undefined, options)
    if (!uuid) return false
    this.uuidByIndex.push(uuid)
    this.logCount++
    this.scheduleFlush()
    return true
  }

  /** Build + buffer one JSONL entry. Returns the entry's uuid so callers that
   *  need to track it (appendLog → uuidByIndex) or reference it later
   *  (appendReplace → replacesUuid) can do so. Does not touch logCount or
   *  uuidByIndex — those are per-call concerns for the caller. */
  private writeEntry(
    logType: string,
    text: string,
    tool?: ToolCallInfo,
    images?: SessionImageRef[],
    agentPath?: string[],
    replacesUuid?: string,
    options?: { restore?: boolean; restoreText?: string },
  ): string | null {
    const uuid = randomUUID()
    // `replacesUuid` at top level (not inside `data`) so parseSessionJsonl
    // can filter replaced entries uniformly across all types without looking
    // inside type-specific payloads.
    const withReplaces = (entry: Record<string, unknown>): Record<string, unknown> => {
      if (replacesUuid) entry["replacesUuid"] = replacesUuid
      if (options?.restore === false) entry["zapRestore"] = false
      if (typeof options?.restoreText === "string") attachRestoreTextMetadata(entry, options.restoreText)
      return entry
    }

    let entry: Record<string, unknown> | null = null

    if (logType === "user") {
      // A slash command (logged with restore:false) is not what the session is about.
      if (this.firstUserMsg === null && options?.restore !== false) this.firstUserMsg = text
      const message: Record<string, unknown> = { role: "user", content: text }
      if (images?.length) message.images = images
      entry = {
        ...baseEntry(this.lastUuid, uuid, this.sessionId),
        promptId: randomUUID(),
        type: "user",
        message,
        permissionMode: "default",
      }
    } else if (logType === "task-notification") {
      // System-synthesized user-role message — typically a `<task-notification>`
      // XML payload fired when a background task exited. Persist as role:"user"
      // (that's what the LLM saw) but stamp `subtype: "task-notification"` so
      // restore can distinguish from human input and the UI can render it as
      // a faint marker instead of a typed message.
      entry = {
        ...baseEntry(this.lastUuid, uuid, this.sessionId),
        promptId: randomUUID(),
        type: "user",
        subtype: "task-notification",
        message: { role: "user", content: text },
        permissionMode: "default",
      }
    } else if (logType === "agent") {
      entry = {
        ...baseEntry(this.lastUuid, uuid, this.sessionId),
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      }
    } else if (logType === "tool" || logType === "result") {
      // Tool calls/results stored as progress entries
      const data: Record<string, unknown> = {
        // toolCallId persists the LLM-provided tool_use id so session restore
        // can rebuild valid assistant(toolCalls=[{id}])/tool_result(toolCallId=id) pairs.
        toolCallId: tool?.id,
        toolName: tool?.name ?? "",
        arguments: tool?.arguments,
        output: tool?.output,
        success: tool?.success,
        suppression: tool?.suppression,
        meta: tool?.meta,
        logType,
      }
      // agentPath: nesting chain of subagent ids for this event. Emitted only
      // for subagent events so root-agent entries stay byte-identical to the
      // pre-grouping format (no unexpected schema change for existing tools
      // that parse JSONL).
      if (agentPath?.length) data.agentPath = agentPath
      entry = {
        ...baseEntry(this.lastUuid, uuid, this.sessionId),
        type: "progress",
        data,
      }
    } else if (logType === "thinking") {
      entry = {
        ...baseEntry(this.lastUuid, uuid, this.sessionId),
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: text }],
        },
      }
    } else if (logType === "system" || logType === "error") {
      entry = {
        ...baseEntry(this.lastUuid, uuid, this.sessionId),
        type: "system",
        subtype: logType === "error" ? "error" : "info",
        message: text,
      }
    }

    if (!entry) return null
    this.materialize(`append_${logType}`)
    this.buffer.push(JSON.stringify(withReplaces(entry)))
    this.lastUuid = uuid
    return uuid
  }

  appendSnapshot(snapshot: any, durable = false): void {
    this.materialize("append_snapshot");
    const uuid = randomUUID();
    const entry = {
      ...baseEntry(this.lastUuid, uuid, this.sessionId),
      type: "snapshot",
      snapshot,
    };
    const serialized = JSON.stringify(entry);
    const previousLastUuid = this.lastUuid;
    this.buffer.push(serialized);
    this.lastUuid = uuid;
    if (durable) {
      this.flushSync();
      const failedIndex = this.buffer.indexOf(serialized);
      if (failedIndex !== -1) {
        this.buffer.splice(failedIndex, 1);
        this.lastUuid = previousLastUuid;
        if (this.buffer.length) this.scheduleFlush();
        throw new Error("failed to persist checkpoint metadata");
      }
    } else this.scheduleFlush();
  }

  appendRewindMarker(targetTurnStartIndex: number, logIndex?: number, snapshotId?: string): void {
    this.materialize("append_rewind_marker");
    const uuid = randomUUID();
    const entry = {
      ...baseEntry(this.lastUuid, uuid, this.sessionId),
      type: "rewind-marker",
      targetTurnStartIndex,
      logIndex,
      snapshotId,
    };
    this.buffer.push(JSON.stringify(entry));
    this.lastUuid = uuid;
    this.scheduleFlush();
  }

  /** Append a rewind marker and synchronously confirm it reached disk. The
   *  caller uses this inside the file-rewind transaction; on failure the
   *  marker is removed from the retry buffer so it cannot later truncate the
   *  conversation after the file changes have been rolled back. */
  appendRewindMarkerDurable(targetTurnStartIndex: number, logIndex?: number, snapshotId?: string): void {
    const previousLastUuid = this.lastUuid;
    const uuid = randomUUID();
    const entry = JSON.stringify({
      ...baseEntry(this.lastUuid, uuid, this.sessionId),
      type: "rewind-marker",
      targetTurnStartIndex,
      logIndex,
      snapshotId,
    });
    this.materialize("append_rewind_marker");
    this.buffer.push(entry);
    this.lastUuid = uuid;
    this.flushSync();
    const markerIndex = this.buffer.indexOf(entry);
    if (markerIndex === -1) {
      this.resetLogicalLogPosition(logIndex);
      return;
    }

    this.buffer.splice(markerIndex, 1);
    this.lastUuid = previousLastUuid;
    if (this.buffer.length > 0) this.scheduleFlush();
    const failure = lastSessionPersistenceFailure;
    throw new Error(failure
      ? `failed to persist rewind marker: ${failure.message}`
      : "failed to persist rewind marker");
  }

  /** The JSONL remains append-only, but the active branch's logical journal
   *  positions restart at the rewind cutoff. This keeps later snapshots and
   *  replacement entries aligned with marker-aware replay after multiple
   *  rewind/fork cycles. */
  private resetLogicalLogPosition(logIndex?: number): void {
    if (typeof logIndex !== "number" || !Number.isFinite(logIndex) || logIndex < 0) return;
    const cutoff = Math.floor(logIndex);
    this.logCount = cutoff;
    this.uuidByIndex.length = cutoff;
  }

  appendTodoUpdate(key: string, todos: unknown[], journalLogIndex?: number): void {
    this.materialize("append_todo_update");
    const uuid = randomUUID();
    const entry = {
      ...baseEntry(this.lastUuid, uuid, this.sessionId),
      type: "todo-update",
      key,
      todos,
      ...(typeof journalLogIndex === "number" ? { journalLogIndex } : {}),
    };
    this.buffer.push(JSON.stringify(entry));
    this.lastUuid = uuid;
    this.scheduleFlush();
  }

  /** Persist per-turn API-reported token usage. `total` is what the
   *  provider counted against the context window (input + cache_read +
   *  cache_creation); `localEstimateAtTime` is what conversation.estimatedTokens
   *  reported at the same moment. The gap is the system-prompt + tools +
   *  memory overhead for this session — saved here so a restore in a fresh
   *  zap process can recover the indicator instead of cold-starting at the
   *  bare conversation estimate. */
  appendUsage(
    total: number,
    localEstimateAtTime: number,
    output: number,
    detail: PersistedUsageDetail = {},
    journalLogIndex?: number,
  ): void {
    this.materialize("append_usage");
    const uuid = randomUUID();
    const entry = {
      ...baseEntry(this.lastUuid, uuid, this.sessionId),
      type: "usage",
      total,
      localEstimateAtTime,
      output,
      ...detail,
      ...(typeof journalLogIndex === "number" ? { journalLogIndex } : {}),
    };
    this.buffer.push(JSON.stringify(entry));
    this.lastUuid = uuid;
    this.scheduleFlush();
  }

  appendReplace(logIndex: number, logType: string, text: string, tool?: ToolCallInfo, agentPath?: string[]): void {
    // Append a new entry carrying `replacesUuid` pointing at the previous
    // write for this logIndex. Chain semantics: successive replaces walk
    // A → B → C, so parseSessionJsonl collects {A, B} as replaced and keeps
    // only C. If we don't know the prior uuid (stale index across /new, or
    // legacy caller), fall back to plain append — matches pre-fix behavior
    // so nothing crashes, at the cost of one duplicated row in that edge
    // case.
    const replacesUuid = this.uuidByIndex[logIndex]
    const uuid = this.writeEntry(logType, text, tool, undefined, agentPath, replacesUuid)
    if (!uuid) return
    this.uuidByIndex[logIndex] = uuid
    this.scheduleFlush()
  }

  finalize(): void {
    if (!this.materialized && this.buffer.length === 0) return
    // Write last-prompt metadata (CCB compatible tail entry)
    if (this.firstUserMsg) {
      const entry = {
        type: "last-prompt",
        lastPrompt: this.firstUserMsg.slice(0, 200),
        sessionId: this.sessionId,
      }
      this.buffer.push(JSON.stringify(entry))
    }
    this.flushSync()
  }

  dispose(): void {
    process.off("exit", this.exitHandler)
  }

  getSessionId(): string { return this.sessionId }
  getLogCount(): number { return this.logCount }
  isMaterialized(): boolean { return this.materialized }
  getPendingWriteCount(): number { return this.buffer.length }
  flush(): void { this.flushSync() }
  getPersistenceStatus(): SessionPersistenceStatus {
    return {
      pendingWrites: this.buffer.length,
      ...(lastSessionPersistenceFailure ? { lastFailure: { ...lastSessionPersistenceFailure } } : {}),
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushSync()
    }, FLUSH_INTERVAL_MS)
  }

  private flushSync(): void {
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0, this.buffer.length)
    const data = batch.join("\n") + "\n"
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    try {
      appendFileSync(this.filePath, data, { mode: 0o600 })
      chmodSync(this.filePath, 0o600)
      this.materialized = true
      clearSessionPersistenceFailure()
    } catch (err) {
      this.buffer = [...batch, ...this.buffer]
      reportSessionPersistenceFailure("flush", err, {
        path: this.filePath,
        pendingEntries: this.buffer.length,
      })
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let currentWriter = new SessionWriter()
let journalLogIndex = 0

export const __test = {
  SessionWriter,
  saveLastOutputFile,
  resolveProjectSessionDirs,
  detectGitBranch,
  flushWriter(writer: SessionWriter): void {
    ;(writer as any).flushSync()
  },
}

export function appendLog(
  type: string,
  text: string,
  tool?: ToolCallInfo,
  images?: SessionImageRef[],
  agentPath?: string[],
  options?: { restore?: boolean; restoreText?: string },
): number | null {
  const wrote = currentWriter.appendLog(type, text, tool, images, agentPath, options)
  if (!wrote) return null
  const idx = journalLogIndex++
  return idx
}

/** Peek at the next log index that would be assigned (does not increment).
 *  Used by checkpoint snapshots to mark "pre-turn log position" so rewind
 *  can truncate logs back to that exact point. */
export function peekJournalLogIndex(): number {
  return journalLogIndex
}

/** The current session's UUID. Stable across all runs within this session,
 *  rotates on /new or session restore. Consumed by LoopAgent to scope
 *  tool-output storage directories so they can be cleaned up together. */
export function getCurrentSessionId(): string {
  return currentWriter.getSessionId()
}

export function getSessionPersistenceStatus(): SessionPersistenceStatus {
  return currentWriter.getPersistenceStatus()
}

export function replaceLog(logIndex: number, type: string, text: string, tool?: ToolCallInfo, agentPath?: string[]): void {
  currentWriter.appendReplace(logIndex, type, text, tool, agentPath)
}

export function startNewSession(): void {
  currentWriter.finalize()
  currentWriter.dispose()
  currentWriter = new SessionWriter()
  journalLogIndex = 0
}

export function appendSnapshot(snapshot: any, durable = false): void {
  currentWriter.appendSnapshot(snapshot, durable);
}

export function appendRewindMarker(targetTurnStartIndex: number, logIndex?: number, snapshotId?: string): void {
  currentWriter.appendRewindMarker(targetTurnStartIndex, logIndex, snapshotId);
}

export function appendRewindMarkerDurable(targetTurnStartIndex: number, logIndex?: number, snapshotId?: string): void {
  currentWriter.appendRewindMarkerDurable(targetTurnStartIndex, logIndex, snapshotId);
  if (typeof logIndex === "number" && Number.isFinite(logIndex) && logIndex >= 0) {
    journalLogIndex = Math.floor(logIndex);
  }
}

export function appendTodoUpdate(key: string, todos: unknown[]): void {
  currentWriter.appendTodoUpdate(key, todos, journalLogIndex);
}

/** Persist per-turn API-reported token usage so restore can prime the
 *  context-usage indicators with last-known truth instead of cold-starting
 *  at the local conversation estimate. See SessionWriter.appendUsage. */
export function appendUsage(
  total: number,
  localEstimateAtTime: number,
  output: number,
  detail: PersistedUsageDetail = {},
): void {
  currentWriter.appendUsage(total, localEstimateAtTime, output, detail, journalLogIndex);
}

/** Snapshot of the LATEST `type: "usage"` row in a session's JSONL.
 *  Returns null if the session has no usage rows (cold restore from a
 *  pre-Q2-2026 session, or a session that never completed a turn). */
export interface PersistedUsage {
  purpose?: "main" | "maintenance"
  total: number
  localEstimateAtTime: number
  output: number
  inputTokens?: number
  providerUsageReported?: boolean
  usageIncomplete?: boolean
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  cacheMissInputTokens?: number
  totalPromptInputTokens?: number
  cacheHitRatio?: number | null
  cacheReuseRatio?: number | null
  cacheWriteRatio?: number | null
  step?: number
  finishReason?: string
  cacheScope?: PromptCacheScope
  contextDiagnostics?: ContextDiagnostics
  promptCacheDiagnostics?: PromptCacheDiagnostics
  /** Logical conversation-row position at which this metadata was emitted.
   *  Rewind markers filter metadata by this stable branch-relative boundary. */
  journalLogIndex?: number
}
export type PersistedUsageDetail = Omit<PersistedUsage, "total" | "localEstimateAtTime" | "output" | "journalLogIndex">

export interface PersistedTodoUpdate {
  key: string
  todos: unknown[]
  journalLogIndex?: number
}

export interface RestoredUsageContext {
  contextTokens: number
  promptOverhead: number
  contextPending: boolean
}

const RECENT_USAGE_DEFAULT_LIMIT = 12

export function resolveRestoredUsageContext(
  persisted: PersistedUsage,
  localEstimate: number,
  currentPromptOverhead: number,
): RestoredUsageContext {
  const total = nonNegativeFinite(persisted.total)
  const localAtTime = nonNegativeFinite(persisted.localEstimateAtTime)
  const local = nonNegativeFinite(localEstimate)
  const currentOverhead = nonNegativeFinite(currentPromptOverhead)
  const recoveredOverhead = total - localAtTime
  const promptOverhead = recoveredOverhead > 0 ? recoveredOverhead : currentOverhead
  const localFallback = Math.max(0, local + promptOverhead)
  return {
    // Persisted total is the previous request's exact prompt. The restored
    // conversation already includes that request's generated output, so the
    // actionable next-prompt value is the current local transcript plus the
    // recovered provider overhead, not the stale historical total itself.
    contextTokens: localFallback,
    promptOverhead,
    contextPending: false,
  }
}

export function resolveUnmeasuredUsageContext(localEstimate: number): RestoredUsageContext {
  return {
    contextTokens: nonNegativeFinite(localEstimate),
    promptOverhead: 0,
    contextPending: true,
  }
}

export function parseLatestUsageJsonl(raw: string): PersistedUsage | null {
  return parseRecentUsageJsonl(raw, 1).at(-1) ?? null;
}

export function parseRecentUsageJsonl(raw: string, limit = RECENT_USAGE_DEFAULT_LIMIT): PersistedUsage[] {
  const max = typeof limit === "number" && Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : RECENT_USAGE_DEFAULT_LIMIT;
  if (max === 0) return [];
  const recent = parseUsageJournalJsonl(raw).filter(usage => usage.purpose !== "maintenance");
  return recent.slice(-max);
}

/** Replay usage metadata through rewind markers. Positioned entries beyond a
 *  marker's logical journal cutoff belong to the abandoned branch and are
 *  removed. Legacy rows without positions are retained for compatibility. */
export function parseUsageJournalJsonl(raw: string): PersistedUsage[] {
  let usages: PersistedUsage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const usage = parseUsageJsonEntry(entry);
      if (usage) {
        usages.push(usage);
        continue;
      }
      if (entry?.type === "rewind-marker" && isJournalIndex(entry.logIndex)) {
        usages = usages.filter((candidate) => (
          candidate.journalLogIndex === undefined
          || candidate.journalLogIndex <= entry.logIndex
        ));
      }
    } catch {}
  }
  return usages;
}

function parseUsageJsonEntry(e: unknown): PersistedUsage | null {
  if (
    isRecord(e) &&
    e.type === "usage" &&
    typeof e.total === "number" &&
    typeof e.localEstimateAtTime === "number"
  ) {
    const contextDiagnostics = sanitizeContextDiagnostics(e.contextDiagnostics);
    const promptCacheDiagnostics = sanitizePromptCacheDiagnostics(e.promptCacheDiagnostics);
    const cacheScope = sanitizePromptCacheScope(e.cacheScope);
    return {
      ...(e.purpose === "maintenance" ? { purpose: "maintenance" as const } : {}),
      total: nonNegativeFinite(e.total),
      localEstimateAtTime: nonNegativeFinite(e.localEstimateAtTime),
      output: nonNegativeFinite(e.output),
      ...(typeof e.inputTokens === "number" ? { inputTokens: nonNegativeFinite(e.inputTokens) } : {}),
      ...(typeof e.providerUsageReported === "boolean" ? { providerUsageReported: e.providerUsageReported } : {}),
      ...(e.usageIncomplete === true ? { usageIncomplete: true } : {}),
      ...(typeof e.cacheReadInputTokens === "number" ? { cacheReadInputTokens: nonNegativeFinite(e.cacheReadInputTokens) } : {}),
      ...(typeof e.cacheCreationInputTokens === "number" ? { cacheCreationInputTokens: nonNegativeFinite(e.cacheCreationInputTokens) } : {}),
      ...(typeof e.cacheMissInputTokens === "number" ? { cacheMissInputTokens: nonNegativeFinite(e.cacheMissInputTokens) } : {}),
      ...(typeof e.totalPromptInputTokens === "number" ? { totalPromptInputTokens: nonNegativeFinite(e.totalPromptInputTokens) } : {}),
      ...(typeof e.cacheHitRatio === "number" || e.cacheHitRatio === null ? { cacheHitRatio: ratioOrNull(e.cacheHitRatio) } : {}),
      ...(typeof e.cacheReuseRatio === "number" || e.cacheReuseRatio === null ? { cacheReuseRatio: ratioOrNull(e.cacheReuseRatio) } : {}),
      ...(typeof e.cacheWriteRatio === "number" || e.cacheWriteRatio === null ? { cacheWriteRatio: ratioOrNull(e.cacheWriteRatio) } : {}),
      ...(typeof e.step === "number" && Number.isFinite(e.step) && e.step >= 0 ? { step: e.step } : {}),
      ...(typeof e.finishReason === "string" ? { finishReason: e.finishReason } : {}),
      ...(cacheScope ? { cacheScope } : {}),
      ...(contextDiagnostics ? { contextDiagnostics } : {}),
      ...(promptCacheDiagnostics ? { promptCacheDiagnostics } : {}),
      ...(isJournalIndex(e.journalLogIndex) ? { journalLogIndex: e.journalLogIndex } : {}),
    };
  }
  return null;
}

function nonNegativeFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function ratioOrNull(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readLatestUsage(sessionId: string): PersistedUsage | null {
  const filePath = sessionJsonlPathFor(sessionId);
  try {
    return parseLatestUsageJsonl(readFileSync(filePath, "utf-8"));
  } catch { return null; }
}

export function readRecentUsages(sessionId: string, limit = RECENT_USAGE_DEFAULT_LIMIT): PersistedUsage[] {
  const filePath = sessionJsonlPathFor(sessionId);
  try {
    return parseRecentUsageJsonl(readFileSync(filePath, "utf-8"), limit);
  } catch { return []; }
}

/** Parse raw JSONL contents and return a key→todos map (tail-wins).
 *  Exported for unit tests; production code uses readTodoUpdates. */
export function parseTodoUpdates(raw: string): Map<string, unknown[]> {
  const latest = new Map<string, unknown[]>();
  for (const update of parseTodoUpdateJournalJsonl(raw)) latest.set(update.key, update.todos);
  return latest;
}

/** Marker-aware todo journal used both by restore and by session-fork seeding. */
export function parseTodoUpdateJournalJsonl(raw: string): PersistedTodoUpdate[] {
  let updates: PersistedTodoUpdate[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type === "todo-update" && typeof e.key === "string" && Array.isArray(e.todos)) {
        updates.push({
          key: e.key,
          todos: e.todos,
          ...(isJournalIndex(e.journalLogIndex) ? { journalLogIndex: e.journalLogIndex } : {}),
        });
      } else if (e?.type === "rewind-marker" && isJournalIndex(e.logIndex)) {
        updates = updates.filter((candidate) => (
          candidate.journalLogIndex === undefined
          || candidate.journalLogIndex <= e.logIndex
        ));
      }
    } catch {}
  }
  return updates;
}

function isJournalIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readTodoUpdates(sessionId: string): Map<string, unknown[]> {
  const filePath = sessionJsonlPathFor(sessionId);
  try {
    return parseTodoUpdates(readFileSync(filePath, "utf-8"));
  } catch { return new Map(); }
}

/** Resolve the JSONL path for a given session id. All JSONL readers
 *  (snapshot / rewind / todo) should call this instead of re-building. */
function sessionFilePathInDir(dir: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new SessionLoadError(
      "invalid_id",
      sessionId,
      "invalid session id: expected a storage id, not a file path",
    )
  }
  const filename = `${sessionId}.jsonl`;
  const root = resolve(dir)
  const path = resolve(root, filename)
  if (dirname(path) !== root) {
    throw new SessionLoadError("invalid_id", sessionId, "session path escaped its storage directory")
  }
  return path
}

function sessionJsonlPathFor(sessionId: string): string {
  for (const dir of projectSessionDirs()) {
    const path = sessionFilePathInDir(dir, sessionId)
    if (existsSync(path)) {
      let stat
      try { stat = lstatSync(path) } catch (error) { throw sessionReadError(sessionId, error) }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new SessionLoadError("unreadable", sessionId, "session path is not a regular file")
      }
      return path;
    }
  }
  return sessionFilePathInDir(projectSessionsDir, sessionId)
}

export function readSnapshotEntries(sessionId: string): Array<{ type: "snapshot"; snapshot: any }> {
  const filePath = sessionJsonlPathFor(sessionId);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const out: Array<{ type: "snapshot"; snapshot: any }> = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.type === "snapshot" && e.snapshot) {
          out.push({ type: "snapshot", snapshot: e.snapshot });
        }
      } catch {}
    }
    return out;
  } catch { return []; }
}

export function readRewindMarkers(sessionId: string): number[] {
  const filePath = sessionJsonlPathFor(sessionId);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const markers: number[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.type === "rewind-marker" && typeof e.targetTurnStartIndex === "number") {
          markers.push(e.targetTurnStartIndex);
        }
      } catch {}
    }
    return markers;
  } catch { return []; }
}

/** Checkpoint-related JSONL entries (snapshots + rewind-markers) returned in
 *  file order. Consumers like CheckpointManager.hydrateFromJsonl walk the
 *  stream and apply each entry: snapshots hydrate the index, rewind-markers
 *  prune forward snapshots (so /load faithfully replays fork semantics). */
export type CheckpointJournalEntry =
  | { type: "snapshot"; snapshot: any }
  | { type: "rewind-marker"; sessionId: string; targetTurnStartIndex: number; logIndex?: number; snapshotId?: string };

function parseCheckpointJournalJsonl(raw: string, sessionId: string): CheckpointJournalEntry[] {
  const out: CheckpointJournalEntry[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e.type === "snapshot" && e.snapshot) {
        out.push({ type: "snapshot", snapshot: e.snapshot })
      } else if (e.type === "rewind-marker" && typeof e.targetTurnStartIndex === "number") {
        out.push({
          type: "rewind-marker",
          sessionId,
          targetTurnStartIndex: e.targetTurnStartIndex,
          ...(typeof e.logIndex === "number" ? { logIndex: e.logIndex } : {}),
          ...(typeof e.snapshotId === "string" ? { snapshotId: e.snapshotId } : {}),
        })
      }
    } catch {}
  }
  return out
}

export function readCheckpointJournal(sessionId: string): CheckpointJournalEntry[] {
  const filePath = sessionJsonlPathFor(sessionId)
  try {
    return parseCheckpointJournalJsonl(readFileSync(filePath, "utf-8"), sessionId)
  } catch { return [] }
}

function effectiveForkSnapshots(entries: CheckpointJournalEntry[]): any[] {
  let snapshots: any[] = [];
  for (const entry of entries) {
    if (entry.type === "snapshot") {
      const existing = snapshots.findIndex(snapshot => snapshot?.id === entry.snapshot?.id);
      if (existing >= 0) snapshots[existing] = entry.snapshot;
      else snapshots.push(entry.snapshot);
    } else {
      if (typeof entry.snapshotId === "string") {
        const targetIndex = snapshots.findIndex((snapshot) => snapshot?.id === entry.snapshotId);
        if (targetIndex >= 0) snapshots = snapshots.slice(0, targetIndex);
      } else {
        snapshots = snapshots.filter((snapshot) => (
          typeof snapshot?.turnStartIndex !== "number"
          || snapshot.turnStartIndex < entry.targetTurnStartIndex
        ));
      }
    }
  }
  return snapshots;
}

export interface SessionForkMetadata {
  checkpointJournal: CheckpointJournalEntry[]
  todoUpdates: PersistedTodoUpdate[]
  usageJournal: PersistedUsage[]
  todos: Map<string, unknown[]>
  usages: PersistedUsage[]
}

function parseForkMetadata(raw: string, sessionId: string): SessionForkMetadata {
  const todoUpdates = parseTodoUpdateJournalJsonl(raw);
  const usageJournal = parseUsageJournalJsonl(raw);
  const todos = new Map<string, unknown[]>();
  for (const update of todoUpdates) todos.set(update.key, update.todos);
  return {
    checkpointJournal: parseCheckpointJournalJsonl(raw, sessionId),
    todoUpdates,
    usageJournal,
    todos,
    usages: usageJournal.filter(usage => usage.purpose !== "maintenance").slice(-RECENT_USAGE_DEFAULT_LIMIT),
  };
}

function readForkMetadata(sourceSessionId: string): SessionForkMetadata {
  try {
    return parseForkMetadata(
      readFileSync(sessionJsonlPathFor(sourceSessionId), "utf-8"),
      sourceSessionId,
    );
  } catch {
    return {
      checkpointJournal: [],
      todoUpdates: [],
      usageJournal: [],
      todos: new Map(),
      usages: [],
    };
  }
}

function seedForkMetadata(
  writer: SessionWriter,
  sourceSessionId: string,
  metadata: SessionForkMetadata = readForkMetadata(sourceSessionId),
): void {
  const forkSessionId = writer.getSessionId();
  let parentId: string | null = null;
  for (const source of effectiveForkSnapshots(metadata.checkpointJournal)) {
    if (!source || typeof source !== "object") continue;
    // A source UI index describes the source process's live transcript. The
    // fork renders restored chunks/dividers differently, so discard it and
    // let dialog-rewind translate the durable journal boundary instead.
    const { uiLogIndex: _sourceUiLogIndex, ...durableSource } = source;
    const snapshot: Record<string, unknown> = {
      ...durableSource,
      sessionId: forkSessionId,
      parentId,
    };
    writer.appendSnapshot(snapshot);
    parentId = typeof snapshot.id === "string" ? snapshot.id : parentId;
  }

  const todoUpdates: PersistedTodoUpdate[] = metadata.todoUpdates.length > 0
    ? metadata.todoUpdates
    : Array.from(metadata.todos, ([key, todos]) => ({ key, todos }));
  for (const update of todoUpdates) {
    writer.appendTodoUpdate(update.key, update.todos, update.journalLogIndex);
  }
  const usageJournal = metadata.usageJournal.length > 0 ? metadata.usageJournal : metadata.usages;
  for (const usage of usageJournal) {
    const { total, localEstimateAtTime, output, journalLogIndex, ...detail } = usage;
    writer.appendUsage(total, localEstimateAtTime, output, detail, journalLogIndex);
  }
}

export function setActiveSession(
  logs: SessionLog[],
  options: { sourceSessionId?: string; metadata?: SessionForkMetadata } = {},
): void {
  // Never abandon buffered rows from the current session. In particular,
  // selecting the active session immediately after a turn must either flush
  // successfully or leave the current writer untouched.
  currentWriter.flush()
  if (currentWriter.getPendingWriteCount() > 0) {
    throw new Error("cannot switch sessions while current session writes are pending")
  }

  const nextWriter = new SessionWriter()
  let nextJournalLogIndex = 0
  for (const log of logs) {
    const wrote = nextWriter.appendLog(log.type, log.text, log.tool, log.images, log.agentPath, {
      restore: log.restore,
      restoreText: log.restoreText,
    })
    if (wrote) nextJournalLogIndex++
  }
  if (options.sourceSessionId) {
    seedForkMetadata(nextWriter, options.sourceSessionId, options.metadata)
  }
  nextWriter.flush()
  if (nextWriter.getPendingWriteCount() > 0) {
    nextWriter.dispose()
    throw new Error("failed to persist restored session fork")
  }

  currentWriter.finalize()
  if (currentWriter.getPendingWriteCount() > 0) {
    nextWriter.dispose()
    throw new Error("cannot finalize current session before switching")
  }
  currentWriter.dispose()
  currentWriter = nextWriter
  journalLogIndex = nextJournalLogIndex
}

// ─── CCB-Compatible Reader ───────────────────────────────────────────────────

const HEAD_SCAN_MAX_BYTES = RESTORE_TEXT_INLINE_MAX_BYTES * 8 + 16 * 1024
const TAIL_BYTES = 64 * 1024

/** Extract first user prompt and sessionId from a bounded file prefix.
 *  The first row may contain an inline long-paste restore payload, so a 4 KiB
 *  prefix is not enough to produce one complete JSONL record. The bound covers
 *  the worst JSON escaping expansion of our 64 KiB inline restore limit while
 *  keeping session listing independent of total transcript size. */
function readHeadInfo(filePath: string): { sessionId?: string; firstPrompt?: string; createdAt?: string } | null {
  try {
    const size = statSync(filePath).size
    const readLen = Math.min(size, HEAD_SCAN_MAX_BYTES)
    const fd = openSync(filePath, "r")
    try {
      const buf = Buffer.alloc(readLen)
      const bytesRead = readSync(fd, buf, 0, readLen, 0)
      return parseHeadInfo(buf.subarray(0, bytesRead).toString("utf-8"))
    } finally { closeSync(fd) }
  } catch { return null }
}

function parseHeadInfo(raw: string): { sessionId?: string; firstPrompt?: string; createdAt?: string } {
  let sessionId: string | undefined
  let firstPrompt: string | undefined
  let createdAt: string | undefined
  for (const line of raw.split("\n")) {
    if (!line) continue
    try {
      const e = JSON.parse(line)
      if (!createdAt && e.timestamp) createdAt = e.timestamp
      if (!sessionId && e.sessionId) sessionId = e.sessionId
      if (!firstPrompt && e.type === "user" && e.zapRestore !== false) {
        const msg = e.message
        if (typeof msg?.content === "string") firstPrompt = msg.content
      }
      if (sessionId && firstPrompt) break
    } catch {}
  }
  return { sessionId, firstPrompt, createdAt }
}

/** Read last-prompt from tail of file */
function readTailPrompt(filePath: string): string | null {
  try {
    const size = statSync(filePath).size
    const readLen = Math.min(size, TAIL_BYTES)
    const fd = openSync(filePath, "r")
    try {
      const buf = Buffer.alloc(readLen)
      readSync(fd, buf, 0, readLen, size - readLen)
      return parseTailPrompt(buf.toString("utf-8"))
    } finally { closeSync(fd) }
  } catch {}
  return null
}

/** Title for the session list. The tail `last-prompt` row is trusted unless it
 *  is a slash command (older builds recorded `/sessions` etc. as the first
 *  prompt); then the first real prompt wins. A session with no real prompt at
 *  all (only slash commands) has nothing worth resuming and gets no entry. */
function resolveSessionPreview(tailPrompt: string | null, firstPrompt: string | undefined): string {
  if (tailPrompt && !/^\/[A-Za-z][\w:-]*(\s|$)/.test(tailPrompt)) return tailPrompt
  return firstPrompt ?? ""
}

function parseTailPrompt(raw: string): string | null {
  const lines = raw.split("\n").filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i])
      if (e.type === "last-prompt" && typeof e.lastPrompt === "string") return e.lastPrompt
    } catch {}
  }
  return null
}

/** Parse raw JSONL session contents into SessionLog[] (works with both CCB
 *  and zapcode format). Exported for unit tests; production code uses
 *  `parseSessionFile` which reads a path. */
type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJsonObjectLine(line: string): JsonObject | null {
  try {
    const parsed = JSON.parse(line) as unknown
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((entry): entry is string => typeof entry === "string")
  return out.length === value.length ? out : undefined
}

function sessionImages(value: unknown): SessionImageRef[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: SessionImageRef[] = []
  for (const entry of value) {
    if (!isJsonObject(entry)) return undefined
    const { filePath, source, mediaType } = entry
    if (typeof filePath !== "string" || typeof source !== "string" || typeof mediaType !== "string") {
      return undefined
    }
    out.push({ filePath, source, mediaType })
  }
  return out.length > 0 ? out : undefined
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  const parts: string[] = []
  for (const block of value) {
    if (isJsonObject(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text)
    }
  }
  return parts.join("\n")
}

export function parseSessionJsonl(raw: string): SessionLog[] {
  const lines = raw.split("\n").filter(Boolean)

  // Pre-parse once so we can (a) resolve `replacesUuid` chains before
  // emitting logs and (b) avoid re-parsing each line twice. Each later entry
  // that carries `replacesUuid` supersedes the one it points at; chained
  // replaces (A → B → C) all get pruned except the tail. Absent field =
  // legacy or non-replaceable entry, keep as-is.
  const parsed = lines.map(parseJsonObjectLine)
  const replacedUuids = new Set<string>()
  for (const e of parsed) {
    if (e && typeof e.replacesUuid === "string") {
      replacedUuids.add(e.replacesUuid)
    }
  }

  const logs: SessionLog[] = []

  for (const e of parsed) {
    if (!e) continue
    if (typeof e.uuid === "string" && replacedUuids.has(e.uuid)) continue
    try {

      // CCB user entry
      const message = isJsonObject(e.message) ? e.message : undefined
      if (e.type === "user" && message) {
        const content = message.content
        const images = sessionImages(message.images)
        const restore = e.zapRestore === false ? false : undefined
        const restoreText = resolveRestoreTextFromEntry(e)
        // Distinguish a human typed message from a system-synthesized one
        // (e.g. background-task completion XML). The `subtype` field is
        // written by `task-notification` entries above; absent → human input.
        const logType: SessionLog["type"] = e.subtype === "task-notification"
          ? "task-notification"
          : "user"
        if (typeof content === "string") {
          const text = restoreText.unavailable ? markUnavailableRestoreText(content) : content
          const log: SessionLog = { type: logType, text, images }
          if (restore === false) log.restore = false
          if (restoreText.text !== undefined) log.restoreText = restoreText.text
          logs.push(log)
        } else if (Array.isArray(content)) {
          // CCB format: user-role arrays often carry tool_result blocks alongside text.
          // Emit separate "result" logs so restore can rebuild tool pairs with correct ids.
          for (const block of content) {
            if (isJsonObject(block) && block.type === "tool_result") {
              const output = textFromContent(block.content)
              logs.push({
                type: "result",
                text: output,
                tool: {
                  id: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
                  name: "",
                  output,
                  success: block.is_error !== true,
                },
              })
            }
          }
          const textParts = content
            .filter((block): block is JsonObject => isJsonObject(block) && block.type === "text" && typeof block.text === "string")
            .map((block) => block.text as string)
          if (textParts.length > 0 || images?.length) {
            const text = textParts.join("\n")
            const log: SessionLog = {
              type: logType,
              text: restoreText.unavailable ? markUnavailableRestoreText(text) : text,
              images,
            }
            if (restore === false) log.restore = false
            if (restoreText.text !== undefined) log.restoreText = restoreText.text
            logs.push(log)
          }
        }
      }

      // CCB assistant entry
      else if (e.type === "assistant" && message) {
        const content = message.content
        if (typeof content === "string") {
          logs.push({ type: "agent", text: content })
        } else if (Array.isArray(content)) {
          const texts: string[] = []
          for (const block of content) {
            if (!isJsonObject(block)) continue
            if (block.type === "text" && typeof block.text === "string") texts.push(block.text)
            else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
              logs.push({ type: "thinking", text: block.thinking })
            }
            else if (block.type === "tool_use" && typeof block.name === "string") {
              logs.push({
                type: "tool",
                text: block.name,
                tool: {
                  id: typeof block.id === "string" ? block.id : undefined,
                  name: block.name,
                  arguments: isJsonObject(block.input) ? block.input : undefined,
                },
              })
            }
          }
          if (texts.length > 0) logs.push({ type: "agent", text: texts.join("\n") })
        }
      }

      // CCB progress entry (tool execution data from zapcode)
      else if (e.type === "progress" && isJsonObject(e.data) && e.data.logType) {
        const d = e.data
        // Back-compat: older sessions baked the subagent tag into toolName as
        // `[sa_xxx] real_tool`. Peel it off so group-logs sees a clean name +
        // agentPath, matching the live format. Sessions predating either
        // format just render flat (no agentPath, no stripping).
        let toolName: string = typeof d.toolName === "string" ? d.toolName : ""
        let parsedAgentPath = stringArray(d.agentPath)
        if (!parsedAgentPath) {
          const m = /^\[(sa_[A-Za-z0-9_]+)\]\s+(.+)$/.exec(toolName)
          if (m) {
            parsedAgentPath = [m[1]]
            toolName = m[2]
          }
        }
        logs.push({
          type: String(d.logType),
          text: typeof d.output === "string" ? d.output : toolName,
          tool: toolName ? {
            id: typeof d.toolCallId === "string" ? d.toolCallId : undefined,
            name: toolName,
            arguments: isJsonObject(d.arguments) ? d.arguments : undefined,
            output: typeof d.output === "string" ? d.output : undefined,
            success: typeof d.success === "boolean" ? d.success : undefined,
            suppression: d.suppression === "duplicate" ? "duplicate" : undefined,
            meta: d.meta,
          } : undefined,
          agentPath: parsedAgentPath,
        })
      }

      // CCB system entry
      else if (e.type === "system" && typeof e.message === "string") {
        logs.push({ type: e.subtype === "error" ? "error" : "system", text: e.message })
      }

      // Snapshot entries — not part of the conversation restore stream
      // (handled separately via readCheckpointJournal).
      else if (e.type === "snapshot") {
        // skip
      }

      // Rewind markers — truncate the logs accumulated so far back to
      // the pre-rewind position. Mirrors in-memory rewind's
      // setLogs(prev.slice(0, logIndex)) so /load reconstructs the same
      // forked state the user sees at rewind time. Markers without
      // logIndex (pre-fix JSONL) are no-ops — prior behavior preserved.
      else if (e.type === "rewind-marker") {
        if (typeof e.logIndex === "number" && e.logIndex >= 0 && e.logIndex < logs.length) {
          logs.length = e.logIndex;
        }
      }

      // Zapcode legacy "log" format (from old zapcode JSONL)
      else if (e.type === "log") {
        const log: SessionLog = {
          type: typeof e.logType === "string" ? e.logType : "system",
          text: typeof e.text === "string" ? e.text : "",
          tool: isJsonObject(e.tool) && typeof e.tool.name === "string"
            ? {
              id: typeof e.tool.id === "string" ? e.tool.id : undefined,
              name: e.tool.name,
              arguments: isJsonObject(e.tool.arguments) ? e.tool.arguments : undefined,
              output: typeof e.tool.output === "string" ? e.tool.output : undefined,
              success: typeof e.tool.success === "boolean" ? e.tool.success : undefined,
              suppression: e.tool.suppression === "duplicate" ? "duplicate" : undefined,
              meta: e.tool.meta,
            }
            : undefined,
        }
        if (e.zapRestore === false) log.restore = false
        const restoreText = resolveRestoreTextFromEntry(e)
        if (restoreText.unavailable) log.text = markUnavailableRestoreText(log.text)
        if (restoreText.text !== undefined) log.restoreText = restoreText.text
        logs.push(log)
      }
    } catch {}
  }

  return logs
}

function sessionReadError(sessionId: string, error: unknown): SessionLoadError {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : ""
  if (code === "ENOENT") {
    return new SessionLoadError("not_found", sessionId, `session '${sessionId}' was not found`, { cause: error })
  }
  if (code === "EACCES" || code === "EPERM") {
    return new SessionLoadError(
      "permission_denied",
      sessionId,
      `session '${sessionId}' cannot be read: permission denied`,
      { cause: error },
    )
  }
  return new SessionLoadError("unreadable", sessionId, `session '${sessionId}' cannot be read`, { cause: error })
}

function parseLoadedSessionRaw(raw: string, sessionId: string): SessionLog[] {
  const lines = raw.split("\n")
  const nonEmpty = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim().length > 0)
  if (nonEmpty.length === 0) {
    throw new SessionLoadError("empty", sessionId, `session '${sessionId}' is empty`)
  }

  const lastNonEmptyIndex = nonEmpty.at(-1)!.index
  let validObjectRows = 0
  for (const { line, index } of nonEmpty) {
    if (parseJsonObjectLine(line)) {
      validObjectRows++
      continue
    }
    // A process crash may leave one unfinished final append. Recover the
    // preceding durable rows, but never silently skip corruption in the
    // middle of the journal or a newline-terminated malformed row.
    const recoverableTornTail = index === lastNonEmptyIndex && !raw.endsWith("\n")
    if (!recoverableTornTail) {
      throw new SessionLoadError("corrupt", sessionId, `session '${sessionId}' contains malformed JSONL`)
    }
  }
  if (validObjectRows === 0) {
    throw new SessionLoadError("corrupt", sessionId, `session '${sessionId}' contains malformed JSONL`)
  }

  const logs = parseSessionJsonl(raw)
  if (logs.length === 0) {
    throw new SessionLoadError("empty", sessionId, `session '${sessionId}' has no restorable messages`)
  }
  return logs
}

function ensureCurrentSessionPersisted(sessionId: string): void {
  if (sessionId !== currentWriter.getSessionId()) return
  currentWriter.flush()
  if (currentWriter.getPendingWriteCount() > 0) {
    throw new SessionLoadError(
      "unreadable",
      sessionId,
      "current session has unpersisted writes; refusing to load a stale fork",
    )
  }
}

function readSavedSessionRaw(sessionId: string): string {
  const filePath = sessionJsonlPathFor(sessionId)
  ensureCurrentSessionPersisted(sessionId)
  try {
    return readFileSync(filePath, "utf-8")
  } catch (error) {
    throw sessionReadError(sessionId, error)
  }
}

function parseSessionFileBestEffort(filePath: string): SessionLog[] {
  try {
    return parseSessionJsonl(readFileSync(filePath, "utf-8"))
  } catch {
    return []
  }
}

async function readSavedSessionRawAsync(sessionId: string): Promise<string> {
  const filePath = sessionJsonlPathFor(sessionId)
  ensureCurrentSessionPersisted(sessionId)
  try {
    return await readFileAsync(filePath, "utf-8")
  } catch (error) {
    throw sessionReadError(sessionId, error)
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function listSavedSessions(): SessionInfo[] {
  // Keep the active session's preview/list entry aligned with what selecting
  // it will load. A failed flush remains visible through persistence status;
  // loadSavedSession will refuse to fork that stale disk view.
  currentWriter.flush()
  const results: (SessionInfo & { _ts: number })[] = []
  const seen = new Set<string>()

  // JSONL sessions (per-project — includes both CCB and zapcode sessions)
  for (const dir of projectSessionDirs()) {
    try {
      const files = readdirSync(dir).filter(f => f.endsWith(".jsonl"))
      for (const f of files) {
        try {
          const id = f.slice(0, -".jsonl".length)
          if (!isValidSessionId(id) || seen.has(id)) continue
          const filePath = join(dir, f)
          const fileStat = lstatSync(filePath)
          if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue
          const head = readHeadInfo(filePath)
          if (!head) continue

          const preview = resolveSessionPreview(readTailPrompt(filePath), head.firstPrompt)
          if (!preview) continue

          const date = new Date(fileStat.mtime)
          const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
          const size = fileStat.size

          seen.add(id)
          results.push({
            id,
            name: preview.replace(/\s+/g, " ").trim().slice(0, 50),
            date: dateStr,
            messageCount: Math.max(1, Math.round(size / 500)), // estimate
            preview,
            _ts: date.getTime(),
          })
        } catch {}
      }
    } catch {}
  }

  results.sort((a, b) => b._ts - a._ts)
  return results.map(({ _ts, ...r }) => r)
}

interface SavedSessionCandidate {
  id: string
  filePath: string
  size: number
  mtimeMs: number
}

export interface SavedSessionPage {
  sessions: SessionInfo[]
  nextOffset: number | null
}

const SESSION_INDEX_TTL_MS = 30_000
let savedSessionIndexCache: {
  key: string
  expiresAt: number
  candidates: SavedSessionCandidate[]
} | null = null

async function buildSavedSessionIndex(forceRefresh: boolean): Promise<SavedSessionCandidate[]> {
  currentWriter.flush()
  const dirs = projectSessionDirs()
  const key = dirs.map(dir => resolve(dir)).join("\0")
  if (
    !forceRefresh
    && savedSessionIndexCache?.key === key
    && savedSessionIndexCache.expiresAt > Date.now()
  ) {
    return savedSessionIndexCache.candidates
  }

  const candidates: SavedSessionCandidate[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    let names: string[] = []
    try {
      const entries = await readdirAsync(dir, { withFileTypes: true })
      names = entries
        .filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(entry => entry.name)
    } catch {}

    for (let start = 0; start < names.length; start += 32) {
      const batch = names.slice(start, start + 32)
      const inspected = await Promise.all(batch.map(async (name): Promise<SavedSessionCandidate | null> => {
        const id = name.slice(0, -".jsonl".length)
        if (!isValidSessionId(id) || seen.has(id)) return null
        const filePath = resolve(dir, name)
        if (dirname(filePath) !== resolve(dir)) return null
        try {
          const stat = await lstatAsync(filePath)
          if (!stat.isFile() || stat.isSymbolicLink()) return null
          return { id, filePath, size: stat.size, mtimeMs: stat.mtimeMs }
        } catch {
          return null
        }
      }))
      for (const candidate of inspected) {
        if (!candidate || seen.has(candidate.id)) continue
        seen.add(candidate.id)
        candidates.push(candidate)
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id))
  savedSessionIndexCache = {
    key,
    expiresAt: Date.now() + SESSION_INDEX_TTL_MS,
    candidates,
  }
  return candidates
}

async function readSavedSessionInfo(candidate: SavedSessionCandidate): Promise<SessionInfo | null> {
  let handle
  try {
    handle = await openAsync(candidate.filePath, "r")
    const headLength = Math.min(candidate.size, HEAD_SCAN_MAX_BYTES)
    const headBuffer = Buffer.alloc(headLength)
    const headRead = await handle.read(headBuffer, 0, headLength, 0)
    const head = parseHeadInfo(headBuffer.subarray(0, headRead.bytesRead).toString("utf-8"))

    const tailLength = Math.min(candidate.size, TAIL_BYTES)
    const tailBuffer = Buffer.alloc(tailLength)
    const tailRead = await handle.read(tailBuffer, 0, tailLength, Math.max(0, candidate.size - tailLength))
    const preview = resolveSessionPreview(
      parseTailPrompt(tailBuffer.subarray(0, tailRead.bytesRead).toString("utf-8")),
      head.firstPrompt,
    )
    if (!preview) return null

    const date = new Date(candidate.mtimeMs)
    return {
      id: candidate.id,
      name: preview.replace(/\s+/g, " ").trim().slice(0, 50),
      date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
      messageCount: Math.max(1, Math.round(candidate.size / 500)),
      preview,
    }
  } catch {
    return null
  } finally {
    try { await handle?.close() } catch {}
  }
}

/** Async, mtime-ordered page used by the TUI session browser. */
export async function listSavedSessionsPage(
  options: { offset?: number; limit?: number } = {},
): Promise<SavedSessionPage> {
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)))
  const candidates = await buildSavedSessionIndex(offset === 0)
  const sessions: SessionInfo[] = []
  let cursor = Math.min(offset, candidates.length)

  while (cursor < candidates.length && sessions.length < limit) {
    const remaining = limit - sessions.length
    const batch = candidates.slice(cursor, cursor + Math.min(16, remaining))
    cursor += batch.length
    const infos = await Promise.all(batch.map(readSavedSessionInfo))
    for (const info of infos) if (info) sessions.push(info)
  }

  return {
    sessions,
    nextOffset: cursor < candidates.length ? cursor : null,
  }
}

export function loadSavedSession(id: string): SessionLog[] {
  return injectRestoreDividers(parseLoadedSessionRaw(readSavedSessionRaw(id), id))
}

export interface PreparedSessionRestore {
  sourceSessionId: string
  sessionLogs: SessionLog[]
  metadata: SessionForkMetadata
}

/** Read and validate a restore without mutating the active writer. */
export async function prepareSavedSession(id: string): Promise<PreparedSessionRestore> {
  const raw = await readSavedSessionRawAsync(id)
  return {
    sourceSessionId: id,
    sessionLogs: injectRestoreDividers(parseLoadedSessionRaw(raw, id)),
    metadata: {
      ...parseForkMetadata(raw, id),
    },
  }
}

/** Read the active session's persisted logs, flushing the current writer first
 *  so commands that fall back to JSONL see the latest buffered entries. Unlike
 *  loadSavedSession(), this returns only persisted rows and does not inject UI
 *  dividers. */
export function readCurrentSessionLogs(): SessionLog[] {
  currentWriter.flush()
  return parseSessionFileBestEffort(sessionJsonlPathFor(currentWriter.getSessionId()))
}

/** Re-insert run-boundary dividers between turns on restore. Live runs emit
 *  these on `run_ended` (useAgentRunner.ts), but they're UI-only and not
 *  persisted — without this, a multi-turn restored session renders as one
 *  continuous stream. Live rule: divider sits at the BOTTOM of every
 *  completed turn, so we emit: (a) one divider before every `user` log
 *  except the first, and (b) one trailing divider after the last log
 *  unless the session ends on a user message (interrupted mid-turn).
 *  `sessionLogsToMessages` ignores unknown log types, so these are
 *  invisible to the LLM context rebuild. */
function injectRestoreDividers(logs: SessionLog[]): SessionLog[] {
  if (logs.length === 0) return logs
  const out: SessionLog[] = []
  let seenUser = false
  for (const l of logs) {
    // task-notification entries open a new turn the same way a user
    // message does (the LLM saw them as role:user), so apply the same
    // divider rule.
    const opensTurn = l.type === "user" || l.type === "task-notification"
    if (opensTurn) {
      if (seenUser) out.push({ type: "divider", text: "" })
      seenUser = true
    }
    out.push(l)
  }
  const last = logs[logs.length - 1].type
  if (last !== "user" && last !== "task-notification") {
    out.push({ type: "divider", text: "" })
  }
  return out
}

export function deleteSavedSession(id: string): void {
  // Validate before touching either session storage or persisted tool output.
  sessionFilePathInDir(projectSessionsDir, id)
  for (const dir of projectSessionDirs()) {
    try { unlinkSync(sessionFilePathInDir(dir, id)) } catch {}
  }
  deletePersistedToolOutputs(id, { projectCwd: cwd })
}

/** Load the most recent session for auto-restore on startup */
export function loadLastSession(): { id: string; logs: SessionLog[] } | null {
  try {
    const candidates: Array<{ dir: string; file: string }> = []
    for (const dir of projectSessionDirs()) {
      try {
        for (const file of readdirSync(dir).filter(f => f.endsWith(".jsonl"))) {
          const id = file.slice(0, -".jsonl".length)
          if (!isValidSessionId(id)) continue
          candidates.push({ dir, file })
        }
      } catch {}
    }
    if (candidates.length === 0) return null

    // Find most recently modified file (skip current writer's empty file)
    let best: { dir: string; file: string; mtime: number } | null = null
    for (const { dir, file } of candidates) {
      const filePath = join(dir, file)
      const stat = lstatSync(filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      if (stat.size < 100) continue // skip empty/init-only files
      if (!best || stat.mtimeMs > best.mtime) {
        best = { dir, file, mtime: stat.mtimeMs }
      }
    }
    if (!best) return null

    const filePath = join(best.dir, best.file)
    const id = best.file.slice(0, -".jsonl".length)
    const logs = parseSessionFileBestEffort(filePath)
    if (logs.length === 0) return null

    return { id, logs: injectRestoreDividers(logs) }
  } catch { return null }
}



// ─── Restore helpers ─────────────────────────────────────────────────────────

/**
/**
 * Phase 3 of the Turn-based history refactor. Canonical restore entry point:
 * SessionLog[] → Turn[]. The result is wire-valid by construction (Turn
 * invariants — every assistant tool_use is paired with its tool_result),
 * matching what ConversationManager produces during a live run.
 *
 * Mid-stream truncation, dropped tool logs, replaceLog chains, and other
 * legacy log oddities all funnel through `buildToolTurn`'s
 * `incomplete`-call path so missing tool_results become synthesized
 * failure ToolResults rather than orphans.
 *
 * `sessionLogsToMessages` (below) is now a thin derivation:
 * `turnsToMessages(sessionLogsToTurns(logs))`. Existing callers stay on the
 * Message-shape API; new callers should prefer this function so they get
 * the type-level pairing guarantee at the API boundary.
 */
export function sessionLogsToTurns(logs: SessionLog[]): Turn[] {
  const out: Turn[] = []
  const noMergeUserTurnIndexes = new Set<number>()
  const emittedCallIds = new Set<string>()
  let idx = 0

  let pendingThinking = ""
  let pendingText = ""
  // toolCalls keyed by id — duplicates from replaceLog chaining are
  // de-duped in place. Order is preserved by tracking insertion order.
  const pendingToolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = []
  const pendingToolResults = new Map<string, { content: string; success?: boolean; suppression?: "duplicate" }>()

  const flushPending = () => {
    if (pendingToolCalls.length > 0) {
      const completed: CompletedCall[] = []
      const incomplete: IncompleteCall[] = []
      for (const tc of pendingToolCalls) {
        const got = pendingToolResults.get(tc.id)
        if (got) {
          completed.push({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            result: {
              success: got.success ?? true,
              output: got.content,
              ...(got.suppression ? { runtime: { suppression: got.suppression } } : {}),
            },
            // Legacy logs lack status evidence. Preserve their output without
            // promoting it to an authorized successful read during compaction.
            ...(got.success === undefined ? { resultStatusUnknown: true as const } : {}),
            formattedOutput: got.content,
          })
        } else {
          incomplete.push({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            reason: "tool_result missing in restored session log",
          })
        }
        emittedCallIds.add(tc.id)
      }
      const raw = pendingThinking ? { reasoning_content: pendingThinking } : undefined
      out.push(buildToolTurn({ text: pendingText, raw, completed, incomplete }))
    } else if (pendingText) {
      const turn: Turn = { kind: "assistant", text: pendingText }
      if (pendingThinking) turn.raw = { reasoning_content: pendingThinking }
      out.push(turn)
    }
    pendingThinking = ""
    pendingText = ""
    pendingToolCalls.length = 0
    pendingToolResults.clear()
  }

  for (const log of logs) {
    if (log.restore === false) {
      idx++
      continue
    }
    if (log.type === "user" || log.type === "task-notification") {
      // Both kinds become user-role turns in the conversation. Task
      // notifications are system-synthesized turn boundaries, so keep them
      // separate from adjacent human user turns during the legacy coalesce
      // pass below.
      flushPending()
      const images = sessionImagesToContent(log.images)
      const content = log.restoreText ?? log.text
      if (log.type === "task-notification") noMergeUserTurnIndexes.add(out.length)
      out.push(images?.length
        ? { kind: "user", content, images }
        : { kind: "user", content })
    } else if (log.type === "thinking") {
      if (pendingToolCalls.length > 0 || pendingToolResults.size > 0) flushPending()
      pendingThinking += log.text
    } else if (log.type === "agent") {
      if (pendingToolResults.size > 0 && pendingToolCalls.length === pendingToolResults.size) {
        flushPending()
      }
      if (log.text) pendingText = pendingText ? pendingText + log.text : log.text
    } else if (log.type === "tool" && log.tool) {
      const id = log.tool.id ?? synthToolCallId(log.tool.name, log.tool.arguments, idx)
      if (!emittedCallIds.has(id) && !pendingToolCalls.some(tc => tc.id === id)) {
        pendingToolCalls.push({
          id,
          name: log.tool.name,
          arguments: (log.tool.arguments as Record<string, unknown>) ?? {},
        })
      }
    } else if (log.type === "result" && log.tool) {
      const id = log.tool.id
      if (id && log.tool.name && !emittedCallIds.has(id) && !pendingToolCalls.some(tc => tc.id === id)) {
        pendingToolCalls.push({
          id,
          name: log.tool.name,
          arguments: (log.tool.arguments as Record<string, unknown>) ?? {},
        })
      }
      if (id) {
        pendingToolResults.set(id, {
          content: log.tool.output ?? "",
          success: log.tool.success,
          suppression: log.tool.suppression,
        })
      }
    }
    idx++
  }

  flushPending()
  return mergeConsecutiveUserTurns(out, noMergeUserTurnIndexes)
}

function sessionImagesToContent(images?: SessionImageRef[]): ImageContent[] | undefined {
  if (!images?.length) return undefined
  return images.map((img) => ({
    type: "image",
    filePath: img.filePath,
    mediaType: img.mediaType,
    source: img.source,
  }))
}

/**
 * Backwards-compat wrapper. New code should call `sessionLogsToTurns`
 * directly so the wire-pairing guarantee is visible at the API boundary.
 */
export function sessionLogsToMessages(logs: SessionLog[]): Message[] {
  return turnsToMessages(sessionLogsToTurns(logs))
}

/**
 * Collapse runs of consecutive user turns into a single user turn. Mirrors
 * the prior `mergeConsecutiveUserMessages` but operates on Turn[] so the
 * Turn-shape guarantee is preserved end-to-end through restore.
 */
function mergeConsecutiveUserTurns(turns: Turn[], noMergeUserTurnIndexes: ReadonlySet<number> = new Set()): Turn[] {
  const out: Turn[] = []
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]
    const prev = out[out.length - 1]
    if (
      t.kind === "user" &&
      prev?.kind === "user" &&
      !noMergeUserTurnIndexes.has(i) &&
      !noMergeUserTurnIndexes.has(i - 1) &&
      typeof t.content === "string" &&
      typeof prev.content === "string" &&
      !t.images?.length &&
      !prev.images?.length
    ) {
      // mutate in place — `out` is a fresh array we own
      ;(prev as { content: string }).content = `${prev.content}\n\n${t.content}`
    } else {
      out.push(t)
    }
  }
  return out
}

function synthToolCallId(name: string, args: unknown, index: number): string {
  const h = createHash("sha256")
    .update(`${name}:${JSON.stringify(args ?? {})}:${index}`)
    .digest("hex")
    .slice(0, 12)
  return `synth_${h}`
}
