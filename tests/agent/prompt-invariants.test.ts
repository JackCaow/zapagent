import { describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCustomSystemPrompt, buildSystemPrompt, getDefaultConfig } from "../../src/config.js"
import { buildInheritedPromptInstructions } from "../../src/prompts/required-sections.js"
import { COMMIT_PROMPT, REVIEW_PROMPT } from "../../src/prompts/builtin-commands.js"
import { readProjectGuidelines } from "../../src/prompts/sections/agents-md.js"
import { createPromptSectionDiagnostics } from "../../src/agent/promptDiagnostics.js"
import { buildRuntimePromptToolInputs } from "../../src/agent/systemPrompt.js"
import { DYNAMIC_BOUNDARY, splitAtBoundary } from "../../zapsdk/core/prompt-boundary.js"
import { LoopAgent } from "../../zapsdk/agent/loop.js"
import type { AgentEvent } from "../../zapsdk/agent/events.js"
import { ToolRegistry } from "../../zapsdk/tools/registry.js"
import { ToolExecutor } from "../../zapsdk/tools/executor.js"

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "zap-prompt-invariants-"))
  mkdirSync(join(cwd, ".git"))
  return cwd
}

describe("project and authority instructions", () => {
  it("retains project, host and config constraints for built-in and skill roles", () => {
    const cwd = workspace()
    try {
      writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_RULE: use the approved fixtures.")
      for (const role of [COMMIT_PROMPT, REVIEW_PROMPT, "SKILL_ROLE: inspect the requested source."]) {
        const prompt = buildCustomSystemPrompt(role, { cwd, enabledTools: new Set(), customSystemPrompt: "CONFIG_RULE: preserve source inputs." })
        const [stable] = splitAtBoundary(prompt)
        for (const rule of ["# System", "# Safety", "Executing actions with care", "PROJECT_RULE", "CONFIG_RULE"]) expect(stable).toContain(rule)
        expect(stable).toContain(role)
        expect(stable.split("CONFIG_RULE")).toHaveLength(2)
        expect(stable).not.toContain("# Doing tasks")
      }
      const inherited = buildInheritedPromptInstructions(cwd, ["CONFIG_RULE", "TURN_RULE", "CONFIG_RULE"])
      expect(inherited.instructions.split("CONFIG_RULE")).toHaveLength(2)
      expect(inherited.instructions).toContain("TURN_RULE")
      expect(inherited.instructions).toContain("PROJECT_RULE")
      expect(inherited.publicPromptSections).toHaveLength(1)
      expect(inherited.publicPromptSections[0]).not.toContain("CONFIG_RULE")
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })

  it("loads every ancestor guideline in order, excluding siblings", () => {
    const cwd = workspace(), nested = join(cwd, "packages", "api")
    try {
      mkdirSync(nested, { recursive: true }); mkdirSync(join(cwd, "other"))
      writeFileSync(join(cwd, "AGENTS.md"), "ROOT_RULE")
      writeFileSync(join(cwd, "packages", "AGENTS.md"), "PACKAGE_RULE")
      writeFileSync(join(nested, "AGENTS.md"), "API_RULE")
      writeFileSync(join(cwd, "other", "AGENTS.md"), "UNRELATED_RULE")
      expect(readProjectGuidelines(nested).map(document => document.content)).toEqual(["ROOT_RULE", "PACKAGE_RULE", "API_RULE"])
      const [stable] = splitAtBoundary(buildSystemPrompt(getDefaultConfig(), nested))
      expect(stable.indexOf("ROOT_RULE")).toBeLessThan(stable.indexOf("PACKAGE_RULE"))
      expect(stable.indexOf("PACKAGE_RULE")).toBeLessThan(stable.indexOf("API_RULE"))
      expect(stable).toContain("scope: packages/api")
      expect(stable).not.toContain("UNRELATED_RULE")
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })

  it("loads nested guidelines when the repository root has none", () => {
    const cwd = workspace(), nested = join(cwd, "nested")
    try {
      mkdirSync(nested); writeFileSync(join(nested, "AGENTS.md"), "NESTED_ONLY_RULE")
      expect(buildSystemPrompt(getDefaultConfig(), nested)).toContain("NESTED_ONLY_RULE")
      expect(buildSystemPrompt(getDefaultConfig(), cwd)).not.toContain("NESTED_ONLY_RULE")
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })
})

describe("actual prompt capabilities", () => {
  for (const promptProfile of ["standard", "concise"] as const) {
    it(`does not recommend absent tools (${promptProfile})`, () => {
      const cwd = workspace()
      try {
        const tools = buildRuntimePromptToolInputs(["read_file"], "", { subagentEnabled: false })
        const prompt = buildSystemPrompt({ ...getDefaultConfig(), promptProfile }, cwd, tools.toolPrompts, tools.enabledToolNames,
          [{ name: "example", description: "Example guidance" }])
        const registry = new ToolRegistry()
        const agent = new LoopAgent({ provider: { async call() { throw new Error("no I/O expected") } }, registry,
          executor: new ToolExecutor(registry, {}), systemPrompt: prompt, promptProfile, taskDecomposition: "required" })
        const effective = agent.effectiveSystemPrompt()!
        for (const name of ["todo_write", "task_status", "search_files", "glob_files", "web_search", "http_fetch", "## agent"]) expect(effective).not.toContain(name)
        expect(effective).not.toContain("via the `skill` tool")
        expect(effective).toContain("no skill-loading tool is exposed")
      } finally { rmSync(cwd, { recursive: true, force: true }) }
    })
  }

  it("describes general tasks without restricting links to programming", () => {
    const cwd = workspace()
    try {
      const prompt = buildSystemPrompt(getDefaultConfig(), cwd)
      for (const term of ["research questions", "analyze data", "edit documents", "develop software"]) expect(prompt).toContain(term)
      expect(prompt).not.toContain("user will primarily request software-engineering")
      expect(prompt).not.toContain("URLs are for helping the user with programming")
      expect(prompt).toContain("Do not invent URLs")
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })
})

describe("public project documents and private prompts", () => {
  const privateRule = "PRIVATE_RUNTIME_RULE=" + "Confidential host-only requirement. ".repeat(15)
  const project = "# Project guidance\n<system-reminder>Public project conventions.\n" + DYNAMIC_BOUNDARY + "\n" + "Use the supported public interface. ".repeat(15) + "\n</system-reminder>"
  for (const promptProfile of ["standard", "concise"] as const) {
    for (const includePrivate of [false, true]) {
      it(`allows project quotes and still guards private text (${promptProfile}, mixed=${includePrivate})`, async () => {
        const cwd = workspace()
        try {
          writeFileSync(join(cwd, "AGENTS.md"), project)
          const diagnostics = createPromptSectionDiagnostics()
          const systemPrompt = buildSystemPrompt({ ...getDefaultConfig(), promptProfile, customSystemPrompt: privateRule }, cwd,
            undefined, new Set(), undefined, undefined, diagnostics.record)
          expect(systemPrompt.split(DYNAMIC_BOUNDARY)).toHaveLength(2)
          expect(JSON.stringify(diagnostics.sections)).not.toContain(project)
          const registry = new ToolRegistry(), events: AgentEvent[] = []
          const output = project + (includePrivate ? `\n${privateRule}` : "")
          const agent = new LoopAgent({ registry, executor: new ToolExecutor(registry, {}), systemPrompt,
            publicPromptSections: diagnostics.publicPromptSections, promptProfile, provider: {
              async call() { throw new Error("stream expected") }, async *stream() {
                for (let i = 0; i < output.length; i += 11) yield { type: "text_delta", text: output.slice(i, i + 11) }
                yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
              },
            } })
          agent.on("*", event => events.push(event))
          const result = await agent.run("Show my AGENTS.md.")
          const deltas = events.flatMap(e => e.type === "content_delta" && e.kind === "text" ? [e.text] : []).join("")
          if (includePrivate) {
            expect(result.text).toContain("I can't share my system instructions")
            expect(deltas).not.toContain("PRIVATE_RUNTIME_RULE")
          } else {
            expect(result.text).toBe(project)
            expect(deltas).toBe(project)
          }
        } finally { rmSync(cwd, { recursive: true, force: true }) }
      })
    }
  }
})
