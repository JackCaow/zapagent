import { describe, expect, it } from "bun:test"
import { HEADLESS_HELP, parseHeadlessArgs } from "../../src/headless/args.js"

describe("headless args parser", () => {
  it("documents the installed zap command in usage and recovery instructions", () => {
    expect(HEADLESS_HELP).toContain("zap -p <prompt> [options]")
    expect(HEADLESS_HELP).toContain('zap "<prompt>" [options]')
    expect(HEADLESS_HELP).toContain('echo "<prompt>" | zap [options]')
    expect(HEADLESS_HELP).toContain("run 'zap' interactive once")
    expect(HEADLESS_HELP).not.toContain("zapcode")
  })

  it("accepts explicit prompts that start with a dash", () => {
    const parsed = parseHeadlessArgs(["-p", "- fix the failing tests"])

    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.args.prompt).toBe("- fix the failing tests")
  })

  it("accepts appended system prompt text that starts with a dash", () => {
    const parsed = parseHeadlessArgs([
      "-p",
      "hello",
      "--system-prompt-append",
      "- prefer terse answers",
    ])

    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.args.systemPromptAppend).toBe("- prefer terse answers")
  })

  it("accepts prepended system prompt text that starts with a dash", () => {
    const parsed = parseHeadlessArgs([
      "-p",
      "hello",
      "--system-prompt-prepend",
      "- benchmark cold nonce",
    ])

    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.args.systemPromptPrepend).toBe("- benchmark cold nonce")
  })

  it("requires an explicit dangerous flag to disable the OS sandbox", () => {
    const normal = parseHeadlessArgs(["-p", "hello"])
    expect(normal.ok).toBe(true)
    if (normal.ok) expect(normal.args.dangerouslyDisableOsSandbox).toBe(false)

    const trustedOuterSandbox = parseHeadlessArgs([
      "-p",
      "hello",
      "--dangerously-disable-os-sandbox",
    ])
    expect(trustedOuterSandbox.ok).toBe(true)
    if (trustedOuterSandbox.ok) {
      expect(trustedOuterSandbox.args.dangerouslyDisableOsSandbox).toBe(true)
    }
  })

  it("accepts a positive self-managed wall-clock budget", () => {
    const parsed = parseHeadlessArgs(["-p", "fix it", "--timeout-ms", "840000"])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.args.timeoutMs).toBe(840000)

    expect(parseHeadlessArgs(["-p", "fix it", "--timeout-ms", "0"])).toEqual({
      ok: false,
      message: "--timeout-ms must be a positive integer, got: 0",
    })
  })

  it("keeps continue-on-tool-denial opt-in for evaluator adapters", () => {
    const normal = parseHeadlessArgs(["-p", "hello"])
    expect(normal.ok).toBe(true)
    if (normal.ok) expect(normal.args.continueOnToolDenial).toBe(false)

    const evaluator = parseHeadlessArgs(["-p", "hello", "--continue-on-tool-denial"])
    expect(evaluator.ok).toBe(true)
    if (evaluator.ok) expect(evaluator.args.continueOnToolDenial).toBe(true)
  })

  it("still rejects missing values for structured flags", () => {
    expect(parseHeadlessArgs(["-p", "hello", "--model", "--quiet"])).toEqual({
      ok: false,
      message: "--model requires a value",
    })
  })

  it("does not consume known flags as free-form prompt text", () => {
    expect(parseHeadlessArgs(["-p", "--quiet"])).toEqual({
      ok: false,
      message: "-p requires a value",
    })
    expect(parseHeadlessArgs(["-p", "--dev"])).toEqual({
      ok: false,
      message: "-p requires a value",
    })
    expect(parseHeadlessArgs(["-p", "--help-headless"])).toEqual({
      ok: false,
      message: "-p requires a value",
    })
  })

  it("does not consume known flags as appended system prompt text", () => {
    expect(parseHeadlessArgs(["-p", "hello", "--system-prompt-append", "--quiet"])).toEqual({
      ok: false,
      message: "--system-prompt-append requires a value",
    })
    expect(parseHeadlessArgs(["-p", "hello", "--system-prompt-append", "--dev"])).toEqual({
      ok: false,
      message: "--system-prompt-append requires a value",
    })
  })

  it("does not consume known flags as prepended system prompt text", () => {
    expect(parseHeadlessArgs(["-p", "hello", "--system-prompt-prepend", "--quiet"])).toEqual({
      ok: false,
      message: "--system-prompt-prepend requires a value",
    })
  })

  it("rejects positional prompt text when -p already supplied a prompt", () => {
    expect(parseHeadlessArgs(["-p", "hello", "extra"])).toEqual({
      ok: false,
      message: "positional prompt text cannot be combined with -p/--print",
    })
  })

  it("rejects ambiguous session restore flags", () => {
    expect(parseHeadlessArgs(["-p", "hello", "--continue", "--session-id", "abc"])).toEqual({
      ok: false,
      message: "--continue cannot be combined with --session-id",
    })
  })

  it("rejects session paths while preserving legacy storage ids", () => {
    expect(parseHeadlessArgs(["-p", "hello", "--session-id", "../secret"])).toEqual({
      ok: false,
      message: "--session-id must be a valid session id, not a path",
    })
    expect(parseHeadlessArgs(["-p", "hello", "--session-id", "/tmp/secret"])).toEqual({
      ok: false,
      message: "--session-id must be a valid session id, not a path",
    })
    expect(parseHeadlessArgs(["-p", "hello", "--session-id", "CON"])).toEqual({
      ok: false,
      message: "--session-id must be a valid session id, not a path",
    })

    const parsed = parseHeadlessArgs(["-p", "hello", "--session-id", "session-legacy_1.2"])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.args.sessionId).toBe("session-legacy_1.2")
  })
})

it("selects outcome-v1 by default and rejects invalid or conflicting profiles", () => {
  expect(parseHeadlessArgs(["-p", "hello"])).toMatchObject({ ok: true, args: { resultSchema: "outcome-v1" } })
  expect(parseHeadlessArgs(["-p", "hello", "--result-schema", "legacy"])).toMatchObject({ ok: true, args: { resultSchema: "legacy" } })
  expect(parseHeadlessArgs(["-p", "hello", "--result-schema", "unknown"]).ok).toBe(false)
  expect(parseHeadlessArgs(["-p", "hello", "--result-schema", "legacy", "--result-schema", "outcome-v1"]).ok).toBe(false)
})
