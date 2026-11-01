import { expect, it } from "bun:test"
import { createElement } from "react"
import { renderToString } from "ink"
import { CompactActivity, LiveActivity } from "../../src/ui/live-activity.js"

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "")
it("renders the reference-style compact label, elapsed time and quiet actionable tip", () => {
  const output = plain(renderToString(createElement(CompactActivity, { elapsed: 8, termWidth: 100 })))
  expect(output).toContain("· Compacting conversation… (8s)")
  expect(output).toContain("└ Tip: Esc twice to stop compaction.")
  expect(output.trim().split("\n")).toHaveLength(2)
  expect(output).not.toContain("🗜")
  expect(output).not.toContain("%")
})
it("keeps the compact state visible even with stale tool/provider activity", () => {
  const output = plain(renderToString(createElement(LiveActivity, {
    isRunning: false, isStreaming: false, isThinking: true, thinkingChars: 123,
    status: "compacting", activeTool: "bash", activeToolBytes: 9000, termWidth: 100,
    pendingTools: [], stopHint: "Ctrl+C to stop",
  })))
  expect(output).toContain("Compacting conversation…")
  expect(output).toContain("Ctrl+C to stop")
  expect(output).not.toContain("bash")
  expect(output).not.toContain("chars")
})
it("leaves no compact text after idle/cancel and bounds narrow terminal rows", () => {
  for (const status of ["ready", "cancelled"]) {
    expect(plain(renderToString(createElement(LiveActivity, {
      isRunning: false, isStreaming: false, isThinking: false, thinkingChars: 0,
      status, activeTool: "", termWidth: 30, pendingTools: [],
    })))).not.toContain("Compacting")
  }
  const output = plain(renderToString(createElement(CompactActivity, { elapsed: 65, termWidth: 40 }), { columns: 40 }))
  expect(output).toContain("(1m 5s)")
  expect(output.split("\n").every(line => [...line].length <= 40)).toBe(true)
})

it("restarts elapsed time when entering compaction rather than carrying thinking time", async () => {
  const { render, Text } = await import("ink")
  const { PassThrough } = await import("node:stream")
  const { useSpinner } = await import("../../src/hooks/useSpinner.js")
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream
  stdout.columns = 80
  let latest = -1
  function Clock({ status }: { status: string }) {
    latest = useSpinner(status).elapsed
    return createElement(Text, null, String(latest))
  }
  const instance = render(createElement(Clock, { status: "thinking" }), {
    stdout, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false,
  })
  try {
    await new Promise(resolve => setTimeout(resolve, 1250))
    expect(latest).toBeGreaterThanOrEqual(1)
    instance.rerender(createElement(Clock, { status: "compacting" }))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(latest).toBe(0)
    instance.rerender(createElement(Clock, { status: "ready" }))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(latest).toBe(0)
  } finally { instance.unmount(); instance.cleanup(); stdout.destroy() }
})
