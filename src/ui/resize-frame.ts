import stringWidth from "string-width"
import stripAnsi from "strip-ansi"

export interface ResizeCursorPosition {
  x: number
  y: number
}

function visualRows(line: string, width: number): number {
  const cells = stringWidth(stripAnsi(line))
  return Math.max(1, Math.ceil(cells / width))
}

/**
 * Return how many physical terminal rows the cursor must move up to reach the
 * first row of a frame that was written before a terminal-width change.
 *
 * `output` is already hard-wrapped by the Ink patch at the old width. A resize
 * may add soft-wrap rows when narrowing, but widening cannot join those hard
 * lines again. When Ink has an active cursor, the terminal is parked inside
 * the frame. Without one it is left after the frame's trailing newline (or on
 * the last row for fullscreen output), so that state must be handled
 * explicitly instead of assuming `{x: 0, y: 0}`.
 */
export function resizeFrameRowsAboveCursor(
  output: string,
  cursor: ResizeCursorPosition | undefined,
  width: number,
): number {
  if (!output || width <= 0) return 0

  const hasTrailingNewline = output.endsWith("\n")
  const split = output.split("\n")
  const lines = hasTrailingNewline ? split.slice(0, -1) : split
  if (lines.length === 0) return 0

  if (cursor) {
    const cursorLine = Math.min(
      Math.max(0, Math.floor(cursor.y)),
      lines.length - 1,
    )
    let rowsAbove = 0
    for (let i = 0; i < cursorLine; i++) {
      rowsAbove += visualRows(lines[i] ?? "", width)
    }
    return rowsAbove + Math.floor(Math.max(0, cursor.x) / width)
  }

  const frameRows = lines.reduce(
    (total, line) => total + visualRows(line, width),
    0,
  )
  return hasTrailingNewline ? frameRows : Math.max(0, frameRows - 1)
}

export function buildResizeFrameClearSequence(
  output: string,
  cursor: ResizeCursorPosition | undefined,
  width: number,
): string {
  const up = resizeFrameRowsAboveCursor(output, cursor, width)
  return `\r${up > 0 ? `\x1b[${up}A` : ""}\x1b[J`
}
