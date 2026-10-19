import { describe, it, expect } from "bun:test"
import { parseCommand, parseSupertaskFlags } from "../../src/commands.js"
import { terminateProcessGracefully } from "../../src/commands/dispatcher.js"

describe("parseCommand — /supertask", () => {
  it("bare /supertask prints usage instead of dispatching", () => {
    const r = parseCommand("/supertask")
    expect(r?.type).toBe("output")
    expect(r?.text).toContain("Usage")
  })

  it("/supertask <desc> returns a new-supertask command with the desc", () => {
    const r = parseCommand("/supertask refactor the auth module")
    expect(r).toEqual({ type: "supertask", value: "refactor the auth module" })
  })

  it("/supertask resume returns supertask_resume", () => {
    expect(parseCommand("/supertask resume")).toEqual({ type: "supertask_resume" })
  })

  it("/supertask resume force returns supertask_resume with value=\"force\"", () => {
    // Force flag is the escape hatch for "runner is alive but I want to
    // restart anyway" — mirrors the /supertask abort confirm shape.
    expect(parseCommand("/supertask resume force")).toEqual({
      type: "supertask_resume",
      value: "force",
    })
  })

  it("/supertask abort returns supertask_abort without confirm flag", () => {
    expect(parseCommand("/supertask abort")).toEqual({ type: "supertask_abort" })
  })

  it("/supertask abort confirm returns supertask_abort with confirm flag", () => {
    expect(parseCommand("/supertask abort confirm")).toEqual({
      type: "supertask_abort",
      value: "confirm",
    })
  })

  it("/supertask status returns supertask_status", () => {
    expect(parseCommand("/supertask status")).toEqual({ type: "supertask_status" })
  })

  it("descriptions that happen to start with 'resume' but have trailing text are treated as new", () => {
    // 'resume' is a subcommand only when it's the entire arg. Anything else
    // is a description, even if it starts with the same word.
    const r = parseCommand("/supertask resume the existing thing")
    expect(r).toEqual({ type: "supertask", value: "resume the existing thing" })
  })

  it("/supertask watch returns supertask_watch", () => {
    expect(parseCommand("/supertask watch")).toEqual({ type: "supertask_watch" })
  })

  it("--max-turns and --max-iter are extracted from the description", () => {
    const r = parseCommand("/supertask build the thing --max-turns 200 --max-iter 50")
    expect(r).toEqual({
      type: "supertask",
      value: "build the thing",
      maxTurns: 200,
      maxIter: 50,
    })
  })

  it("--key=value form is accepted equally", () => {
    const r = parseCommand("/supertask --max-turns=120 do a thing")
    expect(r?.type).toBe("supertask")
    expect(r?.value).toBe("do a thing")
    expect(r?.maxTurns).toBe(120)
  })

  it("short aliases --turns / --iter also work", () => {
    const r = parseCommand("/supertask --turns 50 ship it --iter 5")
    expect(r).toEqual({
      type: "supertask",
      value: "ship it",
      maxTurns: 50,
      maxIter: 5,
    })
  })

  it("flag-only input (no desc) returns a usage error, not a runaway task", () => {
    const r = parseCommand("/supertask --max-turns 200")
    expect(r?.type).toBe("output")
    expect(r?.text).toMatch(/needs a description/i)
  })
})

describe("parseSupertaskFlags", () => {
  it("returns the input unchanged when no flags are present", () => {
    expect(parseSupertaskFlags("just a description")).toEqual({ desc: "just a description" })
  })

  it("extracts flags from anywhere in the input", () => {
    expect(parseSupertaskFlags("--max-turns 99 build it")).toEqual({
      desc: "build it",
      maxTurns: 99,
    })
    expect(parseSupertaskFlags("build it --max-iter 5")).toEqual({
      desc: "build it",
      maxIter: 5,
    })
    expect(parseSupertaskFlags("build --max-turns 99 it")).toEqual({
      desc: "build it",
      maxTurns: 99,
    })
  })

  it("ignores malformed flag values (non-positive, non-numeric)", () => {
    // Negative / zero / words must NOT silently become a value — leave them
    // in desc so the agent sees them. (parseInt of "abc" returns NaN; the
    // regex only matches \d+ anyway so 'abc' won't be captured at all.)
    expect(parseSupertaskFlags("build --max-turns 0 thing").maxTurns).toBeUndefined()
  })

  it("collapses extra whitespace left by flag removal", () => {
    expect(parseSupertaskFlags("a   --max-turns 5   b   c").desc).toBe("a b c")
  })

  it("unknown --flags are not consumed (left in desc)", () => {
    const r = parseSupertaskFlags("ship it --verbose --whatever 5")
    expect(r.desc).toBe("ship it --verbose --whatever 5")
    expect(r.maxTurns).toBeUndefined()
  })
})

describe("terminateProcessGracefully", () => {
  it("waits through an injected async sleep instead of spinning synchronously", async () => {
    let alive = true
    let sleepStarted = false
    let releaseSleep: (() => void) | undefined
    const signals: Array<NodeJS.Signals | 0 | undefined> = []
    let settled = false

    const promise = terminateProcessGracefully(12345, {
      timeoutMs: 1000,
      pollMs: 50,
      kill: (_pid, signal) => {
        signals.push(signal)
        if (signal === 0 && !alive) throw new Error("not alive")
        return true
      },
      sleep: () => {
        sleepStarted = true
        return new Promise<void>((resolve) => {
          releaseSleep = () => {
            alive = false
            resolve()
          }
        })
      },
    }).then(() => {
      settled = true
    })

    await Promise.resolve()

    expect(signals).toEqual(["SIGTERM", 0])
    expect(sleepStarted).toBe(true)
    expect(settled).toBe(false)

    releaseSleep?.()
    await promise

    expect(settled).toBe(true)
    expect(signals).toEqual(["SIGTERM", 0, 0])
  })

  it("returns immediately when SIGTERM cannot be delivered", async () => {
    const signals: Array<NodeJS.Signals | 0 | undefined> = []

    await terminateProcessGracefully(12345, {
      kill: (_pid, signal) => {
        signals.push(signal)
        throw new Error("gone")
      },
      sleep: async () => {
        throw new Error("sleep should not run")
      },
    })

    expect(signals).toEqual(["SIGTERM"])
  })
})
