/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react"
import { Text, useInput } from "ink"
import { DialogFrame } from "./dialog-frame.js"
import { installSelfUpdate, planSelfUpdate, type RestartRequest, type UpdatePlan } from "../self-update.js"

export function UpdateDialog({ version, busy, sessionId, beforeInstall, onRestart, onCancel }: {
  version: string | null; busy: boolean; sessionId: string
  beforeInstall: () => void
  onRestart: (request: RestartRequest) => void; onCancel: () => void
}) {
  const [plan, setPlan] = useState<UpdatePlan | null>(null)
  const [message, setMessage] = useState("Checking installation…")
  const [installing, setInstalling] = useState(false)
  const started = useRef(false)
  useEffect(() => {
    let active = true
    if (!version) { setMessage("No newer version is available yet."); return }
    if (busy) { setMessage("Wait for the current task and queued messages to finish before updating."); return }
    void planSelfUpdate(version).then(result => {
      if (active) { setPlan(result); setMessage(`Install v${version} and restart? Your saved session will be restored.`) }
    }, error => { if (active) setMessage(error instanceof Error ? error.message : "Could not prepare update") })
    return () => { active = false }
  }, [version, busy])
  useInput((input, key) => {
    if (started.current) return
    if (key.escape || input === "n") { onCancel(); return }
    // Enter does not approve: a deliberate 'y' prevents a trailing slash-command
    // Return event from accidentally confirming installation.
    if (input !== "y" || !plan || busy) return
    started.current = true
    setInstalling(true)
    setMessage(`Downloading and installing v${plan.version}…`)
    void Promise.resolve().then(() => { beforeInstall(); return installSelfUpdate(plan, sessionId) }).then(onRestart).catch(error => {
      started.current = false
      setInstalling(false)
      setPlan(null)
      setMessage(`Update failed: ${error instanceof Error ? error.message : "unknown error"}. Close this dialog to continue.`)
    })
  })
  return <DialogFrame title="Update zapAgent" hint={installing ? "Please wait — restart follows successful installation" : "y download, install and restart · esc/n later"}>
    <Text>{message}</Text>
  </DialogFrame>
}
