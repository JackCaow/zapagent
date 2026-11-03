/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react"
import { Text, useInput } from "ink"
import { openAuthBrowser, saveCodexCredentials, startCodexBrowserLogin, startCodexDeviceLogin } from "../codex-auth.js"
import { DialogFrame } from "./dialog-frame.js"
import { PickerDialog } from "./dialog-picker.js"
import { c } from "./theme.js"

export function CodexLoginDialog({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const [method, setMethod] = useState<"browser" | "device" | null>(null)
  const [details, setDetails] = useState<{ url: string; instructions: string } | null>(null)
  const [error, setError] = useState("")
  const callbacks = useRef({ onSuccess, onCancel })
  callbacks.current = { onSuccess, onCancel }
  useInput((_input, key) => { if (method && key.escape) setMethod(null) })
  useEffect(() => {
    if (!method) return
    const controller = new AbortController()
    setDetails(null); setError("")
    void (async () => {
      const login = method === "browser" ? await startCodexBrowserLogin({ signal: controller.signal }) : await startCodexDeviceLogin(controller.signal)
      if (controller.signal.aborted) { login.cancel(); return }
      setDetails({ url: login.url, instructions: login.instructions })
      openAuthBrowser(login.url)
      const credentials = await login.complete
      if (controller.signal.aborted) return
      saveCodexCredentials(credentials)
      callbacks.current.onSuccess()
    })().catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Codex login failed.") })
    return () => controller.abort()
  }, [method])
  if (!method) return <PickerDialog title="OpenAI Codex · sign in with ChatGPT"
    options={[{ id: "browser", label: "Browser login", meta: "opens ChatGPT sign-in · local callback on port 1455" },
      { id: "device", label: "Device code", meta: "for SSH, headless hosts, or a busy callback port" }]}
    onCancel={onCancel} onSelect={id => setMethod(id as "browser" | "device")} />
  return <DialogFrame title="OpenAI Codex · sign in with ChatGPT" hint="esc back / cancel login">
    {error ? <Text color={c.warning}>{error}</Text> : <>
      <Text>{details?.instructions ?? "Starting Codex login…"}</Text>
      {details && <Text color={c.accent}>{details.url}</Text>}
      <Text color={c.text.faint}>If the browser did not open, open this URL manually. Waiting for authorization…</Text>
    </>}
  </DialogFrame>
}
