/**
 * User-input queue.
 *
 * The queue lives outside React state so:
 *   - The streaming agent loop (non-React code) can read/write directly.
 *   - React subscribes via `useSyncExternalStore` — no stale-closure or
 *     batched-render races.
 *   - There's no "live submit path / drain path" asymmetry: handleSubmit
 *     ALWAYS enqueues; the drain path is the only thing that hands work
 *     to the agent.
 *
 * Strictly user input. System-generated events (background-task
 * completion, cron firings, …) live in `systemInbox.ts` and never appear
 * here — they have their own non-UI buffer to prevent accidental edits
 * or dismissal through the input box.
 */

import type { ImageContent } from "../../zapsdk/core/types.js"
import { countCodePoints, splitLogicalLines } from "../utils/logicalLines.js"
import { renderPastedPlaceholder } from "../utils/pastedPlaceholder.js"
import { MessageQueue, type FollowUpMode, type QueueEntry } from "./messageQueue.js"

/** Pending-image entry in the input box. Carries an `id` alongside the
 *  raw `ImageContent` so the `[Image #N]` placeholder text can map back
 *  to the actual image bytes — required for both Esc-pop-back fidelity
 *  and history recall (where we record id→filePath in history.jsonl
 *  and re-load on ↑). The id is monotonic within a session. */
export type PendingImage = {
  id: number
  content: ImageContent
}

export type QueuedCommand = {
  /** Stripped text for the model (no `[Image #N]` markers). */
  text: string
  /** Form to render in the transcript — preserves the user's view. */
  displayForm: string
  /** Optional full user-visible text for transcript/session restore.
   *  Unlike `text`, this must not include implicit model-only context blocks
   *  such as `<file_content>` or `<mcp_resource>`. */
  restoreText?: string
  /** Placeholder id → original pasted text. Preserved while queued so Esc
   *  pop-back can rehydrate pasteStoreRef and a re-submit still expands
   *  `[Pasted #N ...]` tokens instead of sending placeholders literally. */
  pastedContents?: Record<string, string>
  /** Images attached to this submit. Carried through drain so they
   *  reach the model alongside their owning text. PendingImage form
   *  (with id) so Esc pop-back can restore the [Image #N] markers
   *  back to live `pendingImages` without losing the id binding. */
  images?: PendingImage[]
}

