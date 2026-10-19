import { describe, expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { browserScreenshotTool, findBrowser } from "../../builtin-tools/browser.js"

const signal = new AbortController().signal
const browser = findBrowser()
const realBrowser = browser ? describe : describe.skip

describe("browser_screenshot input handling", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-browser-")))
  const tool = browserScreenshotTool({ defaultCwd: root, allowedPaths: [root], browserPath: process.execPath })

  it("reports a missing browser clearly", async () => {
    const result = await browserScreenshotTool({ browserPath: join(root, "nope") }).handler({ target: "https://example.com" }, signal)
    expect(result.success).toBe(false)
    expect(result.error).toContain("Browser not found")
  })

  it("refuses schemes other than http(s) and files", async () => {
    const result = await tool.handler({ target: "ftp://example.com/x" }, signal)
    expect(result.success).toBe(false)
    expect(result.error).toContain("Only http(s)")
  })

  it("refuses a local file outside the allowed roots and a missing file", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "zap-browser-out-")))
    writeFileSync(join(outside, "x.html"), "<p>x</p>")
    try {
      const denied = await tool.handler({ target: join(outside, "x.html") }, signal)
      expect(denied.error).toContain("outside the allowed")
      const missing = await tool.handler({ target: "nope.html" }, signal)
      expect(missing.error).toContain("File not found")
    } finally { rmSync(outside, { recursive: true, force: true }) }
  })

  it("declares a file read for a local target and a network connect for a URL", () => {
    const fx = tool.definition.resolveEffects!
    expect(fx({ target: "a.html" } as never, {} as never).filesystem[0]?.operation).toBe("read")
    expect(fx({ target: "https://example.com/x" } as never, {} as never).network[0]?.destinations).toEqual(["https://example.com/x"])
  })
})

realBrowser("browser_screenshot with a real browser", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-browser-real-")))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
    <rect width="400" height="200" fill="white"/>
    <rect id="r" x="0" y="60" width="80" height="80" fill="crimson">
      <animate attributeName="x" from="0" to="320" dur="2s" fill="freeze"/>
    </rect></svg>`
  writeFileSync(join(root, "anim.svg"), svg)

  it("returns one PNG frame per time, and an animated element moves between frames", async () => {
    const tool = browserScreenshotTool({ defaultCwd: root, allowedPaths: [root] })
    const result = await tool.handler({ target: "anim.svg", times_ms: [100, 2000], width: 400, height: 200 }, signal)
    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
    expect(result.contentBlocks?.length).toBe(2)
    const [a, b] = result.contentBlocks as { base64: string; mediaType: string }[]
    expect(a!.mediaType).toBe("image/png")
    expect(Buffer.from(a!.base64, "base64").subarray(1, 4).toString()).toBe("PNG")
    expect(a!.base64).not.toBe(b!.base64)
  }, 90_000)
})
