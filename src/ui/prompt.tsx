/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react"
import { Box, Text, useInput, usePaste, useCursor, useBoxMetrics, type DOMElement } from "ink"
import wrapAnsi from "wrap-ansi"
import { ControlledInput } from "./controlled-input.js"
import { clampCursor, insertAt as insertAtCursor } from "./input-nav.js"
import { useTerminalFocus } from "./terminal-focus.js"
import { c } from "./theme.js"
import { displayWidth } from "./truncate.js"
import type { AppConfig } from "../config.js"
import { join, basename, dirname } from "node:path"
import { chmodSync, existsSync, readFileSync, appendFileSync } from "node:fs"
import { appDataDir } from "../session.js"
import { writeFileAtomic } from "../utils/secure-write.js"
import {
  MAX_PROMPT_HISTORY,
  isDuplicatePromptHistoryEntry,
  parsePromptHistoryLines,
  persistSidecarPastedContents,
  restorePromptHistoryEntry,
  sanitizeHistoryDisplayForPastes,
  splitHistoryPastedContents,
  type PromptHistoryEntry,
} from "./prompt-history.js"

// ── Prompt history (persisted to history.jsonl, CCB-compatible) ─────────
const HISTORY_PATH = join(appDataDir, "history.jsonl")
const MAX_HISTORY = MAX_PROMPT_HISTORY

const history: PromptHistoryEntry[] = (() => {
  try {
    if (existsSync(HISTORY_PATH)) {
      const lines = readFileSync(HISTORY_PATH, "utf-8").split("\n").filter(Boolean)
      const { entries, dirty } = parsePromptHistoryLines(lines, MAX_HISTORY)
      if (dirty) {
        try { rewriteHistory(entries) } catch {}
      }
      return entries
    }
  } catch {}
  return []
})()

let navIndex = -1
let navStarting = ""

export function pushHistory(
  entry: string,
  pastedContents: Record<string, string> = {},
  imageRefs: Record<string, string> = {},
  _sessionId?: string,
) {
  const trimmed = entry.trim()
  if (!trimmed) return
  const { pastedContents: sanitizedPastedContents, sidecarPastedContents } =
    splitHistoryPastedContents(pastedContents)
  const pastedContentRefs = persistSidecarPastedContents(appDataDir, sidecarPastedContents)
  const display = sanitizeHistoryDisplayForPastes(
    trimmed,
    sanitizedPastedContents,
    pastedContentRefs,
  )
  const line: PromptHistoryEntry = {
    display,
    pastedContents: sanitizedPastedContents,
    ...(Object.keys(pastedContentRefs).length > 0 ? { pastedContentRefs } : {}),
    // Omit when empty so old entries (no images) stay JSON-compact.
    ...(Object.keys(imageRefs).length > 0 ? { imageRefs } : {}),
    timestamp: Date.now(),
  }
  if (isDuplicatePromptHistoryEntry(history[history.length - 1], line)) return
  history.push(line)
  while (history.length > MAX_HISTORY) history.shift()
  try {
    appendFileSync(HISTORY_PATH, JSON.stringify(line) + "\n", { mode: 0o600 })
    chmodSync(HISTORY_PATH, 0o600)
  } catch {}
  navIndex = -1
  navStarting = ""
}

function rewriteHistory(entries: PromptHistoryEntry[]): void {
  writeFileAtomic(
    HISTORY_PATH,
    entries.map(e => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""),
    { mode: 0o600 },
  )
}

/**
 * Pasted-blob map for the entry the cursor currently sits on during
 * ↑/↓ history nav. App reads this after each nav to rehydrate its
 * paste store so placeholders in the recalled entry can still expand
 * to their original content on submit.
 */
export function getCurrentNavPastedContents(): Record<string, string> {
  if (navIndex < 0 || navIndex >= history.length) return {}
  const entry = history[navIndex]
  if (!entry) return {}
  return restorePromptHistoryEntry(appDataDir, entry).pastedContents
}

/** Image-ref counterpart of `getCurrentNavPastedContents`. Returns the
 *  id → filePath map for the entry the cursor is currently on, so App
 *  can re-load image bytes via loadImageFromFile and re-populate
 *  `pendingImages`. Empty map for older entries (those written before
 *  imageRefs was added to HistoryEntry). */
