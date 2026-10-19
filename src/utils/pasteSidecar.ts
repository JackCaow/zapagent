import { createHash } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { writeFileAtomic } from "./secure-write.js"

export const PASTE_SIDECAR_DIRNAME = "paste-history"

const CONTENT_ADDRESSED_SIDECAR_RE = /^[a-f0-9]{64}\.txt$/

export interface ReadPasteSidecarOptions {
  maxBytes?: number
}

export interface ReadPasteSidecarResult {
  content: string
  size: number
  path: string
}

/** Persist a paste body once and return a data-dir-relative reference. */
export function persistPasteSidecar(dataDir: string, content: string): string | null {
  const dir = join(dataDir, PASTE_SIDECAR_DIRNAME)
  try {
    mkdirSync(dir, { recursive: true })
    if (!lstatSync(dir).isDirectory()) return null
    if (process.platform !== "win32") chmodSync(dir, 0o700)
    const hash = createHash("sha256").update(content).digest("hex")
    const filename = `${hash}.txt`
    const path = join(dir, filename)
    if (!existsSync(path)) {
      writeFileAtomic(path, content, { mode: 0o600 })
    } else {
      const stat = lstatSync(path)
      if (!stat.isFile()) return null
      if (
        stat.size !== Buffer.byteLength(content, "utf-8") ||
        readFileSync(path, "utf-8") !== content
      ) {
        writeFileAtomic(path, content, { mode: 0o600 })
      }
      if (process.platform !== "win32") chmodSync(path, 0o600)
    }
    return `${PASTE_SIDECAR_DIRNAME}/${filename}`
  } catch {
    return null
  }
}

/**
 * Resolve new relative refs and legacy absolute refs without permitting path
 * traversal. A moved legacy content-addressed ref falls back to the same hash
 * filename under the current data directory.
 */
export function resolvePasteSidecarPath(dataDir: string, ref: string): string | undefined {
  const dir = resolve(dataDir, PASTE_SIDECAR_DIRNAME)
  const direct = isAbsolute(ref) ? resolve(ref) : resolve(dataDir, ref)
  if (isPathInsideDirectory(dir, direct)) return direct

  if (isAbsolute(ref) && CONTENT_ADDRESSED_SIDECAR_RE.test(basename(ref))) {
    return join(dir, basename(ref))
  }
  return undefined
}

export function readPasteSidecar(
  dataDir: string,
  ref: string,
  options: ReadPasteSidecarOptions = {},
): ReadPasteSidecarResult | undefined {
  try {
    const dir = resolve(dataDir, PASTE_SIDECAR_DIRNAME)
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return undefined
    const path = resolvePasteSidecarPath(dataDir, ref)
    if (!path || !existsSync(path)) return undefined
    const stat = lstatSync(path)
    if (!stat.isFile()) return undefined
    if (options.maxBytes !== undefined && stat.size > options.maxBytes) return undefined
    const content = readFileSync(path, "utf-8")
    const contentBytes = Buffer.byteLength(content, "utf-8")
    if (options.maxBytes !== undefined && contentBytes > options.maxBytes) return undefined
    const filename = basename(path)
    if (CONTENT_ADDRESSED_SIDECAR_RE.test(filename)) {
      const hash = createHash("sha256").update(content).digest("hex")
      if (`${hash}.txt` !== filename) return undefined
    }
    return { content, size: contentBytes, path }
  } catch {
    return undefined
  }
}

function isPathInsideDirectory(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
