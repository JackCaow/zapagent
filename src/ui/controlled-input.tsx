/**
 * ControlledInput — replacement for `ink-text-input` that gives the
 * Prompt component full ownership of (value, cursorOffset). The reason
 * we own cursor state instead of letting TextInput keep its own:
 *
 *   - Atomic placeholder navigation: `[Image #N]` and
 *     `[Pasted #N · ...]` need to behave as ONE cursor position. ink-
 *     text-input has no notion of a multi-char atomic unit.
 *   - Atomic placeholder deletion: backspace at the right boundary of
 *     a placeholder must delete the whole token AND signal to the
 *     parent that it should drop the corresponding pendingImages /
 *     pasteStore entry.
 *   - Deterministic IME caret tracking: the parking ANSI in Prompt
 *     needs the visual column of the cursor, which depends on
 *     cursorOffset. ink-text-input keeps cursorOffset internal and
 *     doesn't expose it.
 *
 * Behavior surface this component covers:
 *   - Printable chars (single + multi-byte CJK) inserted at cursor
 *   - Backspace / Delete (with placeholder atomicity)
 *   - ← / → (skip placeholders), Ctrl+B / Ctrl+F
 *   - Home / Ctrl+A, End / Ctrl+E
 *   - Option+← / Option+→ word jump (Ink reports as key.meta + arrow)
 *   - Ctrl+W (delete word backward), Ctrl+U (kill to start), Ctrl+K (kill to end)
 *   - Enter (submit), Escape (passthrough — caller decides)
 *
 * What this component does NOT handle:
 *   - ↑ / ↓ history nav: caller intercepts via its own useInput.
 *   - Tab autocomplete: caller handles.
 *   - Bracketed paste: caller's `usePaste` handler calls `onValueChange`
 *     with a pre-built insertion result.
 *
 * The split mirrors how ink-text-input was previously embedded: parent
 * (Prompt) owns the bigger keyboard fan-out, child handles what's
 * scoped to the input.
 */

import { useCallback, type ReactNode } from "react"
import { Box, Text, useInput } from "ink"
import { displayWidth } from "./truncate.js"
import { countCodePoints } from "../utils/logicalLines.js"
import { PASTE_CHARS_THRESHOLD } from "../utils/pastedPlaceholder.js"
import {
  navigateLeft,
  navigateRight,
  wordJumpLeft,
  wordJumpRight,
  backspaceAt,
  deleteAt,
  deleteWordBackward,
  deleteToStart,
  deleteToEnd,
  insertAt,
  type EditResult,
  type PlaceholderRange,
} from "./input-nav.js"

export type ControlledInputProps = {
  value: string
  cursorOffset: number
  /** Called for any user-initiated change. The result carries both
   *  the new value AND the new cursor position; caller stores both.
   *  When `deletedPlaceholder` is set, the caller should also remove
   *  the corresponding pendingImages / pasteStore entry. */
  onValueChange: (result: { value: string; cursorOffset: number; deletedPlaceholder?: PlaceholderRange }) => void
  /** Enter submits the input. */
  onSubmit?: (value: string) => void
  /** Handles terminal input blobs that bypass bracketed-paste mode. Long or
   *  multiline blobs should use the same placeholder pipeline as usePaste. */
  onPlainPaste?: (text: string, ctx: {
    value: string
    cursorOffset: number
    insertText: (text: string) => void
    source: "unframed"
    trimBoundaryPadding: boolean
    stripTrailingBoundaryRows: boolean
  }) => void
  /** Disable the useInput listener. Mirrors ink-text-input's `focus`. */
  isActive?: boolean
  /** When false, suppress the visible cursor (inverse-space block) without
   *  disabling input handling. Used to hide the cursor when the terminal
   *  window itself loses focus — keystrokes can't reach us in that state
   *  anyway, but we don't want to gate the listener and stop processing
   *  buffered input the moment focus returns. Defaults to `isActive`. */
  showCursor?: boolean
  /** Optional prefix rendered at the start of the first input line only.
   *  Subsequent lines get a same-width blank gutter so the text columns
   *  stay aligned. Lives inside ControlledInput so the multi-line column
   *  layout owns row composition — keeping the icon as a separate sibling
   *  of the bordered Box's flexrow caused Ink to size the row container
   *  to the icon's height (1) and skip the right border on subsequent
   *  rows. */
  prefix?: ReactNode
  /** Cells the prefix occupies. Used to render the gutter on lines 2+
   *  so the cursor column stays consistent. Pass the visible width of
   *  the prefix string (e.g. 2 for "❯ "). Required if prefix is set. */
  prefixWidth?: number
}

export function isReturnInput(input: string, key: { return?: boolean }): boolean {
  return key.return === true || input.includes("\r")
}

/** Return combinations that mean "insert a logical newline", not submit. */
export function isNewlineInput(
  input: string,
  key: { return?: boolean; shift?: boolean; meta?: boolean },
): boolean {
  if (input === "\n") return true
  if (key.return === true && (key.shift === true || key.meta === true)) return true
  // xterm modifyOtherKeys is parsed by Ink as an unknown shifted CSI key.
  // Normally the transport decoder rewrites it first; keep this fallback for
  // custom stdin streams and delayed/incomplete terminal negotiation.
  return key.shift === true && input === "[27;2;13~"
}

