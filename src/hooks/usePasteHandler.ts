import { useCallback, useRef } from "react"
import type { PendingImage } from "../queue/inputQueue.js"
import { detectBrokenPlaceholders } from "../imagePlaceholder.js"
import {
  clipboardHasImage,
  pasteImageFromClipboard,
  detectAndSaveBase64Image,
} from "../../zapsdk/utils/clipboard-image.js"
import {
  isSupportedImage,
  loadImageFromFile,
} from "../../zapsdk/utils/image.js"
import { existsSync } from "node:fs"
import type { ImageContent } from "../../zapsdk/core/types.js"
import { hasLogicalNewline } from "../utils/logicalLines.js"
import { renderPastedPlaceholder, shouldFoldPastedText } from "../utils/pastedPlaceholder.js"

const ATTACH_DEDUP_MS = 1500
const PASTE_PLACEHOLDER_RE = /\[Pasted #([1-9]\d*) · \d+ lines · \d+ chars\]/g

export interface PasteInsertionContext {
  value: string
  cursorOffset: number
  insertText: (text: string) => void
  source?: "bracketed" | "unframed"
  /** Positive evidence that horizontal boundary whitespace is terminal UI padding. */
  trimBoundaryPadding?: boolean
  /** Unframed CR/LF paste may carry a synthetic final row; never implies a leading row. */
  stripTrailingBoundaryRows?: boolean
}

type SetInputValue = UsePasteHandlerOptions["setInputValue"]

function insertPasteText(
  inserted: string,
  opts: {
    ctx?: PasteInsertionContext
    setInputValue: SetInputValue
    bumpInputEpoch: () => void
  },
): void {
  if (opts.ctx) {
    opts.ctx.insertText(inserted)
    return
  }
  opts.setInputValue((prev) => prev + inserted)
  opts.bumpInputEpoch()
}

/** Heuristic: does the pasted blob look like a drag-dropped file path?
 *  True when the trimmed text is a single line starting with `/` or `~`,
 *  or when it's fully wrapped in matching quotes around such a path.
 *  Used to decide whether the paste fall-through should de-escape `\ `
 *  spaces / strip surrounding quotes — doing this unconditionally would
 *  damage code pastes that legitimately contain those characters. */
function looksLikeDroppedPath(text: string): boolean {
  if (hasLogicalNewline(text)) return false
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > 4096) return false
  // `'/path/to/file'` or `"/path/to/file"` — common Finder drag-drop shape
  const quoted = /^(['"])(.+)\1$/.exec(trimmed)
  if (quoted && /^[/~]/.test(quoted[2]!)) return true
  // Bare `/path/to/file` or `~/path/to/file`, with possibly escaped spaces.
  return /^[/~]/.test(trimmed)
}

/** Normalize whitespace added by terminal-native text selection.
 *
 * Apple Terminal and some tmux/iTerm selection modes include the selected
 * row's surrounding CR/LF plus screen-padding spaces. Feeding that verbatim
 * into the prompt can leave the cursor on an empty boundary row, making a
 * successful paste look blank. Preserve ordinary paste whitespace verbatim;
 * remove boundary rows/padding only for a strongly identified single-row
 * terminal selection or when the unframed transport classifier explicitly
 * marks a synthetic trailing row. */
export function normalizeTextPaste(
  text: string,
  options: {
    trimBoundaryPadding?: boolean
    boundaryRows?: "both" | "trailing" | "none"
  } = {},
): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const leadingBoundaryRows = /^(?:[ \t]*\n)+/.test(normalized)
  const trailingBoundaryRows = /(?:\n[ \t]*)+$/.test(normalized)
  const candidateInner = normalized
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "")
  const inferredTerminalSelection = normalized.trim() === "" || (
    leadingBoundaryRows &&
    trailingBoundaryRows &&
    !candidateInner.includes("\n") &&
    /^[ \t].*[^ \t][ \t]+$/.test(candidateInner)
  )
  const boundaryRows = options.boundaryRows ??
    (inferredTerminalSelection ? "both" : "none")
  const stripLeading = boundaryRows === "both"
  const stripTrailing = boundaryRows === "both" || boundaryRows === "trailing"
  const hadBoundaryRows = (stripLeading && leadingBoundaryRows) ||
    (stripTrailing && trailingBoundaryRows)
  let withoutBoundaryRows = normalized
  if (stripLeading) withoutBoundaryRows = withoutBoundaryRows.replace(/^(?:[ \t]*\n)+/, "")
  if (stripTrailing) withoutBoundaryRows = withoutBoundaryRows.replace(/(?:\n[ \t]*)+$/, "")

  if (withoutBoundaryRows.includes("\n")) return withoutBoundaryRows

  // Do not trim every single-line paste: indentation and trailing spaces can
  // be meaningful model input. Horizontal trimming is allowed only when the
  // unframed-input classifier saw selection padding, or when blank boundary
  // rows plus padding on both sides identify a copied terminal display row.
  const paddedOnBothSides = /^[ \t].*[^ \t][ \t]+$/.test(withoutBoundaryRows)
  return options.trimBoundaryPadding || inferredTerminalSelection ||
    (hadBoundaryRows && paddedOnBothSides)
    ? withoutBoundaryRows.trim()
    : withoutBoundaryRows
}

