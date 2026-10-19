// End-to-end integration test that exercises the manager against a real
// MCP server (the reference `@modelcontextprotocol/server-everything`).
// Skipped by default — set ZAP_TEST_MCP_INTEGRATION=1 to run. Useful for
// CI smoke jobs and local regression after spec-version bumps.

import { describe, it, expect } from "bun:test"
import { MCPManager } from "../../mcp/index.js"

const ENABLED = process.env.ZAP_TEST_MCP_INTEGRATION === "1"
const describeMaybe = ENABLED ? describe : describe.skip

describeMaybe("MCPManager integration (server-everything)", () => {
  it("reconciles, discovers tools/resources/prompts, executes a tool", async () => {
    const mgr = new MCPManager()

    await mgr.reconcile([
      {
        name: "ev",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        connectTimeoutMs: 30_000,
        callTimeoutMs: 10_000,
      },
    ])

    // Wait for ready or terminal failure
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const snap = mgr.snapshots()[0]
      if (snap?.status === "ready" || snap?.status === "error") break
      await new Promise((r) => setTimeout(r, 250))
    }

    const snap = mgr.snapshots()[0]
    expect(snap?.status).toBe("ready")
    expect(snap?.toolCount).toBeGreaterThan(0)
    expect(snap?.resourceCount).toBeGreaterThan(0)
    expect(snap?.promptCount).toBeGreaterThan(0)

    const echo = mgr.allTools().find((t) => t.definition.name === "mcp__ev__echo")
    expect(echo).toBeDefined()
    const result = await echo!.handler({ message: "hello" })
    expect(result.success).toBe(true)
    expect(result.output).toContain("hello")

    // Resource read
    const { resources } = mgr.allResources()
    expect(resources.length).toBeGreaterThan(0)
    const content = await mgr.readResource("ev", resources[0]!.uri)
    expect(content[0]?.text?.length ?? 0).toBeGreaterThan(0)

    await mgr.stopAll()
  }, 60_000)
})