export function textBeforeReturn(input: string): string {
  const idx = input.indexOf("\r")
  return idx === -1 ? input : input.slice(0, idx)
}

export function commandInput(input: string, key: { return?: boolean }): string {
  const raw = isReturnInput(input, key) ? textBeforeReturn(input) : input
  return raw.replace(/[\r\n]/g, "")
}

/** Some terminals fail to deliver bracketed paste and instead hand Ink a
 *  multi-character blob containing CR/CRLF line breaks. Treat those blobs as
 *  pasted text, not Enter, otherwise everything after the first CR is lost. */
export function normalizePlainPasteInput(input: string, key: { return?: boolean }): string | null {
  if (key.return === true) return null
  const cr = input.indexOf("\r")
  if (cr >= 0) {
    // Ink documents a multi-character useInput payload as a paste. A lone CR
    // remains Enter; any CR carried alongside text is an unframed paste and
    // must never fall through to submit merely because it lacks screen padding.
    if (input.length === 1) return null
    return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  }
  if (input.length > 1 && input.includes("\n")) return input
  // Apple Terminal can occasionally bypass bracketed-paste framing for a
  // short copied row. Selection text commonly carries screen-padding spaces
  // at one or both edges; route that shape through the paste handler too so
  // it gets the same boundary normalization as a framed paste. Keep ordinary
  // short multi-codepoint / IME commits on the normal insertion path.
  if (
    input.length > 1 &&
    !input.includes("\x1b") &&
    (/^[ \t]/.test(input) || /[ \t]$/.test(input))
  ) return input
  // Some terminals deliver a large one-line paste as one useInput payload
  // without CR or bracketed-paste framing. Route only clearly batched text;
  // short multi-codepoint IME commits stay on the ordinary insertion path.
  if (!input.includes("\x1b") && countCodePoints(input) >= PASTE_CHARS_THRESHOLD) return input
  return null
}

export function ControlledInput({
  value,
  cursorOffset,
  onValueChange,
  onSubmit,
  onPlainPaste,
  isActive = true,
  showCursor,
  prefix,
  prefixWidth = 0,
}: ControlledInputProps) {
  const cursorVisible = showCursor ?? isActive
  const change = useCallback(
    (result: EditResult) => {
      onValueChange({
        value: result.value,
        cursorOffset: result.cursorOffset,
        deletedPlaceholder: result.deletedPlaceholder,
      })
    },
    [onValueChange],
  )

  const moveCursor = useCallback(
    (next: number) => {
      if (next === cursorOffset) return
      onValueChange({ value, cursorOffset: next })
    },
    [value, cursorOffset, onValueChange],
  )

  useInput((input, key) => {
    if (!isActive) return

    if (isNewlineInput(input, key)) {
      change(insertAt(value, cursorOffset, "\n"))
      return
    }

    const plainPaste = normalizePlainPasteInput(input, key)
    if (plainPaste !== null) {
      if (onPlainPaste) {
        onPlainPaste(plainPaste, {
          value,
          cursorOffset,
          insertText: (inserted) => change(insertAt(value, cursorOffset, inserted)),
          source: "unframed",
          trimBoundaryPadding: /^[ \t]/.test(input) || /[ \t](?:\r|\n)?$/.test(input),
          stripTrailingBoundaryRows: /[\r\n]$/.test(input),
        })
      } else {
        change(insertAt(value, cursorOffset, plainPaste))
      }
      return
    }

    // ── Submit ────────────────────────────────────────────────
    if (isReturnInput(input, key)) {
      const prefix = textBeforeReturn(input).replace(/\r+/g, "")
      const submitted = prefix ? insertAt(value, cursorOffset, prefix).value : value
      onSubmit?.(submitted)
      return
    }

    // ── Cursor navigation (no value change) ───────────────────
    if (key.leftArrow) {
      // Option+← / Cmd+← → word jump. Ink reports both as `key.meta`.
      if (key.meta) moveCursor(wordJumpLeft(value, cursorOffset))
      else          moveCursor(navigateLeft(value, cursorOffset))
      return
    }
    if (key.rightArrow) {
      if (key.meta) moveCursor(wordJumpRight(value, cursorOffset))
      else          moveCursor(navigateRight(value, cursorOffset))
      return
    }
    // Ctrl+B / Ctrl+F (POSIX-style char nav)
    if (key.ctrl && input === "b") { moveCursor(navigateLeft(value, cursorOffset));  return }
    if (key.ctrl && input === "f") { moveCursor(navigateRight(value, cursorOffset)); return }
    // Ctrl+A / Ctrl+E (start / end). On most macOS terminals Cmd+← / Cmd+→
    // are mapped to these by readline-style binding files, but we don't
    // depend on that — bind both directly.
    if (key.ctrl && input === "a") { moveCursor(0);              return }
    if (key.ctrl && input === "e") { moveCursor(value.length);   return }

    // ── Editing ───────────────────────────────────────────────
    if (key.backspace) {
      change(backspaceAt(value, cursorOffset))
      return
    }
    if (key.delete) {
      change(deleteAt(value, cursorOffset))
      return
    }
    // Ctrl+W: delete word backward. Some terminals also send this for
    // Option+Backspace. Either way → same behavior.
    if (key.ctrl && input === "w") {
      change(deleteWordBackward(value, cursorOffset))
      return
    }
    if (key.ctrl && input === "u") { change(deleteToStart(value, cursorOffset)); return }
    if (key.ctrl && input === "k") { change(deleteToEnd(value, cursorOffset));   return }

    // ── Tab / Escape: not consumed here. Tab is a slash-autocomplete
    //    concern at the caller level. Escape is global cancel.
    if (key.tab || key.escape) return

    // ── Printable insert. Ignore empty input (pure modifier presses)
    //    and any control-modified key we didn't already match above. ─
    if (!input) return
    if (key.ctrl || key.meta) return
    // Modified Return and raw Ctrl+J were handled above. CR is still stripped
    // defensively; multi-character CR paste blobs were classified before the
    // submit branch and therefore never reach this ordinary insertion path.
    const sanitized = input.replace(/\r+/g, "")
    if (!sanitized) return
    change(insertAt(value, cursorOffset, sanitized))
  }, { isActive })

  // ── Render value with cursor highlight ────────────────────────
  return (
    <CursorText
      value={value}
      cursor={cursorOffset}
      active={cursorVisible}
      prefix={prefix}
      prefixWidth={prefixWidth}
    />
  )
}

