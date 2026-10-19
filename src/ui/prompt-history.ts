import {
  renderPastedPlaceholder,
  renderUnavailablePastedPlaceholder,
} from "../utils/pastedPlaceholder.js"
import {
  PASTE_SIDECAR_DIRNAME,
  persistPasteSidecar,
  readPasteSidecar,
} from "../utils/pasteSidecar.js"

export const MAX_HISTORY_PASTED_ENTRY_BYTES = 64 * 1024
export const MAX_HISTORY_PASTED_TOTAL_BYTES = 128 * 1024
export const MAX_HISTORY_PASTED_SIDECAR_ENTRY_BYTES = 2 * 1024 * 1024
export const MAX_HISTORY_PASTED_SIDECAR_TOTAL_BYTES = 8 * 1024 * 1024
export const MAX_PROMPT_HISTORY = 200
export const PASTE_HISTORY_DIRNAME = PASTE_SIDECAR_DIRNAME

const PASTED_PLACEHOLDER_RE = /\[Pasted #(\d+) · \d+ lines · \d+ chars\]/g
const PLACEHOLDER_ID_RE = /^[1-9]\d*$/

export interface PromptHistoryEntry {
  display: string
  pastedContents: Record<string, string>
  /** id -> absolute filePath for oversized text pastes stored outside history.jsonl. */
  pastedContentRefs?: Record<string, string>
  /** id -> absolute filePath. Image bytes stay on disk; history stores refs only. */
  imageRefs?: Record<string, string>
  timestamp: number
}

export interface ParsedPromptHistory {
  entries: PromptHistoryEntry[]
  dirty: boolean
}

export interface RestoredPromptHistoryEntry {
  display: string
  pastedContents: Record<string, string>
  imageRefs: Record<string, string>
}

export function parsePromptHistoryLines(
  lines: string[],
  maxHistory = MAX_PROMPT_HISTORY,
): ParsedPromptHistory {
  const entries: PromptHistoryEntry[] = []
  let dirty = lines.length > maxHistory
  for (const line of lines) {
    const parsed = parsePromptHistoryLine(line)
    if (!parsed) {
      dirty = true
      continue
    }
    if (parsed.dirty) dirty = true
    entries.push(parsed.entry)
  }
  const kept = entries.slice(-maxHistory)
  return {
    entries: kept,
    dirty: dirty || kept.length !== entries.length,
  }
}

export function sanitizeHistoryPastedContents(
  pastedContents: Record<string, string>,
): Record<string, string> {
  let totalBytes = 0
  const out: Record<string, string> = {}
  for (const [id, content] of Object.entries(pastedContents)) {
    if (!isPlaceholderId(id)) continue
    if (typeof content !== "string") continue
    const bytes = Buffer.byteLength(content, "utf-8")
    if (bytes > MAX_HISTORY_PASTED_ENTRY_BYTES) continue
    if (totalBytes + bytes > MAX_HISTORY_PASTED_TOTAL_BYTES) continue
    out[id] = content
    totalBytes += bytes
  }
  return out
}

export interface SplitHistoryPastedContents {
  pastedContents: Record<string, string>
  sidecarPastedContents: Record<string, string>
}

export function splitHistoryPastedContents(
  pastedContents: Record<string, string>,
): SplitHistoryPastedContents {
  let inlineBytes = 0
  let sidecarBytes = 0
  const inline: Record<string, string> = {}
  const sidecar: Record<string, string> = {}
  for (const [id, content] of Object.entries(pastedContents)) {
    if (!isPlaceholderId(id)) continue
    if (typeof content !== "string") continue
    const bytes = Buffer.byteLength(content, "utf-8")
    if (
      bytes <= MAX_HISTORY_PASTED_ENTRY_BYTES &&
      inlineBytes + bytes <= MAX_HISTORY_PASTED_TOTAL_BYTES
    ) {
      inline[id] = content
      inlineBytes += bytes
      continue
    }
    if (
      bytes <= MAX_HISTORY_PASTED_SIDECAR_ENTRY_BYTES &&
      sidecarBytes + bytes <= MAX_HISTORY_PASTED_SIDECAR_TOTAL_BYTES
    ) {
      sidecar[id] = content
      sidecarBytes += bytes
    }
  }
  return { pastedContents: inline, sidecarPastedContents: sidecar }
}

export function persistSidecarPastedContents(
  dataDir: string,
  pastedContents: Record<string, string>,
): Record<string, string> {
  const refs: Record<string, string> = {}
  if (Object.keys(pastedContents).length === 0) return refs
  for (const [id, content] of Object.entries(pastedContents)) {
    if (!isPlaceholderId(id)) continue
    const ref = persistPasteSidecar(dataDir, content)
    if (ref) refs[id] = ref
  }
  return refs
}

export function readSidecarPastedContents(
  dataDir: string,
  refs: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!refs) return out
  let totalBytes = 0
  for (const [id, ref] of Object.entries(refs)) {
    if (!isPlaceholderId(id)) continue
    const sidecar = readPasteSidecar(dataDir, ref, {
      maxBytes: MAX_HISTORY_PASTED_SIDECAR_ENTRY_BYTES,
    })
    if (!sidecar) continue
    if (totalBytes + sidecar.size > MAX_HISTORY_PASTED_SIDECAR_TOTAL_BYTES) continue
    out[id] = sidecar.content
    totalBytes += sidecar.size
  }
  return out
}

