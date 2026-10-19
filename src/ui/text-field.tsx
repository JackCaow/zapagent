/** @jsxImportSource react */
// Headless-ish single-line text input for dialogs.
//
// Replaces the hand-rolled `useInput` branches that every step of
// dialog-connect used to ship. Owns three things callers shouldn't have
// to think about:
//
//   1. Bracketed-paste discipline via Ink's `usePaste` — pastes arrive as
//      one atomic blob instead of fanning out through useInput one char at
//      a time (which dropped chars on fast pastes and let stray surrounding
//      quotes leak into the value — see the `"sk-..."` bug).
//   2. Paste sanitization — strips CR/LF, trims surrounding whitespace, and
//      removes one matched pair of wrapping quotes (`"..."` / `'...'`) since
//      keys copied from env-var assignments and JSON literals are usually
//      quoted.
//   3. Step navigation — Enter → onSubmit, Esc → onCancel. Caller controls
//      where each transition lands; this component never knows the wizard
//      state machine.
//
// `transform` is the only per-field hook (digits-only for context window
// today, available for future fields). It runs against both typed AND
// pasted text, so the sanitization story is uniform.
import { Box, Text, useInput, usePaste } from "ink"
import { c } from "./theme.js"
import { isReturnInput, textBeforeReturn } from "./controlled-input.js"

export interface TextFieldProps {
  value: string
  onChange: (next: string) => void
  onSubmit: (value: string) => void
  onCancel: () => void
  /** Gate hooks on the active step. Inactive instances stay mounted but
   *  don't consume input — useful when callers want to render multiple
   *  fields in a column later. */
  isActive: boolean
  placeholder?: string
  hint?: string
  /** Shown in place of `value` (e.g. masked API key). Caller owns the
   *  transform; this component never inspects the underlying value. */
  displayValue?: string
  /** Display color hint — uses `muted` instead of `primary` for masked
   *  fields so a long opaque string of dots doesn't pop visually. */
  masked?: boolean
  /** Per-character filter applied to both typed and pasted text. Return
   *  an empty string to drop the input. */
  transform?: (raw: string) => string
}

/** Strip one matched pair of wrapping quotes from a token. */
function stripWrappingQuotes(s: string): string {
  if (s.length < 2) return s
  const first = s[0]
  const last = s[s.length - 1]
  if ((first === '"' || first === "'") && first === last) return s.slice(1, -1)
  return s
}

export function textFieldSubmittedValue(
  value: string,
  input: string,
  transform?: (raw: string) => string,
): string {
  const prefix = textBeforeReturn(input).replace(/[\r\n]/g, "")
  const cleanedPrefix = transform ? transform(prefix) : prefix
  return cleanedPrefix ? value + cleanedPrefix : value
}

export function TextField(props: TextFieldProps) {
  const { value, onChange, onSubmit, onCancel, isActive,
          placeholder, hint, displayValue, masked, transform } = props

  useInput((input, key) => {
    if (key.escape) { onCancel(); return }
    if (isReturnInput(input, key)) {
      const next = textFieldSubmittedValue(value, input, transform)
      if (next !== value) onChange(next)
      onSubmit(next)
      return
    }
    if (key.backspace || key.delete) { onChange(value.slice(0, -1)); return }
    // Modifier-only chords (Ctrl-C, Cmd-V on some terminals) — caller can
    // layer behavior, but TextField itself doesn't consume them as text.
    if (key.ctrl || key.meta) return
    const printable = input.replace(/[\r\n]/g, "")
    const cleaned = transform ? transform(printable) : printable
    if (cleaned) onChange(value + cleaned)
  }, { isActive })

  usePaste((text) => {
    // usePaste fires for every mounted subscriber regardless of focus; the
    // explicit guard plus `isActive` option (belt + suspenders) keeps an
    // inactive TextField from stealing pastes meant for someone else.
    if (!isActive) return
    const sanitized = stripWrappingQuotes(text.replace(/[\r\n]/g, "").trim())
    const cleaned = transform ? transform(sanitized) : sanitized
    if (cleaned) onChange(value + cleaned)
  }, { isActive })

  const shown = displayValue ?? value
  const isEmpty = shown.length === 0
  // Cursor placement matches the standard convention: it sits at the
  // typing position (start of the input when empty, end of the buffer
  // when typed). Placeholder renders AFTER the cursor — that visually
  // signals "this is a hint, not your text" instead of the misleading
  // "❯ (empty)█" layout that reads as "(empty) is the value".
  return (
    <Box flexDirection="column">
      {hint && <Text color={c.text.faint}>{hint}</Text>}
      <Box marginTop={1}>
        <Text color={c.accent}>{"❯ "}</Text>
        {isEmpty ? (
          <>
            <Text inverse> </Text>
            {placeholder && <Text color={c.text.faint}>{placeholder}</Text>}
          </>
        ) : (
          <>
            <Text color={masked ? c.text.muted : c.text.primary}>{shown}</Text>
            <Text inverse> </Text>
          </>
        )}
      </Box>
    </Box>
  )
}
