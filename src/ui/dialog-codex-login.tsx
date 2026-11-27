/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react"
import { stripVTControlCharacters } from "node:util"
import { Text, useInput } from "ink"
import { runCodexAuth } from "../codex-auth.js"
import { DialogFrame } from "./dialog-frame.js"
import { PickerDialog } from "./dialog-picker.js"
import { c } from "./theme.js"

export function CodexLoginDialog({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const [method, setMethod] = useState<"browser" | "device" | "existing" | null>(null)
  const [details, setDetails] = useState("")
  const [error, setError] = useState("")
  const callbacks = useRef(onSuccess)
  callbacks.current = onSuccess
  useInput((_input, key) => { if (method && key.escape) setMethod(null) })
  useEffect(() => {
    if (!method) return
    const controller = new AbortController()
    setDetails(""); setError("")
    void (async () => {
      const status = await runCodexAuth(method === "existing" ? "status" : "login", { device: method === "device", signal: controller.signal,
        onOutput: text => { if (!controller.signal.aborted) setDetails(previous => (previous + text).slice(-8192)) } })
      if (controller.signal.aborted) return
      if (status !== 0) throw new Error("Codex login did not complete. Run codex login to retry.")
      callbacks.current()
    })().catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Codex login failed.") })
    return () => controller.abort()
  }, [method])
  if (!method) return <PickerDialog title="OpenAI Codex · sign in with ChatGPT"
    options={[{ id: "existing", label: "Use existing Codex login", meta: "checks the local CLI session" },
      { id: "browser", label: "Browser login", meta: "opens ChatGPT sign-in · local callback on port 1455" },
      { id: "device", label: "Device code", meta: "for SSH, headless hosts, or a busy callback port" }]}
    onCancel={onCancel} onSelect={id => setMethod(id as "browser" | "device" | "existing")} />
  return <DialogFrame title="OpenAI Codex · sign in with ChatGPT" hint="esc back / cancel login">
    {error ? <Text color={c.warning}>{error}</Text> : <>
      <Text>{stripVTControlCharacters(details) || "Starting the official Codex login…"}</Text>
    </>}
  </DialogFrame>
}
