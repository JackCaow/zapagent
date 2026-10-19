import { describe, expect, test } from "bun:test"
import { parseCommand } from "../../src/commands.js"

describe("/recovery command", () => {
  test("opens the runtime recovery center", () => {
    expect(parseCommand("/recovery")).toEqual({ type: "open_recovery" })
  })

  test("documents the recovery command in help", () => {
    const help = parseCommand("/help")
    expect(help?.type).toBe("output")
    expect(help?.text).toContain("/recovery")
  })
})
