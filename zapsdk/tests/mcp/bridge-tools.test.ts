import { afterEach, describe, it, expect } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { bridgeMCPTool } from "../../mcp/bridge/tools.js"
import { resolveProjectDataSegment } from "../../utils/project-paths.js"

// Minimal Client stub: only what bridgeMCPTool calls.
function makeClient(callTool: (req: unknown) => Promise<unknown>) {
  return { callTool } as never
}

describe("bridgeMCPTool", () => {
  let cleanupDataDir: string | null = null
  let previousDataDir: string | undefined
  let previousDataDirCaptured = false

  afterEach(() => {
    if (cleanupDataDir) {
      rmSync(cleanupDataDir, { recursive: true, force: true })
      cleanupDataDir = null
    }
    if (previousDataDirCaptured && previousDataDir !== undefined) {
      process.env.ZAPCODE_DATA_DIR = previousDataDir
      previousDataDir = undefined
    } else if (previousDataDirCaptured) {
      delete process.env.ZAPCODE_DATA_DIR
    }
    previousDataDirCaptured = false
  })

  it("namespaces the tool name and attaches rawSchema", async () => {
    const tool = bridgeMCPTool(
      makeClient(async () => ({ content: [{ type: "text", text: "ok" }] })),
      { name: "github", transport: "stdio" },
      {
        name: "create_issue",
        description: "Create a GH issue",
        inputSchema: { type: "object", properties: { title: { type: "string" } } },
      },
    )
    expect(tool.definition.name).toBe("mcp__github__create_issue")
    expect(tool.definition.rawSchema).toBeDefined()
    expect((tool.definition.rawSchema as any).type).toBe("object")
    expect(tool.definition.permission).toBe("confirm")
  })

  it("autoApproveTools whitelist flips permission to auto", () => {
    const tool = bridgeMCPTool(
      makeClient(async () => ({ content: [] })),
      { name: "github", transport: "stdio", autoApproveTools: ["search"] },
      { name: "search", inputSchema: { type: "object" } },
    )
    expect(tool.definition.permission).toBe("auto")
  })

  it("readOnlyHint propagates to ToolDefinition.readOnly", () => {
    const tool = bridgeMCPTool(
      makeClient(async () => ({ content: [] })),
      { name: "fs", transport: "stdio" },
      { name: "stat", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    )
    expect(tool.definition.readOnly).toBe(true)
    const effects = tool.definition.resolveEffects?.({}, { cwd: "/repo", toolName: tool.definition.name })
    expect(effects?.external[0]).toMatchObject({
      system: "mcp:fs",
      operation: "read",
      resource: "stat",
    })
  })

  it("destructiveHint wins over a contradictory readOnlyHint", () => {
    const tool = bridgeMCPTool(
      makeClient(async () => ({ content: [] })),
      { name: "test", transport: "stdio" },
      {
        name: "delete",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true, destructiveHint: true },
      },
    )
    expect(tool.definition.readOnly).toBe(false)
    const effects = tool.definition.resolveEffects?.({}, { cwd: "/repo", toolName: tool.definition.name })
    expect(effects?.external[0]?.operation).toBe("destructive")
  })

  it("collapses text + resource_link content into output", async () => {
    const tool = bridgeMCPTool(
      makeClient(async () => ({
        content: [
          { type: "text", text: "hello" },
          { type: "resource_link", uri: "file:///a.md", name: "a.md", description: "an A" },
        ],
      })),
      { name: "s", transport: "stdio" },
      { name: "t", inputSchema: { type: "object" } },
    )
    const result = await tool.handler({})
    expect(result.success).toBe(true)
    expect(result.output).toContain("hello")
    expect(result.output).toContain("resource_link file:///a.md")
  })

  it("isError=true surfaces as ToolResult error", async () => {
    const tool = bridgeMCPTool(
      makeClient(async () => ({
        isError: true,
        content: [{ type: "text", text: "server said no" }],
      })),
      { name: "s", transport: "stdio" },
      { name: "t", inputSchema: { type: "object" } },
    )
    const result = await tool.handler({})
    expect(result.success).toBe(false)
    expect(result.error).toContain("server said no")
  })

  it("structuredContent fallback when content is empty", async () => {
    const tool = bridgeMCPTool(
      makeClient(async () => ({ content: [], structuredContent: { count: 3, items: ["a"] } })),
      { name: "s", transport: "stdio" },
      { name: "t", inputSchema: { type: "object" } },
    )
    const result = await tool.handler({})
    expect(result.output).toContain('"count":3')
  })

  it("persists inline image content under the project data dir with owner-only permissions", async () => {
    previousDataDir = process.env.ZAPCODE_DATA_DIR
    previousDataDirCaptured = true
    cleanupDataDir = mkdtempSync(join(tmpdir(), "zap-mcp-images-"))
    process.env.ZAPCODE_DATA_DIR = cleanupDataDir
    const bytes = Buffer.from("not-a-real-image-but-valid-base64")
    const tool = bridgeMCPTool(
      makeClient(async () => ({
        content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }],
      })),
      { name: "s", transport: "stdio" },
      { name: "image_tool", inputSchema: { type: "object" } },
    )

    const result = await tool.handler({})

    expect(result.success).toBe(true)
    expect(result.output).toContain("[image: image/png]")
    expect(result.contentBlocks).toHaveLength(1)
    const block = result.contentBlocks![0]!
    expect(block.type).toBe("image")
    const filePath = (block as { filePath: string }).filePath
    expect(filePath.startsWith(join(
      cleanupDataDir,
      "projects",
      resolveProjectDataSegment(process.cwd()),
      "mcp-images",
    ))).toBe(true)
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath)).toEqual(bytes)
    if (process.platform !== "win32") {
      expect(statSync(dirname(filePath)).mode & 0o777).toBe(0o700)
      expect(statSync(filePath).mode & 0o777).toBe(0o600)
    }
  })

  it("uses explicit projectCwd when persisting inline image content", async () => {
    previousDataDir = process.env.ZAPCODE_DATA_DIR
    previousDataDirCaptured = true
    cleanupDataDir = mkdtempSync(join(tmpdir(), "zap-mcp-images-explicit-"))
    const projectCwd = mkdtempSync(join(tmpdir(), "zap-mcp-project-"))
    process.env.ZAPCODE_DATA_DIR = cleanupDataDir
    const bytes = Buffer.from("project-scoped-mcp-image")
    const tool = bridgeMCPTool(
      makeClient(async () => ({
        content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }],
      })),
      { name: "s", transport: "stdio" },
      { name: "image_tool", inputSchema: { type: "object" } },
      { projectCwd },
    )

    try {
      const result = await tool.handler({})

      expect(result.success).toBe(true)
      const block = result.contentBlocks![0]!
      const filePath = (block as { filePath: string }).filePath
      expect(filePath.startsWith(join(
        cleanupDataDir,
        "projects",
        resolveProjectDataSegment(projectCwd),
        "mcp-images",
      ))).toBe(true)
      expect(readFileSync(filePath)).toEqual(bytes)
    } finally {
      rmSync(projectCwd, { recursive: true, force: true })
    }
  })

  it("legacy toolResult envelope", async () => {
    const tool = bridgeMCPTool(
      makeClient(async () => ({ toolResult: "raw legacy" })),
      { name: "s", transport: "stdio" },
      { name: "t", inputSchema: { type: "object" } },
    )
    const result = await tool.handler({})
    expect(result.success).toBe(true)
    expect(result.output).toBe("raw legacy")
  })

  it("aborts immediately when signal already aborted", async () => {
    const tool = bridgeMCPTool(
      makeClient(async () => ({ content: [{ type: "text", text: "should not fire" }] })),
      { name: "s", transport: "stdio" },
      { name: "t", inputSchema: { type: "object" } },
    )
    const ctrl = new AbortController()
    ctrl.abort()
    const result = await tool.handler({}, ctrl.signal)
    expect(result.success).toBe(false)
    expect(result.error).toBe("aborted")
  })
})
