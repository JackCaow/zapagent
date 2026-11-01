import { expect, it } from "bun:test"
import { createElement } from "react"
import { renderToString } from "ink"
import { UpdateNotice } from "../../src/ui/UpdateNotice.js"
import { VERSION } from "../../src/version.js"

it("keeps non-actionable automatic check states out of the terminal input area", () => {
  for (const state of [
    { status: "checking" },
    { status: "current", version: VERSION },
    { status: "error" },
    { status: "disabled" },
    { status: "idle" },
  ] as const) {
    const text = renderToString(createElement(UpdateNotice, { state }))
    expect(text).toBe("")
  }
})

it("renders the installed/new versions and the confirmation command", () => {
  const text = renderToString(createElement(UpdateNotice, { state: { status: "available", version: "9.0.0" } }), { columns: 100 })
  expect(text).toContain(`v${VERSION}`)
  expect(text).toContain("v9.0.0")
  expect(text).toContain("/update")
})
