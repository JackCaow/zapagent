import { countCodePoints, countLogicalLines } from "./logicalLines.js"

export const PASTE_LINES_THRESHOLD = 5
export const PASTE_CHARS_THRESHOLD = 200

export function shouldFoldPastedText(content: string): boolean {
  return countLogicalLines(content) >= PASTE_LINES_THRESHOLD ||
    countCodePoints(content) >= PASTE_CHARS_THRESHOLD
}

export function renderPastedPlaceholder(id: string | number, content: string): string {
  return `[Pasted #${id} · ${countLogicalLines(content)} lines · ${countCodePoints(content)} chars]`
}

export function renderUnavailablePastedPlaceholder(id: string | number): string {
  return `[Pasted #${id} unavailable in history; paste again to resend full text]`
}
