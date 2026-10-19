/** @jsxImportSource react */
// Reusable framed-dialog chrome. All Phase-4 dialogs (Connect, Model, Mode,
// Effort, Sessions, Mem, Permissions, Rewind, Approval) wrap their body
// in this so the visual rhythm — border + title + footer hint — stays
// consistent across the app.
import { useEffect } from "react"
import { Box, Text, useCursor } from "ink"
import { c } from "./theme.js"

/** Hide the real terminal cursor while a dialog-style component is mounted.
 *
 * Prompt.tsx parks the real cursor via useCursor while it owns the input
 * slot; App.tsx unmounts Prompt entirely when a dialog opens. In theory
 * log-update's next render should re-emit `?25l`, but in practice the
 * native cursor leaks through and ends up at column 0 below the frame
 * (reproduced across Connect / Model / Permissions / Tool-use approval).
 * Two-layer guard:
 *   • `useCursor()` keeps `setCursorPosition(undefined)` firing on every
 *     commit, so log-update never re-emits `?25h` via cursorSuffix.
 *   • A direct `\x1b[?25l` on first dialog mount handles the boot-time race
 *     where the unmount-time hide was missed. Write to stderr (cli-cursor
 *     convention) so the escape never interleaves with log-update's stdout
 *     frame writes.
 *
 * The stderr emit is gated to ONCE per process. Apple Terminal accumulates
 * state per stderr `?25l` event (each emit makes subsequent dialog mount
 * ~1.4s slower on the slow path; investigation 2026-05-20). Once the cursor
 * is hidden, it stays hidden — log-update never re-shows it under the patched
 * cursor-helpers — so re-emitting per mount is wasted work.
 *
 * Used by DialogFrame and by dialogs that build their own chrome
 * (dialog-permissions, dialog-approval, dialog-sessions). New dialogs that
 * bypass DialogFrame should call this hook in their top-level component. */
let nativeCursorHiddenOnce = false
export function useHideNativeCursor(): void {
  useCursor()
  useEffect(() => {
    if (nativeCursorHiddenOnce) return
    nativeCursorHiddenOnce = true
    process.stderr.write("\x1b[?25l")
  }, [])
}

interface Props {
  title: string
  hint?: string
  children: React.ReactNode
  /** Override default accent color (applied to title). Plan mode and
   *  destructive-confirm dialogs use warning to flag attention. Used to be
   *  the borderColor when DialogFrame had a round border. */
  accentColor?: string
}

export function DialogFrame({ title, hint, children, accentColor }: Props) {
  useHideNativeCursor()
  // Borderless: rely on title + accent color + indented body to convey "this
  // is a modal block", matching the slash/file palette visual language. Side
  // benefit: fewer terminal bytes per render — the round-border draw used to
  // emit 4 corner glyphs + N horizontal/vertical edges every frame.
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Box>
        <Text color={accentColor ?? c.accent} bold>{title}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>{children}</Box>
      {hint && (
        <Box marginTop={1}>
          <Text color={c.text.faint}>{hint}</Text>
        </Box>
      )}
    </Box>
  )
}
