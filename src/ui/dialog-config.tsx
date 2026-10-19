/** @jsxImportSource react */
// Thin wrappers around PickerDialog for the three single-list config
// dialogs: Model, Mode, Effort. Kept in one file because they share the
// same 30-line shape — caller hands in `{config, onCommit, onCancel}`,
// the dialog wires options + commit semantics around PickerDialog.
import {
  getActiveProvider,
  getEffort,
  setEffort,
  getEffortValuesForProvider,
  type AppConfig,
  type PermissionMode,
} from "../config.js"
import { PickerDialog, type PickerOption } from "./dialog-picker.js"

interface DialogProps {
  config: AppConfig
  onCommit: (next: AppConfig) => void
  onCancel: () => void
}

// ── Mode picker ──────────────────────────────────────────────────────────
const MODES: { id: PermissionMode; label: string; meta: string }[] = [
  { id: "default",           label: "default",            meta: "ask before write/edit/exec" },
  { id: "acceptEdits",       label: "acceptEdits",        meta: "auto-approve file edits" },
  { id: "plan",              label: "plan",               meta: "research only — no edits or commands" },
  { id: "bypassPermissions", label: "bypassPermissions",  meta: "auto-approve everything (use with care)" },
]

export function ModeDialog({ config, onCommit, onCancel }: DialogProps) {
  const options: PickerOption[] = MODES.map(m => ({
    id: m.id,
    label: m.label,
    meta: m.id === config.permissionMode ? `${m.meta} (current)` : m.meta,
  }))
  const initial = MODES.findIndex(m => m.id === config.permissionMode)
  return (
    <PickerDialog
      title="Permission mode"
      options={options}
      initialIndex={Math.max(0, initial)}
      onCancel={onCancel}
      onSelect={(id) => onCommit({ ...config, permissionMode: id as PermissionMode })}
    />
  )
}

// ── Effort picker ────────────────────────────────────────────────────────
export function EffortDialog({ config, onCommit, onCancel }: DialogProps) {
  const provider = getActiveProvider(config)
  const values = provider ? getEffortValuesForProvider(config, provider.id) : []
  if (!provider || values.length === 0) {
    return (
      <PickerDialog
        title="Reasoning effort"
        options={[{ id: "__none", label: "Active provider does not expose reasoning_effort", disabled: true }]}
        onCancel={onCancel}
        onSelect={onCancel}
      />
    )
  }
  const current = getEffort(config, provider.id)
  // Always allow "off" as a first-class option so the user can clear the
  // override and let the provider use its default.
  const allValues = ["off", ...values]
  const options: PickerOption[] = allValues.map(v => ({
    id: v,
    label: v,
    meta: (v === "off" ? !current : current === v) ? "(current)" : "",
  }))
  const initial = current ? Math.max(0, allValues.indexOf(current)) : 0
  return (
    <PickerDialog
      title={`Reasoning effort — ${provider.name}`}
      options={options}
      initialIndex={initial}
      onCancel={onCancel}
      onSelect={(id) => {
        const next = setEffort(config, provider.id, id === "off" ? null : id)
        onCommit(next)
      }}
    />
  )
}
