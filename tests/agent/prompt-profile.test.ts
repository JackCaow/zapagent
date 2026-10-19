import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildSystemPrompt, getDefaultConfig, loadAppConfig, saveAppConfig } from "../../src/config.js"
import { createPromptSectionDiagnostics, buildPromptCacheDiagnostics } from "../../src/agent/promptDiagnostics.js"
import { sanitizePromptCacheDiagnostics } from "../../src/agent/diagnosticSanitizers.js"
import { assemblePrompt } from "../../src/prompts/registry.js"
import { splitAtBoundary } from "../../zapsdk/core/prompt-boundary.js"

describe("prompt profiles", () => {
  it("retains authority, discovery, project and environment text while replacing only behavior guidance", () => {
    const cwd = mkdtempSync(join(tmpdir(), "zap-profile-"))
    try {
      writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_SENTINEL: preserve the existing API.")
      const build = (profile: "standard" | "concise") => {
        const diagnostics = createPromptSectionDiagnostics()
        const prompt = buildSystemPrompt({ ...getDefaultConfig(), promptProfile: profile }, cwd,
          "TOOL_CONTRACT_SENTINEL", new Set(["bash", "task_status"]),
          [{ name: "example", description: "DISCOVERY_SENTINEL", parameters: [{ name: "target", required: true }] }],
          undefined, diagnostics.record)
        return { prompt, diagnostics }
      }
      const standard = build("standard"), concise = build("concise")
      for (const sentinel of ["PROJECT_SENTINEL", "TOOL_CONTRACT_SENTINEL", "DISCOVERY_SENTINEL", "target", "Shell:", "# Safety", "# System", "Executing actions with care"]) {
        expect(concise.prompt).toContain(sentinel)
      }
      expect(concise.prompt.length).toBeLessThan(standard.prompt.length)
      expect(concise.prompt).not.toContain("Every tool call must either advance this item")
      for (const section of standard.diagnostics.sections.filter(s => s.purpose !== "behavior")) {
        expect(concise.diagnostics.sections.find(s => s.name === section.name)).toEqual(section)
      }
      expect(splitAtBoundary(concise.prompt)[1]).toBe(splitAtBoundary(standard.prompt)[1])
      const diagnostics = buildPromptCacheDiagnostics(concise.prompt, [], "concise", concise.diagnostics.sections)
      expect(sanitizePromptCacheDiagnostics(diagnostics)).toEqual(diagnostics)
      expect(JSON.stringify(diagnostics)).not.toContain("PROJECT_SENTINEL")
      expect(JSON.stringify(diagnostics)).not.toContain("DISCOVERY_SENTINEL")
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })

  it("preserves custom prompt text and support, and keeps unclassified extension sections", () => {
    const custom = "CUSTOM_SENTINEL: use my workflow."
    const prompt = buildSystemPrompt({ ...getDefaultConfig(), promptProfile: "concise", customSystemPrompt: custom },
      "/workspace", "TOOL_SENTINEL", new Set(), [{ name: "skill", description: "SKILL_SENTINEL" }])
    expect(prompt.startsWith(custom)).toBe(true)
    expect(prompt).toContain("TOOL_SENTINEL")
    expect(prompt).toContain("SKILL_SENTINEL")
    expect(prompt).toContain("# Plan state")
    expect(prompt).not.toContain("# Working on the task")
    expect(assemblePrompt({ cwd: "/workspace", enabledTools: new Set(), promptProfile: "concise" },
      [{ name: "extension", compute: () => "extension text" }])).toBe("extension text")
  })

  it("persists an explicit profile while old and unknown configs use standard", () => {
    const root = mkdtempSync(join(tmpdir(), "zap-profile-config-")), path = join(root, "config.json")
    try {
      expect(getDefaultConfig().promptProfile).toBe("standard")
      saveAppConfig(path, { ...getDefaultConfig(), promptProfile: "concise" })
      expect(loadAppConfig(path).promptProfile).toBe("concise")
      for (const value of [undefined, "unknown"]) {
        writeFileSync(path, JSON.stringify({ ...getDefaultConfig(), promptProfile: value }))
        expect(loadAppConfig(path).promptProfile).toBe("standard")
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it("keeps diagnostic sink failures out of prompt behavior", () => {
    const ctx = { cwd: "/workspace", enabledTools: new Set<string>(), onSection: () => { throw new Error("diagnostics offline") } }
    expect(assemblePrompt(ctx, [{ name: "fixture", compute: () => "retained" }])).toBe("retained")
    expect(buildSystemPrompt({ ...getDefaultConfig(), customSystemPrompt: "custom", promptProfile: "concise" },
      ctx.cwd, undefined, ctx.enabledTools, undefined, undefined, ctx.onSection)).toContain("custom")
  })
})
