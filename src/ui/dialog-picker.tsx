/** @jsxImportSource react */
// Generic single-choice picker dialog. Mode, Effort, Model, Sessions,
// Permissions all reduce to "scroll a list, hit Enter to commit". The
// caller owns the option list + commit semantics; this component handles
// only the keyboard nav + visual selection.
import { memo, useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, useInput } from "ink"
import { DialogFrame } from "./dialog-frame.js"
import { c } from "./theme.js"
import { displayWidth } from "./truncate.js"
import { appLogger } from "../singletons.js"
import { isReturnInput } from "./controlled-input.js"

const DIAG = process.env.ZAPCODE_DIAG === "1"

export interface PickerOption {
  /** Stable id passed back to onSelect. */
  id: string
  /** Single-line label rendered in the row. */
  label: string
  /** Optional dim suffix (e.g. "(current)" or a description). */
  meta?: string
  /** When true, row is rendered dim and skipped during nav. */
  disabled?: boolean
}

interface Props {
  title: string
  options: PickerOption[]
  initialIndex?: number
  /** Called with the chosen option id. The caller is responsible for
   *  closing the dialog (the picker doesn't know about app state). */
  onSelect: (id: string) => void
  onCancel: () => void
  /** Override default keyboard hint footer. */
  hint?: string
  /** Max rows shown at once; longer lists window around the selection. */
  maxRows?: number
}

export const PickerDialog = memo(function PickerDialog({
  title,
  options,
  initialIndex = 0,
  onSelect,
  onCancel,
  hint = "↑/↓ select  ⏎ confirm  esc cancel",
  maxRows = 12,
}: Props) {
  const [idx, setIdx] = useState(() => clampToEnabled(options, initialIndex))
  useEffect(() => {
    setIdx(current => clampToEnabled(options, current))
  }, [options])
  // Mirror live state into a ref so the useInput handler reads the latest
  // values regardless of closure freshness. Empirically, Ink 7's useInput
  // (via useEffectEvent) does NOT always present the latest `idx` to the
  // handler — pressing Enter at idx=5 (verified via the visible "6/N"
  // indicator) selected options[0]. Reproduced on session restore. Routing
  // through a ref sidesteps the issue entirely; the render body still uses
  // `idx` directly so visible state stays correct.
  const stateRef = useRef({ idx, options, onSelect, onCancel })
  stateRef.current = { idx, options, onSelect, onCancel }
  // ZAPCODE_DIAG=1: log EVERY render — the 1Hz windowed approach was too
  // coarse (window can roll over while the user is mid-burst, leaving the
  // last batch of renders unlogged). One line per render is bounded by
  // human typing speed (~10 keys/sec absolute max), so log volume stays
  // sane while giving us exact reconcile counts.
  const renderSeqRef = useRef(0)
  if (DIAG) {
    renderSeqRef.current++
    appLogger.debug("picker_render", { seq: renderSeqRef.current, idx })
  }

  useInput((input, key) => {
    const { idx: liveIdx, options: liveOptions, onSelect: liveOnSelect, onCancel: liveOnCancel } = stateRef.current
    const returnPressed = isReturnInput(input, key)
    if (DIAG) {
      const k = key.upArrow ? "up" : key.downArrow ? "down"
        : returnPressed ? "ret" : key.escape ? "esc" : "?"
      appLogger.debug("picker_input", { key: k, idx: liveIdx })
    }
    if (key.escape) { liveOnCancel(); return }
    if (returnPressed) {
      const opt = liveOptions[liveIdx]
      if (opt && !opt.disabled) liveOnSelect(opt.id)
      return
    }
    if (key.upArrow)   { setIdx(i => stepIndex(liveOptions, i, -1)); return }
    if (key.downArrow) { setIdx(i => stepIndex(liveOptions, i, +1)); return }
  })

  // Window the option list around the selection.
  let start = 0
  if (options.length > maxRows) {
    start = Math.max(0, Math.min(idx - Math.floor(maxRows / 2), options.length - maxRows))
  }
  const visible = options.slice(start, start + maxRows)

  // Pad every label to the widest one so the meta column starts at the
  // same x position on every row. Display-width aware so CJK and other
  // wide glyphs count as 2 cells. Computed across ALL options (not just
  // the windowed slice) so scrolling doesn't shift the alignment.
  const labelColWidth = useMemo(() => {
    let max = 0
    for (const o of options) {
      const w = displayWidth(o.label)
      if (w > max) max = w
    }
    return max
  }, [options])

  return (
    <DialogFrame title={title} hint={hint}>
      <Box flexDirection="column">
        {visible.map((opt, i) => {
          const realIdx = start + i
          const active = realIdx === idx
          const fg = opt.disabled ? c.text.faint : active ? c.accent : c.text.primary
          // Active row paints meta in accent too so the selection reads as a
          // single highlighted band — matches the slash palette convention.
          // Inactive rows keep the muted/faint hierarchy so the label column
          // still dominates visually.
          const metaFg = opt.disabled ? c.text.faint : active ? c.accent : c.text.faint
          const pad = " ".repeat(Math.max(0, labelColWidth - displayWidth(opt.label)))
          return (
            <Box key={opt.id}>
              <Text color={fg} bold={active}>{opt.label}{pad}</Text>
              {opt.meta && (
                <Text color={metaFg}>{` ${opt.meta}`}</Text>
              )}
            </Box>
          )
        })}
      </Box>
    </DialogFrame>
  )
})

function stepIndex(options: PickerOption[], from: number, dir: 1 | -1): number {
  const n = options.length
  if (n === 0) return 0
  let i = from
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n
    if (!options[i]?.disabled) return i
  }
  return from
}

function clampToEnabled(options: PickerOption[], idx: number): number {
  const safe = Math.max(0, Math.min(idx, options.length - 1))
  if (!options[safe]?.disabled) return safe
  return stepIndex(options, safe, +1)
}