export function getCurrentNavImageRefs(): Record<string, string> {
  if (navIndex < 0 || navIndex >= history.length) return {}
  const entry = history[navIndex]
  return entry ? restorePromptHistoryEntry(appDataDir, entry).imageRefs : {}
}

export function historyUp(currentValue: string): string | null {
  if (history.length === 0) return null
  if (navIndex === -1) {
    navStarting = currentValue
    navIndex = history.length
  }
  const filterPrefix = navStarting
  for (let i = navIndex - 1; i >= 0; i--) {
    const entry = history[i]
    const e = entry ? restorePromptHistoryEntry(appDataDir, entry).display : ""
    if (!filterPrefix || e.startsWith(filterPrefix)) {
      navIndex = i
      return e
    }
  }
  return null
}

export function historyDown(): string | null {
  if (navIndex === -1) return null
  for (let i = navIndex + 1; i < history.length; i++) {
    const entry = history[i]
    const e = entry ? restorePromptHistoryEntry(appDataDir, entry).display : ""
    if (!navStarting || e.startsWith(navStarting)) {
      navIndex = i
      return e
    }
  }
  navIndex = -1
  return navStarting
}

export function resetHistoryNav() { navIndex = -1; navStarting = "" }
export function tryHistoryUp(currentValue: string): string | null { return historyUp(currentValue) }
export function tryHistoryDown(): string | null { return historyDown() }

// ── Shell mode ─────────────────────────────────────────────────────────
let shellMode = false
export function isShellMode()     { return shellMode }
export function setShellMode(v: boolean) { shellMode = v }

interface PromptProps {
  config: AppConfig
  providerLabel: string
  hasActiveKey: boolean
  inputValue: string
  /** Called whenever the user changes the input. `meta.deletedPlaceholder`
   *  is set when an atomic placeholder removal happened (backspace at
   *  the right boundary of a `[Image #N]` or `[Pasted #N · ...]` token);
   *  callers use it to drop the corresponding pendingImages /
   *  pasteStore entry without having to diff old vs new value. Plain
   *  edits leave meta undefined. */
  onInput: (
    value: string,
    meta?: { deletedPlaceholder?: { start: number; end: number; text: string } },
  ) => void
  onSubmit: (value: string) => void
  /** Paste handler. Receives the entire pasted blob (Ink's usePaste
   *  delivers it atomically). The insertion context lets app-level handlers
   *  fold long/multi-line pastes into placeholders without losing the
   *  current cursor position. */
  onPaste?: (text: string, ctx: {
    value: string
    cursorOffset: number
    insertText: (text: string) => void
    source?: "bracketed" | "unframed"
    trimBoundaryPadding?: boolean
    stripTrailingBoundaryRows?: boolean
  }) => void
  /** Called after each ↑/↓ history nav step with the pasted-blob
   *  map for the entry the user just navigated onto. App merges
   *  these into its paste store so placeholders in recalled entries
   *  can still expand on submit. */
  onHistoryNav?: (
    pastedContents: Record<string, string>,
    imageRefs: Record<string, string>,
  ) => void
  /** Bump this when the input was changed externally (paste / history
   *  nav / programmatic set) and the cursor should jump to the end of
   *  the value. ink-text-input doesn't relocate its internal cursor on
   *  prop value changes; using this as the TextInput key forces a
   *  remount whose cursor inits at value.length (i.e. the end). */
  inputEpoch?: number
  focused: boolean
  blockSubmit?: boolean
  isRunning: boolean
  inputTokens: number
  outputTokens: number
  contextTokens?: number
  maxContextTokens?: number
  onHeightChange?: (height: number) => void
  /** When true, Prompt ignores ↑/↓ arrow keys so an open palette
   *  (slash / file / etc.) above can use them for selection nav. */
  disableHistoryNav?: boolean
  /** When true, drop the prompt's top margin. Used when LiveActivity
   *  is rendered above — that component already provides its own gap,
   *  so the default marginTop=1 doubles the spacing. */
  noTopMargin?: boolean
}

