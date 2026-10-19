import { describe, it, expect } from "bun:test"
import {
  progressBar,
  formatDuration,
  estimateEta,
  tailNonEmpty,
  truncateLine,
  progressSummary,
  cleanActivityLine,
  cleanCommitLine,
} from "../../supertask/view.js"
import type { Prd } from "../../supertask/state.js"

describe("view/progressBar", () => {
  it("renders an empty bar when nothing passes", () => {
    const bar = progressBar(0, 10, 10)
    expect(bar).toBe("░".repeat(10))
  })
  it("fills proportionally", () => {
    const bar = progressBar(5, 10, 10)
    expect(bar).toBe("▰".repeat(5) + "░".repeat(5))
  })
  it("renders full when 100%", () => {
    const bar = progressBar(10, 10, 10)
    expect(bar).toBe("▰".repeat(10))
  })
  it("rounds to the nearest cell", () => {
    // 3/16 → 18.75%, round to 3 cells (since 16 cells / 5.33 each).
    // 1/16 → 6.25%, rounds to 1 cell (0.0625*16 = 1).
    const bar = progressBar(1, 16, 16)
    expect(bar.match(/▰/g)?.length).toBe(1)
    expect(bar.length).toBe(16)
  })
  it("clamps over-passed to total (defensive)", () => {
    const bar = progressBar(99, 10, 10)
    expect(bar).toBe("▰".repeat(10))
  })
  it("renders empty bar when total is 0", () => {
    expect(progressBar(0, 0, 5)).toBe("░░░░░")
  })
})

describe("view/formatDuration", () => {
  it("seconds under a minute", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(45)).toBe("45s")
    expect(formatDuration(59.9)).toBe("59s")
  })
  it("minutes when under an hour", () => {
    expect(formatDuration(60)).toBe("1m")
    expect(formatDuration(1800)).toBe("30m")
    expect(formatDuration(3599)).toBe("59m")
  })
  it("hours + minutes when over an hour", () => {
    expect(formatDuration(3600)).toBe("1h")
    expect(formatDuration(3600 + 720)).toBe("1h 12m")
    expect(formatDuration(7320)).toBe("2h 2m")
  })
  it("returns em-dash for invalid inputs (NaN, negative)", () => {
    expect(formatDuration(NaN)).toBe("—")
    expect(formatDuration(-5)).toBe("—")
  })
})

describe("view/estimateEta", () => {
  const start = "2026-05-22T00:00:00.000Z"
  const startMs = Date.parse(start)

  it("returns elapsed only when iter=0 (planner phase)", () => {
    const r = estimateEta({ createdAt: start, nowMs: startMs + 30_000, iter: 0, passed: 0, total: 0 })
    expect(r.elapsedSec).toBe(30)
    expect(r.etaSec).toBeNull()
    expect(r.avgSecPerIter).toBeNull()
  })

  it("returns 0 ETA when all stories pass", () => {
    const r = estimateEta({ createdAt: start, nowMs: startMs + 600_000, iter: 5, passed: 5, total: 5 })
    expect(r.elapsedSec).toBe(600)
    expect(r.etaSec).toBe(0)
    expect(r.avgSecPerIter).toBe(120)
  })

  it("projects ETA from avg-time-per-iter and remaining stories", () => {
    // 10 min elapsed, 2 iters → 5 min/iter. 3 of 5 stories left → 15 min.
    const r = estimateEta({ createdAt: start, nowMs: startMs + 600_000, iter: 2, passed: 2, total: 5 })
    expect(r.elapsedSec).toBe(600)
    expect(r.etaSec).toBe(900)
    expect(r.avgSecPerIter).toBe(300)
  })

  it("handles an unparseable createdAt by zeroing elapsed", () => {
    const r = estimateEta({ createdAt: "not-a-date", nowMs: startMs, iter: 0, passed: 0, total: 0 })
    expect(r.elapsedSec).toBe(0)
    expect(r.etaSec).toBeNull()
  })
})

describe("view/tailNonEmpty", () => {
  it("returns the last N non-empty lines", () => {
    const input = "a\n\nb\nc\n\nd\n"
    expect(tailNonEmpty(input, 2)).toEqual(["c", "d"])
    expect(tailNonEmpty(input, 99)).toEqual(["a", "b", "c", "d"])
  })
  it("trims trailing whitespace per line", () => {
    expect(tailNonEmpty("x  \ny\t\n", 5)).toEqual(["x", "y"])
  })
  it("empty input → empty array", () => {
    expect(tailNonEmpty("", 5)).toEqual([])
  })
})

describe("view/truncateLine", () => {
  it("returns the line as-is when under the limit", () => {
    expect(truncateLine("short", 10)).toBe("short")
  })
  it("clips and adds ellipsis when over", () => {
    expect(truncateLine("abcdefghij", 6)).toBe("abcde…")
  })
  it("handles width<=1 gracefully", () => {
    expect(truncateLine("abc", 1)).toBe("…")
    expect(truncateLine("", 1)).toBe("")
  })
})

