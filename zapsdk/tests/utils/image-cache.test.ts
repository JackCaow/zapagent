import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { loadImage } from "../../utils/image.js"

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("cached image"),
])

function cachePathFor(dataDir: string, url: string): string {
  const hash = createHash("md5").update(url).digest("hex")
  return join(dataDir, "image-cache", `${hash}.png`)
}

function mockFetchReturning(data: Buffer): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  })) as unknown as typeof fetch
}

describe("image cache persistence", () => {
  let dataDir: string
  let previousDataDir: string | undefined
  let previousFetch: typeof fetch

  beforeEach(() => {
    previousDataDir = process.env.ZAPCODE_DATA_DIR
    previousFetch = globalThis.fetch
    dataDir = mkdtempSync(join(tmpdir(), "zap-image-cache-"))
    process.env.ZAPCODE_DATA_DIR = dataDir
  })

  afterEach(() => {
    globalThis.fetch = previousFetch
    if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR
    else process.env.ZAPCODE_DATA_DIR = previousDataDir
    rmSync(dataDir, { recursive: true, force: true })
  })

  it("stores downloaded images with owner-only permissions", async () => {
    const url = "https://example.com/image.png"
    globalThis.fetch = mockFetchReturning(PNG_BYTES)

    const image = await loadImage(url)

    expect(image.source).toBe(url)
    expect(image.filePath).toBe(cachePathFor(dataDir, url))
    expect(existsSync(image.filePath)).toBe(true)
    expect(readFileSync(image.filePath)).toEqual(PNG_BYTES)
    if (process.platform !== "win32") {
      expect(statSync(image.filePath).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(image.filePath)).mode & 0o777).toBe(0o700)
    }
  })

  it("tightens permissions when reusing an existing cached image", async () => {
    const url = "https://example.com/existing.png"
    const path = cachePathFor(dataDir, url)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, PNG_BYTES, { mode: 0o666 })
    chmodSync(path, 0o666)
    globalThis.fetch = (async () => {
      throw new Error("fetch should not be called for cached images")
    }) as typeof fetch

    const image = await loadImage(url)

    expect(image.filePath).toBe(path)
    expect(readFileSync(path)).toEqual(PNG_BYTES)
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })
})
