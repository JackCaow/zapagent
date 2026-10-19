/**
 * Pure cursor-navigation + edit helpers for the controlled input box.
 *
 * Why pure: testing keyboard logic by mounting Ink components is heavy
 * and fragile (key events through useInput, fake stdin streams, etc.).
 * Splitting the policy into pure (string, cursor) → (string, cursor)
 * functions lets us test every navigation/edit path with plain
 * assertions, then mount the component once on top.
 *
 * Placeholder atomicity:
 *   `[Image #N]` and `[Pasted #N · X lines · Y chars]` are visual
 *   tokens for attached image bytes / pasted text blobs. The cursor
 *   should treat each as ONE position — pressing ← from the right
 *   boundary jumps to the left, backspace at the right boundary deletes
 *   the whole token, etc. ink-text-input does not support this; that's
 *   the reason we replace it with our own controlled input.
 */

/** Match every well-formed placeholder. Order in the alternation
 *  doesn't matter for correctness — `matchAll` walks the string
 *  left-to-right anyway — but listing the more-specific Image form
 *  first hints the regex engine. */
const PLACEHOLDER_RE = /\[Image #[1-9]\d*\]|\[Pasted #[1-9]\d* · \d+ lines · \d+ chars\]/g

export type PlaceholderRange = {
  start: number
  end: number
  /** The full token text. Useful for callers that need to extract id. */
  text: string
}

export function findPlaceholders(s: string): PlaceholderRange[] {
  const out: PlaceholderRange[] = []
  for (const m of s.matchAll(PLACEHOLDER_RE)) {
    if (m.index === undefined) continue
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
  }
  return out
}

/** Returns the placeholder containing the given offset, or null.
 *  An offset AT the boundary (== start or == end) is NOT inside —
 *  it's a legal cursor position adjacent to the token. */
export function placeholderAt(s: string, offset: number): PlaceholderRange | null {
  for (const r of findPlaceholders(s)) {
    if (offset > r.start && offset < r.end) return r
  }
  return null
}

// ─── cursor navigation ─────────────────────────────────────────────

/** ←: move cursor 1 left, OR jump to placeholder.start if landing inside one. */
export function navigateLeft(value: string, cursor: number): number {
  if (cursor <= 0) return 0
  // First: are we at the right boundary of a placeholder? Jump to its start.
  for (const r of findPlaceholders(value)) {
    if (cursor === r.end) return r.start
  }
  const next = cursor - 1
  // Inside detection (defensive — cursor shouldn't be inside if we always
  // navigate atomically, but external code can desync state)
  for (const r of findPlaceholders(value)) {
    if (next > r.start && next < r.end) return r.start
  }
  return next
}

/** →: move cursor 1 right, OR jump to placeholder.end if landing inside one. */
export function navigateRight(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length
  for (const r of findPlaceholders(value)) {
    if (cursor === r.start) return r.end
  }
  const next = cursor + 1
  for (const r of findPlaceholders(value)) {
    if (next > r.start && next < r.end) return r.end
  }
  return next
}

// ─── word-jump (Option+arrow / Cmd+arrow on macOS, Ctrl+arrow on Linux) ─

/** Word boundary: skip whitespace then word chars when going LEFT.
 *  Treats placeholders as single words. */
export function wordJumpLeft(value: string, cursor: number): number {
  if (cursor <= 0) return 0
  for (const r of findPlaceholders(value)) {
    if (cursor === r.end) return r.start
    if (cursor > r.start && cursor < r.end) return r.start
  }
  let i = cursor
  while (i > 0 && /\s/.test(value[i - 1] ?? "")) i--
  while (i > 0 && /\S/.test(value[i - 1] ?? "")) {
    // Stop at placeholder boundary if we're walking into one
    const inRange = findPlaceholders(value).find(r => i - 1 >= r.start && i - 1 < r.end)
    if (inRange) return inRange.start
    i--
  }
  return i
}

export function wordJumpRight(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length
  for (const r of findPlaceholders(value)) {
    if (cursor === r.start) return r.end
    if (cursor > r.start && cursor < r.end) return r.end
  }
  let i = cursor
  while (i < value.length && /\S/.test(value[i] ?? "")) {
    const inRange = findPlaceholders(value).find(r => i >= r.start && i < r.end)
    if (inRange) return inRange.end
    i++
  }
  while (i < value.length && /\s/.test(value[i] ?? "")) i++
  return i
}

// ─── line jumps ──────────────────────────────────────────────────

export function lineStart(_value: string, _cursor: number): number {
  // Single-line input — start is always 0.
  return 0
}

export function lineEnd(value: string, _cursor: number): number {
  return value.length
}

// ─── editing ─────────────────────────────────────────────────────

export type EditResult = {
  value: string
  cursorOffset: number
  /** When set, the edit removed an entire placeholder atomically.
   *  The caller (input box) uses this to also drop the corresponding
   *  pendingImages / pasteStore entry. */
  deletedPlaceholder?: PlaceholderRange
}

/** Backspace: delete one char before cursor, OR the whole placeholder
 *  whose right boundary the cursor is at (or whose interior the cursor
 *  is in, defensively). */
export function backspaceAt(value: string, cursor: number): EditResult {
  if (cursor <= 0) return { value, cursorOffset: 0 }
  for (const r of findPlaceholders(value)) {
    if (cursor === r.end || (cursor > r.start && cursor < r.end)) {
      return {
        value: value.slice(0, r.start) + value.slice(r.end),
        cursorOffset: r.start,
        deletedPlaceholder: r,
      }
    }
  }
  return {
    value: value.slice(0, cursor - 1) + value.slice(cursor),
    cursorOffset: cursor - 1,
  }
}

/** Forward delete: delete the char at cursor, OR the whole placeholder
 *  whose left boundary the cursor is at. */
export function deleteAt(value: string, cursor: number): EditResult {
  if (cursor >= value.length) return { value, cursorOffset: cursor }
  for (const r of findPlaceholders(value)) {
    if (cursor === r.start || (cursor > r.start && cursor < r.end)) {
      return {
        value: value.slice(0, r.start) + value.slice(r.end),
        cursorOffset: r.start,
        deletedPlaceholder: r,
      }
    }
  }
  return {
    value: value.slice(0, cursor) + value.slice(cursor + 1),
    cursorOffset: cursor,
  }
}

/** Ctrl+W / Option+Backspace: delete word backward, or whole placeholder
 *  if cursor is at right boundary. */
export function deleteWordBackward(value: string, cursor: number): EditResult {
  if (cursor <= 0) return { value, cursorOffset: 0 }
  for (const r of findPlaceholders(value)) {
    if (cursor === r.end || (cursor > r.start && cursor < r.end)) {
      return {
        value: value.slice(0, r.start) + value.slice(r.end),
        cursorOffset: r.start,
        deletedPlaceholder: r,
      }
    }
  }
  const wordStart = wordJumpLeft(value, cursor)
  return {
    value: value.slice(0, wordStart) + value.slice(cursor),
    cursorOffset: wordStart,
  }
}

/** Ctrl+U: delete from cursor to start of line. */
export function deleteToStart(value: string, cursor: number): EditResult {
  return {
    value: value.slice(cursor),
    cursorOffset: 0,
  }
}

/** Ctrl+K: delete from cursor to end of line. */
export function deleteToEnd(value: string, cursor: number): EditResult {
  return {
    value: value.slice(0, cursor),
    cursorOffset: cursor,
  }
}

/** Insert raw text at cursor. Splits any placeholders that the insertion
 *  point lands inside (defensive — should never happen with atomic nav,
 *  but external programmatic value setters can desync). */
export function insertAt(value: string, cursor: number, text: string): EditResult {
  if (!text) return { value, cursorOffset: cursor }
  // If insert point is inside a placeholder, snap to its end first.
  let safeCursor = cursor
  for (const r of findPlaceholders(value)) {
    if (cursor > r.start && cursor < r.end) {
      safeCursor = r.end
      break
    }
  }
  return {
    value: value.slice(0, safeCursor) + text + value.slice(safeCursor),
    cursorOffset: safeCursor + text.length,
  }
}

/** Clamp cursor to a valid position for the given value, snapping out of
 *  any placeholder interior. Used after external value rewrites to keep
 *  the cursor in a legal spot. */
export function clampCursor(value: string, cursor: number): number {
  if (cursor < 0) return 0
  if (cursor > value.length) return value.length
  for (const r of findPlaceholders(value)) {
    if (cursor > r.start && cursor < r.end) {
      // Snap to whichever boundary is closer.
      return cursor - r.start <= r.end - cursor ? r.start : r.end
    }
  }
  return cursor
}
