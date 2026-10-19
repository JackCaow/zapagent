import { createHash } from "node:crypto"

export interface SourceUrlEvidence {
  urls: string[]
  /** Complete only for recognized literal HTTP(S) matches; redirects, encoded
   * bodies and unbranded sources still need separate review. */
  complete: boolean
  /** Omitted URL occurrences; does not claim a unique-source count. */
  omitted: number
  outputSha256: string
}

export const NETWORK_RESULT_TOOLS = new Set(["web_search", "http_fetch", "http_request", "browser_screenshot"])

/** Bounded Host audit metadata from the entire result, independent of its UI
 * preview. Never fetched, supplied to the model, or used as authorization. */
export function collectSourceUrls(output: string): SourceUrlEvidence {
  const urls = new Set<string>()
  let omitted = 0
  for (const match of output.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    try {
      const parsed = new URL(match[0].replace(/[),;\]]+$/, ""))
      parsed.username = ""
      parsed.password = ""
      parsed.search = ""
      parsed.hash = ""
      const url = parsed.href
      if (urls.has(url)) continue
      if (url.length > 2048 || urls.size >= 32) { omitted++; continue }
      urls.add(url)
    } catch { omitted++ }
  }
  return { urls: [...urls], complete: omitted === 0, omitted,
    outputSha256: createHash("sha256").update(output).digest("hex") }
}
