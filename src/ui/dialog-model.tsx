/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react"
import { Box, Text, useInput } from "ink"
import { inferLegacyContextWindowMode, resolveProviderContextWindow, upsertProvider, type AppConfig } from "../config.js"
import { associateModelMetadata, describeCatalogRow, selectCatalogModel } from "../provider-catalog.js"
import { configuredModelRows, discoverConfiguredModels, modelCatalogKey, savedConnectionCatalogs, type ConnectionCatalog, type ConnectionModelRow } from "../model-catalog.js"
import { DialogFrame } from "./dialog-frame.js"
import { PickerDialog } from "./dialog-picker.js"
import { TextField } from "./text-field.js"
import { commandInput, isReturnInput } from "./controlled-input.js"
import { c } from "./theme.js"
import { useTermWidth } from "./term-width.js"
import { truncateToWidth } from "./truncate.js"
import { ModelMetadataDialog } from "./dialog-model-metadata.js"
import { ContextWindowDialog } from "./dialog-context-window.js"

interface Props { config: AppConfig; initialProviderId?: string; setup?: boolean; onSave: (next: AppConfig) => void; onCommit: (next: AppConfig) => void; onCancel: () => void }

export function ModelDialog({ config, initialProviderId, setup = false, onSave, onCommit, onCancel }: Props) {
  const width = Math.max(10, useTermWidth() - 2)
  const [height, setHeight] = useState(process.stdout.rows ?? 24)
  useEffect(() => {
    const resize = () => setHeight(process.stdout.rows ?? 24)
    process.stdout.on("resize", resize)
    return () => { process.stdout.off("resize", resize) }
  }, [])
  const [providerFilter, setProviderFilter] = useState<string | null>(initialProviderId ?? (setup ? config.active.providerId || config.providers[0]?.id || null : null))
  const [phase, setPhase] = useState<"models" | "providers" | "manual" | "search" | "metadata" | "context">("models")
  const [providerAction, setProviderAction] = useState<"filter" | "manual">("filter")
  const [target, setTarget] = useState<ConnectionModelRow | null>(null)
  const [manualProviderId, setManualProviderId] = useState("")
  const [catalogState, setCatalogState] = useState(() => ({ providers: config.providers, catalogs: savedConnectionCatalogs(config.providers) }))
  const [selectedKey, setSelectedKey] = useState<string | null>(() => modelCatalogKey(config.active.providerId, config.active.model))
  const [query, setQuery] = useState("")
  const [manual, setManual] = useState("")
  const [refresh, setRefresh] = useState(0)
  const setupProviderId = setup ? providerFilter : null
  // Configuration changes cannot briefly expose a removed connection's rows.
  const catalogs = catalogState.providers === config.providers ? catalogState.catalogs : savedConnectionCatalogs(config.providers)
  const shown = configuredModelRows(config.providers, catalogs, providerFilter, query)
  const selectedIndex = Math.max(0, shown.findIndex(row => modelCatalogKey(row.provider.id, row.id) === selectedKey))
  const selected = shown[selectedIndex]
  const displayedKey = selected ? modelCatalogKey(selected.provider.id, selected.id) : null
  // Pin a fallback as soon as it is displayed. Later discovery may insert rows
  // before it, including after a search/filter removed the previous selection.
  useEffect(() => {
    if (displayedKey !== null && displayedKey !== selectedKey) setSelectedKey(displayedKey)
  }, [displayedKey, selectedKey])
  const provider = selected?.provider ?? config.providers.find(item => item.id === providerFilter)
    ?? config.providers.find(item => item.id === config.active.providerId) ?? config.providers[0]
  const targetProvider = config.providers.find(item => item.id === target?.provider.id)
  const manualProvider = config.providers.find(item => item.id === manualProviderId)
  const orphanedPhase = (phase === "metadata" || phase === "context") && !targetProvider || phase === "manual" && !manualProvider
  const currentPhase = !provider || orphanedPhase ? "models" : phase
  const live = useRef({ phase: currentPhase, selectedIndex, shown, config, provider, providerFilter, onCommit, onCancel })
  live.current = { phase: currentPhase, selectedIndex, shown, config, provider, providerFilter, onCommit, onCancel }

  useEffect(() => {
    const providers = config.providers
    const requested = setupProviderId === null ? providers : providers.filter(item => item.id === setupProviderId)
    setCatalogState({ providers, catalogs: savedConnectionCatalogs(requested) })
    const update = (catalog: ConnectionCatalog) => setCatalogState(current => current.providers !== providers ? current
      : { providers, catalogs: current.catalogs.map(item => item.providerId === catalog.providerId ? catalog : item) })
    return discoverConfiguredModels(requested, update)
  }, [config.providers, refresh, setupProviderId])

  useInput((input, key) => {
    const state = live.current
    if (state.phase !== "models") return
    const cmd = commandInput(input, key)
    if (key.escape) { state.onCancel(); return }
    if (!state.provider) return
    if (cmd === "p" && !setup) { setProviderAction("filter"); setPhase("providers"); return }
    if (cmd === "t") {
      setManual("")
      if (state.providerFilter !== null && state.provider) { setManualProviderId(state.provider.id); setPhase("manual") }
      else { setProviderAction("manual"); setPhase("providers") }
      return
    }
    if (cmd === "/") { setPhase("search"); return }
    if (cmd === "r") { setRefresh(value => value + 1); return }
    if (cmd === "c" || cmd === "m") {
      const row = state.shown[state.selectedIndex]
      if (row) { setTarget(row); setPhase(cmd === "c" ? "context" : "metadata") }
      return
    }
    if (key.upArrow || key.downArrow) {
      const next = Math.max(0, Math.min(state.shown.length - 1, state.selectedIndex + (key.upArrow ? -1 : 1)))
      const row = state.shown[next]
      if (row) setSelectedKey(modelCatalogKey(row.provider.id, row.id))
      return
    }
    if (isReturnInput(input, key)) {
      const row = state.shown[state.selectedIndex]
      if (row) state.onCommit(selectCatalogModel(state.config, row.provider.id, row))
    }
  })

  if (!provider) return <DialogFrame title="Models · /model" hint="esc close">
    <Text>No connection configured. Use /connect to create one first.</Text>
  </DialogFrame>
  if (phase === "metadata" && target && targetProvider) return <ModelMetadataDialog modelId={target.id}
    onCancel={() => setPhase("models")} onSelect={metadata => {
      onSave(associateModelMetadata(config, targetProvider.id, target.id, metadata))
      setPhase("models")
    }} />
  if (phase === "context" && target && targetProvider) return <ContextWindowDialog
    mode={targetProvider.contextWindowMode ?? inferLegacyContextWindowMode(targetProvider)}
    contextWindow={resolveProviderContextWindow(targetProvider, target.id)}
    onCancel={() => setPhase("models")} onSave={(mode, tokens) => {
      onSave({ ...upsertProvider(config, { ...targetProvider, contextWindowMode: mode, contextWindow: tokens }), active: config.active })
      setPhase("models")
    }} />
  if (phase === "providers") return <PickerDialog key={providerAction} title={providerAction === "manual" ? "Manual model · choose connection" : "Models · filter connections"}
    options={[...(providerAction === "filter" ? [{ id: "all", label: "All configured connections", meta: `${config.providers.length} connections` }] : []),
      ...config.providers.map(item => ({ id: `provider:${item.id}`, label: item.name || item.baseURL, meta: item.baseURL }))]}
    initialIndex={providerAction === "filter" ? providerFilter === null ? 0 : Math.max(0, config.providers.findIndex(item => item.id === providerFilter) + 1)
      : Math.max(0, config.providers.findIndex(item => item.id === provider.id))}
    onCancel={() => setPhase("models")} onSelect={id => {
      if (providerAction === "manual") { setManualProviderId(id.slice("provider:".length)); setPhase("manual") }
      else { setProviderFilter(id === "all" ? null : id.slice("provider:".length)); setQuery(""); setSelectedKey(null); setPhase("models") }
    }} />
  if (phase === "search" || phase === "manual" && manualProvider) return <DialogFrame
    title={phase === "manual" ? `Manual model ID · ${manualProvider!.name}` : "Filter models and connections"} hint="enter confirm · esc back">
    <Text color={c.text.faint}>{phase === "manual" ? "Manual IDs are unverified. The endpoint must support this exact ID." : "Search model IDs, connection names or endpoints. Selection changes only on Enter."}</Text>
    <TextField key={phase} isActive value={phase === "manual" ? manual : query}
      onChange={phase === "manual" ? setManual : setQuery} onCancel={() => setPhase("models")}
      onSubmit={value => {
        if (phase === "manual") {
          if (value.trim() && manualProvider) onCommit(selectCatalogModel(config, manualProvider.id, { id: value.trim(), source: "manual" }))
        } else { setQuery(value.trim()); setSelectedKey(null); setPhase("models") }
      }} />
  </DialogFrame>
  const scopedCatalogs = catalogs.filter(item => providerFilter === null || item.providerId === providerFilter)
  const loading = scopedCatalogs.filter(item => item.loading).length
  const failed = scopedCatalogs.filter(item => item.error).length
  const error = catalogs.find(item => item.providerId === provider.id)?.error
  const count = Math.max(1, Math.min(7, Math.floor((height - 14) / 3)))
  const start = Math.max(0, selectedIndex - Math.floor(count / 2))
  const activeProvider = config.providers.find(item => item.id === config.active.providerId)
  return <DialogFrame title={`${setup ? "Choose a model" : "Models"} · ${providerFilter === null ? "All connections" : provider.name || provider.baseURL}`}
    hint={setup ? "↑↓ navigate · enter select and finish · m metadata · c context · / filter · t manual · esc choose later" : "↑↓ navigate · enter select · / search · p filter connections · m metadata · c context · r refresh · t manual · esc close"}>
    {setup && <Text color={c.accent}>Connection saved. Choose a model to use it, or press esc to choose later with /model.</Text>}
    <Text color={c.text.faint}>{truncateToWidth(`Current: ${config.active.model || "none"} · ${activeProvider?.name || "none"}`, width)}</Text>
    <Text color={c.text.faint}>{truncateToWidth(`${shown.length} models · ${scopedCatalogs.length} connections${loading ? ` · ${loading} discovering…` : ""}${failed ? ` · ${failed} discovery unavailable` : ""}${query ? ` · filter: ${query}` : ""}`, width)}</Text>
    <Text color={c.text.faint}>{truncateToWidth((provider.contextWindowMode ?? inferLegacyContextWindowMode(provider)) === "manual"
      ? `${provider.name}: manual context ${provider.contextWindow.toLocaleString("en-US")} tokens · c to change`
      : `${provider.name}: automatic context · m to link metadata · fallback ${provider.contextWindow.toLocaleString("en-US")} tokens`, width)}</Text>
    {error && <Text color={c.warning}>{truncateToWidth(`${provider.name}: ${error}`, width)}</Text>}
    <Box flexDirection="column" marginTop={1}>
      {shown.slice(start, start + count).map((row, i) => <Box key={modelCatalogKey(row.provider.id, row.id)} flexDirection="column">
        <Text color={start + i === selectedIndex ? c.accent : c.text.primary} bold={start + i === selectedIndex}>{truncateToWidth(`${start + i === selectedIndex ? "›" : " "} ${row.id}${row.provider.id === config.active.providerId && row.id === config.active.model ? " (current)" : ""}`, width)}</Text>
        <Text color={c.text.faint}>{truncateToWidth(`  ${row.provider.name || row.provider.id} · ${row.provider.baseURL}`, width)}</Text>
        <Text color={c.text.faint}>{truncateToWidth(`  ${describeCatalogRow(row)}`, width)}</Text>
      </Box>)}
      {!shown.length && <Text color={c.text.faint}>{loading ? "Discovering models… You can enter an ID with t." : "No matching models. Press t to enter an ID or / to change the filter."}</Text>}
      {start + count < shown.length && <Text color={c.text.faint}>{`… ${shown.length - start - count} more`}</Text>}
    </Box>
  </DialogFrame>
}