export function Prompt({
  hasActiveKey,
  inputValue,
  onInput,
  onSubmit,
  onPaste,
  onHistoryNav,
  inputEpoch = 0,
  focused,
  blockSubmit,
  isRunning,
  onHeightChange,
  disableHistoryNav,
  noTopMargin = false,
}: PromptProps) {
  // Cursor offset is owned by Prompt now — ControlledInput is fully
  // controlled. Reset to value end on every inputEpoch bump (external
  // rewrites: history nav, attachImageWithPlaceholder, slash autocomplete,
  // submit clearing the input). Plain typing/cursor-move re-renders
  // bump cursorOffset directly via onValueChange — they MUST NOT
  // trigger this reset, otherwise typing in the middle of the input
  // would snap cursor back to end on every keystroke.
  const [cursorOffset, setCursorOffset] = useState(inputValue.length)
  useEffect(() => { setCursorOffset(inputValue.length) }, [inputEpoch])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  const windowFocused = useTerminalFocus()
  const cursorVisible = focused && windowFocused
  const isShell = isShellMode()
  const borderColor = isRunning ? c.text.faint : isShell ? c.warning : c.border.focus
  const iconFg     = isShell ? c.warning : hasActiveKey ? c.accent : c.warning
  const icon       = isShell ? "$ " : hasActiveKey ? "❯ " : "! "

  // Report height — single row + border = 3 rows. Phase-2 follow-up: dynamic
  // multi-line growth.
  useEffect(() => { onHeightChange?.(3) }, [onHeightChange])

  // History nav — Ink's TextInput doesn't expose arrow keys directly; use
  // useInput to intercept BEFORE TextInput sees them. Only triggers when
  // focused so dialogs don't grab.
  useInput((_input, key) => {
    if (!focused || disableHistoryNav) return
    if (key.upArrow) {
      const next = historyUp(inputValue)
      if (next !== null) {
        onInput(next)
        onHistoryNav?.(getCurrentNavPastedContents(), getCurrentNavImageRefs())
      }
    } else if (key.downArrow) {
      const next = historyDown()
      if (next !== null) {
        onInput(next)
        onHistoryNav?.(getCurrentNavPastedContents(), getCurrentNavImageRefs())
      }
    }
  }, { isActive: focused })

  // Paste support. Ink's `usePaste` (a) auto-enables bracketed paste mode
  // (\x1b[?2004h) so the OS terminal stops popping the "this paste may be
  // dangerous" warning on backticks/semicolons/newlines, and (b) delivers
  // the entire pasted blob as a single string instead of fanning it out
  // through useInput one char at a time.
  //
  // App may pass an `onPaste` to replace long pastes with a placeholder
  // (avoids cluttering the prompt row). When omitted we just append.
  usePaste((text) => {
    if (!focused) return
    const insertText = (inserted: string) => {
      const result = insertAtCursor(inputValue, cursorOffset, inserted)
      setCursorOffset(result.cursorOffset)
      if (result.value !== inputValue) onInput(result.value)
    }
    if (onPaste) {
      // App-level handler owns the paste — usually substitutes a
      // `[Pasted #N · ...]` placeholder while preserving the current
      // cursor insertion point through the context callback.
      onPaste(text, {
        value: inputValue,
        cursorOffset,
        insertText,
        source: "bracketed",
      })
      return
    }
    // No app-level handler: insert the blob at the current cursor
    // position. Pre-ControlledInput we appended to end; that broke
    // mid-string paste UX, so route through `insertAt` which also
    // returns the post-insert cursor offset.
    const sanitized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    insertText(sanitized)
  }, { isActive: focused })

  const handleSubmit = (val: string) => {
    if (blockSubmit) return
    if (!val.trim()) return
    // History push moved to App.handleSubmit so it can attach a snapshot
    // of pasteStoreRef alongside the entry — without that snapshot, ↑
    // recalls a placeholder string with no way to expand it on submit.
    resetHistoryNav()
    onSubmit(val)
  }

  // We rely on Ink's flex-stretch (alignItems: stretch in the column
  // parent) to fill the available width. Don't set an explicit width
  // here — earlier revisions wrapped this in an outer Box and set
  // width={termWidth-2} on the inner bordered Box, but the outer Box
  // was in a row-direction parent so the bordered child sat at the
  // left edge with empty space on the right. Removing the wrapper
  // and the explicit width lets the border hug both edges symmetrically.
  // ── IME cursor parking via Ink's useCursor ─────────────────────────
  // Stock ink-text-input renders a chalk.inverse-space "fake" cursor —
  // the terminal's REAL cursor ends up at the bottom of Ink's frame,
  // which is where macOS IME / IBus anchor the candidate popup. Result:
  // typing 中文 shows the popup floating below the footer instead of
  // next to the input.
  //
  // Earlier versions of this file emitted raw ANSI from useEffect to
  // move the cursor up. That fought Ink's throttled log-update writes
  // (renderThrottleMs ≈ 16ms): when our useEffect ran BEFORE the
  // throttle fired, log-update wrote its next frame from the
  // parked-at-input-row position, eraseLines went up from there, and
  // the rows BELOW the input row (bottom border + footer) were never
  // erased — visible as doubled/tripled footer residue, intermittent
  // because only rapid renders hit the trailing-edge throttle path.
  //
  // useCursor + log-update's atomic cursorSuffix fixes this cleanly:
  // setCursorPosition writes a ref, useInsertionEffect propagates it
  // during commit (before resetAfterCommit triggers onRender), and
  // log-update emits the move-cursor sequence WITH the frame write,
  // tracking previousCursorPosition so the next frame's
  // buildReturnToBottomPrefix returns the cursor to end-of-frame
  // before erasing. No race, no scroll-related DECSC drift.
  //
  // y = top of bordered Box + 1 (skip top border) → input row
  // x = left + 2 (icon "❯ "/"$ "/"! ") + displayWidth(input.slice(0, cursor))
  // No left border + paddingLeft=0, so the icon sits flush at col 0.
  // Use displayWidth so CJK (2-cell) chars track correctly.
  const safeCursorOffset = clampCursor(inputValue, cursorOffset)
  // upstream `useBoxMetrics` types its ref as `RefObject<DOMElement>` but
  // `useRef(null)` produces `RefObject<DOMElement | null>` — use a
  // non-null initial assertion since the ref is always populated by the
  // time the hook reads it (post-mount).
  const boxRef = useRef<DOMElement>(null!)
  const { width: boxWidth, left: boxLeft, top: boxTop, hasMeasured } =
    useBoxMetrics(boxRef)
  const { setCursorPosition } = useCursor()
  // Match @anthropic/ink BaseTextInput — gate on focus/showCursor/terminalFocus
  // only, NOT on isRunning. With cursor hidden by log-update startup, parking
  // it at the input even during agent runs gives Apple Terminal IME the
  // position to anchor against without re-emitting `?25h` (which would trip
  // the auto-mark heuristic).
  const cursorActive =
    focused && windowFocused && !blockSubmit && !disableHistoryNav && hasMeasured
  if (cursorActive) {
    // Multi-line + visual-wrap aware. Two layers of "what line is the
    // cursor on":
    //   (a) logical lines, split on `\n` — driven by the user typing
    //       Shift+Enter
    //   (b) visual wrap rows, when a single logical line exceeds the
    //       content column width — Ink reflows the <Text> onto more
    //       rows but DOESN'T tell us about it via box metrics.
    // ControlledInput's inverse-space cursor is just a styled char
    // inside the rendered string, so Ink carries it to the wrapped
    // row automatically. The real terminal cursor placed via
    // setCursorPosition does NOT get that treatment — without the
    // simulation below, a long single-line input pinned the real
    // cursor at line-1 right edge (clamped to maxX) while the visible
    // inverse cursor sat correctly on line 2, reading as two cursors.
    //
    // We delegate to wrap-ansi with the EXACT options Ink uses for its
    // default `wrap` mode (see node_modules/ink/build/wrap-text.js:12):
    //   { trim: false, hard: true }
    // — word-wrap with hard-break fallback for unbreakable runs.
    //
    // Crucially we wrap `cursorLineText + INVERSE_SPACE_PROBE` — i.e. the
    // SAME string ControlledInput hands to Ink at the cursor row — and
    // read the probe's resulting position. Wrapping only the prefix
    // misses the boundary case where the cursor's own inverse-space
    // causes the wrap (text fills the row exactly, the inverse-space
    // bumps it onto the next row): without the probe we predict cursor
    // at row N end, Ink renders it at row N+1 start, and the real
    // terminal cursor lands one+ cells away from the visible inverse-
    // space — reading as two cursors with a gap.
    const before = inputValue.slice(0, safeCursorOffset)
    const linesBefore = before.split("\n")
    const cursorLineIdx = linesBefore.length - 1
    const cursorLineText = linesBefore[cursorLineIdx] ?? ""
    const contentWidth = Math.max(1, boxWidth - 2) // 2 cells: icon column
    // Each earlier logical line owns a separate ControlledInput row, but
    // that row can occupy several visual rows. Counting only newlines parks
    // the hardware cursor above the draft after a long multiline paste.
    const precedingRows = linesBefore.slice(0, -1).reduce((rows, line) => (
      rows + wrapAnsi(line || " ", contentWidth, { trim: false, hard: true }).split("\n").length
    ), 0)
    // ANSI inverse-space — matches `<Text inverse> </Text>` in
    // ControlledInput's renderLine. wrap-ansi handles the SGR codes
    // (zero display width) and treats the space as a 1-cell char for
    // wrap purposes.
    const INVERSE_PROBE = "\x1b[7m \x1b[27m"
    const wrapped = wrapAnsi(cursorLineText + INVERSE_PROBE, contentWidth, { trim: false, hard: true })
    const wrappedRows = wrapped.split("\n")
    const wrapRows = wrappedRows.length - 1
    const lastWrappedRow = wrappedRows[wrapRows] ?? ""
    // Strip SGR codes before measuring — Ink's render-node-to-output
    // does the same via widestLine. The probe is always the LAST cell
    // of the last row, so visualCol = (last row width) - 1.
    const lastWrappedRowStripped = lastWrappedRow.replace(/\x1b\[[0-9;]*m/g, "")
    const visualCol = Math.max(0, displayWidth(lastWrappedRowStripped) - 1)
    const x = boxLeft + 2 + visualCol
    const y = boxTop + 1 + precedingRows + wrapRows
    // Visual-wrap special case (wrapRows > 0): Ink's wrap routes through a
    // measurement path that diverges from `string-width` for some glyphs
    // (e.g. the prompt icon `❯` whose trailing-space sometimes collapses
    // in render), so our predicted x can sit 1–3 cells off from the
    // inverse-space cursor's actual visual position even though wrap-ansi
    // reports a matching row + column. The terminal hardware cursor then
    // blinks next to — not on top of — the visible inverse-space, reading
    // as two cursors. Logical newlines (Shift+Enter) don't go through
    // this path: ControlledInput renders each line as its own <Box>, so
    // y/x use the accumulated visual rows + per-line displayWidth.
    //
    // Trade-off: when input visually wraps we hide the real terminal
    // cursor entirely. IME composition popups then anchor at the
    // terminal's default position (usually end-of-frame) instead of
    // beside the input — wrapped-line IME composition is uncommon
    // enough that this is acceptable for now. The inverse-space
    // cursor remains visible at the correct logical position via
    // ControlledInput.
    if (wrapRows > 0) {
      setCursorPosition(undefined)
    } else {
      const maxX = Math.max(boxLeft + 2, boxLeft + boxWidth - 1)
      setCursorPosition({ x: Math.min(x, maxX), y })
    }
  } else {
    setCursorPosition(undefined)
  }

  return (
    <Box
      ref={boxRef}
      marginTop={noTopMargin ? 0 : 1}
      marginRight={1}
      borderStyle="round"
      borderColor={borderColor}
      // Only top/bottom borders. The horizontal rules give the prompt
      // a visual band without the boxed-in feel of side borders.
      borderLeft={false}
      borderRight={false}
      paddingLeft={0}
      paddingRight={0}
    >
      <ControlledInput
        value={inputValue}
        cursorOffset={safeCursorOffset}
        isActive={focused}
        showCursor={cursorVisible}
        prefix={<Text color={iconFg}>{icon}</Text>}
        prefixWidth={displayWidth(icon)}
        onValueChange={(result) => {
          setCursorOffset(result.cursorOffset)
          if (result.value !== inputValue) {
            onInput(
              result.value,
              result.deletedPlaceholder
                ? { deletedPlaceholder: result.deletedPlaceholder }
                : undefined,
            )
          }
        }}
        onPlainPaste={onPaste}
        onSubmit={handleSubmit}
      />
    </Box>
  )
}

// Re-exports for compat with the rest of the codebase
export { join as _join, basename as _basename, dirname as _dirname }
