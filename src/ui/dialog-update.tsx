/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react"
import { Text, useInput } from "ink"
import { useUpdateCheck } from "../hooks/useUpdateCheck.js"
import { VERSION } from "../version.js"
import { DialogFrame } from "./dialog-frame.js"
import { installSelfUpdate, planSelfUpdate, type RestartRequest, type UpdatePlan } from "../self-update.js"

export function UpdateDialog({ busy, sessionId, beforeInstall, onRestart, onCancel }: {
  busy: boolean; sessionId: string
  beforeInstall: () => void
  onRestart: (request: RestartRequest) => void; onCancel: () => void
}) {
  const [request, setRequest] = useState(0)
  const check = useUpdateCheck(true, request)
  const [plan, setPlan] = useState<UpdatePlan | null>(null)
  const [message, setMessage] = useState("Checking for zapAgent updates…")
  const [installing, setInstalling] = useState(false)
  const started = useRef(false)
  useEffect(() => {
    let active = true
    setPlan(null)
    if (check.status !== "available") {
      setMessage(check.status === "current" ? `zapAgent v${VERSION} is up to date.`
        : check.status === "error" ? "Could not check for updates. Press r to retry."
        : "Checking for zapAgent updates…")
      return
    }
    const version = check.version
    if (busy) { setMessage("Wait for the current task and queued messages to finish before updating."); return }
    setMessage("Checking installation…")
    void planSelfUpdate(version).then(result => {
      if (active) { setPlan(result); setMessage(`Install v${version} and restart? Your saved session will be restored.`) }
    }, error => { if (active) setMessage(error instanceof Error ? error.message : "Could not prepare update") })
    return () => { active = false }
  }, [check, busy])
  useInput((input, key) => {
    if (started.current) return
    if (key.escape || input === "n") { onCancel(); return }
    if (input === "r" && check.status === "error") { setRequest(value => value + 1); return }
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
  return <DialogFrame title="Update zapAgent" hint={installing ? "Please wait — restart follows successful installation" : plan ? "y download, install and restart · esc/n later" : check.status === "error" ? "r retry · esc/n close" : "esc/n close"}>
    <Text>{message}</Text>
  </DialogFrame>
}
