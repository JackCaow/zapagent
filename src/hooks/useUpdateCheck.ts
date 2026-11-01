import { useEffect, useState } from "react"
import { join } from "node:path"
import { getAppDataDir } from "../../zapsdk/utils/platform.js"
import { shouldCheckForUpdates, startUpdateCheck, startUpdateStatusCheck, type UpdateCheckState } from "../update-check.js"
import { VERSION } from "../version.js"

/** Explicit /update requests bypass the automatic-check opt-out as well as the cache. */
export function useUpdateCheck(manual = false, request = 0): UpdateCheckState {
  const enabled = manual || shouldCheckForUpdates()
  const [state, setState] = useState<UpdateCheckState>({ status: !enabled ? "disabled" : manual ? "checking" : "idle" })
  useEffect(() => {
    if (!enabled) { setState({ status: "disabled" }); return }
    if (manual) return startUpdateStatusCheck({ currentVersion: VERSION }, setState)
    // A quiet automatic check retains the success/failure cache. Only explicit
    // dialog requests need fresh metadata and a full checking/error state.
    setState({ status: "idle" })
    return startUpdateCheck({ currentVersion: VERSION,
      cachePath: join(getAppDataDir(), "cache", "update-check.json") }, version => setState({ status: "available", version }))
  }, [enabled, manual, request])
  return state
}