function CursorText({
  value,
  cursor,
  active,
  prefix,
  prefixWidth,
}: {
  value: string
  cursor: number
  active: boolean
  prefix?: ReactNode
  prefixWidth: number
}) {
  // Split on `\n` and render each line as its own flex-row inside a
  // <Box flexDirection="column">. The bordered parent (passed `prefix`
  // here) used to render the icon as a sibling Text of this component
  // in a row-direction container; Ink 7 sized the row to the icon's
  // height (1) and dropped the right border for subsequent rows when
  // value contained `\n`. Owning row composition here — icon-on-row-0
  // + blank gutter on rows 1+ — keeps every visible row a full-width
  // child of one column container, so the border tracks the height.

  // Locate which line the cursor sits on. `cursor` is a char offset over
  // the full string including `\n`. Walk lines, subtracting their length
  // + 1 (the newline) until we land inside one.
  const lines = value.split("\n")
  let cursorLine = 0
  let cursorCol = cursor
  for (; cursorLine < lines.length; cursorLine++) {
    const lineLen = lines[cursorLine]!.length
    if (cursorCol <= lineLen) break
    cursorCol -= lineLen + 1
  }
  // If cursor === value.length (past end) and the trailing line is
  // empty (value ended with `\n`), clamp to last line / its end.
  if (cursorLine >= lines.length) {
    cursorLine = lines.length - 1
    cursorCol = lines[cursorLine]!.length
  }

  const renderLine = (line: string, isCursorLine: boolean): ReactNode => {
    if (!active || !isCursorLine) {
      // Empty lines need a single space so Ink renders the row — an
      // empty <Text> collapses and the column height shrinks.
      return <Text>{line.length === 0 ? " " : line}</Text>
    }
    if (cursorCol >= line.length) {
      return (
        <Text>
          {line}
          <Text inverse> </Text>
        </Text>
      )
    }
    const before = line.slice(0, cursorCol)
    // Code-point indexing — a CJK char (one code point, 2 cells wide)
    // gets inverse on the whole glyph. Surrogate-pair emoji would
    // need Array.from; 2-char degradation is acceptable.
    const at = line[cursorCol] ?? " "
    const after = line.slice(cursorCol + 1)
    return (
      <Text>
        {before}
        <Text inverse>{at}</Text>
        {after}
      </Text>
    )
  }

  const gutter = prefix && prefixWidth > 0 ? " ".repeat(prefixWidth) : ""

  // Pin the prefix column to an exact `prefixWidth` and forbid Yoga
  // from shrinking it. Without this, when `value` is one long line that
  // overflows the available width, Ink's wrap path treats the row Box's
  // adjacent <Text> siblings as a shrinkable pair: the icon's trailing
  // space gets consumed at the flex boundary and the first content char
  // visually butts up against the `❯`. flexShrink:0 + explicit width
  // locks the icon at its declared cell count regardless of overflow.
  const renderPrefix = (forIcon: boolean): ReactNode => (
    <Box flexShrink={0} width={prefixWidth}>
      {forIcon ? prefix : <Text>{gutter}</Text>}
    </Box>
  )

  return (
    <Box flexDirection="column">
      {lines.map((line, idx) => (
        <Box key={idx}>
          {prefix && prefixWidth > 0 ? renderPrefix(idx === 0) : null}
          {renderLine(line, idx === cursorLine)}
        </Box>
      ))}
    </Box>
  )
}