export function restorePromptHistoryEntry(
  dataDir: string,
  entry: PromptHistoryEntry,
): RestoredPromptHistoryEntry {
  const pastedContents = {
    ...readSidecarPastedContents(dataDir, entry.pastedContentRefs),
    ...entry.pastedContents,
  }
  return {
    display: sanitizeHistoryDisplayForPastes(entry.display, pastedContents),
    pastedContents,
    imageRefs: entry.imageRefs ?? {},
  }
}

export function sanitizeHistoryDisplayForPastes(
  display: string,
  pastedContents: Record<string, string>,
  pastedContentRefs: Record<string, string> = {},
): string {
  return display.replace(PASTED_PLACEHOLDER_RE, (placeholder, id) => {
    if (!isPlaceholderId(id)) return renderUnavailablePastedPlaceholder(id)
    const content = pastedContents[id]
    if (content !== undefined) return renderAvailablePastedHistoryPlaceholder(id, content)
    return pastedContentRefs[id] !== undefined
      ? placeholder
      : renderUnavailablePastedPlaceholder(id)
  })
}

function renderAvailablePastedHistoryPlaceholder(id: string, content: string): string {
  return renderPastedPlaceholder(id, content)
}

export function isDuplicatePromptHistoryEntry(
  previous: PromptHistoryEntry | undefined,
  next: PromptHistoryEntry,
): boolean {
  return previous !== undefined &&
    previous.display === next.display &&
    sameStringRecord(previous.pastedContents, next.pastedContents) &&
    sameStringRecord(previous.pastedContentRefs ?? {}, next.pastedContentRefs ?? {}) &&
    sameStringRecord(previous.imageRefs ?? {}, next.imageRefs ?? {})
}

function parsePromptHistoryLine(
  line: string,
): { entry: PromptHistoryEntry; dirty: boolean } | null {
  try {
    const parsed = JSON.parse(line) as unknown
    if (!isRecord(parsed) || typeof parsed.display !== "string" || !parsed.display.trim()) {
      return null
    }
    let dirty = false
    const rawPasted = isRecord(parsed.pastedContents)
      ? (parsed.pastedContents as Record<string, string>)
      : {}
    if (!isRecord(parsed.pastedContents)) dirty = true
    const pastedContents = sanitizeHistoryPastedContents(rawPasted)
    if (!sameStringRecord(pastedContents, rawPasted)) dirty = true
    const pastedContentRefs = sanitizeStringRecord(parsed.pastedContentRefs, { placeholderIdsOnly: true })
    if (!sameStringRecord(pastedContentRefs ?? {}, isRecord(parsed.pastedContentRefs) ? parsed.pastedContentRefs : {})) {
      dirty = true
    }
    const display = sanitizeHistoryDisplayForPastes(parsed.display, pastedContents, pastedContentRefs)
    if (display !== parsed.display) dirty = true

    const imageRefs = sanitizeStringRecord(parsed.imageRefs, { placeholderIdsOnly: true })
    if (!sameStringRecord(imageRefs ?? {}, isRecord(parsed.imageRefs) ? parsed.imageRefs : {})) {
      dirty = true
    }
    const timestamp = typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp)
      ? parsed.timestamp
      : Date.now()
    if (timestamp !== parsed.timestamp) dirty = true

    return {
      dirty,
      entry: {
        display,
        pastedContents,
        ...(pastedContentRefs && Object.keys(pastedContentRefs).length > 0 ? { pastedContentRefs } : {}),
        ...(imageRefs && Object.keys(imageRefs).length > 0 ? { imageRefs } : {}),
        timestamp,
      },
    }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizeStringRecord(
  value: unknown,
  options: { placeholderIdsOnly?: boolean } = {},
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (options.placeholderIdsOnly && !isPlaceholderId(key)) continue
    if (typeof item === "string") out[key] = item
  }
  return out
}

function isPlaceholderId(id: string): boolean {
  return PLACEHOLDER_ID_RE.test(id)
}

function sameStringRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => a[key] === b[key])
}
