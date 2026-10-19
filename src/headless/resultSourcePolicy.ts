import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { resolve } from "node:path"
import { createResultSourceGuard, ResultSourcePolicySchema, type ToolResultGuard } from "../../zapsdk/tools/result-source-policy.js"

/** Host-selected JSON, loaded once before Agent/provider execution. */
export async function loadResultSourceGuard(path: string, cwd: string): Promise<ToolResultGuard> {
  const file = await open(resolve(cwd, path), constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Source policy must be a regular JSON file of at most 64 KiB")
    const bytes = Buffer.alloc(64 * 1024 + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 64 * 1024) throw new Error("Source policy exceeds 64 KiB")
    let data: unknown
    try { data = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) }
    catch { throw new Error("Source policy is not valid JSON") }
    const policy = ResultSourcePolicySchema.safeParse(data)
    if (!policy.success) throw new Error("Source policy has an invalid schema")
    const guard = createResultSourceGuard(policy.data)
    const fileSha256 = createHash("sha256").update(bytes.subarray(0, bytesRead)).digest("hex")
    return (name, args, result) => {
      const checked = guard(name, args, result)
      const evidence = checked.runtime?.resultSourcePolicy
      return evidence && policy.data.tools.includes(name)
        ? { ...checked, runtime: { ...checked.runtime, resultSourcePolicy: { ...evidence, configuredFileSha256: fileSha256 } } }
        : checked
    }
  } finally { await file.close() }
}