describe("view/cleanActivityLine", () => {
  const projectDir = "/Users/me/work/proj"

  it("strips `cd <projectDir> && ` from Bash calls", () => {
    // The exact pattern that filled the screenshot the user complained about:
    // every Bash row started with the project cwd prefix, pushing the actual
    // command past the right-edge truncation.
    expect(cleanActivityLine(`→ Bash(cd ${projectDir} && grep foo bar)`, projectDir))
      .toBe("$ grep foo bar")
  })

  it("handles quoted projectDir in the cd prefix", () => {
    expect(cleanActivityLine(`→ Bash(cd "${projectDir}" && ls)`, projectDir)).toBe("$ ls")
    expect(cleanActivityLine(`→ Bash(cd '${projectDir}' && ls)`, projectDir)).toBe("$ ls")
  })

  it("handles `cd <projectDir>/subdir && ` (cd into a subdir of the project)", () => {
    expect(cleanActivityLine(`→ Bash(cd ${projectDir}/app && ./gradlew build)`, projectDir))
      .toBe("$ ./gradlew build")
  })

  it("leaves Bash calls without a cd prefix alone (just strips the wrapper)", () => {
    expect(cleanActivityLine(`→ Bash(echo hello)`, projectDir)).toBe("$ echo hello")
  })

  it("strips projectDir from MID-command paths (cat / grep / etc. with absolute args)", () => {
    // Screenshot regression: agent stopped using `cd && cmd` and started
    // passing absolute paths directly: `cat /Users/.../camera/app/foo.kt`.
    // The cd-prefix rule didn't help; need a global path replace too.
    expect(cleanActivityLine(`→ Bash(cat ${projectDir}/app/Foo.kt)`, projectDir))
      .toBe("$ cat app/Foo.kt")
    expect(cleanActivityLine(`→ Bash(grep -n "SHEET" ${projectDir}/src/x.ts)`, projectDir))
      .toBe(`$ grep -n "SHEET" src/x.ts`)
    // Multiple absolute paths in one command all get stripped.
    expect(cleanActivityLine(`→ Bash(diff ${projectDir}/a.ts ${projectDir}/b.ts)`, projectDir))
      .toBe("$ diff a.ts b.ts")
  })

  it("preserves cd to OTHER directories (only the projectDir cd-prefix is stripped)", () => {
    // Defensive: if the agent legitimately cd's somewhere else (e.g., /tmp
    // for scratch work), don't silently drop that context.
    expect(cleanActivityLine(`→ Bash(cd /tmp && ls)`, projectDir)).toBe("$ cd /tmp && ls")
  })

  it("compacts Read/Write/Edit lines: drop wrapper + strip projectDir prefix", () => {
    expect(cleanActivityLine(`→ Read(${projectDir}/src/foo.ts)`, projectDir)).toBe("read src/foo.ts")
    expect(cleanActivityLine(`→ Write(${projectDir}/app/Bar.kt)`, projectDir)).toBe("write app/Bar.kt")
    expect(cleanActivityLine(`→ Edit(${projectDir}/README.md)`, projectDir)).toBe("edit README.md")
  })

  it("non-arrow lines pass through unchanged (error rows, plain agent text)", () => {
    expect(cleanActivityLine("✗ Bash: command not found", projectDir))
      .toBe("✗ Bash: command not found")
    expect(cleanActivityLine("Build successful.", projectDir)).toBe("Build successful.")
    expect(cleanActivityLine("", projectDir)).toBe("")
  })

  it("escapes regex metacharacters in projectDir (defensive)", () => {
    const weird = "/path/with(parens)/and.dots"
    expect(cleanActivityLine(`→ Bash(cd ${weird} && ls)`, weird)).toBe("$ ls")
    expect(cleanActivityLine(`→ Read(${weird}/foo.ts)`, weird)).toBe("read foo.ts")
  })
})

describe("view/cleanCommitLine", () => {
  it("strips the [supertask] prefix from `<sha> [supertask] [US-XXX] ...`", () => {
    expect(cleanCommitLine("a545a15 [supertask] [US-006] Background color replacement"))
      .toBe("a545a15 [US-006] Background color replacement")
  })

  it("strips the [supertask] prefix from `<sha> [supertask] mark passes`", () => {
    // The reconciliation commits don't have a story-id tag, just "mark passes".
    expect(cleanCommitLine("a956313 [supertask] mark passes")).toBe("a956313 mark passes")
  })

  it("leaves non-supertask commits alone", () => {
    expect(cleanCommitLine("9badf00 chore: bump deps")).toBe("9badf00 chore: bump deps")
    expect(cleanCommitLine("deadbee feat(ui): something")).toBe("deadbee feat(ui): something")
  })

  it("empty / unparseable lines pass through", () => {
    expect(cleanCommitLine("")).toBe("")
    expect(cleanCommitLine("not a commit line at all")).toBe("not a commit line at all")
  })
})

describe("view/progressSummary", () => {
  function makePrd(stories: Array<{ priority: number; passes: boolean; id?: string; title?: string }>): Prd {
    return {
      project: "p",
      description: "d",
      userStories: stories.map((s, i) => ({
        id: s.id ?? `US-${String(i + 1).padStart(3, "0")}`,
        title: s.title ?? `Story ${i + 1}`,
        description: "x",
        acceptanceCriteria: [],
        priority: s.priority,
        passes: s.passes,
      })),
    }
  }

  it("counts passed vs total", () => {
    const s = progressSummary(makePrd([
      { priority: 1, passes: true },
      { priority: 2, passes: true },
      { priority: 3, passes: false },
    ]))
    expect(s.passed).toBe(2)
    expect(s.total).toBe(3)
    expect(s.remaining).toBe(1)
  })

  it("picks the lowest-priority unfinished story as next", () => {
    const s = progressSummary(makePrd([
      { priority: 3, passes: false, id: "US-A", title: "A" },
      { priority: 1, passes: false, id: "US-B", title: "B" },
      { priority: 2, passes: false, id: "US-C", title: "C" },
    ]))
    expect(s.next?.id).toBe("US-B")
  })

  it("next is undefined when everything passes", () => {
    const s = progressSummary(makePrd([
      { priority: 1, passes: true },
      { priority: 2, passes: true },
    ]))
    expect(s.next).toBeUndefined()
  })

  it("next is undefined for an empty PRD", () => {
    const s = progressSummary(makePrd([]))
    expect(s.passed).toBe(0)
    expect(s.total).toBe(0)
    expect(s.next).toBeUndefined()
  })
})
