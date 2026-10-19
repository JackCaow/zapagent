import { describe, expect, it } from "bun:test"
import {
  blockedPastedInputLabels,
  buildDispatchText,
  buildMCPPromptQueuedCommand,
  buildPromptHistorySnapshot,
  buildSubmitInputText,
  clearConsumedInputArtifacts,
  compactQueuedCommandPreview,
  filterPendingImagesForSubmit,
  isManualCompactCommand,
  mergeQueuedCommandDisplayText,
  mergeQueuedCommandMemoryQueryText,
  mergeQueuedCommandRestoreText,
  mergeQueuedCommandText,
  missingPastedPlaceholderIds,
  parseMCPPromptSubmitInvocation,
  resolveSlashSubmitValue,
  unknownCommandPreview,
  unavailablePastedHistoryLabels,
} from "../../src/hooks/useTurnDispatcher.js"
import {
  filePaletteReturnPrefixValue,
  inputWithReturnPrefix,
} from "../../src/hooks/useKeyboardShortcuts.js"
import type { PendingImage } from "../../src/queue/inputQueue.js"
import {
  buildModelText,
  buildSubmittedTextParts,
  stripImagePlaceholders,
} from "../../src/commands/submit.js"
import { sessionLogsToTurns } from "../../src/session.js"

