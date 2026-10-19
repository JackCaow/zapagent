import type { LogType, ToolCallInfo, UserImageRef, LogEntry } from "../ui/types.js"

type AddLog = (
  type: LogType,
  text: string,
  tool?: ToolCallInfo,
  images?: UserImageRef[],
  agentPath?: string[],
  extra?: Partial<LogEntry>,
) => void

type SetStr = (v: string) => void
type SetBool = (v: boolean) => void

/** Keep provider chunk frequency from becoming React render frequency. */
// 20fps is visually continuous for token streaming while leaving enough CPU
// budget for immediate keyboard/palette renders in Ink's single JS thread.
export const STREAM_PREVIEW_FRAME_MS = 50
export const FROZEN_STREAM_PREVIEW_FRAME_MS = 100

/**
 * The dynamic Ink frame must stay shorter than the terminal viewport. Long
 * paragraphs and a frozen Static buffer can otherwise grow without bound and
 * force wrapAnsi/Yoga/Text layout to revisit the full reply on every keypress.
 * The complete text still lives in PreviewBuf and is committed to the
 * transcript; this only limits the live preview shown before that commit.
 */
export const STREAM_PREVIEW_MAX_CHARS = 1600
export const STREAM_PREVIEW_MAX_LINES = 12

export function limitStreamingTailForDisplay(text: string, prefixAlreadyOmitted = false): string {
  let start = Math.max(0, text.length - STREAM_PREVIEW_MAX_CHARS)
  let newlines = 0
  for (let i = text.length - 1; i >= start; i--) {
    if (text[i] !== "\n") continue
    newlines++
    if (newlines >= STREAM_PREVIEW_MAX_LINES) {
      start = i + 1
      break
    }
  }
  if (start === 0 && !prefixAlreadyOmitted) return text
  if (start > 0 && text[start - 1] !== "\n") {
    const nextLine = text.indexOf("\n", start)
    if (nextLine >= 0 && nextLine - start < 160) start = nextLine + 1
  }
  return `… live preview trimmed; full output is preserved …\n\n${text.slice(start)}`
}

export interface StreamingPreviewDeps {
  addLog: AddLog
  setStreamingText: SetStr
  setIsStreaming: SetBool
  setThinkingText: SetStr
  setIsThinking: SetBool
  /** Returns true when Static commits are currently frozen (palette/dialog open).
   *  Read after each addLog call to decide whether to advance committedOffset. */
  getIsFrozen: () => boolean
}

interface PreviewBuf {
  kind: "text" | "thinking"
  text: string
  /** Char index up to which paragraphs have been committed to <Static>. */
  committedOffset: number
  /** Char index up to which paragraphs have been *sent* (committed or buffered).
   *  When frozen, committedOffset stays behind so the frozen content remains
   *  visible in the streaming tail. bufferSentOffset advances to prevent
   *  duplicate addLog calls on subsequent deltas. */
  bufferSentOffset: number
}

export interface StreamingPreview {
  /** Handle a `content_delta` event for a text content piece. Appends to the
   *  buffer, commits any completed paragraphs (boundary = `\n\n`) as
   *  liveStreamed `agent` log entries, and updates the in-flight tail in the
   *  dynamic frame. Also resets thinking state — providers that interleave
   *  thinking + text would otherwise leave the spinner stuck. */
  onTextDelta(id: string, text: string): void

  /** Handle a `content_delta` event for a thinking content piece. Lazy-starts
   *  the thinkingStartedAt timestamp on the first delta of the piece. */
  onThinkingDelta(id: string, text: string): void

  /** Handle `content_final.text`. Flushes the trailing in-flight paragraph
   *  (the last one may not end with `\n\n`) and clears the dynamic-frame
   *  text state. `finalText` is authoritative — if it diverged from the
   *  accumulated delta sum (rare provider quirk), we trust the final. */
  onTextFinal(id: string, finalText: string): void

  /** Handle `content_final.thinking`. Returns the elapsed thinking ms so the
   *  caller can stamp it on the addLog entry. */
  onThinkingFinal(id: string): { thinkingMs: number }

  /** Clear the dynamic-frame streaming/thinking UI indicators *without*
   *  discarding the underlying buffers. Used when the model transitions
   *  to a tool call (tool_call_pending or content_final.tool_call): the
   *  text/thinking content_final may still fire later, and we don't want
   *  to drop the buffer prematurely. The matching content_final will
   *  cleanly complete via onTextFinal / onThinkingFinal afterwards. */
  interruptPreviews(): void

  /** Called from the run's `finally`: drain any in-flight pieces whose
   *  content_final never fired (canonical case is Esc-abort mid-stream). */
  drainOnAbort(): void

  /** Called by useLogs immediately after the Static freeze buffer is flushed
   *  to State. Clears any streaming-text state that was held pending because
   *  onTextFinal fired while frozen (content stayed in tail instead of being
   *  erased). */
  onStaticFlushed(): void
}

