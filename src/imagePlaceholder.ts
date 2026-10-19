/**
 * Detect damaged `[Image #N]` placeholders in the input box.
 *
 * The placeholder is the visual proxy for an attached image —
 * `pendingImages` carries the actual bytes, keyed by id. When the
 * user edits the input in any way that breaks a placeholder's
 * structure (`[Image #5]` → `[Image #5`, `Image #5]`, partial
 * digit damage, selection-then-overtype, etc.), the image with
 * that id should be dropped from `pendingImages` AND the surviving
 * fragment scrubbed from the input — otherwise the orphaned image
 * silently rides along on the next submit.
 *
 * Pure function so the policy can be tested without React.
 */

export type BrokenPlaceholderResult = {
  /** `next` with broken-placeholder fragments removed. */
  cleaned: string
  /** ids whose well-formed `[Image #N]` token disappeared from `next`. */
  lostImageIds: number[]
  /** ids whose well-formed `[Pasted #N · X lines · Y chars]` token
   *  disappeared from `next`. */
  lostPasteIds: number[]
}

const IMAGE_RE  = /\[Image #([1-9]\d*)\]/g
const PASTED_RE = /\[Pasted #([1-9]\d*) · \d+ lines · \d+ chars\]/g

/**
 * Compare prev's well-formed placeholder ID counts (Image + Pasted) to
 * next's. Any id whose token count decreased is treated as "the user damaged
 * or deleted at least one token" — return a cleaned version of `next` with
 * surviving fragments stripped. Only ids whose count dropped to zero are
 * reported as lost so the caller drops pendingImages / pasteStore entries
 * only when no intact placeholder still references that content.
 *
 * With the new ControlledInput, atomic deletion already removes whole
 * tokens cleanly — `cleaned` typically equals `next` and the diff
 * surfaces purely as lost IDs. The strip-fragment logic stays as
 * defense against silent programmatic value rewrites that don't go
 * through the input box (e.g. paste-handler edge cases).
 *
 * Returns `null` when no ids were lost — caller keeps `next` as-is.
 *
 * Lookahead `(?!\d)` prevents id "1" from mis-matching inside an
 * adjacent well-formed `[Image #11]` token.
 */
export function detectBrokenPlaceholders(
  prev: string,
  next: string,
): BrokenPlaceholderResult | null {
  const prevImg   = countIds(prev, IMAGE_RE)
  const nextImg   = countIds(next, IMAGE_RE)
  const prevPaste = countIds(prev, PASTED_RE)
  const nextPaste = countIds(next, PASTED_RE)

  const damagedImageIds: number[] = []
  const lostImageIds: number[] = []
  for (const [id, count] of prevImg) {
    const nextCount = nextImg.get(id) ?? 0
    if (nextCount < count) damagedImageIds.push(id)
    if (nextCount === 0) lostImageIds.push(id)
  }
  const damagedPasteIds: number[] = []
  const lostPasteIds: number[] = []
  for (const [id, count] of prevPaste) {
    const nextCount = nextPaste.get(id) ?? 0
    if (nextCount < count) damagedPasteIds.push(id)
    if (nextCount === 0) lostPasteIds.push(id)
  }

  if (damagedImageIds.length === 0 && damagedPasteIds.length === 0) return null

  let cleaned = next
  for (const id of damagedImageIds) {
    cleaned = stripBrokenImageFragments(cleaned, id)
  }
  for (const id of damagedPasteIds) {
    // Strip only malformed variants of the canonical pasted-token shape,
    // anchored on the " · N lines · M chars" suffix. The rest of the token
    // must match exactly so we don't eat legitimate text adjacent to a
    // damaged token (e.g. trailing " tail"). Mid-token typos that change
    // "lines" / "chars" are not auto-recovered — those cases are rare and
    // the lostPasteId is still surfaced so the pasteStore entry gets cleaned.
    cleaned = stripBrokenPastedFragments(cleaned, id)
  }
  return { cleaned, lostImageIds, lostPasteIds }
}

function stripBrokenImageFragments(text: string, id: number): string {
  return text
    .replace(new RegExp(`(^|[^\\[])Image #${id}(?!\\d)\\]`, "g"), "$1")
    .replace(new RegExp(`(^|[^\\[])Image #${id}(?!\\d)(?!\\])`, "g"), "$1")
    .replace(new RegExp(`\\[Image #${id}(?!\\d)(?!\\])`, "g"), "")
}

function stripBrokenPastedFragments(text: string, id: number): string {
  const body = `Pasted #${id}(?!\\d) · \\d+ lines · \\d+ chars`
  return text
    .replace(new RegExp(`(^|[^\\[])${body}\\]`, "g"), "$1")
    .replace(new RegExp(`(^|[^\\[])${body}(?!\\])`, "g"), "$1")
    .replace(new RegExp(`\\[${body}(?!\\])`, "g"), "")
}

function countIds(s: string, re: RegExp): Map<number, number> {
  const ids = new Map<number, number>()
  for (const m of s.matchAll(re)) {
    const id = Number(m[1])
    ids.set(id, (ids.get(id) ?? 0) + 1)
  }
  return ids
}

/** @deprecated — use `detectBrokenPlaceholders`. Kept temporarily for
 *  any leftover callers; will be removed once App.tsx is migrated. */
export const detectBrokenImagePlaceholders = detectBrokenPlaceholders
