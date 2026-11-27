/** @jsxImportSource react */
// Thin wrappers around PickerDialog for the three single-list config
// dialogs: Model, Mode, Effort. Kept in one file because they share the
// same 30-line shape — caller hands in `{config, onCommit, onCancel}`,
// the dialog wires options + commit semantics around PickerDialog.
import { modelReasoningFor } from "../../zapsdk/core/reasoning-effort.js"
import { useEffect, useState } from "react"
import { discoverCodexModels } from "../codex-provider.js"
import {
  agentManagingModel, effortModel,
  upsertProvider,
  getActiveProvider,
  getEffort,
  setEffort,
  getEffortValuesForProvider,
  type AppConfig,
  type PermissionMode,
} from "../config.js"
import { PickerDialog, type PickerOption } from "./dialog-picker.js"

import type { WorkspaceChoice } from "../workspace-access.js"

interface DialogProps {
  config: AppConfig
  onCommit: (next: AppConfig) => void
  onCancel: () => void
}

// ── Mode picker ──────────────────────────────────────────────────────────
const MODES: { id: PermissionMode; label: string; meta: string }[] = [
  { id: "default",           label: "default",            meta: "use access granted for this task or project" },
  { id: "acceptEdits",       label: "acceptEdits",        meta: "approve file edits automatically" },
  { id: "plan",              label: "plan",               meta: "read-only research" },
  { id: "bypassPermissions", label: "bypassPermissions",  meta: "approve ordinary requests automatically" },
]

export function ModeDialog({ config, onCommit, onCancel }: DialogProps) {
  const options = MODES.map(mode => mode.id === config.permissionMode ? { ...mode, meta: mode.meta + " (current)" } : mode)
  return <PickerDialog title="Permission mode" options={options}
    initialIndex={MODES.findIndex(m => m.id === config.permissionMode)} onCancel={onCancel}
    onSelect={id => onCommit({ ...config, permissionMode: id as PermissionMode })} />
}

export function WorkspaceAccessDialog({ cwd, remembered, onChoose, onCancel }: {
  cwd: string; remembered: boolean; onChoose: (choice: WorkspaceChoice) => void; onCancel: () => void
}) {
  const options: PickerOption[] = [
    { id: "task", label: "Start implementation", meta: "edit files and run project commands for this task" },
    { id: "project", label: "Always allow work in this project" },
    { id: "analyze", label: "Only analyze", meta: "keep project files unchanged" },
  ]
  if (remembered) options.push({ id: "revoke", label: "Forget project access and return to analysis" })
  return <PickerDialog title={`Work in ${cwd}?`} options={options} onCancel={onCancel}
    onSelect={id => onChoose(id as WorkspaceChoice)} />
}

// ── Effort picker ────────────────────────────────────────────────────────
export function EffortDialog({ config, onCommit, onCancel }: DialogProps) {
  const provider = getActiveProvider(config)
  const agent = agentManagingModel(config)
  if (agent) return <PickerDialog title="Reasoning effort" options={[{ id: "agent", label: `Managed by ${agent}`, disabled: true }]} onCancel={onCancel} onSelect={onCancel} />
  // A changed connection remounts the fetch and picker, including its cursor.
  return <ModelEffortDialog key={provider ? `${provider.id}:${effortModel(config, provider)}` : "none"}
    config={config} onCommit={onCommit} onCancel={onCancel} />
}

function ModelEffortDialog({ config, onCommit, onCancel }: DialogProps) {
  const provider = getActiveProvider(config)
  const [snapshot, setSnapshot] = useState<{ provider: typeof provider; rows: Awaited<ReturnType<typeof discoverCodexModels>> }>()
  const [status, setStatus] = useState("Loading model capabilities…")
  useEffect(() => {
    if (provider?.authMode !== "codex-oauth") return
    const controller = new AbortController()
    setStatus("Loading model capabilities…")
    discoverCodexModels(controller.signal).then(rows => {
      if (controller.signal.aborted) return
      setSnapshot({ provider, rows })
      setStatus("Model has not advertised reasoning levels")
    }, () => {
      if (!controller.signal.aborted) setStatus("Discovery unavailable; using saved model capabilities")
    })
    return () => controller.abort()
  }, [provider])
  let latest = config
  if (provider && snapshot?.provider === provider) {
    const reasoningByModel = Object.fromEntries(snapshot.rows.flatMap(row => row.reasoning ? [[row.id, row.reasoning]] : []))
    latest = upsertProvider(config, { ...provider, reasoningByModel })
  }
  const active = getActiveProvider(latest)
  const codex = active?.authMode === "codex-oauth"
  const values = active ? getEffortValuesForProvider(latest, active.id) : []
  const model = active ? effortModel(latest, active) : ""
  const profile = modelReasoningFor(active?.reasoningByModel, model)
  if (!active || (!codex && values.length === 0)) {
    return <PickerDialog title="Reasoning effort"
      options={[{ id: "__none", label: "Active provider does not expose reasoning_effort", disabled: true }]}
      onCancel={onCancel} onSelect={onCancel} />
  }
  const current = getEffort(latest, active.id)
  const options: PickerOption[] = [{ id: "__default", label: codex ? "default" : "off",
    meta: `${codex ? `server default${profile?.defaultEffort ? ` (${profile.defaultEffort})` : ""}` : "server default"}${!current ? " (current)" : ""}` },
    ...values.map(value => ({ id: `level:${value}`, label: value,
      meta: [profile?.levels.find(level => level.effort === value)?.description,
        current === value ? "(current)" : undefined].filter(Boolean).join(" · ") }))]
  if (codex && !profile) options.push({ id: "__status", label: status, disabled: true })
  if (codex && profile?.levels.length === 0) options.push({ id: "__none", label: "No adjustable reasoning levels", disabled: true })
  return <PickerDialog key={`${model}:${values.join(",")}:${current ?? "default"}`}
    title={`Reasoning effort — ${codex ? model : active.name}`}
    options={options} initialIndex={current ? Math.max(0, values.indexOf(current) + 1) : 0}
    onCancel={onCancel} onSelect={id => onCommit(setEffort(latest, active.id, id === "__default" ? null : id.slice(6)))} />
}
