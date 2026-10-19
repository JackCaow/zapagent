import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { detectAndSaveBase64Image } from "../../utils/clipboard-image.js"

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(96),
])

describe("clipboard image persistence", () => {
  let dataDir: string
  let previousDataDir: string | undefined

  beforeEach(() => {
    previousDataDir = process.env.ZAPCODE_DATA_DIR
    dataDir = mkdtempSync(join(tmpdir(), "zap-clipboard-image-"))
    process.env.ZAPCODE_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR
    else process.env.ZAPCODE_DATA_DIR = previousDataDir
    rmSync(dataDir, { recursive: true, force: true })
  })

  it("stores pasted base64 images under the current data dir with owner-only permissions", () => {
    const path = detectAndSaveBase64Image(PNG_BYTES.toString("base64"))

    expect(path).toBeTruthy()
    expect(path!.startsWith(join(dataDir, "image-paste"))).toBe(true)
    expect(existsSync(path!)).toBe(true)
    expect(readFileSync(path!)).toEqual(PNG_BYTES)
    if (process.platform !== "win32") {
      expect(statSync(path!).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(path!)).mode & 0o777).toBe(0o700)
    }
  })
})
