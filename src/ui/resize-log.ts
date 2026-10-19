import { buildResizeFrameClearSequence, type ResizeCursorPosition } from "./resize-frame.js"

export interface FrameLog {
  (output: string): boolean
  clear(): void
  reset(): void
  sync(output: string): void
  done(): void
  setCursorPosition(position: ResizeCursorPosition | undefined): void
  isCursorDirty(): boolean
}

/** Track the frame actually written, not a cursor requested for a future render. */
export function createResizeAwareLog<T extends FrameLog>(
  log: T,
  stream: { columns?: number; write(text: string): unknown },
): T {
  let output = ""
  let cursor: ResizeCursorPosition | undefined
  let requestedCursor: ResizeCursorPosition | undefined
  let writtenAtWidth = stream.columns ?? 80
  const activeCursor = () => log.isCursorDirty() ? requestedCursor : undefined
  const remember = (text: string, position: ResizeCursorPosition | undefined) => {
    output = text
    cursor = position
    writtenAtWidth = stream.columns ?? 80
  }
  const tracked = Object.assign((text: string) => {
    const position = activeCursor()
    const written = log(text)
    if (written) remember(text, position)
    return written
  }, log) as T

  tracked.setCursorPosition = position => {
    requestedCursor = position ? { ...position } : undefined
    log.setCursorPosition(position)
  }
  tracked.sync = text => {
    const position = activeCursor()
    log.sync(text)
    // Ink's fullscreen fallback writes directly, then calls sync, not log().
    remember(text, position)
  }
  tracked.reset = () => {
    log.reset()
    remember("", undefined)
  }
  tracked.done = () => {
    log.done()
    remember("", undefined)
  }
  tracked.clear = () => {
    const width = stream.columns ?? 80
    if (output && width > 0 && width !== writtenAtWidth) {
      stream.write(buildResizeFrameClearSequence(output, cursor, width))
      log.reset()
    } else {
      log.clear()
    }
    // A second resize can arrive before the replacement frame is written.
    // Never erase using the now-removed frame a second time.
    remember("", undefined)
  }
  return tracked
}
