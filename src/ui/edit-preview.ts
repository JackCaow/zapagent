// Compute a unified-diff preview for the edit/create tools that the
// approval dialog renders before the user decides. Mirrors the actual tool
// semantics (edit.ts / multi-edit.ts / filesystem.ts) closely enough that
// the displayed diff matches what would land if the user approves — but
// without writing to disk and without the syntax check / mtime guard
// (those run inside the tool itself when it actually executes).
//
// Returns `null` for non-edit tools so callers can branch cleanly.
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expandHome } from "../../zapsdk/utils/path.js"
import {
  buildUnifiedDiff,
  filetypeFromPath,
  isProbablyText,
} from "../../zapsdk/builtin-tools/diff-meta.js"

const EDIT_TOOLS = new Set([
  "edit_file", "multi_edit", "write_file", "create_file",
])

const MAX_PREVIEW_BYTES = 1_000_000

export type EditPreviewSkipReason =
  | "binary"
  | "read_error"
  | "too_large"
  | "args_invalid"
  | "match_failed"
  | "match_ambiguous"

export interface EditPreview {
  toolName: string
  /** Resolved absolute path (after `~` expansion). */
  path: string
  /** Unified diff text without `--- / +++` headers. Empty when no changes
   *  or when `skipped` is set. */
  diff: string
  /** Filetype hint (extension-derived) for syntax highlighting. */
  filetype: string
  isNewFile: boolean
  oldBytes: number
  newBytes: number
  /** Set when we couldn't produce a diff. UI renders a muted note instead. */
  skipped?: EditPreviewSkipReason
  /** Human-readable reason that goes with `skipped`. */
  message?: string
}

export function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName)
}

export async function buildEditPreview(
  toolName: string,
  args: Record<string, unknown>,
): Promise<EditPreview | null> {
  if (!EDIT_TOOLS.has(toolName)) return null

  const rawPath = typeof args.path === "string" ? args.path : ""
  if (!rawPath) {
    return makeSkipped(toolName, "", "args_invalid", "missing path argument")
  }
  const path = resolve(expandHome(rawPath))

  const readResult = await safeRead(path)
  if (readResult.kind === "error") {
    return makeSkipped(toolName, path, "read_error", readResult.error)
  }
  if (readResult.kind === "binary") {
    return makeSkipped(toolName, path, "binary", "binary file")
  }
  const isNewFile = readResult.kind === "missing"
  const oldText = readResult.kind === "ok" ? readResult.text : ""

  const sim = simulateNewText(toolName, args, oldText)
  if (typeof sim !== "string") {
    return makeSkipped(toolName, path, sim.skipped, sim.message, isNewFile)
  }

  if (oldText.length > MAX_PREVIEW_BYTES || sim.length > MAX_PREVIEW_BYTES) {
    return makeSkipped(toolName, path, "too_large", "file exceeds preview size limit", isNewFile)
  }

  return {
    toolName,
    path,
    diff: buildUnifiedDiff(oldText, sim, path, 3),
    filetype: filetypeFromPath(path),
    isNewFile,
    oldBytes: Buffer.byteLength(oldText, "utf-8"),
    newBytes: Buffer.byteLength(sim, "utf-8"),
  }
}

type ReadResult =
  | { kind: "ok"; text: string }
  | { kind: "missing" }
  | { kind: "binary" }
  | { kind: "error"; error: string }

async function safeRead(path: string): Promise<ReadResult> {
  try {
    const buf = await readFile(path)
    if (!isProbablyText(buf)) return { kind: "binary" }
    return { kind: "ok", text: buf.toString("utf-8") }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === "ENOENT") return { kind: "missing" }
    return { kind: "error", error: code ?? "read failed" }
  }
}

type SimResult = string | { skipped: EditPreviewSkipReason; message: string }

function simulateNewText(
  toolName: string,
  args: Record<string, unknown>,
  oldText: string,
): SimResult {
  if (toolName === "write_file" || toolName === "create_file") {
    return typeof args.content === "string" ? args.content : ""
  }
  if (toolName === "edit_file") {
    const oldString = typeof args.old_string === "string" ? args.old_string : ""
    const newString = typeof args.new_string === "string" ? args.new_string : ""
    const replaceAll = args.replace_all === true
    return applyEdit(oldText, oldString, newString, replaceAll)
  }
  if (toolName === "multi_edit") {
    const edits = Array.isArray(args.edits) ? args.edits : []
    let buf = oldText
    for (let i = 0; i < edits.length; i++) {
      const e = (edits[i] as Record<string, unknown>) ?? {}
      const oldString = typeof e.old_string === "string" ? e.old_string : ""
      const newString = typeof e.new_string === "string" ? e.new_string : ""
      const replaceAll = e.replace_all === true
      const next = applyEdit(buf, oldString, newString, replaceAll)
      if (typeof next !== "string") {
        return {
          skipped: next.skipped,
          message: `edit ${i + 1}/${edits.length}: ${next.message}`,
        }
      }
      buf = next
    }
    return buf
  }
  return { skipped: "args_invalid", message: `unsupported tool: ${toolName}` }
}

// Mirrors edit.ts: reject empty `old_string`, reject zero matches, and
// reject ambiguous (>1) matches when replace_all is false. Same semantics
// the actual tool will hit when the user approves — keeps the preview
// honest. If preview rejects but the user approves anyway, the tool will
// still surface the same error.
function applyEdit(
  buf: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): SimResult {
  if (oldStr === "") return { skipped: "args_invalid", message: "empty old_string" }
  let count = 0
  let pos = 0
  while (true) {
    const idx = buf.indexOf(oldStr, pos)
    if (idx === -1) break
    count++
    pos = idx + oldStr.length
  }
  if (count === 0) return { skipped: "match_failed", message: "old_string not found" }
  if (count > 1 && !replaceAll) {
    return { skipped: "match_ambiguous", message: `old_string matches ${count} occurrences` }
  }
  if (replaceAll) return buf.split(oldStr).join(newStr)
  const idx = buf.indexOf(oldStr)
  return buf.slice(0, idx) + newStr + buf.slice(idx + oldStr.length)
}

function makeSkipped(
  toolName: string,
  path: string,
  skipped: EditPreviewSkipReason,
  message: string,
  isNewFile = false,
): EditPreview {
  return {
    toolName,
    path,
    diff: "",
    filetype: filetypeFromPath(path),
    isNewFile,
    oldBytes: 0,
    newBytes: 0,
    skipped,
    message,
  }
}
