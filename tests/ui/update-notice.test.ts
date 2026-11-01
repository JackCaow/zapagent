import { expect, it } from "bun:test"
import { createElement } from "react"
import { renderToString } from "ink"
import { UpdateNotice } from "../../src/ui/UpdateNotice.js"
import { VERSION } from "../../src/version.js"

it("distinguishes checking, current, failed and disabled checks", () => {
  for (const [state, expected] of [
    [{ status: "checking" }, "Checking for zapAgent updates"],
    [{ status: "current", version: VERSION }, "is up to date"],
    [{ status: "error" }, "Could not check"],
    [{ status: "disabled" }, "disabled"],
  ] as const) {
    const text = renderToString(createElement(UpdateNotice, { state }))
    expect(text).toContain(expected)
    if (state.status !== "current") expect(text).not.toContain("up to date")
  }
})

it("renders the installed/new versions and the confirmation command", () => {
  const text = renderToString(createElement(UpdateNotice, { state: { status: "available", version: "9.0.0" } }), { columns: 100 })
  expect(text).toContain(`v${VERSION}`)
  expect(text).toContain("v9.0.0")
  expect(text).toContain("/update")
})
