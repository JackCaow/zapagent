/**
 * Image-cache cleanup — keeps two directories under control:
 *
 *   ~/.zapcode/image-paste/   OS clipboard pastes.
 *                             Filenames are timestamps (`paste-<ts>.png`).
 *                             ONE source of truth — once deleted, the
 *                             image is unrecoverable. Strict policy:
 *                             keep only what history.jsonl references.
 *
 *   ~/.zapcode/image-cache/   SVG raster outputs + URL downloads.
 *                             Filenames are content-hash. If a hash gets
 *                             deleted and accessed again, the producer
 *                             regenerates from source — so eviction is
 *                             cheap. Loose policy: age out anything not
 *                             touched in the last N days.
 *
 *   ~/.zapcode/paste-history/ Oversized text-paste sidecars referenced from
 *                             history.jsonl. Strict policy mirrors
 *                             image-paste: keep only referenced files.
 *
 * Cleanup runs once at App mount (useEffect with []), so failures
 * never block startup. All file ops are best-effort: try/catch swallows
 * everything. If something goes wrong, disk just doesn't shrink that
 * session.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs"
import type { Dirent } from "node:fs"
import { createHash } from "node:crypto"
import { basename, join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { getAppDataDir } from "../zapsdk/utils/platform.js"

// ─── tunables ────────────────────────────────────────────────────────

/** image-cache files older than this since last access get evicted.
 *  Content-addressed, so re-creation is automatic on next miss. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000  // 30 days
// Prompt history is capped at 200 entries, but each entry may still carry up
// to 128KB of inline pasted text. The prune pass must see every ref that can
// exist in a valid capped history file, otherwise older sidecar text pastes can
// be deleted while ↑ history can still navigate to them.
const HISTORY_REF_READ_MAX_BYTES = 64 * 1024 * 1024
const SESSION_REF_SCAN_CHUNK_BYTES = 256 * 1024
const SESSION_REF_SCAN_CARRY_CHARS = 64 * 1024
const PLACEHOLDER_ID_RE = /^[1-9]\d*$/
const CONTENT_ADDRESSED_SIDECAR_RE = /^[a-f0-9]{64}\.txt$/

/** Internal struct returned for caller-side logging. */
export type PruneResult = { deleted: number; bytesFreed: number }

// ─── image-paste/ — strict, history-driven prune ────────────────────

/**
 * Walk ~/.zapcode/image-paste/ and remove every file that is NOT
 * referenced by any entry in history.jsonl. The history file is
 * already capped at 200 entries (see prompt.tsx MAX_HISTORY), so the
 * referenced set is bounded — typically a few dozen files at most.
 *
 * Reads history.jsonl directly off disk rather than going through
 * prompt.tsx's in-memory `history` array, both to avoid cross-module
 * state coupling and so this works even if prompt.tsx hasn't been
 * imported yet (it has, but the decoupling is cleaner).
 */
export function pruneOrphanedPasteImages(): PruneResult {
  const result: PruneResult = { deleted: 0, bytesFreed: 0 }
  try {
    const dataDir = getAppDataDir()
    const pasteDir = join(dataDir, "image-paste")
    if (!existsSync(pasteDir)) return result

    const referenced = collectReferencedPaths(join(dataDir, "history.jsonl"), "imageRefs")

    for (const entry of readdirSync(pasteDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const fp = join(pasteDir, entry.name)
      if (referenced.has(fp)) continue
      try {
        const sz = statSync(fp).size
        unlinkSync(fp)
        result.deleted += 1
        result.bytesFreed += sz
      } catch { /* file already gone or no perm — skip */ }
    }
  } catch { /* defensive — never block boot */ }
  return result
}

export function pruneOrphanedPasteHistoryText(): PruneResult {
  const result: PruneResult = { deleted: 0, bytesFreed: 0 }
  try {
    const dataDir = getAppDataDir()
    const pasteDir = join(dataDir, "paste-history")
    if (!existsSync(pasteDir)) return result

    const referenced = collectReferencedPasteHistoryTextPaths(dataDir)

    for (const entry of readdirSync(pasteDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const fp = join(pasteDir, entry.name)
      if (referenced.has(fp) && !isCorruptContentAddressedTextSidecar(fp)) continue
      try {
        const sz = statSync(fp).size
        unlinkSync(fp)
        result.deleted += 1
        result.bytesFreed += sz
      } catch { /* file already gone or no perm — skip */ }
    }
  } catch { /* defensive — never block boot */ }
  return result
}

function collectReferencedPasteHistoryTextPaths(dataDir: string): Set<string> {
  const referenced = collectReferencedPaths(join(dataDir, "history.jsonl"), "pastedContentRefs")
  for (const path of collectSessionRestoreTextRefs(join(dataDir, "projects"))) {
    referenced.add(path)
  }
  return referenced
}

function collectSessionRestoreTextRefs(root: string): Set<string> {
  const referenced = new Set<string>()
  if (!existsSync(root)) return referenced
  const visit = (dir: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      collectSessionRestoreTextRefsFromFile(path, referenced)
    }
  }
  visit(root)
  return referenced
}

function collectSessionRestoreTextRefsFromFile(path: string, referenced: Set<string>): void {
  const buffer = Buffer.alloc(SESSION_REF_SCAN_CHUNK_BYTES)
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const decoder = new StringDecoder("utf8")
    let carry = ""
    let position = 0
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position)
      if (bytesRead <= 0) break
      position += bytesRead
      const text = carry + decoder.write(buffer.subarray(0, bytesRead))
      collectSessionRestoreTextRefsFromText(text, referenced)
      carry = text.slice(-SESSION_REF_SCAN_CARRY_CHARS)
    }
    const finalText = carry + decoder.end()
    if (finalText) {
      collectSessionRestoreTextRefsFromText(finalText, referenced)
    }
  } catch {
    // unreadable session file — skip
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
  }
}

