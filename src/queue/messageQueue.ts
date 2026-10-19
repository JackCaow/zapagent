import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeFileAtomic } from "../utils/secure-write.js"
import type { QueuedCommand } from "./inputQueue.js"
import { looksLikeDroppedFilePath } from "../commands/submit.js"
import { hydrateEntryImages, journalReplacer } from "./queued-images.js"

function isCommand(text: string): boolean {
  const value = text.trimStart()
  return value.startsWith("/") && !looksLikeDroppedFilePath(value)
}

export type FollowUpMode = "queue" | "steer"
export type QueueState = "queued" | "dispatching" | "editing" | "failed" | "accepted"
export interface QueueEntry extends QueuedCommand {
  id: string
  sessionId: string
  mode: FollowUpMode
  state: QueueState
  targetRunId?: string
  error?: string
  beforeEdit?: "queued" | "failed"
  editVersion?: string
}

function freezeEntry(entry: QueueEntry): QueueEntry {
  const copy = structuredClone(entry)
  copy.images?.forEach(image => { Object.freeze(image.content); Object.freeze(image) })
  if (copy.images) Object.freeze(copy.images)
  if (copy.pastedContents) Object.freeze(copy.pastedContents)
  return Object.freeze(copy)
}

function validEntry(value: unknown, sessionId: string): value is QueueEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as QueueEntry
  return typeof entry.id === "string" && entry.id.length > 0 && entry.sessionId === sessionId
    && typeof entry.text === "string" && typeof entry.displayForm === "string"
    && (entry.restoreText === undefined || typeof entry.restoreText === "string")
    && (entry.targetRunId === undefined || typeof entry.targetRunId === "string")
    && (entry.error === undefined || typeof entry.error === "string")
    && (entry.beforeEdit === undefined || entry.beforeEdit === "queued" || entry.beforeEdit === "failed")
    && (entry.editVersion === undefined || typeof entry.editVersion === "string")
    && ["queue", "steer"].includes(entry.mode)
    && ["queued", "dispatching", "editing", "failed", "accepted"].includes(entry.state)
    && (entry.pastedContents === undefined || (!!entry.pastedContents && typeof entry.pastedContents === "object"
      && !Array.isArray(entry.pastedContents) && Object.values(entry.pastedContents).every(text => typeof text === "string")))
    && (entry.images === undefined || (Array.isArray(entry.images) && entry.images.every(image =>
      Number.isSafeInteger(image.id) && image.id > 0 && image.content?.type === "image"
      && typeof image.content.filePath === "string" && typeof image.content.mediaType === "string"
      && typeof image.content.source === "string"
      && (image.content.base64 === undefined || typeof image.content.base64 === "string"))))
}

/** One source of truth for pending user messages. Claims remain visible until
 * the canonical conversation accepts them, not until an LLM request succeeds.
 * Storage writes precede ordinary mutations. Ambiguous crash recovery is held
 * for explicit review rather than automatically repeating potentially applied work. */
export class MessageQueue {
  private threads = new Map<string, readonly QueueEntry[]>()
  private sessionId = "default"
  private activeRunId?: string
  private listeners = new Set<() => void>()
  private snapshot: readonly QueueEntry[] = Object.freeze([])

  constructor(private readonly directory?: string,
    private readonly write: (path: string, contents: string) => void = writeFileAtomic) {}

  getSnapshot = (): readonly QueueEntry[] => this.snapshot
  getSessionId = (): string => this.sessionId
  getActiveRunId = (): string | undefined => this.activeRunId
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  bind(sessionId: string, resumeFrom?: string): void {
    if (this.activeRunId) throw new Error("Cannot change queue session during an active run")
    const threads = new Map(this.threads)
    if (resumeFrom && resumeFrom !== sessionId) {
      const entries = threads.get(resumeFrom) ?? this.read(resumeFrom)
      // A restore is a new journal/fork, potentially in another live TUI.
      // Never consume another writer's queue or automatically execute a copy.
      threads.set(sessionId, this.recover(entries, sessionId))
    } else if (!threads.has(sessionId)) {
      threads.set(sessionId, this.recover(this.read(sessionId), sessionId))
    }
    this.commit(threads, sessionId)
  }

  enqueue(command: QueuedCommand, mode: FollowUpMode = "queue"): QueueEntry {
    const steer = mode === "steer" && this.activeRunId && !isCommand(command.text)
    const entry = freezeEntry({ ...command, id: randomUUID(), sessionId: this.sessionId,
      state: "queued", mode: steer ? "steer" : "queue", targetRunId: steer ? this.activeRunId : undefined })
    this.update([...this.snapshot, entry])
    return entry
  }

