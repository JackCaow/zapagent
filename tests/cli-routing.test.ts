import { describe, expect, it } from "bun:test"
import { devtoolsPortFromArgs, headlessCwdFromArgs, isHeadlessInvocation } from "../src/cli-routing.js"

describe("CLI headless routing", () => {
  it("routes --help-headless to the headless shim even in an interactive TTY", () => {
    expect(isHeadlessInvocation(["--help-headless"], true)).toBe(true)
  })

  it("routes explicit and positional prompts to headless mode", () => {
    expect(isHeadlessInvocation(["-p", "hello"], true)).toBe(true)
    expect(isHeadlessInvocation(["hello"], true)).toBe(true)
  })

  it("does not treat devtools flags or value arguments as prompts", () => {
    expect(isHeadlessInvocation(["--dev"], true)).toBe(false)
    expect(isHeadlessInvocation(["--dev", "9230"], true)).toBe(false)
    expect(isHeadlessInvocation(["--model", "claude-sonnet-4-5"], true)).toBe(false)
  })

  it("routes piped stdin to headless mode", () => {
    expect(isHeadlessInvocation([], false)).toBe(true)
    expect(isHeadlessInvocation([], undefined)).toBe(true)
  })

  it("parses TUI devtools ports without treating the port as a prompt", () => {
    expect(devtoolsPortFromArgs(["--dev"])).toBe("9229")
    expect(devtoolsPortFromArgs(["--dev", "9230"])).toBe("9230")
    expect(isHeadlessInvocation(["--dev", "9230"], true)).toBe(false)
  })

  it("still routes explicit prompts to headless when --dev is present", () => {
    expect(isHeadlessInvocation(["--dev", "-p", "hello"], true)).toBe(true)
    expect(isHeadlessInvocation(["--dev", "9230", "-p", "hello"], true)).toBe(true)
  })

  it("extracts a headless cwd before singletons are loaded", () => {
    expect(headlessCwdFromArgs(["-p", "hello"])).toEqual({ ok: true })
    expect(headlessCwdFromArgs(["--cwd", "/tmp/project", "-p", "hello"])).toEqual({
      ok: true,
      cwd: "/tmp/project",
    })
  })

  it("rejects missing headless cwd values before attempting chdir", () => {
    expect(headlessCwdFromArgs(["--cwd"])).toEqual({
      ok: false,
      message: "--cwd requires a value",
    })
    expect(headlessCwdFromArgs(["--cwd", "-p", "hello"])).toEqual({
      ok: false,
      message: "--cwd requires a value",
    })
  })
})