let manager = new MessageQueue()
const PASTED_PLACEHOLDER_RE = /\[Pasted #([1-9]\d*) · (\d+) lines · (\d+) chars\]/g
const IMAGE_PLACEHOLDER_RE = /\[Image #([1-9]\d*)\]/g
/** Frozen snapshot recreated on every mutation; required by
 *  `useSyncExternalStore` so React can detect changes via reference equality. */
let snapshot: readonly QueueEntry[] = manager.getSnapshot()

const subscribers = new Set<() => void>()

function notify(): void {
  snapshot = manager.getSnapshot()
  for (const fn of subscribers) fn()
}
manager.subscribe(notify)

export function getMessageQueue(): MessageQueue { return manager }
export function getQueueActiveRunId(): string | undefined { return manager.getActiveRunId() }

/** Configure once at TUI startup. Headless/ACP do not initialize a UI queue. */
export function configureQueue(path: string, sessionId: string): void {
  const next = new MessageQueue(path)
  next.bind(sessionId)
  manager = next
  manager.subscribe(notify)
  notify()
}

// ─── React subscription ──────────────────────────────────────────────────────

export function subscribeToQueue(cb: () => void): () => void {
  subscribers.add(cb)
  return () => { subscribers.delete(cb) }
}

export function getQueueSnapshot(): readonly QueueEntry[] {
  return snapshot
}

// ─── Read ────────────────────────────────────────────────────────────────────

export function getQueueLength(): number {
  return snapshot.length
}

export function hasQueue(): boolean {
  return snapshot.length > 0
}

// ─── Write ───────────────────────────────────────────────────────────────────

export function enqueue(cmd: QueuedCommand, mode?: FollowUpMode): QueueEntry {
  return manager.enqueue(cmd, mode)
}

/** Legacy bulk helper. Interactive delivery uses MessageQueue.claimNext and
 * canonical receipts instead of clearing pending ownership before a run. */
export function dequeueAll(): QueuedCommand[] {
  if (snapshot.length === 0) return []
  const items = [...snapshot]
  manager.clear()
  return items
}

export function clearQueue(): void {
  manager.clear()
}

// ─── Pop-back-to-input (Esc semantic) ────────────────────────────────────────

/** Result of `popAllForEditing` — the bundle the input box needs to restore
 *  the queued messages back into an editable state. */
export type PoppedQueue = {
  /** Joined displayForms (preserves `[Image #N]` markers) — paste this
   *  back into the input box. */
  text: string
  /** All images from the popped commands, in queue order. Restore these
   *  to `pendingImages` directly (PendingImage carries the id so the
   *  [Image #N] markers in `text` resolve to the right bytes). */
  images: PendingImage[]
  /** Pasted text blobs referenced by `[Pasted #N ...]` markers in `text`. */
  pastedContents: Record<string, string>
}

export interface PopAllForEditingOptions {
  /** First id to assign when remapping queued pasted placeholders. */
  nextPasteId?: number
  /** First id to assign when remapping queued image placeholders. */
  nextImageId?: number
}

/**
 * Pop everything for editing — concatenates each command's `displayForm`
 * (so `[Image #N]` markers come back to the input box) and gathers every
 * attached image. Used by Esc when the queue is non-empty: instead of
 * silently discarding what the user queued up, return it to them so they
 * can edit and re-submit.
 *
 * Returns null when the queue is empty so the caller can fall through to
 * other Esc behaviors (clearing pendingImages, aborting the agent).
 */
export function popAllForEditing(options: PopAllForEditingOptions = {}): PoppedQueue | null {
  if (snapshot.length === 0) return null
  const restored = prepareQueuedCommandsForEditing(snapshot, options)
  manager.clear()
  return restored
}

/** Rehydrate selected messages without removing them. The editor holds its
 * original entry until replacement succeeds, so Esc never loses a message. */
export function prepareQueuedCommandsForEditing(commands: readonly QueuedCommand[], options: PopAllForEditingOptions = {}): PoppedQueue {
  const texts: string[] = []
  const images: PendingImage[] = []
  const pastedContents: Record<string, string> = {}
  let nextPasteId = positiveIntegerOrDefault(options.nextPasteId, 1)
  let nextImageId = positiveIntegerOrDefault(options.nextImageId, 1)
  for (const cmd of commands) {
    const pasted = remapPastedPlaceholders(
      cmd.displayForm,
      queuePastedContentsForEditing(cmd),
      () => nextPasteId++,
    )
    const image = remapImagePlaceholders(pasted.text, cmd.images, () => nextImageId++)
    texts.push(image.text)
    images.push(...image.images)
    Object.assign(pastedContents, pasted.pastedContents)
  }
  // The interactive editor passes one entry. Legacy callers can still
  // rehydrate a batch, but the actual delivery path never merges messages.
  return { text: texts.join("\n"), images, pastedContents }
}

function remapPastedPlaceholders(
  text: string,
  source: Record<string, string> | undefined,
  nextId: () => number,
): { text: string; pastedContents: Record<string, string> } {
  if (!source) return { text, pastedContents: {} }
  const pastedContents: Record<string, string> = {}
  const targetBySourceId = new Map<string, number>()
  const remappedText = text.replace(PASTED_PLACEHOLDER_RE, (placeholder, id) => {
    const content = source[id]
    if (content === undefined) return placeholder
    let newId = targetBySourceId.get(id)
    if (newId === undefined) {
      newId = nextId()
      targetBySourceId.set(id, newId)
    }
    pastedContents[String(newId)] = content
    return renderPastedPlaceholder(newId, content)
  })
  return { text: remappedText, pastedContents }
}

function queuePastedContentsForEditing(cmd: QueuedCommand): Record<string, string> | undefined {
  if (!cmd.restoreText) return cmd.pastedContents
  const inferred = inferPastedContentsFromRestoreText(cmd.displayForm, cmd.restoreText)
  if (Object.keys(inferred).length === 0) return cmd.pastedContents
  return { ...inferred, ...(cmd.pastedContents ?? {}) }
}

function inferPastedContentsFromRestoreText(
  displayForm: string,
  restoreText: string,
): Record<string, string> {
  const matches = [...displayForm.matchAll(PASTED_PLACEHOLDER_RE)]
  if (matches.length === 0) return {}

  const inferredFromMetadata = inferPastedContentsByPlaceholderMetadata(displayForm, restoreText, matches)
  if (inferredFromMetadata) return inferredFromMetadata

  return inferPastedContentsByDisplayBoundaries(displayForm, restoreText, matches)
}

function inferPastedContentsByPlaceholderMetadata(
  displayForm: string,
  restoreText: string,
  matches: RegExpMatchArray[],
): Record<string, string> | null {
  const inferred: Record<string, string> = {}
  let displayCursor = 0
  let restoreCursor = 0

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!
    const start = match.index ?? 0
    const before = displayForm.slice(displayCursor, start)
    if (!restoreText.startsWith(before, restoreCursor)) return null
    restoreCursor += before.length

    const id = match[1]
    const charCount = Number(match[3])
    if (!id || !Number.isSafeInteger(charCount) || charCount < 0) return null

    const afterPlaceholderStart = start + match[0].length
    const nextMatchStart = matches[i + 1]?.index ?? displayForm.length
    const nextLiteral = displayForm.slice(afterPlaceholderStart, nextMatchStart)
    const end = pastedContentEndFromCharCount(restoreText, restoreCursor, charCount, nextLiteral)
    if (end === null) return null
    inferred[id] = restoreText.slice(restoreCursor, end)
    restoreCursor = end
    displayCursor = start + match[0].length
  }

  const tail = displayForm.slice(displayCursor)
  if (!restoreText.startsWith(tail, restoreCursor)) return null
  restoreCursor += tail.length
  return restoreCursor === restoreText.length ? inferred : null
}

function pastedContentEndFromCharCount(
  restoreText: string,
  start: number,
  charCount: number,
  nextLiteral: string,
): number | null {
  for (const end of pastedContentEndCandidates(restoreText, start, charCount)) {
    if (end > restoreText.length) continue
    if (!restoreText.startsWith(nextLiteral, end)) continue
    return end
  }
  return null
}

function pastedContentEndCandidates(
  text: string,
  start: number,
  charCount: number,
): number[] {
  const candidates: number[] = []
  const add = (end: number) => {
    if (!Number.isSafeInteger(end) || end < start) return
    if (!candidates.includes(end)) candidates.push(end)
  }
  add(start + charCount)
  add(offsetAfterCodePoints(text, start, charCount))
  return candidates
}

function offsetAfterCodePoints(text: string, start: number, count: number): number {
  let offset = Math.min(Math.max(0, start), text.length)
  let seen = 0
  while (offset < text.length && seen < count) {
    const code = text.charCodeAt(offset)
    offset++
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      offset < text.length &&
      text.charCodeAt(offset) >= 0xdc00 &&
      text.charCodeAt(offset) <= 0xdfff
    ) {
      offset++
    }
    seen++
  }
  return seen === count ? offset : text.length + 1
}

