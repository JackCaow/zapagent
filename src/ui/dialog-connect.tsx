/** @jsxImportSource react */
import { useRef, useState } from "react"
import { Box, Text, useInput } from "ink"
import { randomUUID } from "node:crypto"
import { buildConnectedProvider, presetForConnection, removeProvider, upsertProvider,
  type AppConfig, type Provider, type ProviderProtocol } from "../config.js"
import { ProviderDirectory } from "./provider-directory.js"
import { DialogFrame } from "./dialog-frame.js"
import { PickerDialog } from "./dialog-picker.js"
import { TextField } from "./text-field.js"
import { commandInput, isReturnInput } from "./controlled-input.js"
import { c } from "./theme.js"
import { ModelDialog } from "./dialog-model.js"

interface Props { config: AppConfig; onSave: (next: AppConfig) => void; onCommit: (next: AppConfig) => void; onCancel: () => void }
type Draft = { name: string; baseURL: string; apiKey: string; protocol: ProviderProtocol;
  authMode: "none" | "api-key"; catalogProviderId?: string; existing?: Provider }
type Step = "connections" | "preset" | "name" | "endpoint" | "protocol" | "auth" | "key" | "review"

export function saveConnection(config: AppConfig, draft: Draft): AppConfig {
  const existing = draft.existing
  const catalogProviderId = draft.catalogProviderId ?? existing?.catalogProviderId
  // The directory entry maps to a preset through an explicit table, so preset
  // request params (DeepSeek thinking) and effort values still apply, as long
  // as the endpoint is still the preset's own host. A custom endpoint has no
  // catalog id, and a gateway on another host never picks up a preset.
  const preset = existing?.sourcePresetId ? undefined : presetForConnection(catalogProviderId, draft.baseURL.trim())
  const provider = buildConnectedProvider({ existing, preset,
    name: draft.name.trim(), baseURL: draft.baseURL.trim(),
    apiKey: draft.authMode === "none" ? "" : draft.apiKey.trim(),
    models: existing?.models ?? [], modelMetadata: existing?.modelMetadata,
    contextWindowInput: existing?.contextWindow ?? 128000 })
  provider.id = existing?.id ?? `sp_${randomUUID()}`
  provider.protocol = draft.protocol
  provider.authMode = draft.authMode
  provider.catalogProviderId = catalogProviderId
  // Catalog identity is explicit, never inferred from a brand/URL heuristic.
  provider.sourcePresetId = existing?.sourcePresetId ?? preset?.id
  if (!existing && provider.catalogProviderId) provider.contextWindowMode = "auto"
  return upsertProvider(config, provider)
}

