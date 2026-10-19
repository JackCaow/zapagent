/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react"
import { Box, Text, useInput } from "ink"
import type { AppConfig } from "../config.js"
import { discoverProviderModels, describeCatalogRow, selectCatalogModel, type CatalogRow } from "../provider-catalog.js"
import { DialogFrame } from "./dialog-frame.js"
import { PickerDialog } from "./dialog-picker.js"
import { TextField } from "./text-field.js"
import { commandInput, isReturnInput } from "./controlled-input.js"
import { c } from "./theme.js"
import { useTermWidth } from "./term-width.js"
import { truncateToWidth } from "./truncate.js"

interface Props { config: AppConfig; initialProviderId?: string; setup?: boolean; onCommit: (next: AppConfig) => void; onCancel: () => void }

export function ModelDialog({ config, initialProviderId, setup = false, onCommit, onCancel }: Props) {
  const width = Math.max(10, useTermWidth() - 2)
  const [height, setHeight] = useState(process.stdout.rows ?? 24)
  useEffect(() => {
    const resize = () => setHeight(process.stdout.rows ?? 24)
    process.stdout.on("resize", resize)
    return () => { process.stdout.off("resize", resize) }
  }, [])
  const [providerId, setProviderId] = useState(initialProviderId ?? (config.active.providerId || config.providers[0]?.id || ""))
  const provider = config.providers.find(item => item.id === providerId)
  const [phase, setPhase] = useState<"models" | "providers" | "manual" | "search">("models")
  const [rows, setRows] = useState<CatalogRow[]>([])
  const [index, setIndex] = useState(0)
  const [query, setQuery] = useState("")
  const [manual, setManual] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(0)
  const shown = rows.filter(row => row.id.toLowerCase().includes(query.toLowerCase()))
  const selectedIndex = Math.min(index, Math.max(0, shown.length - 1))
  const live = useRef({ phase, selectedIndex, shown, config, providerId, onCommit, onCancel })
  live.current = { phase, selectedIndex, shown, config, providerId, onCommit, onCancel }

  useEffect(() => {
    if (!provider) { setRows([]); return }
    const controller = new AbortController()
    let finished = false
    setRows(provider.models.map(id => ({ id, source: "saved", metadata: provider.modelMetadata?.[id] })))
    setLoading(true); setError(""); setIndex(Math.max(0, provider.models.indexOf(config.active.model)))
    const timer = setTimeout(() => {
      if (finished) return
      finished = true; controller.abort(); setLoading(false)
      setError("Discovery timed out. Saved models remain available; press t to enter an ID.")
    }, 6500)
    void discoverProviderModels(provider, controller.signal).then(result => {
      if (finished) return
      finished = true; clearTimeout(timer)
      setRows(result.rows); setError(result.error ?? ""); setLoading(false)
    }).catch(() => {
      if (finished) return
      finished = true; clearTimeout(timer); setLoading(false)
      setError("Discovery unavailable. Press r to retry or t for a manual model ID.")
    })
    return () => { finished = true; controller.abort(); clearTimeout(timer) }
  }, [provider, refresh])

  useInput((input, key) => {
    const state = live.current
    if (state.phase !== "models") return
    const cmd = commandInput(input, key)
    if (key.escape) { state.onCancel(); return }
    if (cmd === "p" && !setup) { setPhase("providers"); return }
    if (cmd === "t") { setManual(""); setPhase("manual"); return }
    if (cmd === "/") { setPhase("search"); return }
    if (cmd === "r") { setRefresh(value => value + 1); return }
    if (key.upArrow) { setIndex(Math.max(0, state.selectedIndex - 1)); return }
    if (key.downArrow) { setIndex(Math.min(Math.max(0, state.shown.length - 1), state.selectedIndex + 1)); return }
    if (isReturnInput(input, key)) {
      const row = state.shown[state.selectedIndex]
      if (row) state.onCommit(selectCatalogModel(state.config, state.providerId, row))
    }
  })

  if (!provider) return <DialogFrame title="Models · /model" hint="esc close">
    <Text>No connection configured. Use /connect to create one first.</Text>
  </DialogFrame>
  if (phase === "providers") return <PickerDialog title="Models · choose connection"
    options={config.providers.map(item => ({ id: item.id, label: item.name || item.baseURL, meta: item.baseURL }))}
    initialIndex={Math.max(0, config.providers.findIndex(item => item.id === providerId))}
    onCancel={() => setPhase("models")} onSelect={id => { setProviderId(id); setQuery(""); setIndex(0); setPhase("models") }} />
  if (phase === "manual" || phase === "search") return <DialogFrame
    title={phase === "manual" ? `Manual model ID · ${provider.name}` : "Filter model directory"} hint="enter confirm · esc back">
    <Text color={c.text.faint}>{phase === "manual" ? "Manual IDs are unverified. The endpoint must support this exact ID." : "Filter by model ID. Discovery does not change your current selection."}</Text>
    <TextField key={phase} isActive value={phase === "manual" ? manual : query}
      onChange={phase === "manual" ? setManual : setQuery} onCancel={() => setPhase("models")}
      onSubmit={value => {
        if (phase === "manual") {
          if (value.trim()) onCommit(selectCatalogModel(config, providerId, { id: value.trim(), source: "manual" }))
        } else { setQuery(value.trim()); setIndex(0); setPhase("models") }
      }} />
  </DialogFrame>
  const count = Math.max(1, Math.min(7, Math.floor((height - 14) / 3)))
  const start = Math.max(0, selectedIndex - Math.floor(count / 2))
  return <DialogFrame title={`${setup ? "Choose a model" : "Models"} · ${provider.name || provider.baseURL}`}
    hint={setup ? "↑↓ navigate · enter select and finish · / filter · r refresh · t manual · esc choose later" : "↑↓ navigate · enter select · / filter · p connection · r refresh · t manual · esc close"}>
    {setup && <Text color={c.accent}>Connection saved. Choose a model to use it, or press esc to choose later with /model.</Text>}
    <Text color={c.text.faint}>{truncateToWidth(provider.baseURL, width)}</Text>
    <Text color={c.text.faint}>{truncateToWidth(`Current: ${config.active.providerId === providerId ? config.active.model || "none" : "none on this connection"} · ${shown.length} models${loading ? " · discovering…" : ""}${query ? ` · filter: ${query}` : ""}`, width)}</Text>
    <Text color={c.text.faint}>{truncateToWidth("Metadata is not proof of account access.", width)}</Text>
    {error && <Text color={c.warning}>{truncateToWidth(error, width)}</Text>}
    <Box flexDirection="column" marginTop={1}>
      {shown.slice(start, start + count).map((row, i) => <Box key={row.id} flexDirection="column">
        <Text color={start + i === selectedIndex ? c.accent : c.text.primary} bold={start + i === selectedIndex}>{truncateToWidth(`${start + i === selectedIndex ? "›" : " "} ${row.id}`, width)}</Text>
        <Text color={c.text.faint}>{truncateToWidth(`  ${describeCatalogRow(row).split(" · ").slice(0, 3).join(" · ")}`, width)}</Text>
        <Text color={c.text.faint}>{truncateToWidth(`  ${describeCatalogRow(row).split(" · ").slice(3).join(" · ")}`, width)}</Text>
      </Box>)}
      {!shown.length && <Text color={c.text.faint}>{loading ? "Discovering models… You can enter an ID with t." : "No matching models. Press t to enter an ID or / to change the filter."}</Text>}
      {start + count < shown.length && <Text color={c.text.faint}>{`… ${shown.length - start - count} more`}</Text>}
    </Box>
  </DialogFrame>
}