describe("turn dispatcher text assembly", () => {
  it("recognizes only the standalone manual compact command", () => {
    expect(isManualCompactCommand("/compact")).toBe(true)
    expect(isManualCompactCommand("  /COMPACT  ")).toBe(true)
    expect(isManualCompactCommand("/compact now")).toBe(false)
    expect(isManualCompactCommand("compact")).toBe(false)
  })

  it("preserves one long Unicode paste through submit, queue merge, and session restore", () => {
    const placeholder = "[Pasted #1 · 5 lines · 70030 chars]"
    const paste = `\nLONG_HEAD\r\n  ${"界🧪".repeat(35_000)}\rline [Image #2] is literal\nLONG_TAIL\n`
    const raw = `inspect [Image #1]\n${placeholder}\nfinish`
    const expandPastes = (value: string) => value.replace(placeholder, paste)
    const parts = buildSubmittedTextParts(raw, expandPastes)
    const withoutActiveImage = stripImagePlaceholders(raw, [1])
    const expanded = expandPastes(withoutActiveImage)
    const userVisibleModelText = buildModelText(expanded, [], { stripImagePlaceholders: false })
    const modelText = buildModelText(expanded, [
      '<file_content path="fixture.txt">model-only</file_content>',
    ], { stripImagePlaceholders: false })
    const command = {
      text: modelText,
      displayForm: parts.displayForm,
      restoreText: userVisibleModelText,
      pastedContents: { "1": paste },
    }

    const mergedModelText = mergeQueuedCommandText([command])
    const mergedDisplayText = mergeQueuedCommandDisplayText([command])
    const mergedRestoreText = mergeQueuedCommandRestoreText([command])
    const restoredTurns = sessionLogsToTurns([{
      type: "user",
      text: mergedDisplayText,
      restoreText: mergedRestoreText,
    }])

    expect(parts.modelInput).toBe(`inspect [Image #1]\n${paste}\nfinish`)
    expect(mergedModelText).toContain(paste)
    expect(mergedModelText).toContain("model-only")
    expect(mergedRestoreText).toBe(userVisibleModelText)
    expect(mergedRestoreText).not.toContain("model-only")
    expect(mergedRestoreText).toContain("line [Image #2] is literal")
    expect(restoredTurns).toEqual([{ kind: "user", content: userVisibleModelText }])
    expect(mergeQueuedCommandMemoryQueryText([command])).toBe(parts.displayForm)
    expect(mergeQueuedCommandMemoryQueryText([command])).not.toContain("LONG_HEAD")
  })

  it("preserves queued model text whitespace when merging a batch", () => {
    const merged = mergeQueuedCommandText([
      { text: "\n  first block\n", displayForm: "first" },
      { text: "  second block\n\n", displayForm: "second" },
    ])

    expect(merged).toBe("\n  first block\n\n\n  second block\n\n")
  })

  it("merges queued display text separately from model text", () => {
    const merged = mergeQueuedCommandDisplayText([
      { text: "first\n\n<file_content path=\"a.ts\">x</file_content>", displayForm: "first @a.ts" },
      { text: "second", displayForm: "second" },
    ])

    expect(merged).toBe("first @a.ts\n\nsecond")
  })

  it("uses compact display text for memory query hints instead of expanded pasted model text", () => {
    const memoryQueryText = mergeQueuedCommandMemoryQueryText([
      {
        text: `review cache behavior\n${"full pasted body ".repeat(300)}\nthen continue`,
        displayForm: "review cache behavior\n[Pasted #1 · 1 lines · 5100 chars]\nthen continue",
        restoreText: `review cache behavior\n${"full pasted body ".repeat(300)}\nthen continue`,
      },
    ])

    expect(memoryQueryText).toBe("review cache behavior\n[Pasted #1 · 1 lines · 5100 chars]\nthen continue")
    expect(memoryQueryText).not.toContain("full pasted body")
  })

  it("uses compact display text for unknown slash command previews", () => {
    const fullPaste = "full pasted body ".repeat(300)
    const preview = unknownCommandPreview({
      text: `/unknown ${fullPaste}`,
      displayForm: "/unknown [Pasted #1 · 1 lines · 5100 chars]",
    })

    expect(preview).toBe("/unknown [Pasted #1 · 1 lines · 5100 chars]")
    expect(preview).not.toContain("full pasted body")
  })

  it("caps unknown command previews to keep system error rows compact", () => {
    const preview = unknownCommandPreview({
      text: `/unknown ${"x".repeat(300)}`,
      displayForm: `/unknown ${"x".repeat(300)}`,
    })

    expect(preview.length).toBe(160)
    expect(preview.endsWith("...")).toBe(true)
  })

  it("does not cap queued previews when only UTF-16 code units exceed the limit", () => {
    const display = `/unknown ${"😀".repeat(80)}`
    const preview = compactQueuedCommandPreview({
      text: display,
      displayForm: display,
    }, 90)

    expect(preview).toBe(display)
  })

  it("does not split non-BMP characters when capping queued previews", () => {
    const preview = compactQueuedCommandPreview({
      text: `/unknown ${"😀".repeat(20)}`,
      displayForm: `/unknown ${"😀".repeat(20)}`,
    }, 18)

    expect(preview).toBe(`/unknown ${"😀".repeat(6)}...`)
    expect(hasUnpairedSurrogate(preview)).toBe(false)
  })

  it("uses compact display text for provider-unavailable dropped queued turns", () => {
    const preview = compactQueuedCommandPreview({
      text: `review ${"full pasted body ".repeat(300)}`,
      displayForm: "review [Pasted #1 · 1 lines · 5100 chars]",
    }, 80)

    expect(preview).toBe("review [Pasted #1 · 1 lines · 5100 chars]")
    expect(preview).not.toContain("full pasted body")
  })

  it("does not restore implicit model-only context blocks by default", () => {
    const restore = mergeQueuedCommandRestoreText([
      {
        text: "inspect @a.ts\n\n<file_content path=\"a.ts\">secret</file_content>",
        displayForm: "inspect @a.ts",
      },
    ])

    expect(restore).toBeUndefined()
  })

  it("restores expanded pasted text without file or MCP context blocks", () => {
    const restore = mergeQueuedCommandRestoreText([
      {
        text: "inspect @a.ts\nfull pasted text\n\n<file_content path=\"a.ts\">secret</file_content>",
        displayForm: "inspect @a.ts\n[Pasted #1 · 1 lines · 16 chars]",
        restoreText: "inspect @a.ts\nfull pasted text",
      },
    ])

    expect(restore).toBe("inspect @a.ts\nfull pasted text")
    expect(restore).not.toContain("<file_content")
  })

  it("keeps non-restored batch entries visible when another entry needs restore text", () => {
    const restore = mergeQueuedCommandRestoreText([
      {
        text: "full pasted text",
        displayForm: "[Pasted #1 · 1 lines · 16 chars]",
        restoreText: "full pasted text",
      },
      {
        text: "inspect @a.ts\n\n<file_content path=\"a.ts\">secret</file_content>",
        displayForm: "inspect @a.ts",
      },
    ])

    expect(restore).toBe("full pasted text\n\ninspect @a.ts")
  })

  it("does not replace meaningful whitespace-wrapped text with the image carrier", () => {
    expect(buildDispatchText("\n  describe this\n", true)).toBe("\n  describe this\n")
  })

  it("uses an image carrier only when the merged text is blank", () => {
    expect(buildDispatchText("", true)).toBe("(image attached)")
    expect(buildDispatchText("  \n", true)).toBe("(image attached)")
    expect(buildDispatchText("", false)).toBe("")
  })

  it("expands paste placeholders for slash command routing", () => {
    const value = "/run [Pasted #1 · 2 lines · 20 chars]"
    const modelInput = "/run first line\nsecond line"
    const routed = buildSubmitInputText(value, modelInput, true, (input) =>
      input.replace("[Pasted #1 · 2 lines · 20 chars]", "first line\nsecond line"),
    )

    expect(routed).toBe("/run first line\nsecond line")
  })

  it("expands pasted MCP prompt arguments before rendering the prompt", () => {
    const value = '/mcp.docs.summarize text="[Pasted #1 · 2 lines · 22 chars]"'
    const modelInput = '/mcp.docs.summarize text="first line\nsecond line"'
    const invocation = parseMCPPromptSubmitInvocation(value, modelInput, (input) =>
      input.replace("[Pasted #1 · 2 lines · 22 chars]", "first line\nsecond line"),
    )

    expect(invocation).toEqual({
      server: "docs",
      name: "summarize",
      args: { text: "first line\nsecond line" },
    })
  })

  it("keeps quotes inside pasted MCP prompt arguments intact", () => {
    const value = '/mcp.docs.summarize text="[Pasted #1 · 2 lines · 34 chars]"'
    const pasted = 'first "quoted" line\nsecond line'
    const modelInput = `/mcp.docs.summarize text="${pasted}"`
    const invocation = parseMCPPromptSubmitInvocation(value, modelInput, (input) =>
      input.replace("[Pasted #1 · 2 lines · 34 chars]", pasted),
    )

    expect(invocation).toEqual({
      server: "docs",
      name: "summarize",
      args: { text: pasted },
    })
  })

  it("treats unquoted pasted MCP prompt placeholders as one argument", () => {
    const value = "/mcp.docs.summarize text=[Pasted #1 · 2 lines · 34 chars] mode=fast"
    const pasted = "first line\nsecond line"
    const invocation = parseMCPPromptSubmitInvocation(value, `/mcp.docs.summarize text=${pasted} mode=fast`, (input) =>
      input.replace("[Pasted #1 · 2 lines · 34 chars]", pasted),
    )

    expect(invocation).toEqual({
      server: "docs",
      name: "summarize",
      args: {
        text: pasted,
        mode: "fast",
      },
    })
  })

  it("keeps unquoted pasted MCP prompt placeholders embedded in an argument", () => {
    const value = "/mcp.docs.summarize text=prefix-[Pasted #1 · 2 lines · 34 chars]-suffix mode=fast"
    const pasted = "first line\nsecond line"
    const invocation = parseMCPPromptSubmitInvocation(value, `/mcp.docs.summarize text=prefix-${pasted}-suffix mode=fast`, (input) =>
      input.replace("[Pasted #1 · 2 lines · 34 chars]", pasted),
    )

    expect(invocation).toEqual({
      server: "docs",
      name: "summarize",
      args: {
        text: `prefix-${pasted}-suffix`,
        mode: "fast",
      },
    })
  })

  it("parses escaped and single-quoted MCP prompt arguments", () => {
    const invocation = parseMCPPromptSubmitInvocation(
      String.raw`/mcp.docs.summarize text="first \"quoted\" line" note='single quoted value'`,
      String.raw`/mcp.docs.summarize text="first \"quoted\" line" note='single quoted value'`,
      (input) => input,
    )

    expect(invocation).toEqual({
      server: "docs",
      name: "summarize",
      args: {
        text: 'first "quoted" line',
        note: "single quoted value",
      },
    })
  })

  it("keeps expanded pasted MCP prompt invocations restorable after rendering", () => {
    const image: PendingImage = {
      id: 2,
      content: {
        type: "image",
        filePath: "/tmp/prompt.png",
        mediaType: "image/png",
        source: "clipboard",
      },
    }
    const cmd = buildMCPPromptQueuedCommand(
      "server rendered prompt",
      '/mcp.docs.summarize text="[Pasted #1 · 2 lines · 22 chars]"',
      '/mcp.docs.summarize text="first line\nsecond line"',
      {
        pastedContents: { "1": "first line\nsecond line" },
        images: [image],
      },
    )

    expect(cmd).toEqual({
      text: "server rendered prompt",
      displayForm: '/mcp.docs.summarize text="[Pasted #1 · 2 lines · 22 chars]"',
      restoreText: '/mcp.docs.summarize text="first line\nsecond line"',
      pastedContents: { "1": "first line\nsecond line" },
      images: [image],
    })
  })

  it("escapes expanded pasted MCP prompt restore text so it can be resent intact", () => {
    const placeholder = "[Pasted #1 · 3 lines · 42 chars]"
    const pasted = '  first "quoted" line\npath C:\\tmp\\note.txt\nthird  '
    const cmd = buildMCPPromptQueuedCommand(
      "server rendered prompt",
      `/mcp.docs.summarize text="${placeholder}" mode=fast`,
      `/mcp.docs.summarize text="${pasted}" mode=fast`,
      {
        pastedContents: { "1": pasted },
      },
    )

    expect(cmd.restoreText).toBe(
      '/mcp.docs.summarize text="  first \\"quoted\\" line\npath C:\\\\tmp\\\\note.txt\nthird  " mode=fast',
    )

    const invocation = parseMCPPromptSubmitInvocation(
      cmd.restoreText ?? "",
      cmd.restoreText ?? "",
      (input) => input,
    )
    expect(invocation).toEqual({
      server: "docs",
      name: "summarize",
      args: {
        text: pasted,
        mode: "fast",
      },
    })
  })

  it("does not duplicate MCP prompt restore text when the display is already complete", () => {
    const cmd = buildMCPPromptQueuedCommand(
      "server rendered prompt",
      "/mcp.docs.summarize text=short",
      "/mcp.docs.summarize text=short",
    )

    expect(cmd).toEqual({
      text: "server rendered prompt",
      displayForm: "/mcp.docs.summarize text=short",
    })
  })

  it("builds history snapshots for MCP prompt submissions with pasted text and image refs", () => {
    const pasteStoreRef = {
      current: new Map([
        [1, "first pasted body"],
        [2, "second pasted body"],
      ]),
    }
    const pendingImages: PendingImage[] = [
      {
        id: 3,
        content: {
          type: "image",
          filePath: "/tmp/diagram.png",
          mediaType: "image/png",
          source: "clipboard",
        },
      },
      {
        id: 4,
        content: {
          type: "image",
          filePath: "",
          base64: "abc",
          mediaType: "image/png",
          source: "inline",
        },
      },
    ]

    expect(buildPromptHistorySnapshot(pasteStoreRef, pendingImages)).toEqual({
      pastedContentsSnapshot: {
        "1": "first pasted body",
        "2": "second pasted body",
      },
      imageRefs: {
        "3": "/tmp/diagram.png",
      },
    })
  })

  it("filters stale pasted contents that are no longer referenced by the submitted text", () => {
    const pasteStoreRef = {
      current: new Map([
        [1, "visible pasted body"],
        [2, "deleted pasted body"],
      ]),
    }
    const pendingImages: PendingImage[] = []

    expect(
      buildPromptHistorySnapshot(
        pasteStoreRef,
        pendingImages,
        "use [Pasted #1 · 1 lines · 19 chars]",
      ),
    ).toEqual({
      pastedContentsSnapshot: {
        "1": "visible pasted body",
      },
      imageRefs: {},
    })
  })

  it("ignores non-canonical pasted placeholders when building history snapshots", () => {
    const pasteStoreRef = {
      current: new Map([
        [1, "visible pasted body"],
      ]),
    }

    expect(
      buildPromptHistorySnapshot(
        pasteStoreRef,
        [],
        "use [Pasted #01 · 1 lines · 19 chars]",
      ),
    ).toEqual({
      pastedContentsSnapshot: {},
      imageRefs: {},
    })
  })

  it("detects pasted placeholders whose original content is unavailable", () => {
    expect(
      missingPastedPlaceholderIds(
        "use [Pasted #1 · 1 lines · 19 chars] and [Pasted #2 · 1 lines · 12 chars]",
        new Map([[2, "available body"]]),
      ),
    ).toEqual([1])
  })

  it("deduplicates missing pasted placeholder ids", () => {
    expect(
      missingPastedPlaceholderIds(
        "[Pasted #1 · 1 lines · 19 chars]\n[Pasted #1 · 1 lines · 19 chars]",
        new Map(),
      ),
    ).toEqual([1])
  })

  it("does not treat unavailable-history notices as canonical pasted placeholders", () => {
    expect(
      missingPastedPlaceholderIds(
        "use [Pasted #1 unavailable in history; paste again to resend full text]",
        new Map(),
      ),
    ).toEqual([])
  })

  it("detects unavailable pasted history notices before submit", () => {
    expect(
      unavailablePastedHistoryLabels(
        "use [Pasted #1 unavailable in history; paste again to resend full text] and " +
        "[Pasted #01 unavailable in history; paste again to resend full text]",
      ),
    ).toEqual(["#1", "#01"])
  })

  it("deduplicates unavailable pasted history notices before submit", () => {
    expect(
      unavailablePastedHistoryLabels(
        "[Pasted #3 unavailable in history; paste again to resend full text]\n" +
        "[Pasted #3 unavailable in history; paste again to resend full text]",
      ),
    ).toEqual(["#3"])
  })

  it("combines missing canonical placeholders and unavailable history notices", () => {
    expect(
      blockedPastedInputLabels(
        "use [Pasted #1 · 1 lines · 19 chars] " +
        "[Pasted #2 unavailable in history; paste again to resend full text] " +
        "[Pasted #1 unavailable in history; paste again to resend full text]",
        new Map(),
      ),
    ).toEqual(["#1", "#2"])
  })

  it("ignores non-canonical pasted placeholder ids when checking availability", () => {
    expect(
      missingPastedPlaceholderIds(
        "use [Pasted #01 · 1 lines · 19 chars]",
        new Map(),
      ),
    ).toEqual([])
  })

  it("filters stale image refs that are no longer referenced by the submitted text", () => {
    const pasteStoreRef = { current: new Map<number, string>() }
    const pendingImages: PendingImage[] = [
      {
        id: 1,
        content: {
          type: "image",
          filePath: "/tmp/visible.png",
          mediaType: "image/png",
          source: "clipboard",
        },
      },
      {
        id: 2,
        content: {
          type: "image",
          filePath: "/tmp/deleted.png",
          mediaType: "image/png",
          source: "clipboard",
        },
      },
    ]

    expect(
      buildPromptHistorySnapshot(
        pasteStoreRef,
        pendingImages,
        "describe [Image #1]",
      ),
    ).toEqual({
      pastedContentsSnapshot: {},
      imageRefs: {
        "1": "/tmp/visible.png",
      },
    })
  })

  it("ignores non-canonical image placeholders when filtering image refs", () => {
    const pasteStoreRef = { current: new Map<number, string>() }
    const pendingImages: PendingImage[] = [
      {
        id: 1,
        content: {
          type: "image",
          filePath: "/tmp/visible.png",
          mediaType: "image/png",
          source: "clipboard",
        },
      },
    ]

    expect(
      buildPromptHistorySnapshot(
        pasteStoreRef,
        pendingImages,
        "describe [Image #01]",
      ),
    ).toEqual({
      pastedContentsSnapshot: {},
      imageRefs: {},
    })
  })

  it("keeps legacy all-paste snapshot behavior when no submitted text is provided", () => {
    const pasteStoreRef = {
      current: new Map([
        [1, "first pasted body"],
        [2, "second pasted body"],
      ]),
    }

    expect(buildPromptHistorySnapshot(pasteStoreRef, [])).toEqual({
      pastedContentsSnapshot: {
        "1": "first pasted body",
        "2": "second pasted body",
      },
      imageRefs: {},
    })
  })

  it("keeps legacy all-image snapshot behavior when no submitted text is provided", () => {
    const pasteStoreRef = { current: new Map<number, string>() }
    const pendingImages: PendingImage[] = [
      {
        id: 1,
        content: {
          type: "image",
          filePath: "/tmp/first.png",
          mediaType: "image/png",
          source: "clipboard",
        },
      },
      {
        id: 2,
        content: {
          type: "image",
          filePath: "/tmp/second.png",
          mediaType: "image/png",
          source: "clipboard",
        },
      },
    ]

    expect(buildPromptHistorySnapshot(pasteStoreRef, pendingImages)).toEqual({
      pastedContentsSnapshot: {},
      imageRefs: {
        "1": "/tmp/first.png",
        "2": "/tmp/second.png",
      },
    })
  })

  it("filters pending images to the placeholders still visible at submit time", () => {
    const images: PendingImage[] = [
      {
        id: 1,
        content: {
          type: "image",
          filePath: "/tmp/visible.png",
          mediaType: "image/png",
          source: "clipboard",
        },
      },
      {
        id: 2,
        content: {
          type: "image",
          filePath: "/tmp/stale.png",
          mediaType: "image/png",
          source: "clipboard",
        },
      },
    ]

    expect(filterPendingImagesForSubmit(images, "look [Image #1]")).toEqual([images[0]])
    expect(filterPendingImagesForSubmit(images, "look only")).toEqual([])
    expect(filterPendingImagesForSubmit(images)).toBe(images)
  })

  it("keeps non-command submit text as the already-expanded model input", () => {
    const routed = buildSubmitInputText(
      "[Pasted #1 · 1 lines · 11 chars]",
      "hello world",
      false,
      () => "should not be used",
    )

    expect(routed).toBe("hello world")
  })

  it("submits an exact slash command instead of rewriting it", () => {
    expect(resolveSlashSubmitValue("/status", "/status")).toBe("/status")
  })

  it("preserves arguments for an exact slash command", () => {
    expect(resolveSlashSubmitValue("/mode bypass", "/mode")).toBe("/mode bypass")
  })

  it("expands a typed slash prefix to the highlighted command", () => {
    expect(resolveSlashSubmitValue("/sta", "/status")).toBe("/status")
  })

  it("leaves slash input unchanged when no command is selected", () => {
    expect(resolveSlashSubmitValue("/sta", undefined)).toBe("/sta")
  })

  it("includes coalesced slash text before raw return", () => {
    const value = inputWithReturnPrefix("/", "status\r", {})
    expect(resolveSlashSubmitValue(value, "/status")).toBe("/status")
  })

  it("leaves slash state unchanged for a bare return", () => {
    expect(inputWithReturnPrefix("/sta", "\r", {})).toBe("/sta")
  })

  it("defers file palette confirmation when raw return includes coalesced query text", () => {
    expect(filePaletteReturnPrefixValue("@", "src/App.tsx\r", {})).toBe("@src/App.tsx")
  })

  it("does not defer file palette confirmation on bare return", () => {
    expect(filePaletteReturnPrefixValue("@src", "\r", {})).toBeNull()
  })

  it("does not defer file palette confirmation for non-return input", () => {
    expect(filePaletteReturnPrefixValue("@", "src/App.tsx", {})).toBeNull()
  })

  it("clears consumed paste and image state after submit", () => {
    const pasteStoreRef = { current: new Map([[1, "full pasted text"]]) }
    const pasteCounterRef = { current: 3 }
    const imageCounterRef = { current: 9 }
    let pendingImages: PendingImage[] = [
      {
        id: 8,
        content: {
          type: "image",
          filePath: "/tmp/image.png",
          mediaType: "image/png",
          source: "clipboard",
        },
      },
    ]

    clearConsumedInputArtifacts(pasteStoreRef, pasteCounterRef, (next) => {
      pendingImages = typeof next === "function" ? next(pendingImages) : next
    })

    expect([...pasteStoreRef.current]).toEqual([])
    expect(pasteCounterRef.current).toBe(0)
    expect(pendingImages).toEqual([])
    expect(imageCounterRef.current).toBe(9)
  })
})

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}
