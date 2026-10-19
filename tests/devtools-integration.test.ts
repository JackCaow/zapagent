import { describe, expect, it } from "bun:test"
import { shouldCaptureDevtoolsHttp } from "../src/devtools-integration.js"

describe("devtools HTTP capture filtering", () => {
  it("skips requests to the devtools server itself", () => {
    const devtoolsUrl = "http://127.0.0.1:9229/?token=t"

    expect(shouldCaptureDevtoolsHttp("http://127.0.0.1:9229/snapshot", devtoolsUrl)).toBe(false)
    expect(shouldCaptureDevtoolsHttp("ws://127.0.0.1:9229/ws?token=t", devtoolsUrl)).toBe(false)
    expect(shouldCaptureDevtoolsHttp("http://localhost:9229/snapshot", devtoolsUrl)).toBe(false)
  })

  it("keeps other localhost provider traffic visible", () => {
    const devtoolsUrl = "http://127.0.0.1:9229/?token=t"

    expect(shouldCaptureDevtoolsHttp("http://127.0.0.1:11434/v1/chat/completions", devtoolsUrl)).toBe(true)
    expect(shouldCaptureDevtoolsHttp("http://localhost:3000/v1/chat/completions", devtoolsUrl)).toBe(true)
  })

  it("keeps non-localhost HTTP traffic visible", () => {
    const devtoolsUrl = "http://127.0.0.1:9229/?token=t"

    expect(shouldCaptureDevtoolsHttp("https://api.openai.com/v1/responses", devtoolsUrl)).toBe(true)
  })
})