function inferPastedContentsByDisplayBoundaries(
  displayForm: string,
  restoreText: string,
  matches: RegExpMatchArray[],
): Record<string, string> {
  const pieces: string[] = []
  let cursor = 0
  for (const match of matches) {
    const start = match.index ?? 0
    pieces.push(displayForm.slice(cursor, start))
    cursor = start + match[0].length
  }
  pieces.push(displayForm.slice(cursor))

  const inferred: Record<string, string> = {}
  let restoreCursor = 0
  for (let i = 0; i < matches.length; i++) {
    const before = pieces[i] ?? ""
    if (!restoreText.startsWith(before, restoreCursor)) return {}
    restoreCursor += before.length

    const after = pieces[i + 1] ?? ""
    const end = after.length === 0
      ? restoreText.length
      : restoreText.indexOf(after, restoreCursor)
    if (end < 0) return {}

    const id = matches[i]?.[1]
    if (!id) return {}
    inferred[id] = restoreText.slice(restoreCursor, end)
    restoreCursor = end
  }

  const tail = pieces[pieces.length - 1] ?? ""
  if (!restoreText.startsWith(tail, restoreCursor)) return {}
  restoreCursor += tail.length
  return restoreCursor === restoreText.length ? inferred : {}
}

function remapImagePlaceholders(
  text: string,
  source: PendingImage[] | undefined,
  nextId: () => number,
): { text: string; images: PendingImage[] } {
  if (!source || source.length === 0) return { text, images: [] }

  const sourceById = new Map(source.map((image) => [image.id, image]))
  const targetBySourceId = new Map<number, number>()
  const images: PendingImage[] = []

  const remappedText = text.replace(IMAGE_PLACEHOLDER_RE, (placeholder, idText) => {
    const sourceId = Number(idText)
    const image = sourceById.get(sourceId)
    if (!image) return placeholder

    let targetId = targetBySourceId.get(sourceId)
    if (targetId === undefined) {
      targetId = nextId()
      targetBySourceId.set(sourceId, targetId)
      images.push({ ...image, id: targetId })
    }
    return `[Image #${targetId}]`
  })

  for (const image of source) {
    if (targetBySourceId.has(image.id)) continue
    const targetId = nextId()
    targetBySourceId.set(image.id, targetId)
    images.push({ ...image, id: targetId })
  }

  return { text: remappedText, images }
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value))
}

export function queuedCommandPreview(cmd: QueuedCommand): string {
  const text = cmd.displayForm || cmd.text
  const lines = splitLogicalLines(text)
  if (lines.length <= 1) return text
  const first = lines[0] ?? ""
  return `${first} … (${lines.length} lines, ${countCodePoints(text)} chars queued)`
}

// ─── Test-only ───────────────────────────────────────────────────────────────

/** Reset to a fresh state. Tests only — do not call from app code. */
export function _resetForTest(): void {
  manager = new MessageQueue()
  snapshot = manager.getSnapshot()
  subscribers.clear()
  manager.subscribe(notify)
}