export function createStreamingPreview(deps: StreamingPreviewDeps): StreamingPreview {
  const previewById = new Map<string, PreviewBuf>()
  let thinkingStartedAt: number | null = null
  let frameTimer: ReturnType<typeof setTimeout> | null = null
  const dirtyTextIds = new Set<string>()
  let lastTextId: string | null = null
  let dirtyThinkingId: string | null = null
  let streamingActive = false
  let thinkingActive = false
  // True when onTextFinal fired while frozen: content is in the Static buffer
  // (not yet visible) and streamingText was NOT cleared so the user can still
  // see the response in the tail. Cleared by onStaticFlushed after the buffer
  // flushes to Static, or by the next onTextDelta (new run started).
  let pendingClearStreamingState = false

  function clearFrameTimerIfIdle(): void {
    if (dirtyTextIds.size > 0 || dirtyThinkingId !== null || frameTimer === null) return
    clearTimeout(frameTimer)
    frameTimer = null
  }

  function visibleText(buf: PreviewBuf): string {
    // Avoid first allocating the entire frozen suffix just to discard its
    // beginning. The probe is capped to MAX + one short line-search window.
    const probeStart = Math.max(
      buf.committedOffset,
      buf.text.length - STREAM_PREVIEW_MAX_CHARS - 160,
    )
    return limitStreamingTailForDisplay(
      buf.text.slice(probeStart),
      probeStart > buf.committedOffset,
    )
  }

  function setStreamingActive(next: boolean): void {
    if (streamingActive === next) return
    streamingActive = next
    deps.setIsStreaming(next)
  }

  function setThinkingActive(next: boolean): void {
    if (thinkingActive === next) return
    thinkingActive = next
    deps.setIsThinking(next)
  }

  function flushUiFrame(): void {
    if (frameTimer !== null) {
      clearTimeout(frameTimer)
      frameTimer = null
    }

    for (const id of dirtyTextIds) {
      const buf = previewById.get(id)
      if (buf?.kind === "text") flushTextParagraphs(buf, /* includeTail */ false)
    }
    dirtyTextIds.clear()

    if (lastTextId !== null) {
      const buf = previewById.get(lastTextId)
      if (buf?.kind === "text") deps.setStreamingText(visibleText(buf))
      lastTextId = null
    }

    if (dirtyThinkingId !== null) {
      const buf = previewById.get(dirtyThinkingId)
      if (buf?.kind === "thinking") deps.setThinkingText(buf.text)
      dirtyThinkingId = null
    }
  }

  function scheduleUiFrame(): void {
    if (frameTimer !== null) return
    // Palette/approval interaction has priority over token animation. Static
    // commits are already buffered while frozen, so a 10fps preview is enough
    // to show progress and materially reduces keypress/frame collisions.
    const delay = deps.getIsFrozen()
      ? FROZEN_STREAM_PREVIEW_FRAME_MS
      : STREAM_PREVIEW_FRAME_MS
    frameTimer = setTimeout(flushUiFrame, delay)
  }

  function cancelTextFrame(id?: string): void {
    if (id === undefined) {
      dirtyTextIds.clear()
      lastTextId = null
    } else {
      dirtyTextIds.delete(id)
      if (lastTextId === id) lastTextId = null
    }
    clearFrameTimerIfIdle()
  }

  function cancelThinkingFrame(id?: string): void {
    if (id === undefined || dirtyThinkingId === id) dirtyThinkingId = null
    clearFrameTimerIfIdle()
  }

  function flushTextParagraphs(buf: PreviewBuf, includeTail: boolean): void {
    // When the freeze just lifted, sync committedOffset to match what was
    // already sent to the buffer (now flushed to Static). Without this, the
    // next setStreamingText call would show flushed paragraphs in BOTH the
    // tail and Static simultaneously.
    if (!deps.getIsFrozen() && buf.bufferSentOffset > buf.committedOffset) {
      buf.committedOffset = buf.bufferSentOffset
    }

    let scanFrom = buf.committedOffset
    // Bounded for issue #20 freeze investigation. Each iteration must advance
    // scanFrom by ≥ 2; a single buf.text is capped at provider chunk sizes
    // (well under 100k chars even for very long replies), so 200k iterations
    // is comfortably above the natural ceiling. Throwing here gives us a
    // stack trace before the freeze swallows Ctrl+C.
    let iter = 0
    while (true) {
      if (++iter > 200000) {
        throw new Error(
          `flushTextParagraphs runaway: scanFrom=${scanFrom} text.length=${buf.text.length} committedOffset=${buf.committedOffset} bufferSentOffset=${buf.bufferSentOffset}`,
        )
      }
      const boundary = buf.text.indexOf("\n\n", scanFrom)
      if (boundary < 0) break
      const end = boundary + 2

      // Skip paragraphs already sent to the freeze buffer (avoid duplicates).
      if (end <= buf.bufferSentOffset) {
        scanFrom = end
        continue
      }

      // Paragraph slice starts from whichever offset is furthest ahead.
      const start = Math.max(buf.committedOffset, buf.bufferSentOffset)
      const paragraphText = buf.text.slice(start, end)
      const firstOfStream = buf.committedOffset === 0 && buf.bufferSentOffset === 0
      deps.addLog("agent", paragraphText, undefined, undefined, undefined, {
        liveStreamed: true,
        firstOfStream,
      })
      if (deps.getIsFrozen()) {
        // Buffered — keep committedOffset where it is so the paragraph
        // remains visible in the streaming tail until the freeze releases.
        buf.bufferSentOffset = end
      } else {
        buf.committedOffset = end
        buf.bufferSentOffset = end
      }
      scanFrom = end
    }

    if (includeTail) {
      const start = Math.max(buf.committedOffset, buf.bufferSentOffset)
      const tailText = buf.text.slice(start)
      if (tailText.length > 0) {
        const firstOfStream = buf.committedOffset === 0 && buf.bufferSentOffset === 0
        deps.addLog("agent", tailText, undefined, undefined, undefined, {
          liveStreamed: true,
          firstOfStream,
        })
        if (deps.getIsFrozen()) {
          buf.bufferSentOffset = buf.text.length
        } else {
          buf.committedOffset = buf.text.length
          buf.bufferSentOffset = buf.text.length
        }
      }
    }
  }

  return {
    onTextDelta(id, text) {
      // New streaming started — cancel any pending clear from a prior run that
      // ended while frozen (its content is already in the Static buffer).
      pendingClearStreamingState = false
      const buf = previewById.get(id) ?? { kind: "text" as const, text: "", committedOffset: 0, bufferSentOffset: 0 }
      buf.text += text
      previewById.set(id, buf)
      if (thinkingActive) {
        cancelThinkingFrame()
        deps.setThinkingText("")
      }
      setThinkingActive(false)
      setStreamingActive(true)
      // Paragraph commits and live-tail updates share one 20fps frame. This
      // also lets React batch multiple addLog calls from a burst of chunks.
      dirtyTextIds.add(id)
      lastTextId = id
      scheduleUiFrame()
    },

    onThinkingDelta(id, text) {
      const buf = previewById.get(id) ?? { kind: "thinking" as const, text: "", committedOffset: 0, bufferSentOffset: 0 }
      buf.text += text
      previewById.set(id, buf)
      setThinkingActive(true)
      dirtyThinkingId = id
      scheduleUiFrame()
      if (thinkingStartedAt === null) thinkingStartedAt = Date.now()
    },

    onTextFinal(id, finalText) {
      // Preserve event ordering: drain any coalesced paragraph commits before
      // applying the authoritative final value.
      flushUiFrame()
      const buf = previewById.get(id) ?? { kind: "text" as const, text: finalText, committedOffset: 0, bufferSentOffset: 0 }
      // Final is authoritative — providers occasionally diverge from
      // accumulated deltas. Trust the final to avoid drop/duplicate.
      if (buf.text !== finalText) buf.text = finalText
      flushTextParagraphs(buf, /* includeTail */ true)
      previewById.delete(id)
      if (deps.getIsFrozen()) {
        // Content went into the Static buffer, not yet visible. Keep
        // streamingText showing so the user can still read the response
        // while the palette is open. onStaticFlushed() will clear it after
        // the buffer flushes to State when the palette closes.
        pendingClearStreamingState = true
        deps.setStreamingText(visibleText(buf))
        setStreamingActive(false)
      } else {
        deps.setStreamingText("")
        setStreamingActive(false)
      }
    },

    onThinkingFinal(id) {
      // Capture startedAt BEFORE clearing the ref. Returning ms === 0 from a
      // post-clear read was the visible bug in the old single-method flow.
      const startedAt = thinkingStartedAt
      const thinkingMs = startedAt !== null ? Math.max(0, Date.now() - startedAt) : 0
      cancelThinkingFrame(id)
      previewById.delete(id)
      deps.setThinkingText("")
      setThinkingActive(false)
      thinkingStartedAt = null
      return { thinkingMs }
    },

    interruptPreviews() {
      cancelTextFrame()
      cancelThinkingFrame()
      deps.setStreamingText("")
      setStreamingActive(false)
      deps.setThinkingText("")
      setThinkingActive(false)
      thinkingStartedAt = null
    },

    drainOnAbort() {
      cancelTextFrame()
      cancelThinkingFrame()
      for (const [, buf] of previewById) {
        if (!buf.text) continue
        if (buf.kind === "text") {
          flushTextParagraphs(buf, /* includeTail */ true)
        } else {
          const startedAt = thinkingStartedAt
          const thinkingMs = startedAt !== null ? Math.max(0, Date.now() - startedAt) : 0
          deps.addLog("thinking", buf.text, undefined, undefined, undefined, { thinkingMs })
        }
      }
      previewById.clear()
      thinkingStartedAt = null
      deps.setThinkingText("")
      setThinkingActive(false)
      // If onTextFinal already fired while frozen (pendingClearStreamingState=true),
      // the content is in the freeze buffer waiting to flush. Leave streamingText
      // visible; onStaticFlushed() will clear it when the palette closes.
      if (!pendingClearStreamingState) {
        deps.setStreamingText("")
        setStreamingActive(false)
      }
    },

    onStaticFlushed() {
      if (!pendingClearStreamingState) return
      pendingClearStreamingState = false
      cancelTextFrame()
      deps.setStreamingText("")
      setStreamingActive(false)
    },

  }
}
