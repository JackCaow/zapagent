import { describe, expect, it } from "bun:test"
import { applyDotEnv, parseDotEnv } from "../src/dotenv.js"

describe("dotenv parsing", () => {
  it("parses common dotenv forms", () => {
    const parsed = parseDotEnv([
      "# comment",
      "OPENAI_API_KEY=sk-plain",
      "export OPENAI_BASE_URL = \"https://example.test/v1\"",
      "MODEL='gpt-5 codex'",
      "SERPER_KEY=abc123 # inline comment",
      "URL_WITH_HASH=https://example.test/#section",
      "MULTILINE=\"hello\\nworld\"",
      "BAD-NAME=ignored",
      "MISSING_EQUALS",
    ].join("\n"))

    expect(parsed).toEqual({
      OPENAI_API_KEY: "sk-plain",
      OPENAI_BASE_URL: "https://example.test/v1",
      MODEL: "gpt-5 codex",
      SERPER_KEY: "abc123",
      URL_WITH_HASH: "https://example.test/#section",
      MULTILINE: "hello\nworld",
    })
  })

  it("does not overwrite existing environment values", () => {
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY: "from-shell",
    }

    const applied = applyDotEnv("OPENAI_API_KEY=from-file\nMODEL=gpt-5\n", env)

    expect(env).toEqual({
      OPENAI_API_KEY: "from-shell",
      MODEL: "gpt-5",
    })
    expect(applied).toEqual({ MODEL: "gpt-5" })
  })
})
