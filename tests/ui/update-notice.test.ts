import { expect, it } from "bun:test"
import { createElement } from "react"
import { renderToString } from "ink"
import { UpdateNotice } from "../../src/ui/UpdateNotice.js"
import { VERSION } from "../../src/version.js"

it("renders no banner without a newer release", () => {
  expect(renderToString(createElement(UpdateNotice, { version: null }))).toBe("")
})

it("renders the installed/new versions and the confirmation command", () => {
  const text = renderToString(createElement(UpdateNotice, { version: "9.0.0" }), { columns: 100 })
  expect(text).toContain(`v${VERSION}`)
  expect(text).toContain("v9.0.0")
  expect(text).toContain("/update")
})