/** Persist the connection first, then guide new connections through model selection. */
export function ConnectDialog({ config, onSave, onCommit, onCancel }: Props) {
  const [step, setStep] = useState<Step>("connections")
  const [index, setIndex] = useState(0)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState("")
  const [modelTarget, setModelTarget] = useState<{ id: string; setup: boolean } | null>(null)
  const [draft, setDraft] = useState<Draft>({ name: "", baseURL: "", apiKey: "", protocol: "openai", authMode: "api-key" })
  const live = useRef({ step, index, deleting, config, onCommit, onCancel, modelTarget })
  live.current = { step, index, deleting, config, onCommit, onCancel, modelTarget }
  useInput((input, key) => {
    const state = live.current
    if (state.step !== "connections" || state.modelTarget) return
    const cmd = commandInput(input, key)
    if (key.escape) { if (state.deleting) setDeleting(false); else state.onCancel(); return }
    if (state.deleting) {
      if (cmd === "d") {
        const p = state.config.providers[state.index]
        if (p) state.onCommit(removeProvider(state.config, p.id))
      }
      return
    }
    const count = state.config.providers.length + 1
    if (key.upArrow) { setIndex((state.index - 1 + count) % count); return }
    if (key.downArrow) { setIndex((state.index + 1) % count); return }
    const provider = state.config.providers[state.index]
    if (cmd === "m" && provider) { setModelTarget({ id: provider.id, setup: false }); return }
    if (cmd === "d" && provider) { setDeleting(true); return }
    if (isReturnInput(input, key) || cmd === "e") {
      if (!provider) { setStep("preset"); return }
      setDraft({ existing: provider, name: provider.name, baseURL: provider.baseURL,
        apiKey: provider.apiKey, protocol: provider.protocol ?? "openai",
        authMode: provider.authMode ?? (provider.apiKey ? "api-key" : "none"), catalogProviderId: provider.catalogProviderId })
      setStep("name")
    }
  })

  if (modelTarget) return <ModelDialog key={modelTarget.id} config={config}
    initialProviderId={modelTarget.id} setup={modelTarget.setup} onCommit={onCommit}
    onCancel={() => { if (modelTarget.setup) onCancel(); else setModelTarget(null) }} />

  if (step === "connections") return <DialogFrame title="Connections · /connect"
    hint={deleting ? "d confirm removal · esc cancel" : "↑↓ navigate · enter/e edit · m models · d remove · esc close"}>
    <Text color={c.text.faint}>Add a connection, then choose its model. Press m to manage models for an existing connection.</Text>
    <Box flexDirection="column" marginTop={1}>
      {config.providers.map((provider, i) => <Box key={provider.id} flexDirection="column">
        <Text color={i === index ? c.accent : c.text.primary}>{`${i === index ? "›" : " "} ${provider.name || "Unnamed connection"}`}</Text>
        <Text color={c.text.faint}>{`  ${provider.protocol ?? "openai"} · ${provider.apiKey ? "API key stored" : "no key"} · ${provider.models.length} saved models`}</Text>
        <Text color={c.text.faint}>{`  ${provider.baseURL}`}</Text>
      </Box>)}
      <Text color={index === config.providers.length ? c.accent : c.text.primary}>{`${index === config.providers.length ? "›" : " "} + New connection`}</Text>
    </Box>
    {deleting && <Text color={c.warning}>Remove connection and its saved model preferences?</Text>}
  </DialogFrame>

  if (step === "preset") return <ProviderDirectory
    onCancel={() => setStep("connections")} onSelect={provider => {
      setDraft({ catalogProviderId: provider?.id, name: provider?.name ?? "", baseURL: provider?.api ?? "", apiKey: "",
        protocol: provider?.protocol ?? "openai", authMode: "api-key" })
      setStep("name")
    }} />

  if (step === "protocol") return <PickerDialog key={step} title="Connection · wire protocol" initialIndex={draft.protocol === "anthropic" ? 1 : 0}
    options={[{ id: "openai", label: "OpenAI Chat Completions" }, { id: "anthropic", label: "Anthropic Messages" }]}
    onCancel={() => setStep("endpoint")} onSelect={id => { setDraft({ ...draft, protocol: id as ProviderProtocol }); setStep("auth") }} />
  if (step === "auth") return <PickerDialog key={step} title="Connection · authentication" initialIndex={draft.authMode === "none" ? 1 : 0}
    options={[{ id: "api-key", label: "API key", meta: "stored locally; never sent to the public catalog" },
      { id: "none", label: "No authentication", meta: "local or explicitly keyless endpoints" }]}
    onCancel={() => setStep("protocol")} onSelect={id => {
      setDraft({ ...draft, authMode: id as Draft["authMode"] })
      setStep(id === "none" ? "review" : "key")
    }} />
  if (step === "review") return <PickerDialog key={step} title={draft.existing ? "Review connection" : "Review connection · next: choose a model"}
    options={[{ id: "save", label: draft.existing ? `Save ${draft.name}` : `Save ${draft.name} and choose a model`, meta: `${draft.protocol} · ${draft.authMode} · ${draft.baseURL}` },
      { id: "edit", label: "Edit settings" }]}
    hint={draft.existing ? "enter save · esc back · current model is kept" : "enter save and continue · esc back"}
    onCancel={() => setStep("auth")} onSelect={id => {
      if (id === "edit") setStep("name")
      else {
        const next = saveConnection(config, draft)
        if (draft.existing) onCommit(next)
        else {
          const created = next.providers.find(provider => !config.providers.some(item => item.id === provider.id))!
          onSave(next)
          setModelTarget({ id: created.id, setup: true })
        }
      }
    }} />

  const field = step === "name" ? "name" : step === "endpoint" ? "baseURL" : "apiKey"
  return <DialogFrame title={`Connection · ${step === "key" ? "API key" : step}`} hint="enter continue · esc back">
    <Text color={c.text.faint}>{draft.name || "New connection"} · {draft.existing ? "edit connection" : "choose a model after saving"}</Text>
    {error && <Text color={c.warning}>{error}</Text>}
    <TextField key={step} isActive value={draft[field]} masked={step === "key"}
      displayValue={step === "key" ? "•".repeat(Math.min(draft.apiKey.length, 24)) : undefined}
      placeholder={step === "name" ? "Connection name" : step === "endpoint" ? "https://example.com/v1" : "Paste API key"}
      onChange={value => { setDraft({ ...draft, [field]: value }); setError("") }}
      onCancel={() => { setError(""); setStep(step === "name" ? "connections" : step === "endpoint" ? "name" : "auth") }}
      onSubmit={value => {
        const trimmed = value.trim()
        if (!trimmed) { setError("This field is required. For no key, choose No authentication."); return }
        if (step === "endpoint") {
          try { const url = new URL(trimmed); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error() }
          catch { setError("Use an HTTP(S) base URL without embedded credentials, query or fragment."); return }
        }
        setDraft({ ...draft, [field]: trimmed }); setError("")
        setStep(step === "name" ? "endpoint" : step === "endpoint" ? "protocol" : "review")
      }} />
  </DialogFrame>
}
