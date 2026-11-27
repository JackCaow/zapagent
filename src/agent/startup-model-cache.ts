import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { getAppDataDir } from "../../zapsdk/utils/platform.js"
import { writeFileAtomic } from "../utils/secure-write.js"

export interface ExternalModelIdentity { provider: string; model: string }

export function modelMetadataText(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim() || undefined : undefined
}

export function startupModelCachePath(agent: string, cwd: string, scope: unknown): string {
  const key = createHash("sha256").update(JSON.stringify([cwd, scope])).digest("hex")
  return join(getAppDataDir(), "cache", `${agent}-startup`, `${key}.json`)
}

export function readStartupModel(path: string): ExternalModelIdentity | undefined {
  try {
    const cached = JSON.parse(readFileSync(path, "utf8"))
    const provider = modelMetadataText(cached?.provider)
    const model = modelMetadataText(cached?.model)
    if (provider && model) return { provider, model }
  } catch { /* Cache misses are normal on startup. */ }
}

export function writeStartupModel(path: string, identity: ExternalModelIdentity): void {
  try { writeFileAtomic(path, JSON.stringify(identity) + "\n") }
  catch { /* The model is still available for this process. */ }
}