  beginRun(id: string): void {
    if (this.activeRunId) throw new Error("A queue run is already active")
    this.activeRunId = id
    this.notify()
  }

  endRun(id: string): void {
    if (this.activeRunId !== id) return
    this.activeRunId = undefined
    if (!this.snapshot.some(entry => entry.targetRunId === id)) { this.notify(); return }
    try {
      this.update(this.snapshot.map(entry => entry.targetRunId !== id ? entry : { ...entry,
        mode: "queue", targetRunId: undefined,
        state: entry.state === "dispatching" ? "failed" : entry.state,
        error: entry.state === "dispatching" ? "Steer delivery was interrupted; review before retrying." : entry.error }))
    } catch (error) {
      // Ownership ended even if saving pending Steer recovery failed. Do not
      // leave subscribers displaying a run that no longer exists.
      this.notify()
      throw error
    }
  }

  /** True while a failed message at the head blocks everything behind it. */
  isPaused(): boolean { return isQueuePaused(this.snapshot) }

  /** Drop every failed message so the rest of the queue can run. Entries that are
   *  being sent or edited are left alone. Returns how many were removed. */
  discardFailed(): number {
    const kept = this.snapshot.filter(entry => entry.state !== "failed")
    const removed = this.snapshot.length - kept.length
    if (removed) this.update(kept)
    return removed
  }

  claimNext(): QueueEntry | undefined {
    const first = this.snapshot.find(entry => entry.state !== "accepted")
    return first?.state === "queued" ? this.change(first.id, { state: "dispatching", mode: "queue", targetRunId: undefined }) : undefined
  }

  hasSteering(runId: string): boolean {
    return this.activeRunId === runId && this.snapshot.some(entry => entry.state === "queued" && entry.mode === "steer" && entry.targetRunId === runId)
  }

  claimSteering(runId: string): QueueEntry | undefined {
    if (this.activeRunId !== runId) return
    const entry = this.snapshot.find(item => item.state === "queued" && item.mode === "steer" && item.targetRunId === runId)
    return entry ? this.change(entry.id, { state: "dispatching" }) : undefined
  }

  acknowledge(id: string, sessionId: string): string | undefined {
    const entry = this.snapshot.find(item => item.id === id && item.sessionId === sessionId)
    if (!entry || entry.state !== "dispatching") return
    try { this.update(this.snapshot.filter(item => item.id !== id)) }
    catch (error) {
      // Input is already in the canonical conversation. Even if the queue
      // receipt cannot be saved, NEVER make it retryable in this process.
      const warning = `Accepted, but queue receipt could not be saved: ${error instanceof Error ? error.message : String(error)}`
      const entries = Object.freeze(this.snapshot.map(item => item.id === id
        ? freezeEntry({ ...item, state: "accepted", error: warning }) : item))
      this.threads.set(this.sessionId, entries)
      this.snapshot = entries
      this.notify()
      return warning
    }
  }

  fail(id: string, error: string): void {
    this.hold(this.snapshot.map(entry => entry.id === id ? { ...entry, state: "failed", error,
      mode: "queue", targetRunId: undefined } : entry))
  }
  pause(error: string): void {
    this.hold(this.snapshot.map(entry => entry.state === "editing" ? { ...entry, beforeEdit: "failed",
      mode: "queue", targetRunId: undefined, error } : ["queued", "dispatching"].includes(entry.state)
      ? { ...entry, state: "failed", mode: "queue", targetRunId: undefined, error } : entry))
  }
  retry(id: string): boolean {
    if (this.snapshot.find(entry => entry.id === id)?.state !== "failed") return false
    return !!this.change(id, { state: "queued", error: undefined })
  }
  steer(id: string): boolean {
    const entry = this.snapshot.find(item => item.id === id)
    if (!this.activeRunId || !entry || !["queued", "failed"].includes(entry.state)
      || isCommand(entry.text)) return false
    return !!this.change(id, { mode: "steer", state: "queued", error: undefined, targetRunId: this.activeRunId })
  }
  remove(id: string): boolean {
    const entry = this.snapshot.find(item => item.id === id)
    if (!entry || ["dispatching", "editing"].includes(entry.state)) return false
    this.update(this.snapshot.filter(item => item.id !== id))
    return true
  }
  move(id: string, direction: -1 | 1): boolean {
    const index = this.snapshot.findIndex(entry => entry.id === id)
    const adjacent = this.snapshot[index + direction]
    const entry = this.snapshot[index]
    if (!entry || !adjacent || !["queued", "failed"].includes(entry.state)
      || !["queued", "failed"].includes(adjacent.state)) return false
    const entries = [...this.snapshot]
    ;[entries[index], entries[index + direction]] = [adjacent, entry]
    this.update(entries)
    return true
  }
  edit(id: string): QueueEntry | undefined {
    const entry = this.snapshot.find(item => item.id === id)
    if (!entry || !["queued", "failed"].includes(entry.state)) return
    return this.change(id, { state: "editing", beforeEdit: entry.state as "queued" | "failed", editVersion: randomUUID() })
  }
  cancelEdit(id: string): void {
    const entry = this.snapshot.find(item => item.id === id)
    if (entry?.state === "editing") this.change(id, { state: entry.beforeEdit ?? "queued", beforeEdit: undefined, editVersion: undefined })
  }
  replace(id: string, command: QueuedCommand, expectedEditVersion?: string): boolean {
    const entry = this.snapshot.find(item => item.id === id)
    if (entry?.state !== "editing") return false
    if (expectedEditVersion && entry.editVersion !== expectedEditVersion) return false
    const steer = !!this.activeRunId && entry.targetRunId === this.activeRunId && !isCommand(command.text)
    this.change(id, { ...command, images: command.images, pastedContents: command.pastedContents, restoreText: command.restoreText,
      state: "queued", beforeEdit: undefined, editVersion: undefined, error: undefined,
      mode: steer ? entry.mode : "queue", targetRunId: steer ? this.activeRunId : undefined })
    return true
  }
  clear(): void { if (this.snapshot.length) this.update([]) }

