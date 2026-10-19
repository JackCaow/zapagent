import { expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { collectSourceUrls } from "../../src/headless/source-urls.js"

it("collects full-result URLs with credentials/query/fragment removed and a raw output hash", () => {
  const body = "prefix ".repeat(100) + "https://user:password@example.test:8080/a?token=private#f https://example.test:8080/a"
  expect(collectSourceUrls(body)).toEqual({ urls: ["https://example.test:8080/a"], complete: true, omitted: 0,
    outputSha256: createHash("sha256").update(body).digest("hex") })
})
it("bounds URL count and marks omitted occurrences rather than implying full coverage", () => {
  const audit = collectSourceUrls(Array.from({ length: 35 }, (_, i) => `https://example.test/${i}`).join(" "))
  expect(audit.urls).toHaveLength(32)
  expect(audit.complete).toBe(false)
  expect(audit.omitted).toBe(3)
})
it("marks oversized and malformed URLs incomplete while retaining later valid sources", () => {
  const audit = collectSourceUrls(`https://[bad]/ https://example.test/${"x".repeat(3000)} https://example.test/valid`)
  expect(audit.urls).toEqual(["https://example.test/valid"])
  expect(audit.complete).toBe(false)
  expect(audit.omitted).toBe(2)
})
it("does not serialize query-only secrets or invent URLs for ordinary text", () => {
  expect(collectSourceUrls("plain output").urls).toEqual([])
  const audit = collectSourceUrls(`https://example.test/docs?token=${"secret".repeat(1000)}`)
  expect(audit.urls).toEqual(["https://example.test/docs"])
  expect(audit.complete).toBe(true)
})
