import { useEffect, useState } from "react"
import { shouldCheckForUpdates, startUpdateStatusCheck, type UpdateCheckState } from "../update-check.js"
import { VERSION } from "../version.js"

/** Explicit /update requests bypass the automatic-check opt-out as well as the cache. */
export function useUpdateCheck(manual = false): UpdateCheckState {
  const enabled = manual || shouldCheckForUpdates()
  const [state, setState] = useState<UpdateCheckState>({ status: enabled ? "checking" : "disabled" })
  useEffect(() => {
    if (!enabled) { setState({ status: "disabled" }); return }
    return startUpdateStatusCheck({ currentVersion: VERSION }, setState)
  }, [enabled])
  return state
}
