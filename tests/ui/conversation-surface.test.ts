import { describe, expect, it } from "bun:test"
import { createElement } from "react"
import { Static, Text, renderToString } from "ink"
import { ConversationSurface } from "../../src/ui/conversation-surface.js"

describe("ConversationSurface", () => {
  it("keeps committed history visible above a naturally sized prompt", () => {
    const output = renderToString(createElement(
      ConversationSurface,
      null,
      createElement(Static<string>, {
        items: ["user message", "assistant reply"],
        children: (item: string) => createElement(Text, { key: item }, item),
      }),
      createElement(Text, null, "prompt"),
      createElement(Text, null, "footer"),
    ), { columns: 40 })

    const lines = output.split("\n")
    expect(lines.filter(Boolean)).toEqual(["user message", "assistant reply", "prompt", "footer"])
    expect(lines.length).toBeLessThanOrEqual(5)
  })

  it("grows past the viewport instead of clipping tall content", () => {
    const output = renderToString(createElement(
      ConversationSurface,
      null,
      createElement(Text, null, "one\ntwo\nthree\nfour"),
    ), { columns: 40 })

    expect(output.split("\n")).toEqual(["one", "two", "three", "four"])
  })
})
