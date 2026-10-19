import { describe, it, expect } from "bun:test"
import { buildChildEnv } from "../../mcp/env.js"

describe("buildChildEnv", () => {
  it("only passes baseline vars by default", () => {
    const out = buildChildEnv({
      hostEnv: {
        PATH: "/usr/bin",
        HOME: "/home/me",
        OPENAI_API_KEY: "sk-secret",
        ANTHROPIC_API_KEY: "ant-secret",
        SERPER_KEY: "serper-secret",
        SOMETHING_ELSE: "x",
      },
    })
    expect(out.PATH).toBe("/usr/bin")
    expect(out.HOME).toBe("/home/me")
    expect(out.OPENAI_API_KEY).toBeUndefined()
    expect(out.ANTHROPIC_API_KEY).toBeUndefined()
    expect(out.SERPER_KEY).toBeUndefined()
    expect(out.SOMETHING_ELSE).toBeUndefined()
  })

  it("forwards LC_* locale vars", () => {
    const out = buildChildEnv({
      hostEnv: { LC_ALL: "en_US.UTF-8", LC_TIME: "en_GB.UTF-8" },
    })
    expect(out.LC_ALL).toBe("en_US.UTF-8")
    expect(out.LC_TIME).toBe("en_GB.UTF-8")
  })

  it("honours opt-in passthrough", () => {
    const out = buildChildEnv({
      hostEnv: { GITHUB_TOKEN: "ghp_xxx", OPENAI_API_KEY: "sk-x" },
      passthrough: ["GITHUB_TOKEN"],
    })
    expect(out.GITHUB_TOKEN).toBe("ghp_xxx")
    // Non-listed sensitive vars must NOT leak.
    expect(out.OPENAI_API_KEY).toBeUndefined()
  })

  it("explicit overrides win over baseline / passthrough", () => {
    const out = buildChildEnv({
      hostEnv: { PATH: "/usr/bin", GITHUB_TOKEN: "from-env" },
      passthrough: ["GITHUB_TOKEN"],
      overrides: { GITHUB_TOKEN: "from-config", FOO: "bar" },
    })
    expect(out.GITHUB_TOKEN).toBe("from-config")
    expect(out.FOO).toBe("bar")
    expect(out.PATH).toBe("/usr/bin")
  })
})
