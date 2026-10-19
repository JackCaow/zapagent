import { describe, expect, it } from "bun:test"
import { createElement } from "react"
import { renderToString } from "ink"
import { ToolResult } from "../../src/ui/Transcript.js"

function renderResult(success: boolean, exitCode: number, stderrPresent?: boolean, output = "output") {
  return renderToString(createElement(ToolResult, {
    log: { id: 1, type: "result", text: "", tool: {
      name: "bash", arguments: { command: "cat missing | wc -l" }, success, output,
      meta: { runtime: { command: { exitCode, stderrPresent } } },
    } },
  }), { columns: 120 }).replace(/\x1b\[[0-9;]*m/g, "")
}

describe("shell result status", () => {
  it("warns for exit zero with stderr even when output is folded", () => {
    const output = renderResult(true, 0, true, Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"))
    expect(output).toContain("⚠")
    expect(output).not.toContain("✓")
    expect(output).toContain("exit 0 with stderr")
    expect(output).toContain("more lines")
  })

  it("preserves clean success and nonzero failure markers", () => {
    expect(renderResult(true, 0)).toContain("✓")
    expect(renderResult(true, 0)).not.toContain("exit 0 with stderr")
    expect(renderResult(false, 7, true)).toContain("✗")
    expect(renderResult(false, 7, true)).not.toContain("exit 0 with stderr")
  })

  it("does not hide the warning when output resembles a diff", () => {
    expect(renderResult(true, 0, true, "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new"))
      .toContain("exit 0 with stderr")
  })
})
