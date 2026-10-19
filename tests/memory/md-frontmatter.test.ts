import { describe, it, expect } from "bun:test"
import { parseMdFile, serializeMdFile } from "../../zapsdk/memory/md-frontmatter"

describe("parseMdFile", () => {
  it("parses frontmatter + body", () => {
    const src = "---\nname: foo\ndescription: a thing\ntype: user\n---\n\nbody line 1\nbody line 2\n"
    const r = parseMdFile(src)
    expect(r).not.toBeNull()
    expect(r!.frontmatter).toEqual({ name: "foo", description: "a thing", type: "user" })
    expect(r!.body).toBe("body line 1\nbody line 2\n")
  })

  it("parses CRLF frontmatter files", () => {
    const src = "---\r\nname: foo\r\ndescription: from windows\r\ntype: project\r\n---\r\n\r\nbody line 1\r\nbody line 2\r\n"
    const r = parseMdFile(src)
    expect(r).not.toBeNull()
    expect(r!.frontmatter).toEqual({ name: "foo", description: "from windows", type: "project" })
    expect(r!.body).toBe("body line 1\nbody line 2\n")
  })

  it("returns null when no frontmatter delimiter", () => {
    expect(parseMdFile("just body, no frontmatter\n")).toBeNull()
  })

  it("returns null when type is invalid", () => {
    const src = "---\nname: foo\ndescription: x\ntype: bogus\n---\n\nbody\n"
    expect(parseMdFile(src)).toBeNull()
  })

  it("does not treat delimiter prefixes as a closing frontmatter line", () => {
    const src = "---\nname: foo\ndescription: x\ntype: user\n---not-a-delimiter\nbody\n"
    expect(parseMdFile(src)).toBeNull()
  })

  it("accepts a closing delimiter at end of file", () => {
    const src = "---\nname: foo\ndescription: x\ntype: user\n---"
    const r = parseMdFile(src)
    expect(r?.frontmatter.name).toBe("foo")
    expect(r?.body).toBe("")
  })

  it("tolerates extra unknown frontmatter keys (preserves required ones)", () => {
    const src = "---\nname: foo\ndescription: x\ntype: user\nlegacy_field: keep\n---\n\nbody\n"
    const r = parseMdFile(src)
    expect(r).not.toBeNull()
    expect(r!.frontmatter.name).toBe("foo")
  })

  it("decodes JSON-quoted descriptions (colon-bearing)", () => {
    const src = '---\nname: foo\ndescription: "tool: bash; args: cmd"\ntype: user\n---\n\nbody\n'
    const r = parseMdFile(src)
    expect(r!.frontmatter.description).toBe("tool: bash; args: cmd")
  })

  it("parses optional metadata fields", () => {
    const src = [
      "---",
      "name: cache_notes",
      "description: cache hit investigation",
      "type: project",
      'tags: ["cache","agent","cache"]',
      "source: user feedback",
      "createdAt: 2026-06-28T01:02:03.000Z",
      "updatedAt: 2026-06-28T02:03:04.000Z",
      "---",
      "",
      "body\n",
    ].join("\n")
    const r = parseMdFile(src)
    expect(r?.frontmatter.tags).toEqual(["agent", "cache"])
    expect(r?.frontmatter.source).toBe("user feedback")
    expect(r?.frontmatter.createdAt).toBe("2026-06-28T01:02:03.000Z")
    expect(r?.frontmatter.updatedAt).toBe("2026-06-28T02:03:04.000Z")
  })

  it("ignores malformed optional provenance without rejecting the memory", () => {
    const src = "---\nname: manual\ndescription: manual memory\ntype: project\nprovenance: not-json\n---\n\nbody\n"

    const result = parseMdFile(src)

    expect(result?.frontmatter).toEqual({
      name: "manual",
      description: "manual memory",
      type: "project",
    })
  })

  it("marks malformed lifecycle metadata so recall fails closed", () => {
    const src = "---\nname: manual\ndescription: manual memory\ntype: project\nlifecycle: not-json\n---\n\nbody\n"

    const result = parseMdFile(src)

    expect(result?.frontmatter).toEqual({
      name: "manual",
      description: "manual memory",
      type: "project",
      lifecycleInvalid: true,
      lifecycleRaw: "not-json",
    })
  })

  it("canonicalizes comma-separated tags from manually authored files", () => {
    const src = [
      "---",
      "name: manual",
      "description: manually authored",
      "type: project",
      "tags: Provider, cache, agent, CACHE",
      "---",
      "",
      "body\n",
    ].join("\n")

    const r = parseMdFile(src)

    expect(r?.frontmatter.tags).toEqual(["agent", "cache", "provider"])
  })
})

describe("serializeMdFile", () => {
  it("round-trips through parse", () => {
    const fm = { name: "ex", description: "d", type: "feedback" as const }
    const body = "rule.\n\n**Why:** because.\n\n**How to apply:** when X.\n"
    const text = serializeMdFile(fm, body)
    const back = parseMdFile(text)
    expect(back!.frontmatter).toEqual(fm)
    expect(back!.body).toBe(body)
  })

  it("quotes a description that contains a colon", () => {
    const fm = { name: "ex", description: "tool: bash; args: cmd", type: "user" as const }
    const text = serializeMdFile(fm, "body\n")
    expect(text).toContain('description: "tool: bash; args: cmd"')
    const back = parseMdFile(text)
    expect(back!.frontmatter.description).toBe(fm.description)
  })

  it("quotes multiline scalar fields so they round-trip without truncation", () => {
    const fm = {
      name: "ex",
      description: "first line\nsecond line",
      type: "reference" as const,
      source: "issue note\nuser follow-up",
    }

    const text = serializeMdFile(fm, "body\n")

    expect(text).toContain('description: "first line\\nsecond line"')
    expect(text).toContain('source: "issue note\\nuser follow-up"')
    const back = parseMdFile(text)
    expect(back!.frontmatter.description).toBe(fm.description)
    expect(back!.frontmatter.source).toBe(fm.source)
  })

  it("serializes optional metadata", () => {
    const contentHash = `sha256:${"a".repeat(64)}`
    const fm = {
      name: "cache_notes",
      description: "cache hit investigation",
      type: "project" as const,
      tags: ["agent", "cache"],
      source: "compact summary",
      lifecycle: {
        version: 1 as const,
        confidence: "medium" as const,
        validFrom: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-08-01T00:00:00.000Z",
        supersedes: ["old_cache_notes"],
      },
      provenance: {
        version: 1 as const,
        created: {
          origin: "memory_save" as const,
          sessionId: "session-1",
          toolCallId: "call-1",
          step: 2,
          contentHash,
        },
        updated: {
          origin: "memory_merge" as const,
          sessionId: "session-2",
          toolCallId: "call-2",
          step: 4,
          contentHash,
        },
      },
      createdAt: "2026-06-28T01:02:03.000Z",
      updatedAt: "2026-06-28T02:03:04.000Z",
    }
    const text = serializeMdFile(fm, "body\n")
    expect(text).toContain('tags: ["agent","cache"]')
    expect(text).toContain("source: compact summary")
    expect(text).toContain('lifecycle: {"version":1,"confidence":"medium","validFrom":"2026-07-01T00:00:00.000Z"')
    expect(text).toContain('provenance: {"version":1,"created":{"origin":"memory_save"')
    const back = parseMdFile(text)
    expect(back!.frontmatter).toEqual(fm)
  })
})
