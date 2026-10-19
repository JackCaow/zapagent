import { describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSkillIfMissing, loadSkillsFromDir } from "../../skills/loader.js"
import type { SkillDefinition } from "../../skills/types.js"

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "reviewer",
    description: "Review code",
    systemPrompt: "Review the code.",
    tools: ["read_file"],
    maxSteps: 5,
    ...overrides,
  }
}

describe("skills loader", () => {
  it("installs missing skills with owner-only permissions", () => {
    if (process.platform === "win32") return
    const dir = mkdtempSync(join(tmpdir(), "zap-skills-"))
    try {
      installSkillIfMissing(dir, makeSkill())

      const skillDir = join(dir, "reviewer")
      const skillFile = join(skillDir, "SKILL.md")
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(skillDir).mode & 0o777).toBe(0o700)
      expect(statSync(skillFile).mode & 0o777).toBe(0o600)
      expect(readFileSync(skillFile, "utf-8")).toContain('name: "reviewer"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("tightens existing skill files without overwriting user content", () => {
    if (process.platform === "win32") return
    const dir = mkdtempSync(join(tmpdir(), "zap-skills-existing-"))
    try {
      const skillDir = join(dir, "reviewer")
      const skillFile = join(skillDir, "SKILL.md")
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(skillFile, "---\nname: reviewer\n---\n\ncustom user content\n", { mode: 0o666 })
      chmodSync(dir, 0o777)
      chmodSync(skillDir, 0o777)
      chmodSync(skillFile, 0o666)

      installSkillIfMissing(dir, makeSkill({ systemPrompt: "replacement" }))

      expect(readFileSync(skillFile, "utf-8")).toContain("custom user content")
      expect(readFileSync(skillFile, "utf-8")).not.toContain("replacement")
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(skillDir).mode & 0o777).toBe(0o700)
      expect(statSync(skillFile).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("loads installed skills from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-skills-load-"))
    try {
      installSkillIfMissing(dir, makeSkill())
      const skills = loadSkillsFromDir(dir)
      expect(skills.get("reviewer")?.description).toBe("Review code")
      expect(skills.get("reviewer")?.tools).toEqual(["read_file"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("loads skills in deterministic directory-name order", () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-skills-order-"))
    try {
      writeSkill(dir, "zeta", `---
name: "zeta"
description: "Zeta"
---

Use zeta.
`)
      writeSkill(dir, "alpha", `---
name: "alpha"
description: "Alpha"
---

Use alpha.
`)

      expect(Array.from(loadSkillsFromDir(dir).keys())).toEqual(["alpha", "zeta"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("uses deterministic last-wins behavior for duplicate skill names", () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-skills-duplicate-order-"))
    try {
      writeSkill(dir, "b-source", `---
name: "same"
description: "From B"
---

Use B.
`)
      writeSkill(dir, "a-source", `---
name: "same"
description: "From A"
---

Use A.
`)

      const skills = loadSkillsFromDir(dir)

      expect(Array.from(skills.keys())).toEqual(["same"])
      expect(skills.get("same")?.description).toBe("From B")
      expect(skills.get("same")?.systemPrompt).toBe("Use B.")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves explicit zero step limits when installing skills", () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-skills-zero-limits-"))
    try {
      installSkillIfMissing(dir, makeSkill({ maxSteps: 0, reserveSteps: 0 }))

      const skill = loadSkillsFromDir(dir).get("reviewer")
      expect(skill?.maxSteps).toBe(0)
      expect(skill?.reserveSteps).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("sanitizes invalid step limits from skill frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-skills-limits-"))
    try {
      writeSkill(dir, "bad-limits", `---
name: "bad-limits"
description: "Bad limits"
max_steps: nope
reserve_steps: Infinity
---

Use bad limits.
`)
      writeSkill(dir, "negative-limits", `---
name: "negative-limits"
description: "Negative limits"
max_steps: -5
reserve_steps: -2
---

Use negative limits.
`)
      writeSkill(dir, "fractional-limits", `---
name: "fractional-limits"
description: "Fractional limits"
max_steps: 7.9
reserve_steps: 3.9
---

Use fractional limits.
`)

      const skills = loadSkillsFromDir(dir)

      expect(skills.get("bad-limits")?.maxSteps).toBe(10)
      expect(skills.get("bad-limits")?.reserveSteps).toBeUndefined()
      expect(skills.get("negative-limits")?.maxSteps).toBe(0)
      expect(skills.get("negative-limits")?.reserveSteps).toBe(0)
      expect(skills.get("fractional-limits")?.maxSteps).toBe(7)
      expect(skills.get("fractional-limits")?.reserveSteps).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function writeSkill(dir: string, name: string, content: string): void {
  const skillDir = join(dir, name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, "SKILL.md"), content)
}
