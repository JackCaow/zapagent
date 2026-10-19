import { describe, expect, it } from "bun:test"
import logUpdate from "../../node_modules/ink/build/log-update.js"
import { createResizeAwareLog } from "../../src/ui/resize-log.js"

function fixture() {
  const writes: string[] = []
  const stream = { columns: 40, write: (text: string) => { writes.push(text); return true } }
  const log = createResizeAwareLog(logUpdate.create(stream as NodeJS.WriteStream, { incremental: true }), stream)
  return { log, stream, writes }
}

describe("resize log written-frame tracking", () => {
  it("does not use the next requested cursor to clear the previous frame", () => {
    const { log, stream, writes } = fixture()
    log.setCursorPosition({ x: 2, y: 1 })
    log("top\ninput\nbottom\n")
    log.setCursorPosition({ x: 2, y: 0 })
    stream.columns = 60
    log.clear()
    expect(writes.at(-1)).toBe("\r\x1b[1A\x1b[J")
  })

  it("tracks direct fullscreen sync writes", () => {
    const { log, stream, writes } = fixture()
    log("old\n")
    log.setCursorPosition({ x: 2, y: 3 })
    log.sync("one\ntwo\nthree\nfour")
    stream.columns = 60
    log.clear()
    expect(writes.at(-1)).toBe("\r\x1b[3A\x1b[J")
  })

  it("forgets cursor position when a frame no longer supplies one", () => {
    const { log, stream, writes } = fixture()
    log.setCursorPosition({ x: 2, y: 1 })
    log("top\ninput\nbottom\n")
    log("top\ninput\nbottom\n")
    stream.columns = 60
    log.clear()
    expect(writes.at(-1)).toBe("\r\x1b[3A\x1b[J")
  })

  for (const action of ["clear", "reset", "done"] as const) {
    it(`does not erase old history after ${action} and another resize`, () => {
      const { log, stream, writes } = fixture()
      log("one\ntwo\n")
      log[action]()
      stream.columns = 60
      writes.length = 0
      log.clear()
      expect(writes.join("")).not.toContain("A")
      expect(writes.join("")).not.toContain("\x1b[J")
    })
  }
})