  private change(id: string, fields: Partial<QueueEntry>): QueueEntry | undefined {
    if (!this.snapshot.some(entry => entry.id === id)) return
    this.update(this.snapshot.map(entry => entry.id === id ? { ...entry, ...fields } : entry))
    return this.snapshot.find(entry => entry.id === id)
  }
  private update(entries: readonly QueueEntry[]): void {
    const threads = new Map(this.threads)
    threads.set(this.sessionId, Object.freeze(entries.map(freezeEntry)))
    this.commit(threads, this.sessionId)
  }
  private hold(entries: readonly QueueEntry[]): void {
    try { this.update(entries) }
    catch (error) {
      // Safety transitions must take effect even with a full disk. A later
      // successful enqueue must not revive messages paused by an interruption.
      this.snapshot = Object.freeze(entries.map(freezeEntry))
      this.threads.set(this.sessionId, this.snapshot)
      this.notify()
      throw error
    }
  }
  private commit(threads: Map<string, readonly QueueEntry[]>, sessionId: string): void {
    // Native journals have distinct writer IDs. Per-journal files avoid two
    // concurrent TUI instances overwriting each other's pending messages.
    if (this.directory) this.write(this.path(sessionId), JSON.stringify({ version: 1, sessionId, entries: threads.get(sessionId) ?? [] }, journalReplacer))
    this.threads = threads
    this.sessionId = sessionId
    this.snapshot = threads.get(sessionId) ?? Object.freeze([])
    this.notify()
  }
  private path(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw new Error("Invalid queue session ID")
    return join(this.directory!, `${sessionId}.json`)
  }
  private read(sessionId: string): readonly QueueEntry[] {
    if (!this.directory || !existsSync(this.path(sessionId))) return []
    const saved = JSON.parse(readFileSync(this.path(sessionId), "utf8"))
    if (saved.version !== 1 || saved.sessionId !== sessionId || !Array.isArray(saved.entries)
      || !saved.entries.every((entry: unknown) => validEntry(entry, sessionId))) {
      throw new Error("Invalid pending-message store; original file was not overwritten")
    }
    const entries = saved.entries as QueueEntry[]
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("Duplicate pending-message ID")
    return entries
  }
  private recover(entries: readonly QueueEntry[], sessionId: string): readonly QueueEntry[] {
    return Object.freeze(entries.filter(entry => entry.state !== "accepted").map(saved => {
      // The journal keeps image file references only; bring the bytes back.
      const { entry, unreadable } = hydrateEntryImages(saved)
      return freezeEntry({ ...entry,
        sessionId, mode: "queue", targetRunId: undefined, state: "failed", beforeEdit: undefined, editVersion: undefined,
        error: "Recovered pending message. Check the transcript before retrying; delivery may already have happened."
          + (unreadable.length ? ` Image no longer readable, it would be sent without it: ${unreadable.join(", ")}` : "") })
    }))
  }
  private notify(): void { for (const listener of this.listeners) listener() }
}

/** The queue is paused when the first pending entry failed: delivery never skips
 *  it, so every later message waits until it is retried or removed. */
export function isQueuePaused(entries: readonly QueueEntry[]): boolean {
  return entries.find(entry => entry.state !== "accepted")?.state === "failed"
}
