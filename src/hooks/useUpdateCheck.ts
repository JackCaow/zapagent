import { useEffect, useState } from "react"
import { join } from "node:path"
import { getAppDataDir } from "../../zapsdk/utils/platform.js"
import { shouldCheckForUpdates, startUpdateCheck } from "../update-check.js"
import { VERSION } from "../version.js"

export function useUpdateCheck(): string | null {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    if (!shouldCheckForUpdates()) return
    return startUpdateCheck({ currentVersion: VERSION,
      cachePath: join(getAppDataDir(), "cache", "update-check.json") }, setVersion)
  }, [])
  return version
}
