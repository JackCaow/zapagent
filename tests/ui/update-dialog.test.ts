import { expect, it } from "bun:test"
import { createElement } from "react"
import { render } from "ink"
import { PassThrough } from "node:stream"
import { UpdateDialog } from "../../src/ui/dialog-update.js"
import { VERSION } from "../../src/version.js"

it("explicit update rechecks on reopen despite automatic opt-out, with truthful errors and no install", async () => {
  const originalFetch = globalThis.fetch
  const originalDisable = process.env.ZAP_DISABLE_UPDATE_CHECK
  process.env.ZAP_DISABLE_UPDATE_CHECK = "1"
  let calls = 0, installs = 0, closed = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls === 1) throw new Error("offline")
    return Response.json({ latest: VERSION })
  }) as typeof fetch
  const sessions: ReturnType<typeof render>[] = []
  try {
    for (const expected of ["Could not check for updates", "is up to date"]) {
      const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void; ref: () => void; unref: () => void }
      stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.ref = () => {}; stdin.unref = () => {}
      const stdout = new PassThrough() as PassThrough & { columns: number }
      stdout.columns = 100
      let text = ""
      stdout.on("data", chunk => { text += chunk.toString() })
      const instance = render(createElement(UpdateDialog, {
        busy: false, sessionId: "fixture", beforeInstall: () => { installs++ },
        onRestart: () => { installs++ }, onCancel: () => { closed++ },
      }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stdout as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false, patchConsole: false })
      sessions.push(instance)
      const deadline = Date.now() + 2000
      while (!text.includes(expected) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      expect(text).toContain(expected)
      if (calls === 1) expect(text).not.toContain("is up to date")
      // Neither Enter nor y may install without an available, prepared update.
      stdin.write("\r"); await new Promise(resolve => setTimeout(resolve, 10))
      stdin.write("y"); await new Promise(resolve => setTimeout(resolve, 10))
      stdin.write("n")
      await new Promise(resolve => setTimeout(resolve, 20))
      instance.unmount(); instance.cleanup()
    }
    expect(calls).toBe(2)
    expect(installs).toBe(0)
    expect(closed).toBe(2)
  } finally {
    for (const session of sessions) { session.unmount(); session.cleanup() }
    globalThis.fetch = originalFetch
    if (originalDisable === undefined) delete process.env.ZAP_DISABLE_UPDATE_CHECK
    else process.env.ZAP_DISABLE_UPDATE_CHECK = originalDisable
  }
})