/** Normalize text for the transport path that delivered it.
 *
 * Apple Terminal copies a selected display row as `text + CRLF`. Once that
 * payload arrives through bracketed-paste mode, the final CRLF is selection
 * framing rather than an intentional second input row. Remove it only when
 * the payload contains exactly one non-empty logical row. Multiline pastes
 * keep their leading/trailing newlines byte-for-byte after CR normalization.
 */
export function normalizePasteForInsertion(
  text: string,
  ctx?: Pick<
    PasteInsertionContext,
    "source" | "trimBoundaryPadding" | "stripTrailingBoundaryRows"
  >,
): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const bracketedSingleRowBoundary =
    ctx?.source === "bracketed" &&
    !normalized.startsWith("\n") &&
    /^[^\n]*\S[^\n]*\n[ \t]*$/.test(normalized)

  return normalizeTextPaste(text, {
    trimBoundaryPadding: ctx?.trimBoundaryPadding,
    boundaryRows: ctx?.source === "unframed"
      ? ctx.stripTrailingBoundaryRows ? "trailing" : "none"
      : bracketedSingleRowBoundary ? "trailing" : undefined,
  })
}

export interface UsePasteHandlerOptions {
  inputValue: string
  setInputValue: (next: string | ((prev: string) => string)) => void
  setPendingImages: (
    next: PendingImage[] | ((prev: PendingImage[]) => PendingImage[]),
  ) => void
  /** Pulled from useInputEpoch — bumped on any external write to inputValue
   *  so TextInput's internal cursor re-initializes at value.length. */
  bumpInputEpoch: () => void
  /** Used in handleHistoryNav to refresh pendingImages with re-loaded refs. */
  pendingImagesGetter?: () => PendingImage[]
}

export interface UsePasteHandlerResult {
  handleInput: (newValue: string) => void
  handlePaste: (text: string, ctx?: PasteInsertionContext) => void
  expandPastes: (input: string) => string
  /** After ↑/↓ history nav, prompt hands us the recalled entry's
   *  pastedContents + imageRefs map. Merge into the live stores and bump
   *  the counters past any rehydrated id. */
  handleHistoryNav: (
    pastedContents: Record<string, string>,
    imageRefs: Record<string, string>,
  ) => void
  attachImageWithPlaceholder: (img: ImageContent) => void
  /** Refs exposed to the parent for history-push snapshot building and reset
   *  on submit. The pasteStoreRef is the source of truth for live placeholders;
   *  imageCounterRef monotonically grows across the session (never reset on
   *  submit — see comment in submit handler). */
  pasteStoreRef: React.MutableRefObject<Map<number, string>>
  pasteCounterRef: React.MutableRefObject<number>
  imageCounterRef: React.MutableRefObject<number>
  lastAttachAtRef: React.MutableRefObject<number>
  /** Ctrl+V keyboard handler arms this window after a clipboard probe so
   *  any solo `v` keystroke that leaks through from the same Cmd+V event
   *  is dropped in handleInput. */
  absorbVUntilRef: React.MutableRefObject<number>
  /** Re-exported so the submit handler can use the same dedup window when
   *  deciding whether to absorb a stray Ctrl+V keystroke around paste. */
  ATTACH_DEDUP_MS: number
}

/**
 * Long / multi-line pastes get replaced in the prompt with a placeholder
 * (`[Pasted #N · 42 lines · 1.2KB]`) to keep the input row readable. The
 * original text is stashed in pasteStoreRef and expanded back on submit.
 * Threshold is conservative: a 4-line snippet still pastes inline; only at
 * 5+ lines or 200+ chars does the placeholder kick in.
 *
 * Image-paste is multi-branch by necessity because different terminals
 * deliver clipboard images differently:
 *   - bracketed paste with base64 inline → detectAndSaveBase64Image
 *   - paste event + OS clipboard has bytes → pasteImageFromClipboard
 *   - terminal types `[Image #N]` char-by-char → Path B in handleInput
 *   - macOS Cmd+V leaks a stray `v` keystroke → absorbV window
 *   - drag-drop a file path → isSupportedImage check on handleSubmit
 */
