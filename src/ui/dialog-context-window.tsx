/** @jsxImportSource react */
import { useState } from "react"
import { Text } from "ink"
import type { ContextWindowMode } from "../config.js"
import { DialogFrame } from "./dialog-frame.js"
import { PickerDialog } from "./dialog-picker.js"
import { TextField } from "./text-field.js"
import { c } from "./theme.js"

export function parseContextWindowInput(value: string): number | undefined {
  const trimmed = value.trim()
  const tokens = Number(trimmed)
  return /^\d+$/.test(trimmed) && Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined
}

export function ContextWindowDialog({ mode, contextWindow, onSave, onCancel }: {
  mode: ContextWindowMode
  contextWindow: number
  onSave: (mode: ContextWindowMode, tokens: number) => void
  onCancel: () => void
}) {
  const [manual, setManual] = useState(false)
  const [value, setValue] = useState(String(contextWindow))
  const [error, setError] = useState("")
  if (!manual) return <PickerDialog title="Context window" initialIndex={mode === "manual" ? 1 : 0}
    options={[{ id: "auto", label: "Automatic · use model metadata", meta: "unknown models use a visible fallback" },
      { id: "manual", label: "Manual · set token limit", meta: "kept across catalog refreshes" }]}
    onCancel={onCancel} onSelect={id => {
      if (id === "manual") setManual(true)
      else onSave("auto", contextWindow)
    }} />
  return <DialogFrame title="Manual context window" hint="enter save · esc back">
    <Text color={c.text.faint}>Total input + output tokens. For a 1M window, enter 1048576. Overrides model metadata.</Text>
    {error && <Text color={c.warning}>{error}</Text>}
    <TextField isActive value={value} onChange={next => { setValue(next); setError("") }}
      onCancel={() => setManual(false)} onSubmit={next => {
        const tokens = parseContextWindowInput(next)
        if (tokens === undefined) { setError("Enter a positive whole number of tokens."); return }
        onSave("manual", tokens)
      }} />
  </DialogFrame>
}
