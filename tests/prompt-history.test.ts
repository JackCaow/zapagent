import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MAX_HISTORY_PASTED_ENTRY_BYTES,
  MAX_HISTORY_PASTED_TOTAL_BYTES,
  PASTE_HISTORY_DIRNAME,
  isDuplicatePromptHistoryEntry,
  parsePromptHistoryLines,
  readSidecarPastedContents,
  restorePromptHistoryEntry,
  sanitizeHistoryDisplayForPastes,
  sanitizeHistoryPastedContents,
  splitHistoryPastedContents,
} from "../src/ui/prompt-history.js"

describe("prompt history paste snapshots", () => {
  it("keeps small pasted contents but drops oversized blobs", async () => {
    const small = "small paste"
    const large = "x".repeat(MAX_HISTORY_PASTED_ENTRY_BYTES + 1)

    expect(sanitizeHistoryPastedContents({
      "1": small,
      "2": large,
    })).toEqual({ "1": small })
  })

  it("enforces a total pasted-content budget per history entry", async () => {
    const chunk = "x".repeat(40 * 1024)

    expect(sanitizeHistoryPastedContents({
      "1": chunk,
      "2": chunk,
      "3": chunk,
      "4": chunk,
    })).toEqual({
      "1": chunk,
      "2": chunk,
      "3": chunk,
    })
  })

  it("splits oversized pasted contents into sidecar candidates", () => {
    const small = "small paste"
    const large = "x".repeat(MAX_HISTORY_PASTED_ENTRY_BYTES + 1)

    expect(splitHistoryPastedContents({
      "1": small,
      "2": large,
    })).toEqual({
      pastedContents: { "1": small },
      sidecarPastedContents: { "2": large },
    })
  })

  it("moves overflow pastes beyond the inline total budget into sidecar candidates", () => {
    const chunk = "a".repeat(MAX_HISTORY_PASTED_TOTAL_BYTES / 4)
    const overflow = "b".repeat(2)

    expect(splitHistoryPastedContents({
      "1": chunk,
      "2": chunk,
      "3": chunk,
      "4": chunk,
      "5": overflow,
    })).toEqual({
      pastedContents: {
        "1": chunk,
        "2": chunk,
        "3": chunk,
        "4": chunk,
      },
      sidecarPastedContents: { "5": overflow },
    })
  })

  it("omits non-canonical placeholder ids when splitting pasted contents", () => {
    const large = "x".repeat(MAX_HISTORY_PASTED_ENTRY_BYTES + 1)

    expect(splitHistoryPastedContents({
      "1": "small paste",
      "2": large,
      "0": "zero",
      "01": "leading",
      bad: "bad",
    })).toEqual({
      pastedContents: { "1": "small paste" },
      sidecarPastedContents: { "2": large },
    })
  })

  it("marks non-canonical pasted placeholders unavailable even when content exists", () => {
    expect(sanitizeHistoryDisplayForPastes(
      "[Pasted #01 · 1 lines · 12 chars] [Pasted #0 · 1 lines · 4 chars]",
      { "01": "leading zero", "0": "zero" },
      { "01": "/tmp/paste-history/leading.txt" },
    )).toBe(
      "[Pasted #01 unavailable in history; paste again to resend full text] " +
      "[Pasted #0 unavailable in history; paste again to resend full text]",
    )

    const parsed = parsePromptHistoryLines([
      JSON.stringify({
        display: "[Pasted #01 · 1 lines · 12 chars]",
        pastedContents: { "01": "leading zero" },
        pastedContentRefs: { "01": "/tmp/paste-history/leading.txt" },
        timestamp: 1,
      }),
    ])

    expect(parsed.entries[0]).toEqual({
      display: "[Pasted #01 unavailable in history; paste again to resend full text]",
      pastedContents: {},
      timestamp: 1,
    })
    expect(parsed.dirty).toBe(true)
  })

  it("skips malformed history lines instead of dropping the whole history", () => {
    const validBefore = {
      display: "before",
      pastedContents: { "1": "ok" },
      timestamp: 1,
    }
    const validAfter = {
      display: "after",
      pastedContents: {},
      timestamp: 2,
    }

    const parsed = parsePromptHistoryLines([
      JSON.stringify(validBefore),
      "{not-json",
      JSON.stringify({ pastedContents: {}, timestamp: 3 }),
      JSON.stringify(validAfter),
    ])

    expect(parsed.entries).toEqual([validBefore, validAfter])
    expect(parsed.dirty).toBe(true)
  })

  it("sanitizes invalid pasted contents and image refs from persisted entries", () => {
    const large = "x".repeat(MAX_HISTORY_PASTED_ENTRY_BYTES + 1)
    const parsed = parsePromptHistoryLines([
      JSON.stringify({
        display: "entry",
        pastedContents: { "1": "small", "2": large, "3": 42 },
        imageRefs: { "1": "/tmp/a.png", "2": null },
        timestamp: 10,
      }),
    ])

    expect(parsed.entries).toEqual([{
      display: "entry",
      pastedContents: { "1": "small" },
      imageRefs: { "1": "/tmp/a.png" },
      timestamp: 10,
    }])
    expect(parsed.dirty).toBe(true)
  })

  it("drops non-canonical placeholder ids from persisted paste and image refs", () => {
    const parsed = parsePromptHistoryLines([
      JSON.stringify({
        display: [
          "[Pasted #1 · 1 lines · 5 chars]",
          "[Pasted #2 · 1 lines · 70000 chars]",
          "[Pasted #3 · 1 lines · 70000 chars]",
          "[Image #4]",
        ].join(" "),
        pastedContents: {
          "1": "small",
          "0": "zero",
          "01": "leading",
          "1.5": "fraction",
          bad: "bad",
        },
        pastedContentRefs: {
          "2": "/tmp/paste-history/two.txt",
          "03": "/tmp/paste-history/three.txt",
          bad: "/tmp/paste-history/bad.txt",
        },
        imageRefs: {
          "4": "/tmp/image.png",
          "05": "/tmp/leading.png",
          nope: "/tmp/nope.png",
        },
        timestamp: 10,
      }),
    ])

    expect(parsed.entries[0]).toEqual({
      display: [
        "[Pasted #1 · 1 lines · 5 chars]",
        "[Pasted #2 · 1 lines · 70000 chars]",
        "[Pasted #3 unavailable in history; paste again to resend full text]",
        "[Image #4]",
      ].join(" "),
      pastedContents: { "1": "small" },
      pastedContentRefs: { "2": "/tmp/paste-history/two.txt" },
      imageRefs: { "4": "/tmp/image.png" },
      timestamp: 10,
    })
    expect(parsed.dirty).toBe(true)
  })

  it("ignores sidecar refs with non-canonical placeholder ids", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-prompt-history-"))
    try {
      const pasteHistoryDir = join(dataDir, PASTE_HISTORY_DIRNAME)
      mkdirSync(pasteHistoryDir, { recursive: true })
      const sidecar = join(pasteHistoryDir, "manual.txt")
      writeFileSync(sidecar, "large pasted body")

      expect(readSidecarPastedContents(dataDir, {
        "1": sidecar,
        "0": sidecar,
        "01": sidecar,
        bad: sidecar,
      })).toEqual({ "1": "large pasted body" })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("marks content-addressed sidecar pastes unavailable when the file content changed", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-prompt-history-"))
    try {
      const pasteHistoryDir = join(dataDir, PASTE_HISTORY_DIRNAME)
      mkdirSync(pasteHistoryDir, { recursive: true })
      const original = "large pasted body"
      const hash = createHash("sha256").update(original).digest("hex")
      const sidecar = join(pasteHistoryDir, `${hash}.txt`)
      writeFileSync(sidecar, "different pasted body")

      const restored = restorePromptHistoryEntry(dataDir, {
        display: "before [Pasted #1 · 1 lines · 17 chars] after",
        pastedContents: {},
        pastedContentRefs: { "1": sidecar },
        timestamp: 1,
      })

      expect(restored.pastedContents).toEqual({})
      expect(restored.display).toBe(
        "before [Pasted #1 unavailable in history; paste again to resend full text] after",
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("keeps pasted placeholders when their content is still available", () => {
    expect(sanitizeHistoryDisplayForPastes(
      "before [Pasted #1 · 1 lines · 11 chars] after",
      { "1": "hello paste" },
    )).toBe("before [Pasted #1 · 1 lines · 11 chars] after")

    const parsed = parsePromptHistoryLines([
      JSON.stringify({
        display: "before [Pasted #1 · 1 lines · 11 chars] after",
        pastedContents: { "1": "hello paste" },
        timestamp: 1,
      }),
    ])

    expect(parsed.entries[0]).toEqual({
      display: "before [Pasted #1 · 1 lines · 11 chars] after",
      pastedContents: { "1": "hello paste" },
      timestamp: 1,
    })
    expect(parsed.dirty).toBe(false)
  })

  it("normalizes stale pasted placeholder metadata from available inline content", () => {
    const restoredDisplay = sanitizeHistoryDisplayForPastes(
      "before [Pasted #1 · 1 lines · 999 chars] after",
      { "1": "first\rsecond\rthird" },
    )

    expect(restoredDisplay).toBe("before [Pasted #1 · 3 lines · 18 chars] after")

    const parsed = parsePromptHistoryLines([
      JSON.stringify({
        display: "before [Pasted #1 · 1 lines · 999 chars] after",
        pastedContents: { "1": "first\rsecond\rthird" },
        timestamp: 1,
      }),
    ])

    expect(parsed.entries[0]).toEqual({
      display: "before [Pasted #1 · 3 lines · 18 chars] after",
      pastedContents: { "1": "first\rsecond\rthird" },
      timestamp: 1,
    })
    expect(parsed.dirty).toBe(true)
  })

  it("normalizes pasted placeholder char metadata by code point", () => {
    const restoredDisplay = sanitizeHistoryDisplayForPastes(
      "before [Pasted #1 · 1 lines · 999 chars] after",
      { "1": "a😀b" },
    )

    expect("a😀b".length).toBe(4)
    expect(restoredDisplay).toBe("before [Pasted #1 · 1 lines · 3 chars] after")
  })

  it("keeps pasted placeholders when their sidecar ref is available", () => {
    expect(sanitizeHistoryDisplayForPastes(
      "before [Pasted #1 · 1 lines · 70000 chars] after",
      {},
      { "1": "/tmp/paste-history/abc.txt" },
    )).toBe("before [Pasted #1 · 1 lines · 70000 chars] after")

    const parsed = parsePromptHistoryLines([
      JSON.stringify({
        display: "before [Pasted #1 · 1 lines · 70000 chars] after",
        pastedContents: {},
        pastedContentRefs: { "1": "/tmp/paste-history/abc.txt" },
        timestamp: 1,
      }),
    ])

    expect(parsed.entries[0]).toEqual({
      display: "before [Pasted #1 · 1 lines · 70000 chars] after",
      pastedContents: {},
      pastedContentRefs: { "1": "/tmp/paste-history/abc.txt" },
      timestamp: 1,
    })
    expect(parsed.dirty).toBe(false)
  })

  it("marks oversized pasted placeholders unavailable after dropping their content", () => {
    const large = "x".repeat(MAX_HISTORY_PASTED_ENTRY_BYTES + 1)
    expect(sanitizeHistoryDisplayForPastes(
      "before [Pasted #1 · 1 lines · 65537 chars] after",
      {},
    )).toBe("before [Pasted #1 unavailable in history; paste again to resend full text] after")

    const parsed = parsePromptHistoryLines([
      JSON.stringify({
        display: "before [Pasted #1 · 1 lines · 65537 chars] after",
        pastedContents: { "1": large },
        timestamp: 1,
      }),
    ])

    expect(parsed.entries[0]).toEqual({
      display: "before [Pasted #1 unavailable in history; paste again to resend full text] after",
      pastedContents: {},
      timestamp: 1,
    })
    expect(parsed.dirty).toBe(true)
  })

  it("marks pasted placeholders unavailable when old history lacks content", () => {
    const parsed = parsePromptHistoryLines([
      JSON.stringify({
        display: "[Pasted #3 · 2 lines · 20 chars]",
        pastedContents: {},
        timestamp: 1,
      }),
    ])

    expect(parsed.entries[0]).toEqual({
      display: "[Pasted #3 unavailable in history; paste again to resend full text]",
      pastedContents: {},
      timestamp: 1,
    })
    expect(parsed.dirty).toBe(true)
  })

  it("keeps only the newest valid history entries after parsing", () => {
    const parsed = parsePromptHistoryLines(
      [
        JSON.stringify({ display: "old", pastedContents: {}, timestamp: 1 }),
        JSON.stringify({ display: "new", pastedContents: {}, timestamp: 2 }),
      ],
      1,
    )

    expect(parsed.entries.map(e => e.display)).toEqual(["new"])
    expect(parsed.dirty).toBe(true)
  })

  it("does not treat identical pasted placeholders with different contents as duplicate history", () => {
    const display = "[Pasted #1 · 2 lines · 22 chars]"
    const previous = {
      display,
      pastedContents: { "1": "first line\nsecond line" },
      timestamp: 1,
    }
    const next = {
      display,
      pastedContents: { "1": "alpha line\nbravo line" },
      timestamp: 2,
    }

    expect(isDuplicatePromptHistoryEntry(previous, next)).toBe(false)
  })

  it("treats identical display, paste snapshots, and image refs as duplicate history", () => {
    const previous = {
      display: "describe [Pasted #1 · 1 lines · 11 chars] [Image #2]",
      pastedContents: { "1": "hello paste" },
      imageRefs: { "2": "/tmp/a.png" },
      timestamp: 1,
    }
    const next = {
      display: "describe [Pasted #1 · 1 lines · 11 chars] [Image #2]",
      pastedContents: { "1": "hello paste" },
      imageRefs: { "2": "/tmp/a.png" },
      timestamp: 2,
    }

    expect(isDuplicatePromptHistoryEntry(previous, next)).toBe(true)
  })

  it("does not treat identical display with different image refs as duplicate history", () => {
    const previous = {
      display: "describe [Image #1]",
      pastedContents: {},
      imageRefs: { "1": "/tmp/a.png" },
      timestamp: 1,
    }
    const next = {
      display: "describe [Image #1]",
      pastedContents: {},
      imageRefs: { "1": "/tmp/b.png" },
      timestamp: 2,
    }

    expect(isDuplicatePromptHistoryEntry(previous, next)).toBe(false)
  })

  it("does not treat identical display with different pasted sidecar refs as duplicate history", () => {
    const previous = {
      display: "describe [Pasted #1 · 1 lines · 70000 chars]",
      pastedContents: {},
      pastedContentRefs: { "1": "/tmp/a.txt" },
      timestamp: 1,
    }
    const next = {
      display: "describe [Pasted #1 · 1 lines · 70000 chars]",
      pastedContents: {},
      pastedContentRefs: { "1": "/tmp/b.txt" },
      timestamp: 2,
    }

    expect(isDuplicatePromptHistoryEntry(previous, next)).toBe(false)
  })
})