export function usePasteHandler(opts: UsePasteHandlerOptions): UsePasteHandlerResult {
  const {
    inputValue,
    setInputValue,
    setPendingImages,
    bumpInputEpoch,
  } = opts

  const pasteStoreRef = useRef<Map<number, string>>(new Map())
  const pasteCounterRef = useRef(0)
  const imageCounterRef = useRef(0)
  // Set after a successful image attach. Some terminals (Warp Cmd+V on a
  // clipboard with image data) emit BOTH a paste protocol event AND a stray
  // `v` keystroke — Ink's useInput has no propagation control, so the `v`
  // reaches TextInput and tacks onto the placeholder. During this window
  // handleInput drops a trailing `v` whose only diff from prev is that single
  // appended char.
  const absorbVUntilRef = useRef(0)
  // Dedup window for attach paths. A single Cmd+V can fan out to multiple
  // branches (bracketed paste fires usePaste; the same event leaks a `v`
  // char into TextInput which trips Path X) and each branch independently
  // probes the clipboard, sees the same image, and attaches it. Any attach
  // within 1500ms of the previous is treated as a duplicate signal from the
  // same user action.
  const lastAttachAtRef = useRef(0)

  const attachImageWithPlaceholder = useCallback(
    (img: ImageContent) => {
      // Single-action dedup. Window has to cover both paste-event handling
      // AND the keystroke leakage that the same Cmd+V emits a moment later
      // — combined with osascript probe latency (~50-200ms each) the gap
      // routinely exceeds 500ms.
      const now = Date.now()
      if (now - lastAttachAtRef.current < ATTACH_DEDUP_MS) return
      lastAttachAtRef.current = now
      const id = ++imageCounterRef.current
      setPendingImages((prev) => [...prev, { id, content: img }])
      setInputValue((prev) => (prev ? prev + " " : "") + `[Image #${id}]`)
      // Open absorb window: any solo `v` keystroke that arrives in the next
      // 250ms is treated as Cmd+V leakage and dropped.
      absorbVUntilRef.current = now + 250
      bumpInputEpoch()
    },
    [bumpInputEpoch, setInputValue, setPendingImages],
  )

  const handleInput = useCallback(
    (newValue: string) => {
      // Stray-`v` absorber. Right after a successful image attach, some
      // terminals leak the `v` keystroke from Cmd+V through to TextInput.
      // If the diff vs current is exactly an appended `v`, drop it (re-mount
      // via epoch bump so TextInput's internal state syncs back to the
      // un-`v` value).
      if (
        Date.now() < absorbVUntilRef.current &&
        newValue === inputValue + "v"
      ) {
        absorbVUntilRef.current = 0 // one-shot
        bumpInputEpoch()
        return
      }

      // Path X: speculative paste detect on a fresh trailing `v`. macOS
      // Cmd+V over an image-only clipboard sometimes lands as a literal
      // `v` keystroke. Off by default — when the user has ANY image left
      // in their clipboard from earlier, every typed `v` would silently
      // swallow the keystroke and attach that stale image. Gate behind
      // ZAPCODE_PASTE_V=1 for users who explicitly need it.
      if (
        process.env.ZAPCODE_PASTE_V === "1" &&
        newValue === inputValue + "v" &&
        !inputValue.endsWith("v") &&
        Date.now() - lastAttachAtRef.current >= ATTACH_DEDUP_MS
      ) {
        try {
          const imgPath = pasteImageFromClipboard()
          if (imgPath) {
            attachImageWithPlaceholder(loadImageFromFile(imgPath))
            return
          }
        } catch {
          // probe failed; fall through to normal text insert
        }
      }

      // Path B: terminal typed `[Image #N]` into the input char-by-char
      // (Warp / certain iTerm handle clipboard-image paste this way). Probe
      // the OS clipboard for the actual bytes and attach them to
      // pendingImages — but LEAVE the placeholder in the input so the user
      // has a visual marker. Submit-time expander strips placeholders before
      // dispatching.
      if (
        newValue.length > 0 &&
        newValue.endsWith("]") &&
        newValue.length > inputValue.length // only on a fresh `]` keystroke
      ) {
        const tailMatch = newValue.match(/\[Image #([1-9]\d*)\]$/)
        if (tailMatch && clipboardHasImage()) {
          try {
            const imgPath = pasteImageFromClipboard()
            if (imgPath) {
              const img = loadImageFromFile(imgPath)
              const id = Number(tailMatch[1])
              imageCounterRef.current = Math.max(imageCounterRef.current, id)
              setPendingImages((prev) => [...prev, { id, content: img }])
              // keep the placeholder visible in input — fall through to
              // setInputValue(newValue) below
            }
          } catch {
            // probe failed — leave placeholder in input as plain text
          }
        }
      }

      // Path A2: [Image #N] structural-break detection. When the user damages
      // a [Image #N] placeholder by ANY edit (single-char backspace inside
      // the bracket, multi-char delete, mid-string paste-over, etc.), the
      // placeholder is no longer well-formed — but the corresponding image
      // still sits in `pendingImages` and would silently get sent on the
      // NEXT live submit. Strip the surviving fragment from the input AND
      // drop the matching image from pendingImages so the user's "delete
      // the placeholder" gesture is atomic with respect to the attached
      // bytes.
      // Ordinary typing has no placeholders. Avoid two full-string regex
      // scans on every keypress unless the previous value can actually lose
      // an attachment token.
      const canBreakPlaceholder = inputValue.includes("[Image #")
        || inputValue.includes("[Pasted #")
      const broken = canBreakPlaceholder
        ? detectBrokenPlaceholders(inputValue, newValue)
        : null
      if (broken) {
        setInputValue(broken.cleaned)
        if (broken.lostImageIds.length > 0) {
          setPendingImages((prev) =>
            prev.filter((p) => !broken.lostImageIds.includes(p.id)),
          )
        }
        for (const pid of broken.lostPasteIds) {
          pasteStoreRef.current.delete(pid)
        }
        return
      }

      // Path A
      setInputValue((prev) => {
        if (newValue.length !== prev.length - 1) return newValue
        let i = 0
        while (i < newValue.length && newValue[i] === prev[i]) i++
        const deletedChar = prev[i]

        if (deletedChar === "]") {
          const head = prev.slice(0, i)
          const m = head.match(/\[Pasted #([1-9]\d*) · \d+ lines · \d+ chars$/)
          if (m) {
            const tokenStart = i - m[0].length
            pasteStoreRef.current.delete(Number(m[1]))
            return prev.slice(0, tokenStart) + prev.slice(i + 1)
          }
        }
        if (deletedChar === "[") {
          const tail = prev.slice(i + 1)
          const m = tail.match(/^Pasted #([1-9]\d*) · \d+ lines · \d+ chars\]/)
          if (m) {
            pasteStoreRef.current.delete(Number(m[1]))
            return prev.slice(0, i) + tail.slice(m[0].length)
          }
        }
        return newValue
      })
    },
    [
      attachImageWithPlaceholder,
      bumpInputEpoch,
      inputValue,
      setInputValue,
      setPendingImages,
    ],
  )

  const handlePaste = useCallback(
    (text: string, ctx?: PasteInsertionContext) => {
      const insertText = (inserted: string) =>
        insertPasteText(inserted, { ctx, setInputValue, bumpInputEpoch })

      // Image/base64 detection below must inspect the original bytes. Text
      // insertion uses a normalized view so terminal selection padding does
      // not create blank first/last prompt rows.
      const normalizedText = normalizePasteForInsertion(text, ctx)

      // Already-attached guard: another path (Path X or Ctrl+V handler) may
      // have probed the clipboard ahead of this paste event for the same
      // user action. Skip the image-detection branches.
      if (Date.now() - lastAttachAtRef.current < ATTACH_DEDUP_MS) {
        if (shouldFoldPastedText(normalizedText)) {
          const id = ++pasteCounterRef.current
          pasteStoreRef.current.set(id, normalizedText)
          const placeholder = renderPastedPlaceholder(id, normalizedText)
          insertText(placeholder)
        } else if (normalizedText) {
          insertText(normalizedText)
        }
        return
      }

      // Branch 0: pasted blob IS the image data (base64-encoded). Some
      // terminals deliver image paste this way. Cheapest, no IPC.
      const savedFromBase64 = detectAndSaveBase64Image(text)
      if (savedFromBase64) {
        try {
          attachImageWithPlaceholder(loadImageFromFile(savedFromBase64))
          return
        } catch {
          // load failed — fall through (rare; the file was just written)
        }
      }

      // Branch 1: empty-paste passthrough — some terminals deliver a
      // Cmd+V over an image-only clipboard as `onPaste("")`. Probe the OS
      // clipboard ONLY in that case. When `text` carries content (drag-
      // drop of a file path, a quoted file path from Finder, or any text
      // paste), the user's intent is the text — NOT a stale image they
      // copied earlier. Without this gate, dragging /Users/x/foo.yaml in
      // while a screenshot sits on the clipboard would attach the
      // screenshot and silently drop the yaml path.
      if (normalizedText === "") {
        try {
          const imgPath = pasteImageFromClipboard()
          if (imgPath) {
            attachImageWithPlaceholder(loadImageFromFile(imgPath))
            return
          }
        } catch {
          // probe failed — fall through to text-paste handling
        }
      }

      // Branch 2: pasted blob is itself a file path. Strip drag-drop shell
      // escapes + surrounding quotes.
      const stripped = normalizedText
        .replace(/\\ /g, " ")
        .replace(/^['"]|['"]$/g, "")
        .trim()
      if (isSupportedImage(stripped)) {
        try {
          attachImageWithPlaceholder(loadImageFromFile(stripped))
          return
        } catch {
          // load failure → fall through to text paste
        }
      }

      // Fall-through: pasted text wasn't a recognised image. If it looks
      // like a drag-dropped FILE PATH (unsupported type — pdf/txt/.go/etc.),
      // de-escape it so the user sees a clean path in the input box
      // instead of `'/Users/x/My\ File.pdf'`. Conservative: only strip
      // when the trimmed text starts with `/` or `~` (or is fully
      // quote-wrapped around a path-shaped inner), so code pastes
      // containing `\ ` / surrounding quotes stay intact.
      const display = looksLikeDroppedPath(normalizedText) ? stripped : normalizedText

      if (shouldFoldPastedText(display)) {
        const id = ++pasteCounterRef.current
        pasteStoreRef.current.set(id, display)
        const placeholder = renderPastedPlaceholder(id, display)
        insertText(placeholder)
      } else {
        insertText(display)
      }
    },
    [attachImageWithPlaceholder, bumpInputEpoch, setInputValue],
  )

  const expandPastes = useCallback((input: string): string => {
    return input.replace(PASTE_PLACEHOLDER_RE, (match, idStr) => {
      const stored = pasteStoreRef.current.get(Number(idStr))
      return stored ?? match
    })
  }, [])

  const handleHistoryNav = useCallback(
    (
      pastedContents: Record<string, string>,
      imageRefs: Record<string, string>,
    ) => {
      let maxPasteId = pasteCounterRef.current
      for (const [idStr, content] of Object.entries(pastedContents)) {
        const id = Number(idStr)
        if (!Number.isFinite(id)) continue
        pasteStoreRef.current.set(id, content)
        if (id > maxPasteId) maxPasteId = id
      }
      pasteCounterRef.current = maxPasteId

      // Re-load images for [Image #N] markers in the recalled value.
      // imageRefs is id → absolute filePath; loadImageFromFile re-reads bytes
      // from disk. Files deleted since the original submit are silently
      // skipped — the [Image #N] marker stays in the recalled input but no
      // image is attached, which the user can fix by re-pasting.
      let maxImageId = imageCounterRef.current
      const reloaded: PendingImage[] = []
      for (const [idStr, filePath] of Object.entries(imageRefs)) {
        const id = Number(idStr)
        if (!Number.isFinite(id)) continue
        try {
          if (!existsSync(filePath)) continue
          const content = loadImageFromFile(filePath)
          reloaded.push({ id, content })
          if (id > maxImageId) maxImageId = id
        } catch {
          /* file unreadable — skip */
        }
      }
      imageCounterRef.current = maxImageId
      setPendingImages(reloaded)

      // History nav also externally rewrites the input — cursor should
      // jump to the end of the recalled text, not stay at column 0.
      bumpInputEpoch()
    },
    [bumpInputEpoch, setPendingImages],
  )

  return {
    handleInput,
    handlePaste,
    expandPastes,
    handleHistoryNav,
    attachImageWithPlaceholder,
    pasteStoreRef,
    pasteCounterRef,
    imageCounterRef,
    lastAttachAtRef,
    absorbVUntilRef,
    ATTACH_DEDUP_MS,
  }
}

// Test-only — internal heuristic exposed for unit testing without booting
// the full hook + React runtime.
export const __test = { looksLikeDroppedPath, insertPasteText }