function collectSessionRestoreTextRefsFromText(text: string, referenced: Set<string>): void {
  const re = /"zapRestoreTextRef"\s*:\s*"((?:\\.|[^"\\])*)"/g
  for (;;) {
    const match = re.exec(text)
    if (!match) return
    const ref = parseJsonStringLiteral(match[1])
    if (ref) referenced.add(ref)
  }
}

function parseJsonStringLiteral(value: string): string | null {
  try {
    const parsed = JSON.parse(`"${value}"`)
    return typeof parsed === "string" && parsed ? parsed : null
  } catch {
    return null
  }
}

/**
 * Parse history.jsonl and collect every filePath referenced via the chosen
 * history ref field. Malformed lines are skipped. Missing file is fine —
 * empty set. Caller decides what to do with the set.
 */
function collectReferencedPaths(
  historyPath: string,
  field: "imageRefs" | "pastedContentRefs",
): Set<string> {
  const referenced = new Set<string>()
  if (!existsSync(historyPath)) return referenced
  try {
    const content = readHistoryTail(historyPath)
    for (const line of content.split("\n")) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        const refs = entry[field]
        if (refs && typeof refs === "object" && !Array.isArray(refs)) {
          for (const [id, fp] of Object.entries(refs)) {
            if (!PLACEHOLDER_ID_RE.test(id)) continue
            if (typeof fp === "string" && fp) referenced.add(fp)
          }
        }
      } catch { /* malformed entry — skip */ }
    }
  } catch { /* unreadable — return what we have */ }
  return referenced
}

function isCorruptContentAddressedTextSidecar(path: string): boolean {
  const name = basename(path)
  if (!CONTENT_ADDRESSED_SIDECAR_RE.test(name)) return false
  try {
    const content = readFileSync(path, "utf-8")
    const hash = createHash("sha256").update(content).digest("hex")
    return `${hash}.txt` !== name
  } catch {
    return true
  }
}

function readHistoryTail(historyPath: string): string {
  const size = statSync(historyPath).size
  if (size <= HISTORY_REF_READ_MAX_BYTES) return readFileSync(historyPath, "utf-8")

  const start = Math.max(0, size - HISTORY_REF_READ_MAX_BYTES)
  const buffer = Buffer.alloc(size - start)
  const fd = openSync(historyPath, "r")
  try {
    let offset = 0
    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, start + offset)
      if (bytesRead <= 0) break
      offset += bytesRead
    }
  } finally {
    closeSync(fd)
  }
  const text = buffer.toString("utf-8")
  const firstNewline = text.indexOf("\n")
  return firstNewline >= 0 ? text.slice(firstNewline + 1) : ""
}

// ─── image-cache/ — loose, age-based prune ──────────────────────────

/**
 * Walk ~/.zapcode/image-cache/ and remove any file whose mtime is
 * older than CACHE_TTL_MS. Safe because filenames are content-hashes:
 * the SVG/URL producer (zapsdk/utils/image.ts) regenerates on miss.
 * No history-set check needed — re-creation is automatic.
 */
export function pruneStaleImageCache(): PruneResult {
  const result: PruneResult = { deleted: 0, bytesFreed: 0 }
  try {
    const cacheDir = join(getAppDataDir(), "image-cache")
    if (!existsSync(cacheDir)) return result

    const cutoff = Date.now() - CACHE_TTL_MS
    for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const fp = join(cacheDir, entry.name)
      try {
        const st = statSync(fp)
        if (st.mtimeMs >= cutoff) continue
        unlinkSync(fp)
        result.deleted += 1
        result.bytesFreed += st.size
      } catch { /* skip */ }
    }
  } catch { /* defensive */ }
  return result
}

// ─── unified entry point ────────────────────────────────────────────

/**
 * Run both prune passes. Call this once at App mount.
 * Returns combined stats for optional debug logging.
 */
export function pruneImageStorage(): PruneResult {
  const a = pruneOrphanedPasteImages()
  const b = pruneStaleImageCache()
  const c = pruneOrphanedPasteHistoryText()
  return {
    deleted: a.deleted + b.deleted + c.deleted,
    bytesFreed: a.bytesFreed + b.bytesFreed + c.bytesFreed,
  }
}
