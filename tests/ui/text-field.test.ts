import { describe, expect, it } from "bun:test"
import { textFieldSubmittedValue } from "../../src/ui/text-field.js"

describe("textFieldSubmittedValue", () => {
  it("includes coalesced text before raw CR in the submitted value", () => {
    expect(textFieldSubmittedValue("", "sk-test\r")).toBe("sk-test")
  })

  it("appends coalesced text to the current field value", () => {
    expect(textFieldSubmittedValue("https://", "api.example.test/v1\r")).toBe(
      "https://api.example.test/v1",
    )
  })

  it("applies field transforms before submitting coalesced text", () => {
    expect(textFieldSubmittedValue("", "128k000\r", (raw) => raw.replace(/[^\d]/g, ""))).toBe("128000")
  })

  it("leaves the value unchanged for a bare raw CR submit", () => {
    expect(textFieldSubmittedValue("existing", "\r")).toBe("existing")
  })
})
