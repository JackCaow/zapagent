import { describe, it, expect } from "bun:test"
import { MD_MEMORY_TYPES, isMdMemoryType, type MdFrontmatter, type MdMemoryType } from "../../zapsdk/memory/md-types"

describe("markdown memory types", () => {
  it("exposes the four CC-compatible types in stable order", () => {
    expect(MD_MEMORY_TYPES).toEqual(["user", "feedback", "project", "reference"])
  })

  it("isMdMemoryType narrows unknown strings", () => {
    expect(isMdMemoryType("user")).toBe(true)
    expect(isMdMemoryType("project")).toBe(true)
    expect(isMdMemoryType("episode")).toBe(false)
    expect(isMdMemoryType("")).toBe(false)
    expect(isMdMemoryType(undefined)).toBe(false)
  })

  it("MdFrontmatter shape compiles for a CC-style record", () => {
    const fm: MdFrontmatter = {
      name: "user_role",
      description: "senior engineer working on zapcode",
      type: "user",
    }
    const t: MdMemoryType = fm.type
    expect(t).toBe("user")
  })
})
