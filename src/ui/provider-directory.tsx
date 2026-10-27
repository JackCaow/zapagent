/** @jsxImportSource react */
import { useEffect, useState } from "react"
import { Text, useInput } from "ink"
import { getModelsDevConnections, refreshModelsDevConnections, type ModelsDevConnection } from "../../zapsdk/core/models-dev.js"
import { PickerDialog } from "./dialog-picker.js"
import { DialogFrame } from "./dialog-frame.js"
import { TextField } from "./text-field.js"
import { commandInput } from "./controlled-input.js"
import { useTermWidth } from "./term-width.js"
import { truncateToWidth } from "./truncate.js"
import { c } from "./theme.js"

interface Props { onSelect: (provider: ModelsDevConnection | null) => void; onCancel: () => void; metadataOnly?: boolean }

/** Public directory data supplies vendor names and endpoints; adapters only
 * constrain which wire protocols the installed runtime actually supports. */
export function ProviderDirectory({ onSelect, onCancel, metadataOnly = false }: Props) {
  const [providers, setProviders] = useState<ModelsDevConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [revision, setRevision] = useState(0)
  const width = Math.max(20, useTermWidth() - 4)
  useEffect(() => {
    let done = false
    setLoading(true); setError("")
    const timer = setTimeout(() => {
      done = true; setLoading(false)
      setError("Public directory timed out. Retry with r or configure a custom endpoint.")
    }, 5000)
    const request = revision === 0 ? getModelsDevConnections() : refreshModelsDevConnections()
    void request.then(rows => {
      if (done) return
      clearTimeout(timer); setProviders(rows); setLoading(false)
      if (!rows.length) setError("No providers in the public directory. Configure a custom endpoint.")
    }).catch(() => {
      if (done) return
      clearTimeout(timer); setLoading(false)
      setError("Public directory unavailable. Retry with r or configure a custom endpoint.")
    })
    return () => { done = true; clearTimeout(timer) }
  }, [revision])
  useInput((input, key) => {
    if (searching) return
    const command = commandInput(input, key)
    if (command === "/") setSearching(true)
    if (command === "r") setRevision(value => value + 1)
  })
  if (searching) return <DialogFrame title="Filter provider directory" hint="enter filter · esc back">
    <TextField isActive value={query} onChange={setQuery} onCancel={() => setSearching(false)}
      onSubmit={value => { setQuery(value.trim()); setSearching(false) }} />
  </DialogFrame>
  const labelWidth = Math.max(10, Math.floor(width * 0.42))
  const visible = providers.filter(provider => `${provider.name} ${provider.id}`.toLowerCase().includes(query.toLowerCase()))
  return <>
    <Text color={c.text.faint}>{loading ? "Loading models.dev provider directory…" : `models.dev · ${providers.length} providers · public metadata, not verified access`}</Text>
    {error && <Text color={c.warning}>{error}</Text>}
    <PickerDialog key={query} title="Provider directory · models.dev"
      maxRows={Math.max(3, Math.min(10, (process.stdout.rows ?? 24) - 15))}
      hint="↑↓ select · enter configure · / search · r reload · esc back"
      options={[...(!metadataOnly ? [{ id: "__custom", label: "Custom endpoint", meta: "configure manually" }] : []),
        ...visible.map(provider => ({ id: `catalog:${provider.id}`, label: truncateToWidth(provider.name, labelWidth),
          meta: truncateToWidth(provider.protocol ? `${provider.protocol}${provider.api ? " · endpoint provided" : " · enter endpoint"}` : "unsupported adapter", width - labelWidth - 2),
          disabled: !metadataOnly && !provider.protocol }))]}
      onCancel={onCancel} onSelect={id => {
        if (id === "__custom") onSelect(null)
        else {
          const provider = providers.find(item => item.id === id.slice("catalog:".length))
          if (provider && (metadataOnly || provider.protocol)) onSelect(provider)
        }
      }} />
  </>
}
