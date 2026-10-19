import { Transform, type TransformCallback } from "node:stream"

const BRACKETED_PASTE_START = "\x1b[200~"
const BRACKETED_PASTE_END = "\x1b[201~"

type ControlSequence = {
  sequence: string
  replacement: string
  focus?: boolean
}

const OUTSIDE_PASTE_SEQUENCES: ControlSequence[] = [
  { sequence: "\x1b[27;2;13~", replacement: "\n" },
  { sequence: "\x1b[13;2u", replacement: "\n" },
  { sequence: "\x1b\r", replacement: "\n" },
  { sequence: "\x1b[I", replacement: "", focus: true },
  { sequence: "\x1b[O", replacement: "", focus: false },
]

function longestSuffixThatPrefixes(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1)
  for (let length = max; length > 0; length--) {
    if (marker.startsWith(value.slice(-length))) return length
  }
  return 0
}

/**
 * Stateful transport decoder used before Ink's own input parser.
 *
 * It has deliberately narrow responsibilities:
 *   - normalize the terminal-specific Shift+Enter encodings to LF;
 *   - consume DEC 1004 focus notifications;
 *   - keep bracketed-paste markers and every byte between them untouched.
 *
 * Partial control sequences are retained across chunks. This matters because
 * raw mode changes line discipline, not the stream's chunk-boundary contract.
 */
export class TerminalInputDecoder {
  private pending = ""
  private insidePaste = false

  constructor(private readonly onFocusChange: (focused: boolean) => void) {}

  push(chunk: string): string {
    const input = this.pending + chunk
    this.pending = ""
    let output = ""
    let index = 0

    while (index < input.length) {
      if (this.insidePaste) {
        const end = input.indexOf(BRACKETED_PASTE_END, index)
        if (end >= 0) {
          output += input.slice(index, end + BRACKETED_PASTE_END.length)
          index = end + BRACKETED_PASTE_END.length
          this.insidePaste = false
          continue
        }

        const rest = input.slice(index)
        const retained = longestSuffixThatPrefixes(rest, BRACKETED_PASTE_END)
        output += retained > 0 ? rest.slice(0, -retained) : rest
        this.pending = retained > 0 ? rest.slice(-retained) : ""
        break
      }

      if (input.startsWith(BRACKETED_PASTE_START, index)) {
        output += BRACKETED_PASTE_START
        index += BRACKETED_PASTE_START.length
        this.insidePaste = true
        continue
      }

      const control = OUTSIDE_PASTE_SEQUENCES.find(({ sequence }) =>
        input.startsWith(sequence, index),
      )
      if (control) {
        output += control.replacement
        if (control.focus !== undefined) this.onFocusChange(control.focus)
        index += control.sequence.length
        continue
      }

      const rest = input.slice(index)
      const canBecomeKnownSequence = [
        BRACKETED_PASTE_START,
        ...OUTSIDE_PASTE_SEQUENCES.map(({ sequence }) => sequence),
      ].some((sequence) => sequence.startsWith(rest))
      if (canBecomeKnownSequence) {
        this.pending = rest
        break
      }

      output += input[index]
      index++
    }

    return output
  }

  hasPendingStandaloneEscape(): boolean {
    return this.pending === "\x1b" && !this.insidePaste
  }

  flushPending(): string {
    const pending = this.pending
    this.pending = ""
    return pending
  }
}

class TerminalInputTransform extends Transform {
  private readonly decoder: TerminalInputDecoder
  private escapeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(onFocusChange: (focused: boolean) => void) {
    super()
    this.decoder = new TerminalInputDecoder(onFocusChange)
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.clearEscapeTimer()
    try {
      const decoded = this.decoder.push(
        typeof chunk === "string" ? chunk : chunk.toString("utf8"),
      )
      if (decoded) this.push(decoded)
      this.scheduleEscapeFlush()
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }

  override _flush(callback: TransformCallback): void {
    this.clearEscapeTimer()
    const pending = this.decoder.flushPending()
    if (pending) this.push(pending)
    callback()
  }

  private scheduleEscapeFlush(): void {
    if (!this.decoder.hasPendingStandaloneEscape()) return
    // A lone Escape is both a complete key and a prefix for several terminal
    // sequences. Wait long enough for another stdin chunk, then hand it to
    // Ink, which applies its normal standalone-Escape handling.
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = undefined
      const pending = this.decoder.flushPending()
      if (pending) this.push(pending)
    }, 50)
  }

  private clearEscapeTimer(): void {
    if (this.escapeTimer === undefined) return
    clearTimeout(this.escapeTimer)
    this.escapeTimer = undefined
  }

}

/**
 * Give Ink a filtered ReadStream while delegating TTY lifecycle operations to
 * the real process stdin. The Transform preserves backpressure and exposes the
 * paused-mode `readable` interface used by Ink 7.
 */
export function createTerminalInputStream(
  stdin: NodeJS.ReadStream,
  onFocusChange: (focused: boolean) => void,
): NodeJS.ReadStream {
  const filtered = new TerminalInputTransform(onFocusChange)
  Object.defineProperty(filtered, "isTTY", { value: stdin.isTTY })

  const compatible = filtered as TerminalInputTransform & {
    setRawMode: (mode: boolean) => typeof filtered
    ref: () => typeof filtered
    unref: () => typeof filtered
  }
  compatible.setRawMode = (mode) => {
    stdin.setRawMode?.(mode)
    return filtered
  }
  compatible.ref = () => {
    stdin.ref()
    return filtered
  }
  compatible.unref = () => {
    stdin.unref()
    return filtered
  }

  stdin.pipe(filtered)
  return compatible as unknown as NodeJS.ReadStream
}
