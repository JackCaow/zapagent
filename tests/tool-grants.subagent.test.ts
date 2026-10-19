import { expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PermissionManager } from "../src/permissions.js"
import { buildToolGrantRules } from "../src/tool-grants.js"
import { evaluateApprovalPolicy } from "../src/permission-policy.js"
import { subagentTool } from "../zapsdk/builtin-tools/subagent.js"
import { writeFileTool } from "../zapsdk/builtin-tools/filesystem.js"
import { ToolRegistry } from "../zapsdk/tools/registry.js"
import type { LLMProvider } from "../zapsdk/core/llm.js"

it("SDK children reuse root grants while roles, resource filters and revocation remain authoritative", async () => {
  const root = mkdtempSync(join(tmpdir(), "zap-child-tool-grant-"))
  const previous = process.env.ZAPCODE_DATA_DIR
  process.env.ZAPCODE_DATA_DIR = join(root, "data")
  try {
    const cwd = join(root, "workspace"); mkdirSync(cwd)
    const manager = new PermissionManager(cwd); manager.setSessionId("root-session")
    manager.addToolRules(buildToolGrantRules({ tools: ["write_file"], resource: { kind: "pattern", value: "src/**" }, lifetime: "session" }, ["write_file"]), "session")
    for (const scenario of ["allowed", "outside", "readonly", "revoked"]) {
      if (scenario === "revoked") manager.setSessionId("restored-root-session")
      const path = scenario === "outside" ? "lib/outside.txt" : `src/${scenario}.txt`
      const registry = new ToolRegistry(); registry.register(writeFileTool({ defaultCwd: cwd, allowedPaths: [cwd] }))
      let calls = 0, approvals = 0
      const provider: LLMProvider = { async call(_messages, tools) {
        calls++
        expect(tools?.some(tool => tool.name === "write_file") ?? false).toBe(scenario !== "readonly")
        return calls === 1 ? { type: "tool_call", text: "", toolCalls: [{ id: `write-${scenario}`, name: "write_file", arguments: { path, content: "fixture" } }], usage: { inputTokens: 1, outputTokens: 1 } }
          : { type: "text", text: "fixture finished", usage: { inputTokens: 1, outputTokens: 1 } }
      } }
      const child = subagentTool({ registry, provider, storageProjectCwd: cwd, executorOptions: { cwd }, maxSteps: 3,
        onApproval: async (name, args, _signal, context) => {
          approvals++
          return evaluateApprovalPolicy(manager, name, args, { mode: "default", cwd, context }).decision === "allow"
        } })
      await child.handler({ task: "Write the fixture only if authorized.", agent_type: scenario === "readonly" ? "explore" : "general" })
      expect(existsSync(join(cwd, path))).toBe(scenario === "allowed")
      expect(approvals).toBe(scenario === "readonly" ? 0 : 1)
    }
  } finally {
    if (previous === undefined) delete process.env.ZAPCODE_DATA_DIR
    else process.env.ZAPCODE_DATA_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})
