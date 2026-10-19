import { chmodSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { extname, resolve, join } from "node:path"
import { createHash } from "node:crypto"
import type { ImageContent } from "../core/types.js"
import { getAppDataDir } from "./platform.js"

// Formats Anthropic AND OpenAI both accept as image content blocks. SVG is
// not on this list (and never will be — providers don't render SVG); we
// rasterize SVG to PNG locally via @resvg/resvg-js before sending. See
// `rasterizeSvgToPng` and the `.svg` branch in `loadImageFromFile`.
const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

const SUPPORTED_MIME_TYPES = new Set(Object.values(SUPPORTED_EXTENSIONS))
const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20MB
// Upper bound on the rasterized SVG width. Most slide-style SVGs are
// 960–1920 wide; 1600 keeps the PNG sharp on retina screens without
// blowing up the base64 payload (a 1600x900 PNG is typically 100–400 KB).
const SVG_RASTER_MAX_WIDTH = 1600
function getImageCacheDir(): string {
  const dir = join(getAppDataDir(), "image-cache")
  try {
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o700)
  } catch {}
  return dir
}

function tightenFilePermissions(path: string): void {
  try { chmodSync(path, 0o600) } catch {}
}

function detectMimeFromBuffer(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png"
  }

  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg"
  }

  if (data.length >= 6) {
    const ascii6 = data.subarray(0, 6).toString("ascii")
    if (ascii6 === "GIF87a" || ascii6 === "GIF89a") {
      return "image/gif"
    }
  }

  if (data.length >= 12) {
    const riff = data.subarray(0, 4).toString("ascii")
    const webp = data.subarray(8, 12).toString("ascii")
    if (riff === "RIFF" && webp === "WEBP") {
      return "image/webp"
    }
  }

  return null
}

export function isSupportedImage(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return ext === ".svg" || ext in SUPPORTED_EXTENSIONS
}

/** Rasterize SVG bytes to PNG bytes using @resvg/resvg-js. The cached PNG
 *  path is keyed on the content hash so a re-saved SVG renders fresh while
 *  unchanged SVGs reuse the cached PNG (rasterization is ~50–200ms even
 *  for simple slides). Errors propagate so loadImageFromFile can surface
 *  a clean message to the agent. */
function rasterizeSvgToPng(absPath: string, svgData: Buffer): { pngData: Buffer; pngPath: string } {
  // Lazy import: @resvg/resvg-js loads native bindings (~5MB), which we
  // don't want to pay for on the common case where the user never reads
  // an SVG. require() cache makes subsequent calls free.
  // Avoid `import()` here: the dynamic-import case path leaks an unhandled
  // promise rejection if the binding fails to load on a platform we don't
  // ship a binary for. require() throws synchronously, which the caller
  // already wraps.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Resvg } = require("@resvg/resvg-js") as typeof import("@resvg/resvg-js")

  const hash = createHash("md5").update(svgData).digest("hex")
  const pngPath = join(getImageCacheDir(), `${hash}.png`)
  if (existsSync(pngPath)) {
    tightenFilePermissions(pngPath)
    return { pngData: readFileSync(pngPath), pngPath }
  }

  const resvg = new Resvg(svgData, {
    fitTo: { mode: "width", value: SVG_RASTER_MAX_WIDTH },
    // White background: SVGs commonly use transparency, but JPEG-style
    // model previews look broken with a transparent background — most
    // model UIs render transparent pixels as black. White is a safe
    // default; users who want transparent should rasterize themselves.
    background: "white",
  })
  const pngData = Buffer.from(resvg.render().asPng())
  writeFileSync(pngPath, pngData, { mode: 0o600 })
  tightenFilePermissions(pngPath)
  return { pngData, pngPath }
}

/** Load an image from a file path, returning an ImageContent with base64
 *  data. SVG inputs are rasterized to PNG via resvg-js (cached by content
 *  hash) since no LLM accepts SVG image blocks. */
export function loadImageFromFile(filePath: string): ImageContent {
  const absPath = resolve(filePath)

  if (!existsSync(absPath)) {
    throw new Error(`Image not found: ${filePath}`)
  }

  const stat = statSync(absPath)
  if (stat.size > MAX_IMAGE_SIZE) {
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1)
    throw new Error(`Image too large: ${sizeMB}MB (max 20MB)`)
  }

  // SVG → rasterize to PNG before handing to the model.
  if (extname(absPath).toLowerCase() === ".svg") {
    const svgData = readFileSync(absPath)
    const { pngData, pngPath } = rasterizeSvgToPng(absPath, svgData)
    return {
      type: "image",
      filePath: pngPath,
      mediaType: "image/png",
      base64: pngData.toString("base64"),
      source: filePath,
    }
  }

  const data = readFileSync(absPath)
  const mediaType = detectMimeFromBuffer(data) ?? SUPPORTED_EXTENSIONS[extname(absPath).toLowerCase()]
  if (!mediaType || !SUPPORTED_MIME_TYPES.has(mediaType)) {
    const ext = extname(absPath).toLowerCase() || "(no extension)"
    throw new Error(`Unsupported image format: ${ext}. Supported: ${Object.keys(SUPPORTED_EXTENSIONS).join(", ")}, .svg`)
  }

  return {
    type: "image",
    filePath: absPath,
    mediaType,
    base64: data.toString("base64"),
    source: filePath,
  }
}

/** Download an image from URL to cache, return ImageContent. SVG URLs are
 *  cached as `.svg` and `loadImageFromFile` handles rasterization on read. */
async function loadImageFromURL(url: string): Promise<ImageContent> {
  const hash = createHash("md5").update(url).digest("hex")
  const urlObj = new URL(url)
  const ext = extname(urlObj.pathname).toLowerCase() || ".png"

  const allowedExt = ext in SUPPORTED_EXTENSIONS || ext === ".svg"
  if (!allowedExt) {
    throw new Error(`Unsupported image format from URL: ${ext}`)
  }

  const cachePath = join(getImageCacheDir(), `${hash}${ext}`)

  if (existsSync(cachePath)) {
    tightenFilePermissions(cachePath)
    return loadImageFromFile(cachePath)
  }

  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!resp.ok) throw new Error(`Failed to download image: HTTP ${resp.status}`)

  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length > MAX_IMAGE_SIZE) {
    throw new Error(`Downloaded image too large: ${(buf.length / (1024 * 1024)).toFixed(1)}MB (max 20MB)`)
  }

  writeFileSync(cachePath, buf, { mode: 0o600 })
  tightenFilePermissions(cachePath)
  return { ...loadImageFromFile(cachePath), source: url }
}

/** Load image from path or URL */
export async function loadImage(ref: string): Promise<ImageContent> {
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    return loadImageFromURL(ref)
  }
  return loadImageFromFile(ref)
}
