import { execSync } from "node:child_process"
import { chmodSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { getAppDataDir } from "./platform.js"
import { isSupportedImage } from "./image.js"

function getPasteDir(): string {
  const dir = join(getAppDataDir(), "image-paste")
  try {
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o700)
  } catch {}
  return dir
}

function tightenFilePermissions(path: string): void {
  try { chmodSync(path, 0o600) } catch {}
}

/**
 * Detect whether a pasted text blob is actually base64-encoded image
 * data and save it as a file. Some terminals (Claude Code interop,
 * iTerm2 with image protocol) deliver paste events whose `text` is
 * the raw base64 of the clipboard image rather than a path. Returns
 * the saved file path on a hit, null on miss.
 *
 * Detection:
 *   - body is mostly base64 chars (the Ink paste arrives stripped of
 *     bracketed-paste markers)
 *   - decoded bytes start with PNG / JPEG / GIF / WEBP magic numbers
 *
 * Why a separate helper from clipboardHasImage(): paste delivers the
 * data inline; clipboardHasImage probes the OS clipboard via
 * osascript / xclip after the fact. Different code paths.
 */
export function detectAndSaveBase64Image(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.length < 100) return null
  // Strip whitespace; some terminals wrap base64 with newlines.
  const compact = trimmed.replace(/\s+/g, "")
  if (!/^[A-Za-z0-9+/=]+$/.test(compact)) return null
  let data: Buffer
  try {
    data = Buffer.from(compact, "base64")
  } catch {
    return null
  }
  if (data.length < 64) return null

  let ext: string
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    ext = "png"
  } else if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    ext = "jpg"
  } else if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    ext = "gif"
  } else if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("utf-8") === "RIFF" &&
    data.subarray(8, 12).toString("utf-8") === "WEBP"
  ) {
    ext = "webp"
  } else {
    return null
  }

  try {
    const outPath = join(getPasteDir(), `paste-${Date.now()}.${ext}`)
    writeFileSync(outPath, data, { mode: 0o600 })
    tightenFilePermissions(outPath)
    return outPath
  } catch {
    return null
  }
}

/**
 * On macOS, if the clipboard holds a copied file (e.g. from Finder),
 * return the POSIX path to that file.  Returns null otherwise.
 */
function getClipboardFilePath(): string | null {
  if (process.platform !== "darwin") return null
  try {
    // «class furl» is the file-URL class placed on the clipboard when
    // a user copies a file in Finder (Cmd+C on a file).
    const info = execSync("osascript -e 'clipboard info' 2>/dev/null", { timeout: 2000 }).toString()
    if (!info.includes("furl")) return null
    const posix = execSync(
      `osascript -e 'POSIX path of (the clipboard as «class furl»)' 2>/dev/null`,
      { timeout: 2000 },
    ).toString().trim()
    return posix && existsSync(posix) ? posix : null
  } catch { return null }
}

/**
 * Check if the system clipboard contains image data.
 * Returns true if an image is available for paste.
 */
export function clipboardHasImage(): boolean {
  if (process.platform === "darwin") {
    try {
      const info = execSync("osascript -e 'clipboard info' 2>/dev/null", { timeout: 2000 }).toString()
      return info.includes("PNGf") || info.includes("JPEG") || info.includes("TIFF") || info.includes("furl")
    } catch { return false }
  }

  if (process.platform === "linux") {
    try {
      const targets = execSync("xclip -selection clipboard -t TARGETS -o 2>/dev/null", { timeout: 2000 }).toString()
      return targets.includes("image/png") || targets.includes("image/jpeg")
    } catch { return false }
  }

  if (process.platform === "win32") {
    try {
      const out = execSync(
        `powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { 'yes' } else { 'no' }"`,
        { timeout: 3000 },
      ).toString().trim()
      return out === "yes"
    } catch { return false }
  }

  return false
}

/**
 * Save the clipboard image to a temp file and return its path.
 * Returns null if no image is available.
 *
 * When the clipboard holds a copied *file* (e.g. Cmd+C on a JPG in Finder),
 * we return the original file path directly instead of reading the (icon-sized)
 * PNGf representation, which would be just a generic file-type thumbnail.
 */
export function pasteImageFromClipboard(): string | null {
  // ── macOS: prefer file path over raw PNGf ──
  if (process.platform === "darwin") {
    // 1. If a file was copied and it's a supported image, return its path directly
    const filePath = getClipboardFilePath()
    if (filePath && isSupportedImage(filePath)) {
      return filePath
    }

    // 2. Fall back to reading raw image data (e.g. screenshot copied to clipboard)
    const filename = `paste-${Date.now()}.png`
    const outPath = join(getPasteDir(), filename)
    try {
      // `2>/dev/null` matters: Bun's execSync inherits the child's
      // stderr to the parent terminal (Node captures into Error.stderr
      // and stays silent). When the clipboard has no PNGf data —
      // routine on every `v` keystroke that triggers Path X — osascript
      // prints `execution error: … (-1700)` to stderr, which corrupts
      // Ink's frame and visibly shifts the prompt down by one row.
      execSync(
        `osascript -e 'set pngData to the clipboard as «class PNGf»' -e 'set fp to open for access POSIX file "${outPath}" with write permission' -e 'write pngData to fp' -e 'close access fp' 2>/dev/null`,
        { timeout: 5000 }
      )
      tightenFilePermissions(outPath)
      return outPath
    } catch { return null }
  }

  // ── Linux ──
  if (process.platform === "linux") {
    const filename = `paste-${Date.now()}.png`
    const outPath = join(getPasteDir(), filename)
    try {
      execSync(`xclip -selection clipboard -t image/png -o > "${outPath}" 2>/dev/null`, {
        timeout: 5000,
        shell: "/bin/sh",
      })
      tightenFilePermissions(outPath)
      return outPath
    } catch { return null }
  }

  // ── Windows ── PowerShell + System.Windows.Forms.Clipboard
  if (process.platform === "win32") {
    const filename = `paste-${Date.now()}.png`
    const outPath = join(getPasteDir(), filename)
    // Single-quote the path inside PowerShell and double any embedded single quotes.
    const psPath = outPath.replace(/'/g, "''")
    const script =
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `Add-Type -AssemblyName System.Drawing; ` +
      `$img = [System.Windows.Forms.Clipboard]::GetImage(); ` +
      `if ($img) { $img.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png); 'ok' } ` +
      `else { 'no' }`
    try {
      const out = execSync(`powershell -NoProfile -STA -Command "${script}"`, { timeout: 5000 }).toString().trim()
      if (out === "ok" && existsSync(outPath)) tightenFilePermissions(outPath)
      return out === "ok" && existsSync(outPath) ? outPath : null
    } catch { return null }
  }

  return null
}
