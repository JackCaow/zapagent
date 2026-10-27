/** @jsxImportSource react */
import { useEffect, useState } from "react"
import { Text } from "ink"
import type { ProviderModelMetadata } from "../config.js"
import { getModelsDevProvider, type ModelsDevProvider } from "../../zapsdk/core/models-dev.js"
import { catalogModelMetadata } from "../provider-catalog.js"
import { ProviderDirectory } from "./provider-directory.js"
import { DialogFrame } from "./dialog-frame.js"
import { PickerDialog } from "./dialog-picker.js"
import { TextField } from "./text-field.js"
import { c } from "./theme.js"

/** Explicit linkage only: catalog selections never replace endpoint or wire ID. */
export function ModelMetadataDialog({ modelId, onSelect, onCancel }: {
  modelId: string
  onSelect: (metadata: ProviderModelMetadata) => void
  onCancel: () => void
}) {
  const [providerId, setProviderId] = useState("")
  const [catalog, setCatalog] = useState<ModelsDevProvider | null>(null)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [filtering, setFiltering] = useState(false)
  useEffect(() => {
    if (!providerId) return
    let cancelled = false
    setCatalog(null); setError("")
    void getModelsDevProvider(providerId).then(result => {
      if (cancelled) return
      if (!result) setError("Provider metadata unavailable. Press esc to choose another provider.")
      else setCatalog(result)
    }).catch(() => { if (!cancelled) setError("Catalog unavailable. Press esc to go back; your connection is unchanged.") })
    return () => { cancelled = true }
  }, [providerId])
  if (!providerId) return <ProviderDirectory metadataOnly onCancel={onCancel}
    onSelect={provider => { if (provider) { setProviderId(provider.id); setQuery("") } }} />
  if (filtering) return <DialogFrame title="Filter metadata models" hint="enter filter · esc back">
    <TextField isActive value={query} onChange={setQuery} onCancel={() => setFiltering(false)}
      onSubmit={next => { setQuery(next.trim()); setFiltering(false) }} />
  </DialogFrame>
  if (!catalog || error) return <PickerDialog title="Model metadata · models.dev"
    options={[{ id: "back", label: error || "Loading model metadata… · back" }]}
    onCancel={() => setProviderId("")} onSelect={() => setProviderId("")} />
  const models = catalog.models.filter(model => `${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()))
  return <>
    <Text color={c.text.faint}>{`Metadata for endpoint model ${modelId}; endpoint and request ID stay unchanged.`}</Text>
    <PickerDialog key={query} title={`Model metadata · ${catalog.name}`} maxRows={8}
      options={[{ id: "filter", label: "Search models…" }, ...models.map(model => ({
        id: `model:${model.id}`, label: model.id,
        meta: `context ${model.contextWindow?.toLocaleString("en-US") ?? "unknown"} · ${model.name}`,
      }))]} onCancel={() => setProviderId("")} onSelect={id => {
        if (id === "filter") { setFiltering(true); return }
        const metadata = catalogModelMetadata(catalog, id.slice("model:".length))
        if (metadata) onSelect(metadata)
      }} />
  </>
}
