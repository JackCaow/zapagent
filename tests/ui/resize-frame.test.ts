import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildResizeFrameClearSequence,
  resizeFrameRowsAboveCursor,
} from "../../src/ui/resize-frame.js"

describe("resize frame cleanup", () => {
  const oldFrame = [
    "─".repeat(40),
    "─".repeat(40),
    "workspace/test2",
    "~51.3K/1.00M  ●  DeepSeek/deepseek-v4-flash",
  ].join("\n") + "\n"

  it("clears every hard-wrapped row when a window widens without an active cursor", () => {
    expect(resizeFrameRowsAboveCursor(oldFrame, undefined, 100)).toBe(4)
    expect(buildResizeFrameClearSequence(oldFrame, undefined, 100)).toBe(
      "\r\x1b[4A\x1b[J",
    )
  })

  it("counts new soft-wrap rows when a window narrows without an active cursor", () => {
    expect(resizeFrameRowsAboveCursor(oldFrame, undefined, 20)).toBe(8)
  })

  it("clears upward from an active cursor parked inside the old frame", () => {
    expect(resizeFrameRowsAboveCursor(oldFrame, { x: 5, y: 2 }, 100)).toBe(2)
    expect(resizeFrameRowsAboveCursor(oldFrame, { x: 25, y: 2 }, 20)).toBe(5)
  })

  it("treats fullscreen output without a trailing newline as cursor-on-last-row", () => {
    expect(resizeFrameRowsAboveCursor("one\ntwo\nthree", undefined, 80)).toBe(2)
  })

  it("installs an Ink resize hook that resets frames in both directions", () => {
    const source = readFileSync(join(process.cwd(), "node_modules/ink/build/ink.js"), "utf8")
    expect(source).toContain("if (currentWidth !== this.lastTerminalWidth)")
    expect(source).toContain("this.lastOutputHeight = 0")
  })
})
