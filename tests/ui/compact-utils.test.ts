import { describe, it, expect } from "bun:test"
import { extractFilesFromSummary } from "../../src/ui/compact-utils.js"

describe("extractFilesFromSummary", () => {
  it("returns bullet list paths from '# Files read / modified' section", () => {
    const summary = `# User's overall goal
Refactor auth.

# Files read / modified
- src/auth.ts — extract SessionStore
- src/middleware/session.ts — replace cookie logic
- tests/auth.test.ts

# Next steps
- ship it
`
    expect(extractFilesFromSummary(summary)).toEqual([
      "src/auth.ts",
      "src/middleware/session.ts",
      "tests/auth.test.ts",
    ])
  })

  it("returns [] when section is missing", () => {
    const summary = "# User's overall goal\nSomething.\n\n# Next steps\n- go"
    expect(extractFilesFromSummary(summary)).toEqual([])
  })

  it("returns [] when section is present but empty", () => {
    const summary = "# Files read / modified\n\n# Next steps\n- go"
    expect(extractFilesFromSummary(summary)).toEqual([])
  })

  it("tolerates punctuation and emphasis around the files heading", () => {
    const summary = [
      "# **Files read / modified:**",
      "- src/compact.ts",
      "- tests/compact.test.ts",
    ].join("\n")

    expect(extractFilesFromSummary(summary)).toEqual([
      "src/compact.ts",
      "tests/compact.test.ts",
    ])
  })

  it("matches files headings case-insensitively", () => {
    const summary = [
      "# FILES READ / MODIFIED",
      "- src/status.ts",
      "- tests/status.test.ts",
    ].join("\n")

    expect(extractFilesFromSummary(summary)).toEqual([
      "src/status.ts",
      "tests/status.test.ts",
    ])
  })

  it("matches files headings with slash spacing variants", () => {
    const summary = [
      "# Files read/modified",
      "- src/compact-utils.ts",
      "- tests/compact-utils.test.ts",
    ].join("\n")

    expect(extractFilesFromSummary(summary)).toEqual([
      "src/compact-utils.ts",
      "tests/compact-utils.test.ts",
    ])
  })

  it("matches localized files headings", () => {
    const summary = [
      "# **读取/修改的文件：**",
      "- src/ui/compact-utils.ts — 复用 compact heading normalize",
      "- `tests/ui/compact-utils.test.ts:70` — 覆盖中文标题",
      "# 后续步骤",
      "- run checks",
    ].join("\n")

    expect(extractFilesFromSummary(summary)).toEqual([
      "src/ui/compact-utils.ts",
      "tests/ui/compact-utils.test.ts",
    ])
  })

  it("handles backtick-quoted paths", () => {
    const summary = "# Files read / modified\n- `src/a.ts` — note\n- `src/b.ts`\n"
    expect(extractFilesFromSummary(summary)).toEqual(["src/a.ts", "src/b.ts"])
  })

  it("handles Windows paths without truncating at the drive colon", () => {
    const summary = [
      "# Files read / modified",
      "- C:\\repo\\zap\\src\\App.tsx — inspected TUI runner",
      "- `D:\\work\\zap\\tests\\app.test.ts:12` — line reference",
    ].join("\n")

    expect(extractFilesFromSummary(summary)).toEqual([
      "C:\\repo\\zap\\src\\App.tsx",
      "D:\\work\\zap\\tests\\app.test.ts",
    ])
  })

  it("strips line suffixes from compact summary paths", () => {
    const summary = [
      "# Files read / modified",
      "- src/App.tsx:120 — hook setup",
      "- `tests/app.test.ts:7`",
    ].join("\n")

    expect(extractFilesFromSummary(summary)).toEqual([
      "src/App.tsx",
      "tests/app.test.ts",
    ])
  })

  it("accepts both - and * bullet markers, rejects others", () => {
    const summary = "# Files read / modified\n- a.ts\n* b.ts\n+ c.ts\n"
    expect(extractFilesFromSummary(summary)).toEqual(["a.ts", "b.ts"])
  })

  it("stops at the next '# ' header", () => {
    const summary = "# Files read / modified\n- a.ts\n# Other\n- b.ts\n"
    expect(extractFilesFromSummary(summary)).toEqual(["a.ts"])
  })

  it("keeps nested headings inside the files section", () => {
    const summary = [
      "## Files read / modified",
      "- src/a.ts",
      "### Generated tests",
      "- tests/a.test.ts",
      "",
      "## Next steps",
      "- not-a-file.md",
    ].join("\n")

    expect(extractFilesFromSummary(summary)).toEqual(["src/a.ts", "tests/a.test.ts"])
  })

  it("stops at a shallower heading after a nested files section", () => {
    const summary = [
      "## Files read / modified",
      "- src/a.ts",
      "# Next steps",
      "- not-a-file.md",
    ].join("\n")

    expect(extractFilesFromSummary(summary)).toEqual(["src/a.ts"])
  })
})
